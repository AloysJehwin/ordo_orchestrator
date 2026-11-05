// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOrdoTrust, OrdoSigned} from "./OrdoSigned.sol";

/// @title OrdoPolicies
/// @notice Which autonomy policy each production line runs under, published only with a plant manager's signature.
///  A site's manager holds every right, so one plant manager publishes, raises or lowers a line's policy; more
///  signatures may be given, each from a different plant manager.
/// Plant managers are read from OrdoTrust credentials. Ordo's guard compares its policy hash with this record.
contract OrdoPolicies is OrdoSigned {
    uint8 private constant PLANT_MANAGER = 8;
    uint256 public constant REQUIRED = 1;

    struct Policy {
        uint8 level; // 1..4 = L1 Assist .. L4 Autonomous
        bytes32 policyHash; // sha256 of the canonical policy file
        uint32 version;
        uint64 updatedAt;
    }

    IOrdoTrust public immutable trust;
    mapping(bytes32 => mapping(bytes32 => Policy)) public policies; // site → keccak(lineId) → policy

    event Published(bytes32 indexed site, string lineId, uint8 level, bytes32 policyHash, uint32 version, address[] signers);

    error UnknownSite();
    error InvalidLevel(uint8 level);
    error VersionNotIncreasing(uint32 current, uint32 proposed);
    error NotEnoughSigners(uint256 have, uint256 need);
    error NotAuthorized(address signer);
    error DuplicateSigner(address signer);

    constructor(IOrdoTrust _trust) {
        trust = _trust;
    }

    function current(string calldata siteId, string calldata lineId) external view returns (Policy memory) {
        return policies[siteKey(siteId)][keccak256(bytes(lineId))];
    }

    struct Update {
        string lineId;
        uint8 level;
        bytes32 policyHash;
        uint32 version;
    }

    /// Each signature: action "policy.publish", entity "<lineId>#L<level>#<0xpolicyHash>#<version>",
    /// from a plant manager of the site, all different.
    function publish(string calldata siteId, Update calldata u, OrdoSig[] calldata sigs) external {
        bytes32 k = siteKey(siteId);
        (bool exists, ) = trust.sites(k);
        if (!exists) revert UnknownSite();
        if (u.level < 1 || u.level > 4) revert InvalidLevel(u.level);
        Policy storage p = policies[k][keccak256(bytes(u.lineId))];
        if (u.version <= p.version) revert VersionNotIncreasing(p.version, u.version);
        if (sigs.length < REQUIRED) revert NotEnoughSigners(sigs.length, REQUIRED);

        address[] memory signers = _plantManagers(k, siteId, _entity(u), sigs);
        policies[k][keccak256(bytes(u.lineId))] = Policy(u.level, u.policyHash, u.version, uint64(block.timestamp));
        emit Published(k, u.lineId, u.level, u.policyHash, u.version, signers);
    }

    function _entity(Update calldata u) private pure returns (string memory) {
        return string.concat(u.lineId, "#L", _dec(u.level), "#", _hex32(u.policyHash), "#", _dec(u.version));
    }

    /// Consume every signature; each must come from a different plant manager of the site.
    function _plantManagers(bytes32 k, string calldata siteId, string memory entity, OrdoSig[] calldata sigs) private returns (address[] memory signers) {
        signers = new address[](sigs.length);
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = _consume(sigs[i], "policy.publish", siteId, entity);
            if (trust.roles(k, s) & PLANT_MANAGER == 0) revert NotAuthorized(s);
            for (uint256 j = 0; j < i; j++) if (signers[j] == s) revert DuplicateSigner(s);
            signers[i] = s;
        }
    }
}
