// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOrdoTrust} from "./OrdoSigned.sol";
import {IEnsV2Registry, IMulticallable, IUserRegistryInit, IVerifiableFactory, OrdoEnsName} from "./OrdoEns.sol";

/// @title OrdoNames
/// @notice Every org, person, role, machine, run and stage in Ordo is an ENSv2 name under Ordo's root (ordo.eth), and
///         a role is a name you hold: `priya.validators.acme.ordo.eth`. This contract issues them in batches and
///         answers which roles an account holds at a site, from those names alone.
///
/// Names live in ENSv2 registries: the root registry Ordo's root name points at, and below it one UserRegistry per
/// name that has names of its own (each org, its role collections, its runs). This contract deploys those registries
/// through ENS's VerifiableFactory, so their addresses are known before they exist and one batch can create a
/// registry and the names inside it. Ordo's operator sends `execute` with many operations; each runs on its own, so
/// one that fails (a name taken, a role missing) is reported and the rest still land.
///
/// Roles: a person holds a role at a site while they own `<handle>.<collection>.<org>` in that org's collection
/// registry, which this contract recorded when it created it. Promoting issues the name; demoting unregisters it,
/// and every contract that asks (it answers OrdoTrust's `sites` and `roles` calls) sees the change at once. A
/// machine's gateway holds DEVICE through its machine name, a vendor VENDOR through its vendor name.
contract OrdoNames is IOrdoTrust {
    // role bits, as OrdoTrust numbers them
    uint8 public constant OPERATOR = 1;
    uint8 public constant SUPERVISOR = 2;
    uint8 public constant VALIDATOR = 4;
    uint8 public constant PLANT_MANAGER = 8;
    uint8 public constant ADMIN = 16;
    uint8 public constant VENDOR = 32;
    uint8 public constant DEVICE = 64;
    uint8 public constant TESTER = 128;

    // registries this contract keeps for each site (0 = none)
    uint8 public constant ORG = 1;
    uint8 public constant MANAGERS = 2;
    uint8 public constant VALIDATORS = 3;
    uint8 public constant TESTERS = 4;
    uint8 public constant CONTRIBUTORS = 5;
    uint8 public constant MACHINES = 6;
    uint8 public constant VENDORS = 7;
    uint8 public constant RUNS = 8;

    // what an owner is to a site (0 = nothing): whose label this contract remembers
    uint8 public constant PERSON = 1;
    uint8 public constant MACHINE = 2;
    uint8 public constant SUPPLIER = 3;

    // operations
    uint8 public constant ISSUE = 0;
    uint8 public constant RECORDS = 1;
    uint8 public constant REVOKE = 2;
    uint8 public constant GRANT = 3;
    uint8 public constant UNGRANT = 4;

    /// every ENSv2 role and its admin role (each role is one bit at 4k, admins shifted by 128)
    uint256 public constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;

    struct Op {
        uint8 kind;
        /// the registry that holds the name (ISSUE, REVOKE), or the registry whose root roles change (GRANT, UNGRANT)
        IEnsV2Registry parent;
        string label;
        /// ISSUE: who holds the name; GRANT, UNGRANT: who gets or loses the roles; REVOKE: whose member link goes
        address owner;
        /// ISSUE: the name's resolver (0 = Ordo's resolver)
        address resolver;
        /// ISSUE: not 0 = the name has its own registry, at predictRegistry(salt), deployed here if it is not yet
        uint256 salt;
        uint64 expiry;
        /// ISSUE: roles on the name's token (0 = a credential its holder can neither transfer nor repoint);
        /// GRANT, UNGRANT: roles on `parent`'s root
        uint256 roles;
        /// calls on Ordo's resolver for this name: setText, setAddress, setContenthash
        bytes[] records;
        bytes32 site;
        /// ISSUE: remember the name's registry as this registry of the site
        uint8 slot;
        /// ISSUE, REVOKE: link or unlink `owner` as this kind of member of the site, under `label`
        uint8 member;
    }

    IVerifiableFactory public immutable factory;
    address public immutable registryImpl;
    IEnsV2Registry public immutable root;
    /// Ordo's PermissionedResolver, where every name's records are written
    address public immutable resolver;
    string public rootName;
    string[] private rootLabels;

    address public owner;
    mapping(address => bool) public operators;

    mapping(bytes32 => string) public orgLabel;
    mapping(bytes32 => mapping(uint8 => address)) public registryOf;
    mapping(bytes32 => mapping(uint8 => mapping(address => string))) public memberLabel;

    event Applied(uint256 indexed index, address registry);
    event Failed(uint256 indexed index, bytes reason);
    event RegistryLinked(bytes32 indexed site, uint8 indexed slot, address registry, string label);
    event MemberLinked(bytes32 indexed site, uint8 indexed member, address indexed account, string label);
    event MemberUnlinked(bytes32 indexed site, uint8 indexed member, address indexed account);
    event OperatorSet(address indexed account, bool allowed);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotOperator();
    error OnlySelf();
    error Taken(string label, address holder);
    error UnknownOp(uint8 kind);
    error WrongRegistry(address expected, address made);

    constructor(IVerifiableFactory _factory, address _registryImpl, IEnsV2Registry _root, address _resolver, string memory _rootName, address admin) {
        factory = _factory;
        registryImpl = _registryImpl;
        root = _root;
        resolver = _resolver;
        rootName = _rootName;
        rootLabels = OrdoEnsName.split(_rootName);
        owner = admin;
        operators[admin] = true;
        emit OwnerChanged(admin);
        emit OperatorSet(admin, true);
    }

    function setOperator(address account, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        operators[account] = allowed;
        emit OperatorSet(account, allowed);
    }

    function transferOwnership(address to) external {
        if (msg.sender != owner) revert NotOwner();
        owner = to;
        emit OwnerChanged(to);
    }

    /// Where the registry made with `salt` lives (or will).
    function predictRegistry(uint256 salt) public view returns (address) {
        return factory.predictProxyAddress(address(this), salt);
    }

    // ------------------------------------------------------------------ issuing

    /// Run a batch. Each operation succeeds or fails on its own: `Applied` or `Failed` says which, by index.
    function execute(Op[] calldata ops) external returns (uint256 applied) {
        if (!operators[msg.sender]) revert NotOperator();
        for (uint256 i = 0; i < ops.length; i++) {
            try this.executeOne(ops[i], i) {
                applied++;
            } catch (bytes memory reason) {
                emit Failed(i, reason);
            }
        }
    }

    /// One operation; only `execute` calls it, so a failure reverts this operation alone.
    function executeOne(Op calldata op, uint256 index) external {
        if (msg.sender != address(this)) revert OnlySelf();
        address made;
        if (op.kind == ISSUE) made = _issue(op);
        else if (op.kind == RECORDS) _records(op.records);
        else if (op.kind == REVOKE) _revoke(op);
        else if (op.kind == GRANT) op.parent.grantRootRoles(op.roles, op.owner);
        else if (op.kind == UNGRANT) op.parent.revokeRootRoles(op.roles, op.owner);
        else revert UnknownOp(op.kind);
        emit Applied(index, made);
    }

    /// Register the name if it is free (or put it right if it is already this owner's), with its records. Safe to repeat.
    function _issue(Op calldata op) internal returns (address sub) {
        if (op.salt != 0) sub = _registry(op.salt);
        address res = op.resolver == address(0) ? resolver : op.resolver;
        uint256 id = uint256(keccak256(bytes(op.label)));
        address holder = op.parent.findOwner(op.label);
        if (holder == address(0)) {
            op.parent.register(op.label, op.owner, sub, res, op.roles, op.expiry);
        } else {
            if (holder != op.owner) revert Taken(op.label, holder);
            if (op.parent.getSubregistry(op.label) != sub) op.parent.setSubregistry(id, sub);
            if (op.parent.getResolver(op.label) != res) op.parent.setResolver(id, res);
        }
        // the registry's own record of where it hangs, which ENS reads for its canonical name
        if (sub != address(0)) IEnsV2Registry(sub).setParent(address(op.parent), op.label);
        _records(op.records);
        if (op.slot != 0 && sub != address(0)) {
            registryOf[op.site][op.slot] = sub;
            if (op.slot == ORG) orgLabel[op.site] = op.label;
            emit RegistryLinked(op.site, op.slot, sub, op.label);
        }
        if (op.member != 0) {
            memberLabel[op.site][op.member][op.owner] = op.label;
            emit MemberLinked(op.site, op.member, op.owner, op.label);
        }
    }

    function _revoke(Op calldata op) internal {
        if (op.parent.findOwner(op.label) != address(0)) op.parent.unregister(uint256(keccak256(bytes(op.label))));
        _records(op.records);
        if (op.member != 0 && keccak256(bytes(memberLabel[op.site][op.member][op.owner])) == keccak256(bytes(op.label))) {
            delete memberLabel[op.site][op.member][op.owner];
            emit MemberUnlinked(op.site, op.member, op.owner);
        }
    }

    /// The registry at predictRegistry(salt), deployed if it is not there yet. This contract and its owner hold every role on it.
    function _registry(uint256 salt) internal returns (address sub) {
        sub = predictRegistry(salt);
        if (sub.code.length != 0) return sub;
        IUserRegistryInit.Grant[] memory grants = new IUserRegistryInit.Grant[](2);
        grants[0] = IUserRegistryInit.Grant(address(this), ALL_ROLES);
        grants[1] = IUserRegistryInit.Grant(owner, ALL_ROLES);
        address made = factory.deployProxy(registryImpl, salt, abi.encodeCall(IUserRegistryInit.initialize, (grants)));
        if (made != sub) revert WrongRegistry(sub, made);
    }

    function _records(bytes[] calldata records) internal {
        if (records.length != 0) IMulticallable(resolver).multicall(records);
    }

    // ------------------------------------------------------------------ roles (IOrdoTrust)

    /// A site exists while its org name does; its "treasury" is the name's holder (Ordo's account).
    function sites(bytes32 site) external view returns (bool exists, address treasury) {
        string memory label = orgLabel[site];
        if (bytes(label).length == 0) return (false, address(0));
        treasury = root.findOwner(label);
        exists = treasury != address(0);
    }

    /// The roles `account` holds at `site`, from the names it holds right now (expired or unregistered names count for nothing).
    function roles(bytes32 site, address account) public view returns (uint8 bits) {
        if (account == address(0)) return 0;
        string memory h = memberLabel[site][PERSON][account];
        if (bytes(h).length != 0 && _holds(site, ORG, h, account)) {
            if (_holds(site, MANAGERS, h, account)) bits |= ADMIN | PLANT_MANAGER | SUPERVISOR | VALIDATOR | OPERATOR;
            if (_holds(site, VALIDATORS, h, account)) bits |= VALIDATOR;
            if (_holds(site, TESTERS, h, account)) bits |= TESTER;
            if (_holds(site, CONTRIBUTORS, h, account)) bits |= OPERATOR;
        }
        string memory m = memberLabel[site][MACHINE][account];
        if (bytes(m).length != 0 && _holds(site, MACHINES, m, account)) bits |= DEVICE;
        string memory v = memberLabel[site][SUPPLIER][account];
        if (bytes(v).length != 0 && _holds(site, VENDORS, v, account)) bits |= VENDOR;
    }

    function hasRole(string calldata siteId, address account, uint8 role) external view returns (bool) {
        return roles(keccak256(bytes(siteId)), account) & role != 0;
    }

    function _holds(bytes32 site, uint8 slot, string memory label, address account) internal view returns (bool) {
        address r = registryOf[site][slot];
        return r != address(0) && IEnsV2Registry(r).findOwner(label) == account;
    }

    // ------------------------------------------------------------------ names

    /// The org's labels, for building names under it: ["acme", "ordo", "eth"] ([] for a site with no org name).
    function orgLabels(bytes32 site) public view returns (string[] memory) {
        string memory label = orgLabel[site];
        if (bytes(label).length == 0) return new string[](0);
        return OrdoEnsName.prepend(label, rootLabels);
    }

    /// The name `account` goes by at `site`: its person name, else its machine or vendor name ("" if none).
    function nameOf(bytes32 site, address account) external view returns (string memory) {
        string[] memory org = orgLabels(site);
        if (org.length == 0) return "";
        string memory h = memberLabel[site][PERSON][account];
        if (bytes(h).length != 0) return OrdoEnsName.join(OrdoEnsName.prepend(h, org));
        string memory m = memberLabel[site][MACHINE][account];
        if (bytes(m).length != 0) return OrdoEnsName.join(OrdoEnsName.prepend(m, OrdoEnsName.prepend("machines", org)));
        string memory v = memberLabel[site][SUPPLIER][account];
        if (bytes(v).length != 0) return OrdoEnsName.join(OrdoEnsName.prepend(v, OrdoEnsName.prepend("vendors", org)));
        return "";
    }

    // ------------------------------------------------------------------ ERC-1155 receiver (registry tokens minted here)

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x4e2312e0;
    }
}
