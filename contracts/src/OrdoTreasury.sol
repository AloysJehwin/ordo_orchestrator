// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOrdoTrust} from "./OrdoSigned.sol";

/// Hedera's Schedule Service system contract (HIP-755).
interface IHederaScheduleService {
    /// Adds the calling contract's ContractId key to the schedule's signatures; the schedule executes once its keys are met.
    function authorizeSchedule(address schedule) external returns (int64 responseCode);
}

/// @title OrdoTreasury
/// @notice An org's treasury is a native Hedera account whose key is a contract: the org's own OrdoTreasuryKey, which
/// only this contract drives. No server holds a key that can move its HBAR; anyone can fund it.
/// HBAR leaves a treasury only through a scheduled transaction (HIP-423, with an on-ledger expiry) that Ordo creates
/// and the org's manager approves: a run's budget, or a machine's over-budget top-up. `approve` checks that an
/// OrdoTrust ADMIN of the org signed `budget.approve` for exactly that schedule (entity `<scheduleId>#<0xhash>`, the
/// hash of the recipients and amounts the manager was shown), burns the nonce, and has the org's key contract sign the
/// schedule through the Schedule Service (`authorizeSchedule`, HIP-755). The schedule executes at that consensus
/// instant, or lapses at its expiry. Each org's account answers only to its own key contract, so a manager of one org
/// cannot approve another org's spending.
/// Signatures use OrdoTrust's domain shape {name:"Ordo",version:"2",chainId,verifyingContract} with this contract's
/// address, so one made for this deployment cannot be replayed on another.
contract OrdoTreasury {
    address public constant HSS = address(0x16b);
    /// HederaResponseCodes.SUCCESS
    int64 public constant SUCCESS = 22;
    uint8 private constant ADMIN = 16;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant SIG_TYPEHASH =
        keccak256("OrdoSignature(string action,string entity,string meaning,string comment,string site,string nonce,string issuedAt)");

    struct OrdoSig {
        string action;
        string entity;
        string meaning;
        string comment;
        string site;
        string nonce;
        string issuedAt;
        bytes signature;
    }

    IOrdoTrust public immutable trust;
    /// site key (keccak256 of the site id) → its key contract: the key of the org's treasury account
    mapping(bytes32 => address) public keyOf;
    /// schedule → the site whose manager approved it
    mapping(address => bytes32) public approvedFor;
    mapping(bytes32 => bool) public usedNonces;

    event KeyOpened(bytes32 indexed site, string siteId, address key);
    event BudgetApproved(bytes32 indexed site, address indexed schedule, string entity, address manager);

    error UnknownSite();
    error NoKey();
    error NotAuthorized(address signer);
    error BadSchedule();
    error WrongAction();
    error WrongSite();
    error WrongEntity();
    error NonceUsed();
    error BadSignature();
    error ScheduleRefused(int64 responseCode);

    constructor(IOrdoTrust _trust) {
        trust = _trust;
    }

    function siteKey(string memory siteId) public pure returns (bytes32) {
        return keccak256(bytes(siteId));
    }

    /// The org's key contract, created once per registered site (anyone may call; the address is fixed by CREATE2).
    /// The org's treasury account is then created on Hedera with this contract's id as its key.
    function openSite(string calldata siteId) external returns (address key) {
        bytes32 k = siteKey(siteId);
        (bool exists, ) = trust.sites(k);
        if (!exists) revert UnknownSite();
        key = keyOf[k];
        if (key != address(0)) return key;
        key = address(new OrdoTreasuryKey{salt: k}());
        keyOf[k] = key;
        emit KeyOpened(k, siteId, key);
    }

    /// The Hedera id ("0.0.N") of a schedule given by its long-zero EVM address (shard 0, realm 0).
    function scheduleId(address schedule) public pure returns (string memory) {
        uint256 n = uint160(schedule);
        if (n == 0 || n >> 64 != 0) revert BadSchedule();
        return string.concat("0.0.", _dec(n));
    }

    /// A manager approves a schedule that pays out of the org's treasury: action "budget.approve", entity
    /// "<scheduleId>#<0x 32-byte hash of its recipients and amounts>". Anyone may relay it.
    function approve(string calldata siteId, address schedule, string calldata entity, OrdoSig calldata sig) external returns (int64 rc) {
        bytes32 k = siteKey(siteId);
        address key = keyOf[k];
        if (key == address(0)) revert NoKey();
        _checkEntity(schedule, entity);
        address manager = _consume(sig, "budget.approve", k, entity);
        if (trust.roles(k, manager) & ADMIN == 0) revert NotAuthorized(manager);
        rc = OrdoTreasuryKey(key).authorize(schedule);
        if (rc != SUCCESS) revert ScheduleRefused(rc);
        approvedFor[schedule] = k;
        emit BudgetApproved(k, schedule, entity, manager);
    }

    /// The entity names this schedule: "<scheduleId>#0x" followed by 64 hex digits.
    function _checkEntity(address schedule, string calldata entity) private pure {
        bytes memory prefix = bytes(string.concat(scheduleId(schedule), "#0x"));
        bytes calldata e = bytes(entity);
        if (e.length != prefix.length + 64) revert WrongEntity();
        for (uint256 i = 0; i < prefix.length; i++) if (e[i] != prefix[i]) revert WrongEntity();
    }

    // ------------------------------------------------------------------ signatures

    function digest(OrdoSig calldata s) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ordo"), keccak256("2"), block.chainid, address(this)));
        bytes32 structHash = keccak256(
            abi.encode(
                SIG_TYPEHASH,
                keccak256(bytes(s.action)),
                keccak256(bytes(s.entity)),
                keccak256(bytes(s.meaning)),
                keccak256(bytes(s.comment)),
                keccak256(bytes(s.site)),
                keccak256(bytes(s.nonce)),
                keccak256(bytes(s.issuedAt))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// Verify action, site and entity; burn the nonce; return the signer.
    function _consume(OrdoSig calldata s, string memory action, bytes32 k, string calldata entity) private returns (address) {
        if (keccak256(bytes(s.action)) != keccak256(bytes(action))) revert WrongAction();
        if (keccak256(bytes(s.site)) != k) revert WrongSite();
        if (keccak256(bytes(s.entity)) != keccak256(bytes(entity))) revert WrongEntity();
        bytes32 n = keccak256(bytes(s.nonce));
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return _recover(digest(s), s.signature);
    }

    /// secp256k1 recovery of a 65-byte signature, rejecting malleable s values.
    function _recover(bytes32 h, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 sv = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(sv) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(h, v, r, sv);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    function _dec(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory out = new bytes(len);
        while (v != 0) {
            out[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(out);
    }
}

/// @title OrdoTreasuryKey
/// @notice One org's treasury key. Its contract id is the key of the org's Hedera treasury account, and it signs a
/// schedule only when OrdoTreasury, having checked the org's manager signed for it, asks.
contract OrdoTreasuryKey {
    /// HederaResponseCodes.UNKNOWN, when the system contract cannot be called
    int64 private constant UNKNOWN = 21;
    address public immutable treasury;

    error NotTreasury();

    constructor() {
        treasury = msg.sender;
    }

    function authorize(address schedule) external returns (int64 rc) {
        if (msg.sender != treasury) revert NotTreasury();
        (bool ok, bytes memory res) = address(0x16b).call(abi.encodeWithSelector(IHederaScheduleService.authorizeSchedule.selector, schedule));
        rc = ok && res.length >= 32 ? abi.decode(res, (int64)) : UNKNOWN;
    }
}
