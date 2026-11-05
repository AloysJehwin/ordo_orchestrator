// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOrdoTrust, OrdoSigned} from "./OrdoSigned.sol";

/// @title OrdoWorkOrders
/// @notice Lets a site's maintenance agent pay vendors, inside limits that people set and the chain enforces:
///  - only accounts holding the site's VENDOR credential in OrdoTrust can be paid;
///  - an agent spends only from its site's fund, within a per-order and a per-day cap a site admin signed;
///  - the agent escrows when it opens a work order; the vendor is paid only when a supervisor or plant
///    manager signs that the work is done; an unreleased escrow returns to the fund once it expires;
///  - an admin or plant manager can stop the agent at once, without blocking releases or refunds.
/// Amounts are in the native unit as the contract sees it (tinybars on Hedera).
contract OrdoWorkOrders is OrdoSigned, ReentrancyGuard {
    uint8 private constant SUPERVISOR = 2;
    uint8 private constant PLANT_MANAGER = 8;
    uint8 private constant ADMIN = 16;
    uint8 private constant VENDOR = 32;

    enum Status {
        None,
        Escrowed,
        Released,
        Refunded
    }

    struct Caps {
        uint256 perOrder;
        uint256 perDay;
    }

    struct WorkOrder {
        address agent;
        address vendor;
        uint256 amount;
        uint64 expiresAt;
        Status status;
        bytes32 incidentHash;
    }

    IOrdoTrust public immutable trust;

    mapping(bytes32 => uint256) public funds; // site → balance not held in escrow
    mapping(bytes32 => mapping(address => Caps)) public caps; // site → agent → caps
    mapping(bytes32 => mapping(address => mapping(uint256 => uint256))) public spentOnDay; // site → agent → day → committed
    mapping(bytes32 => bool) public paused; // site → agent spending stopped
    mapping(bytes32 => WorkOrder) public workOrders; // orderKey(site, workOrderId) → work order

    event Funded(bytes32 indexed site, address indexed from, uint256 amount, uint256 total);
    event AgentSet(bytes32 indexed site, address indexed agent, uint256 perOrder, uint256 perDay, address indexed by);
    event PausedSet(bytes32 indexed site, bool paused, address indexed by);
    event Escrowed(bytes32 indexed site, string workOrderId, address indexed agent, address indexed vendor, uint256 amount, uint64 expiresAt, bytes32 incidentHash);
    event Released(bytes32 indexed site, string workOrderId, address indexed vendor, uint256 amount, address indexed by);
    event Refunded(bytes32 indexed site, string workOrderId, uint256 amount);
    event Withdrawn(bytes32 indexed site, address indexed to, uint256 amount, address indexed by);

    error UnknownSite();
    error NotAuthorized(address signer);
    error NotAgent(address account);
    error NotVendor(address account);
    error AgentPaused();
    error ZeroAmount();
    error OverOrderCap(uint256 amount, uint256 cap);
    error OverDailyCap(uint256 wouldSpend, uint256 cap);
    error InsufficientFunds(uint256 amount, uint256 available);
    error WorkOrderExists();
    error NotEscrowed();
    error NotExpired(uint64 expiresAt);
    error TransferFailed();

    constructor(IOrdoTrust _trust) {
        trust = _trust;
    }

    function orderKey(string calldata siteId, string calldata workOrderId) public pure returns (bytes32) {
        return keccak256(abi.encode(siteKey(siteId), keccak256(bytes(workOrderId))));
    }

    function spentToday(string calldata siteId, address agent) external view returns (uint256) {
        return spentOnDay[siteKey(siteId)][agent][block.timestamp / 1 days];
    }

    // ------------------------------------------------------------------ people

    /// Anyone may add to a site's fund.
    function fund(string calldata siteId) external payable {
        bytes32 k = _site(siteId);
        if (msg.value == 0) revert ZeroAmount();
        funds[k] += msg.value;
        emit Funded(k, msg.sender, msg.value, funds[k]);
    }

    /// Set an agent's caps with a site admin's signature: action "agent.caps",
    /// entity "<0xagent>#<perOrder>#<perDay>". A perOrder of 0 removes the agent.
    function setAgent(string calldata siteId, address agent, uint256 perOrder, uint256 perDay, OrdoSig calldata sig) external {
        bytes32 k = _site(siteId);
        address admin = _consume(sig, "agent.caps", siteId, string.concat(_hex(agent), "#", _dec(perOrder), "#", _dec(perDay)));
        if (!_has(k, admin, ADMIN)) revert NotAuthorized(admin);
        caps[k][agent] = Caps(perOrder, perDay);
        emit AgentSet(k, agent, perOrder, perDay, admin);
    }

    /// Stop or resume agent spending with an admin's or plant manager's signature:
    /// action "agent.pause" or "agent.resume", entity = siteId.
    function setPaused(string calldata siteId, bool stop, OrdoSig calldata sig) external {
        bytes32 k = _site(siteId);
        address by = _consume(sig, stop ? "agent.pause" : "agent.resume", siteId, siteId);
        if (!_has(k, by, ADMIN | PLANT_MANAGER)) revert NotAuthorized(by);
        paused[k] = stop;
        emit PausedSet(k, stop, by);
    }

    /// Pay the vendor once the work is done: action "workorder.release",
    /// entity "<workOrderId>#<0xvendor>#<amount>", signed by a supervisor or plant manager who is not the vendor.
    function release(string calldata siteId, string calldata workOrderId, OrdoSig calldata sig) external nonReentrant {
        bytes32 k = _site(siteId);
        WorkOrder storage w = workOrders[orderKey(siteId, workOrderId)];
        if (w.status != Status.Escrowed) revert NotEscrowed();
        address by = _consume(sig, "workorder.release", siteId, string.concat(workOrderId, "#", _hex(w.vendor), "#", _dec(w.amount)));
        if (by == w.vendor || !_has(k, by, SUPERVISOR | PLANT_MANAGER)) revert NotAuthorized(by);
        w.status = Status.Released;
        emit Released(k, workOrderId, w.vendor, w.amount, by);
        _send(w.vendor, w.amount);
    }

    /// After expiry anyone may return an unreleased escrow to the site's fund.
    function refund(string calldata siteId, string calldata workOrderId) external {
        bytes32 k = _site(siteId);
        WorkOrder storage w = workOrders[orderKey(siteId, workOrderId)];
        if (w.status != Status.Escrowed) revert NotEscrowed();
        if (block.timestamp < w.expiresAt) revert NotExpired(w.expiresAt);
        w.status = Status.Refunded;
        funds[k] += w.amount;
        emit Refunded(k, workOrderId, w.amount);
    }

    /// Take money out of the fund with a site admin's signature: action "fund.withdraw", entity "<0xto>#<amount>".
    function withdraw(string calldata siteId, address to, uint256 amount, OrdoSig calldata sig) external nonReentrant {
        bytes32 k = _site(siteId);
        address admin = _consume(sig, "fund.withdraw", siteId, string.concat(_hex(to), "#", _dec(amount)));
        if (!_has(k, admin, ADMIN)) revert NotAuthorized(admin);
        if (amount > funds[k]) revert InsufficientFunds(amount, funds[k]);
        funds[k] -= amount;
        emit Withdrawn(k, to, amount, admin);
        _send(to, amount);
    }

    // ------------------------------------------------------------------ agent

    /// Hold money for a work order. The caller is the agent; the vendor must hold the site's VENDOR credential.
    function escrow(string calldata siteId, string calldata workOrderId, address vendor, uint256 amount, uint64 ttl, bytes32 incidentHash)
        external
        nonReentrant
    {
        bytes32 k = _site(siteId);
        if (paused[k]) revert AgentPaused();
        Caps memory c = caps[k][msg.sender];
        if (c.perOrder == 0) revert NotAgent(msg.sender);
        if (!_has(k, vendor, VENDOR)) revert NotVendor(vendor);
        if (amount == 0) revert ZeroAmount();
        if (amount > c.perOrder) revert OverOrderCap(amount, c.perOrder);
        uint256 day = block.timestamp / 1 days;
        uint256 wouldSpend = spentOnDay[k][msg.sender][day] + amount;
        if (wouldSpend > c.perDay) revert OverDailyCap(wouldSpend, c.perDay);
        if (amount > funds[k]) revert InsufficientFunds(amount, funds[k]);
        bytes32 id = orderKey(siteId, workOrderId);
        if (workOrders[id].status != Status.None) revert WorkOrderExists();
        spentOnDay[k][msg.sender][day] = wouldSpend;
        funds[k] -= amount;
        uint64 expiresAt = uint64(block.timestamp) + ttl;
        workOrders[id] = WorkOrder(msg.sender, vendor, amount, expiresAt, Status.Escrowed, incidentHash);
        emit Escrowed(k, workOrderId, msg.sender, vendor, amount, expiresAt, incidentHash);
    }

    // ------------------------------------------------------------------ internal

    function _site(string calldata siteId) private view returns (bytes32 k) {
        k = siteKey(siteId);
        (bool exists, ) = trust.sites(k);
        if (!exists) revert UnknownSite();
    }

    function _has(bytes32 k, address account, uint8 anyOf) private view returns (bool) {
        return trust.roles(k, account) & anyOf != 0;
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
