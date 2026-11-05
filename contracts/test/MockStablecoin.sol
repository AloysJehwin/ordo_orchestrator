// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A stand-in for a Stablecoin Studio stablecoin in tests: cash-in, ERC-20 transfers and its hold facet, with the
/// same rules as HoldManagementFacet (the escrow executes or releases; anyone reclaims an expired hold).
contract MockStablecoin {
    struct HoldIdentifier {
        address tokenHolder;
        uint256 holdId;
    }
    struct Hold {
        int64 amount;
        uint256 expirationTimestamp;
        address escrow;
        address to;
        bytes data;
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(uint256 => Hold)) private holds;
    mapping(address => uint256) public holdCount;

    event HoldCreated(address indexed operator, address indexed tokenHolder, uint256 holdId, Hold hold, bytes operatorData);

    error UnauthorizedEscrow(address caller, address escrow);
    error HoldExpired(uint256 expirationTime);
    error HoldNotExpired(uint256 expirationTime);
    error HoldNotFound(address tokenHolder, uint256 holdId);
    error InvalidDestination(address expected, address provided);

    function mint(address account, int64 amount) external returns (bool) {
        balanceOf[account] += uint256(int256(amount));
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function createHold(Hold calldata h) external returns (bool, uint256) {
        balanceOf[msg.sender] -= uint256(int256(h.amount));
        uint256 id = ++holdCount[msg.sender];
        holds[msg.sender][id] = h;
        emit HoldCreated(msg.sender, msg.sender, id, h, "");
        return (true, id);
    }

    function getHoldFor(HoldIdentifier calldata i) external view returns (int64, uint256, address, address, bytes memory, bytes memory) {
        Hold storage h = holds[i.tokenHolder][i.holdId];
        if (h.amount == 0) revert HoldNotFound(i.tokenHolder, i.holdId);
        return (h.amount, h.expirationTimestamp, h.escrow, h.to, h.data, "");
    }

    function executeHold(HoldIdentifier calldata i, address to, int64 amount) external returns (bool) {
        Hold storage h = _escrowed(i);
        if (block.timestamp > h.expirationTimestamp) revert HoldExpired(h.expirationTimestamp);
        if (h.to != address(0) && h.to != to) revert InvalidDestination(h.to, to);
        h.amount -= amount;
        balanceOf[to] += uint256(int256(amount));
        return true;
    }

    function releaseHold(HoldIdentifier calldata i, int64 amount) external returns (bool) {
        Hold storage h = _escrowed(i);
        h.amount -= amount;
        balanceOf[i.tokenHolder] += uint256(int256(amount));
        return true;
    }

    function reclaimHold(HoldIdentifier calldata i) external returns (bool) {
        Hold storage h = holds[i.tokenHolder][i.holdId];
        if (h.amount == 0) revert HoldNotFound(i.tokenHolder, i.holdId);
        if (block.timestamp <= h.expirationTimestamp) revert HoldNotExpired(h.expirationTimestamp);
        balanceOf[i.tokenHolder] += uint256(int256(h.amount));
        h.amount = 0;
        return true;
    }

    function _escrowed(HoldIdentifier calldata i) private view returns (Hold storage h) {
        h = holds[i.tokenHolder][i.holdId];
        if (h.amount == 0) revert HoldNotFound(i.tokenHolder, i.holdId);
        if (msg.sender != h.escrow) revert UnauthorizedEscrow(msg.sender, h.escrow);
    }
}

/// OrdoTrust's release record, settable in tests.
contract MockReleases {
    struct Release {
        bytes32 contentHash;
        bytes32 proofRoot;
        address performedBy;
        address reviewedBy;
        address approvedBy;
        uint64 releasedAt;
    }

    mapping(bytes32 => mapping(bytes32 => Release)) public releases;

    function release(string calldata siteId, string calldata packageId) external {
        releases[keccak256(bytes(siteId))][keccak256(bytes(packageId))] = Release(bytes32(uint256(1)), bytes32(uint256(2)), msg.sender, msg.sender, msg.sender, uint64(block.timestamp));
    }
}

/// The release record of OrdoTrust as first deployed: five fields, no proof root.
contract MockOldReleases {
    struct Release {
        bytes32 contentHash;
        address performedBy;
        address reviewedBy;
        address approvedBy;
        uint64 releasedAt;
    }

    mapping(bytes32 => mapping(bytes32 => Release)) public releases;

    function release(string calldata siteId, string calldata packageId) external {
        releases[keccak256(bytes(siteId))][keccak256(bytes(packageId))] = Release(bytes32(uint256(1)), msg.sender, msg.sender, msg.sender, uint64(block.timestamp));
    }
}
