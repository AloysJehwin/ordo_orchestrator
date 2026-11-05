// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Stablecoin Studio's hold facet (IHoldManagement), as every Stablecoin Studio stablecoin proxy exposes it.
interface IStablecoinHolds {
    struct HoldIdentifier {
        address tokenHolder;
        uint256 holdId;
    }

    function getHoldFor(HoldIdentifier calldata id)
        external
        view
        returns (int64 amount, uint256 expirationTimestamp, address escrow, address to, bytes memory data, bytes memory operatorData);
    function executeHold(HoldIdentifier calldata id, address to, int64 amount) external returns (bool);
    function releaseHold(HoldIdentifier calldata id, int64 amount) external returns (bool);
    function reclaimHold(HoldIdentifier calldata id) external returns (bool);
}

/// The stablecoin's underlying HTS token, through its ERC-20 facade.
interface IERC20Transfer {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title OrdoPayOnProof
/// @notice Pay on proof: a customer pays for a lot only once its quality is proven, and the supplier can sell
/// the right to that payment before then.
///  - The customer locks the price in a Stablecoin Studio hold on its own balance, naming this contract as escrow
///    and committing in the hold's data to the terms: the site, the lot's validation package and who is paid.
///  - Anyone registers the hold here (`open`); this contract checks the hold matches the terms.
///  - The payment is released (`settle`, by anyone) only when OrdoTrust records the package's release: three
///    signatures (performed, reviewed, approved) by different people, the reviewer and approver staked validators.
///  - Until then the supplier holds a receivable it can sell for less (`offer`/`take`): a financier pays the asking
///    price at once, and is paid the full amount on proof. Supply-chain finance with no one to trust but the chain.
///  - The supplier can waive the payment (a rejected lot), and once the hold expires unreleased the customer has it
///    back (`refundExpired`, or Stablecoin Studio's own reclaimHold).
/// Amounts are in the stablecoin's smallest unit (int64, as HTS counts them).
contract OrdoPayOnProof {
    enum State {
        None,
        Open,
        Paid,
        Refunded
    }

    struct Order {
        address buyer;
        uint256 holdId;
        int64 amount;
        uint64 expiresAt;
        bytes32 site;
        bytes32 packageKey;
        address payee; // who is paid on proof: the supplier, or whoever bought the receivable
        int64 ask; // the payee's asking price for the receivable; 0 = not for sale
        State state;
    }

    IStablecoinHolds public immutable coin;
    IERC20Transfer public immutable token;
    /// OrdoTrust: `releases(site, packageKey)` returns a release whose last field is its time (0 = not released)
    address public immutable trust;

    mapping(bytes32 => Order) public orders;

    event Opened(bytes32 indexed key, address indexed buyer, uint256 holdId, string siteId, string packageId, address indexed payee, int64 amount, uint64 expiresAt);
    event Offered(bytes32 indexed key, address indexed payee, int64 ask);
    event Assigned(bytes32 indexed key, address indexed from, address indexed to, int64 price);
    event Paid(bytes32 indexed key, address indexed payee, int64 amount);
    event Refunded(bytes32 indexed key, address indexed buyer, int64 amount, bool waived);

    error AlreadyOpen();
    error NotOpen();
    error NotEscrow();
    error WrongTerms();
    error NotReleased();
    error NotPayee();
    error BadPrice();
    error NotExpired();
    error HoldFailed();

    constructor(address _coin, address _token, address _trust) {
        coin = IStablecoinHolds(_coin);
        token = IERC20Transfer(_token);
        trust = _trust;
    }

    function keyOf(address buyer, uint256 holdId) public pure returns (bytes32) {
        return keccak256(abi.encode(buyer, holdId));
    }

    /// What a hold's data must be: the hash of the terms it pays for.
    function terms(string calldata siteId, string calldata packageId, address payee) public pure returns (bytes32) {
        return keccak256(abi.encode("OrdoPayOnProof", siteId, packageId, payee));
    }

    /// Register a customer's hold as an order. The hold must name this contract as escrow, leave the destination
    /// open (the payee can change by sale) and carry `terms(...)` as its data.
    function open(address buyer, uint256 holdId, string calldata siteId, string calldata packageId, address payee) external returns (bytes32 key) {
        key = keyOf(buyer, holdId);
        if (orders[key].state != State.None) revert AlreadyOpen();
        if (payee == address(0)) revert WrongTerms();
        (int64 amount, uint64 exp) = _checkHold(buyer, holdId, terms(siteId, packageId, payee));
        orders[key] = Order(buyer, holdId, amount, exp, keccak256(bytes(siteId)), keccak256(bytes(packageId)), payee, 0, State.Open);
        emit Opened(key, buyer, holdId, siteId, packageId, payee, amount, exp);
    }

    function _checkHold(address buyer, uint256 holdId, bytes32 want) private view returns (int64 amount, uint64 exp) {
        (int64 a, uint256 e, address escrow, address to, bytes memory data,) = coin.getHoldFor(IStablecoinHolds.HoldIdentifier(buyer, holdId));
        if (escrow != address(this) || to != address(0) || a <= 0) revert NotEscrow();
        if (keccak256(data) != keccak256(abi.encodePacked(want))) revert WrongTerms();
        return (a, uint64(e));
    }

    /// When OrdoTrust recorded the order's package release (0 if it has not).
    function releasedAt(bytes32 key) public view returns (uint64) {
        Order storage o = orders[key];
        (bool ok, bytes memory r) = trust.staticcall(abi.encodeWithSignature("releases(bytes32,bytes32)", o.site, o.packageKey));
        // every OrdoTrust release ends with its uint64 time; earlier deployments have one field fewer
        if (!ok || r.length < 32) return 0;
        uint256 last;
        assembly {
            last := mload(add(r, mload(r)))
        }
        return uint64(last);
    }

    /// Pay the payee: anyone may call it once the release is on-chain.
    function settle(bytes32 key) external {
        Order storage o = orders[key];
        if (o.state != State.Open) revert NotOpen();
        if (releasedAt(key) == 0) revert NotReleased();
        o.state = State.Paid;
        o.ask = 0;
        if (!coin.executeHold(IStablecoinHolds.HoldIdentifier(o.buyer, o.holdId), o.payee, o.amount)) revert HoldFailed();
        emit Paid(key, o.payee, o.amount);
    }

    /// The payee gives the payment up (the lot was rejected): the customer's hold is released back to it.
    function waive(bytes32 key) external {
        Order storage o = orders[key];
        if (o.state != State.Open) revert NotOpen();
        if (msg.sender != o.payee) revert NotPayee();
        o.state = State.Refunded;
        o.ask = 0;
        if (!coin.releaseHold(IStablecoinHolds.HoldIdentifier(o.buyer, o.holdId), o.amount)) revert HoldFailed();
        emit Refunded(key, o.buyer, o.amount, true);
    }

    /// An order whose hold expired unreleased: the customer has its money back.
    function refundExpired(bytes32 key) external {
        Order storage o = orders[key];
        if (o.state != State.Open) revert NotOpen();
        if (block.timestamp <= o.expiresAt) revert NotExpired();
        o.state = State.Refunded;
        o.ask = 0;
        if (!coin.reclaimHold(IStablecoinHolds.HoldIdentifier(o.buyer, o.holdId))) revert HoldFailed();
        emit Refunded(key, o.buyer, o.amount, false);
    }

    // ------------------------------------------------------------------ the receivable

    /// The payee puts the receivable up for sale at `ask` (less than the amount: the financier's discount); 0 withdraws it.
    function offer(bytes32 key, int64 ask) external {
        Order storage o = orders[key];
        if (o.state != State.Open) revert NotOpen();
        if (msg.sender != o.payee) revert NotPayee();
        if (ask < 0 || ask >= o.amount) revert BadPrice();
        o.ask = ask;
        emit Offered(key, msg.sender, ask);
    }

    /// Buy the receivable at its asking price (which the caller names, so it cannot change under it): the price goes
    /// to the payee now, from the caller's stablecoin (approved to this contract), and the caller is paid on proof.
    function take(bytes32 key, int64 price) external {
        Order storage o = orders[key];
        if (o.state != State.Open) revert NotOpen();
        if (o.ask == 0 || price != o.ask) revert BadPrice();
        address seller = o.payee;
        o.payee = msg.sender;
        o.ask = 0;
        if (!token.transferFrom(msg.sender, seller, uint256(int256(price)))) revert HoldFailed();
        emit Assigned(key, seller, msg.sender, price);
    }
}
