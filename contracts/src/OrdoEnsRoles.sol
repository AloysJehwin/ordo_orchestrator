// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOrdoTrust} from "./OrdoSigned.sol";

/// The parts of an ENSv2 registry (UserRegistry) Ordo reads. Every lookup is by label and returns zero once the
/// name has expired or been unregistered.
interface IEnsV2Registry {
    function findOwner(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

/// ENSIP-10 resolution, which ENSv2 resolvers implement.
interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface ITextResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// DNS wire format and namehash for names built from labels, as ENS resolvers take them.
library OrdoEnsName {
    function dns(string[] memory labels) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < labels.length; i++) out = abi.encodePacked(out, uint8(bytes(labels[i]).length), labels[i]);
        out = abi.encodePacked(out, uint8(0));
    }

    function namehash(string[] memory labels) internal pure returns (bytes32 node) {
        for (uint256 i = labels.length; i > 0; i--) node = keccak256(abi.encodePacked(node, keccak256(bytes(labels[i - 1]))));
    }

    /// "a.b.eth" → ["a", "b", "eth"]
    function split(string memory name) internal pure returns (string[] memory labels) {
        bytes memory b = bytes(name);
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) if (b[i] == ".") n++;
        labels = new string[](n);
        uint256 start;
        uint256 k;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ".") {
                bytes memory l = new bytes(i - start);
                for (uint256 j = 0; j < l.length; j++) l[j] = b[start + j];
                labels[k++] = string(l);
                start = i + 1;
            }
        }
    }

    /// [first, ...rest]
    function prepend(string memory first, string[] memory rest) internal pure returns (string[] memory out) {
        out = new string[](rest.length + 1);
        out[0] = first;
        for (uint256 i = 0; i < rest.length; i++) out[i + 1] = rest[i];
    }
}

/// @title OrdoEnsRoles
/// @notice Ordo roles read from ENS, so a person's `member-…` name *is* their credential: revoke or let the name
///         expire and the role is gone in every contract that asks.
///
/// Each Ordo site is `<site>.<parent>` (e.g. `chennai-1.ordo-mfg.eth`) with its own ENSv2 registry, and each person
/// is `member-<their wallet's 40 hex digits>.<site>.<parent>`, minted to their wallet with no roles on the token so
/// they cannot transfer it. A wallet holds a role at a site when:
///  - it owns its member name in the site's registry right now (not expired, not unregistered), and
///  - the name's `com.ordo.roles` text record lists the role (Ordo's role names, comma-separated), or, for
///    VALIDATOR, its `com.ordo.validator` record names a validator scope.
/// Records live in the resolver the site's registry points at, which only Ordo can write.
///
/// It answers the same `sites` and `roles` calls as OrdoTrust (IOrdoTrust), so OrdoWorkOrders, OrdoPolicies and
/// OrdoLotResolver can take their credentials from ENS instead.
contract OrdoEnsRoles is IOrdoTrust {
    uint8 public constant OPERATOR = 1;
    uint8 public constant SUPERVISOR = 2;
    uint8 public constant VALIDATOR = 4;
    uint8 public constant PLANT_MANAGER = 8;
    uint8 public constant ADMIN = 16;
    /// a machine's gateway, which signs stage readings; its member name is minted to the gateway's key
    uint8 public constant DEVICE = 64;

    IEnsV2Registry public immutable parent;
    string public parentName;
    string[] private parentLabels;

    /// site key (keccak256 of Ordo's site id, as in OrdoTrust) → the site's label under the parent
    mapping(bytes32 => string) public siteLabel;

    event SiteLinked(bytes32 indexed site, string siteId, string label, address indexed by);

    error NotSiteOwner(address caller);
    error BadLabel();

    constructor(IEnsV2Registry _parent, string memory _parentName) {
        parent = _parent;
        parentName = _parentName;
        parentLabels = OrdoEnsName.split(_parentName);
    }

    /// Tie an Ordo site id to its ENS name. Only whoever owns `<label>.<parent>` may, and may re-link it.
    function linkSite(string calldata siteId, string calldata label) external {
        if (bytes(label).length == 0) revert BadLabel();
        if (parent.findOwner(label) != msg.sender) revert NotSiteOwner(msg.sender);
        bytes32 k = keccak256(bytes(siteId));
        siteLabel[k] = label;
        emit SiteLinked(k, siteId, label, msg.sender);
    }

    /// A site exists while its ENS name does; its treasury is the name's owner.
    function sites(bytes32 site) external view returns (bool exists, address treasury) {
        string memory label = siteLabel[site];
        if (bytes(label).length == 0) return (false, address(0));
        treasury = parent.findOwner(label);
        exists = treasury != address(0);
    }

    function roles(bytes32 site, address account) external view returns (uint8) {
        return rolesOf(site, memberLabel(account), account);
    }

    function hasRole(string calldata siteId, address account, uint8 role) external view returns (bool) {
        return rolesOf(keccak256(bytes(siteId)), memberLabel(account), account) & role != 0;
    }

    /// Roles `account` holds through the member name `label` at `site`.
    function rolesOf(bytes32 site, string memory label, address account) public view returns (uint8 bits) {
        string memory sl = siteLabel[site];
        if (bytes(sl).length == 0 || account == address(0)) return 0;
        IEnsV2Registry reg = IEnsV2Registry(parent.getSubregistry(sl));
        if (address(reg) == address(0)) return 0;
        if (reg.findOwner(label) != account) return 0;
        address resolver = reg.getResolver(label);
        if (resolver == address(0)) return 0;
        string[] memory labels = OrdoEnsName.prepend(label, OrdoEnsName.prepend(sl, parentLabels));
        bits = _parseRoles(_text(resolver, labels, "com.ordo.roles"));
        if (bytes(_text(resolver, labels, "com.ordo.validator")).length != 0) bits |= VALIDATOR;
    }

    /// `member-` and the wallet's 40 hex digits, as Ordo labels people and gateways: one label per wallet, so no two
    /// wallets can clash (a shorter label could be ground to collide and push the real holder to a name with no roles).
    function memberLabel(address account) public pure returns (string memory) {
        bytes memory out = new bytes(47);
        bytes memory prefix = "member-";
        for (uint256 i = 0; i < 7; i++) out[i] = prefix[i];
        bytes16 digits = "0123456789abcdef";
        uint256 v = uint160(account);
        for (uint256 i = 46; i > 6; i--) {
            out[i] = digits[v & 0xf];
            v >>= 4;
        }
        return string(out);
    }

    /// The member's full name, e.g. member-70997970c51812dc3a010c7d01b50e0d17dc79c8.chennai-1.ordo-mfg.eth ("" for an unlinked site).
    function memberName(bytes32 site, address account) external view returns (string memory) {
        string memory sl = siteLabel[site];
        if (bytes(sl).length == 0) return "";
        return string.concat(memberLabel(account), ".", sl, ".", parentName);
    }

    /// The site's labels, for building names under it.
    function siteLabels(bytes32 site) public view returns (string[] memory) {
        string memory sl = siteLabel[site];
        if (bytes(sl).length == 0) return new string[](0);
        return OrdoEnsName.prepend(sl, parentLabels);
    }

    function _text(address resolver, string[] memory labels, string memory key) internal view returns (string memory) {
        bytes memory call = abi.encodeCall(ITextResolver.text, (OrdoEnsName.namehash(labels), key));
        try IExtendedResolver(resolver).resolve(OrdoEnsName.dns(labels), call) returns (bytes memory out) {
            if (out.length < 64) return "";
            return abi.decode(out, (string));
        } catch {
            return "";
        }
    }

    /// "admin,operator,plant_manager" → role bits ("device" for a gateway). Process and quality engineers hold no on-chain role.
    function _parseRoles(string memory list) internal pure returns (uint8 bits) {
        bytes memory b = bytes(list);
        uint256 start;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                bits |= _roleBit(_slice(b, start, i));
                start = i + 1;
            }
        }
    }

    function _roleBit(bytes memory name) internal pure returns (uint8) {
        bytes32 h = keccak256(name);
        if (h == keccak256("operator")) return OPERATOR;
        if (h == keccak256("supervisor") || h == keccak256("maintenance_lead")) return SUPERVISOR;
        if (h == keccak256("plant_manager")) return PLANT_MANAGER;
        if (h == keccak256("admin")) return ADMIN;
        if (h == keccak256("validator")) return VALIDATOR;
        if (h == keccak256("device")) return DEVICE;
        return 0;
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i = 0; i < out.length; i++) out[i] = b[from + i];
    }
}
