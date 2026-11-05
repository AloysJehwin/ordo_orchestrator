// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OrdoProofs} from "./OrdoProofs.sol";

/// @title OrdoTrust
/// @notice Who may decide what at an Ordo site, enforced on-chain. A site has four roles:
///  - manager: every right (ADMIN | PLANT_MANAGER | SUPERVISOR | VALIDATOR); the site's registering admin is one;
///  - validator: stakes, and selects the valid contribution for a stage (`recordAcceptance`);
///  - tester: stakes, and opens slashing cases against validators (`openCase`);
///  - contributor: submits proof of work; holds no credential and is paid from the site's reward pool.
/// Roles are non-transferable credentials per site, granted only with a site admin's signature. A case is decided by a
/// manager who is neither party: upheld, part of the validator's stake goes to the tester (bounty) and the rest to the
/// site's quality fund; rejected, part of the tester's stake goes to the validator. A selected contribution's reward
/// vests after a challenge window, during which a case naming it freezes it.
/// Every authorisation is an Ordo EIP-712 signature (`OrdoSignature`, domain {name:"Ordo",version:"2",chainId,
/// verifyingContract}) — the same typed data the Ordo console asks people to sign — so anyone may relay it; the
/// contract checks who signed, not who sent the transaction. The domain names this deployment, so a signature made
/// for it cannot be replayed on a redeployed contract (where its nonce would be fresh). Releases are `OrdoRelease`
/// statements (OrdoProofs) that cover exactly what is released.
contract OrdoTrust is ReentrancyGuard {
    uint8 public constant OPERATOR = 1;
    uint8 public constant SUPERVISOR = 2;
    uint8 public constant VALIDATOR = 4;
    uint8 public constant PLANT_MANAGER = 8;
    uint8 public constant ADMIN = 16;
    uint8 public constant VENDOR = 32;
    /// a machine's gateway: it signs stage readings (OrdoProofs.OrdoReading)
    uint8 public constant DEVICE = 64;
    /// stakes and opens cases against validators
    uint8 public constant TESTER = 128;
    /// every right at a site: granted and revoked in one signed call (role name "MANAGER")
    uint8 public constant MANAGER = ADMIN | PLANT_MANAGER | SUPERVISOR | VALIDATOR;

    uint8 private constant OPEN = 1;
    uint8 private constant RESPONDED = 2;
    uint8 private constant UPHELD = 3;
    uint8 private constant REJECTED = 4;

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

    struct Site {
        bool exists;
        address treasury; // the quality fund that receives slashed stake
    }
    struct Stake {
        uint256 amount;
        uint64 unlockAt; // 0 = staked and active; otherwise withdrawable from this time
    }
    struct Release {
        bytes32 contentHash;
        bytes32 proofRoot;
        address performedBy;
        address reviewedBy;
        address approvedBy;
        uint64 releasedAt;
    }
    /// Per-site economics. Amounts are in the chain's native unit as the contract sees it (tinybars on Hedera).
    struct Settings {
        uint256 reward; // paid to the contributor of a selected contribution
        uint256 fee; // paid to the validator who selected it
        uint64 challengeWindow; // seconds an acceptance can be challenged before it vests
        uint64 responseWindow; // seconds the accused validator has to respond to a case
        uint16 defaultSlashBps; // what Ordo proposes when a tester opens a case
        uint16 maxSlashBps; // the most a case may slash
        uint16 bountyBps; // the tester's share of an upheld slash; the rest goes to the quality fund
        uint16 falseClaimBps; // the share of the tester's stake paid to the validator when a case is rejected
    }
    struct Case {
        address tester;
        address validator;
        uint16 bps;
        bytes32 evidenceHash;
        bytes32 responseHash;
        uint64 openedAt;
        uint64 respondBy;
        uint8 status; // 0 none, 1 open, 2 responded, 3 upheld, 4 rejected
        uint256 amount; // moved by the decision: slashed (upheld) or the tester's penalty (rejected)
        bytes32 acceptance; // key of the acceptance the case froze, 0 if none
    }
    struct Acceptance {
        address contributor;
        address validator;
        uint256 reward;
        uint256 fee;
        uint64 vestAt;
        bool frozen;
        bool settled;
    }

    uint256 public immutable minStake;
    uint64 public immutable unstakeCooldown;
    /// Ordo's relayer: only it may register a site, so nobody can claim a site id first (ids are public in HCS anchors)
    address public immutable registrar;

    mapping(bytes32 => Site) public sites;
    mapping(bytes32 => mapping(address => uint8)) public roles;
    mapping(bytes32 => mapping(address => Stake)) public stakes;
    mapping(bytes32 => mapping(bytes32 => Release)) public releases; // site → package key → release
    mapping(bytes32 => bool) public usedNonces;
    mapping(bytes32 => uint256) public adminCount;
    mapping(bytes32 => Settings) private _settings;
    /// site → keccak(caseId) → case
    mapping(bytes32 => mapping(bytes32 => Case)) public cases;
    /// cases an account is the tester or validator of and that are not decided; its stake cannot leave meanwhile
    mapping(bytes32 => mapping(address => uint256)) public openCases;
    mapping(bytes32 => uint256) public rewardPool;
    /// site → keccak(contributionId) → acceptance
    mapping(bytes32 => mapping(bytes32 => Acceptance)) public acceptances;
    mapping(bytes32 => mapping(address => uint256)) public claimable;

    event SiteRegistered(bytes32 indexed site, string siteId, address indexed admin, address treasury);
    event RoleGranted(bytes32 indexed site, address indexed account, uint8 role, address indexed by);
    event RoleRevoked(bytes32 indexed site, address indexed account, uint8 role, address indexed by);
    event Staked(bytes32 indexed site, address indexed validator, uint256 amount, uint256 total);
    event UnstakeRequested(bytes32 indexed site, address indexed validator, uint64 unlockAt);
    event Withdrawn(bytes32 indexed site, address indexed validator, uint256 amount);
    event Released(bytes32 indexed site, string packageId, string runId, string lot, bytes32 contentHash, bytes32 proofRoot, address performedBy, address reviewedBy, address approvedBy);
    event SettingsChanged(bytes32 indexed site, Settings settings, address indexed by);
    event CaseOpened(bytes32 indexed site, string caseId, address indexed tester, address indexed validator, uint16 bps, bytes32 evidenceHash, string acceptanceId, uint64 respondBy);
    event CaseResponded(bytes32 indexed site, string caseId, address indexed validator, bytes32 responseHash);
    /// upheld: `amount` slashed from the validator, `bounty` of it to the tester, the rest to `treasury`.
    /// rejected: `amount` taken from the tester's stake for the validator; `bounty` is 0.
    event CaseDecided(bytes32 indexed site, string caseId, bool upheld, address indexed by, uint256 amount, uint256 bounty, address treasury);
    event RewardsFunded(bytes32 indexed site, address indexed from, uint256 amount, uint256 pool);
    event AcceptanceRecorded(bytes32 indexed site, string contributionId, address indexed contributor, address indexed validator, uint256 reward, uint256 fee, uint64 vestAt);
    event AcceptanceSettled(bytes32 indexed site, string contributionId, address indexed contributor, address indexed validator, uint256 reward, uint256 fee);
    event Claimed(bytes32 indexed site, address indexed account, uint256 amount);

    error UnknownSite();
    error SiteExists();
    error WrongAction();
    error WrongSite();
    error WrongEntity();
    error NonceUsed();
    error NotAuthorized(address signer);
    error BadRole();
    error NotValidator();
    error Unstaking();
    error StillLocked(uint64 unlockAt);
    error NothingStaked();
    error DuplicateSigner(address signer);
    error TransferFailed();
    error BadSignature();
    error NotRegistrar();
    error AlreadyReleased();
    error LastAdmin();
    error BadSettings();
    error BadBps();
    error EmptyId();
    error CaseExists();
    error CaseNotOpen();
    error TooLate(uint64 respondBy);
    error TooEarly(uint64 respondBy);
    error CaseOpen();
    error UnknownAcceptance();
    error AcceptanceExists();
    error AcceptanceFrozen();
    error AlreadySettled();
    error ChallengeClosed();
    error NotVested(uint64 vestAt);
    error PoolTooLow();
    error NothingToClaim();

    constructor(uint256 _minStake, uint64 _unstakeCooldown, address _registrar) {
        minStake = _minStake;
        unstakeCooldown = _unstakeCooldown;
        registrar = _registrar;
    }

    // ------------------------------------------------------------------ signatures

    function siteKey(string memory siteId) public pure returns (bytes32) {
        return keccak256(bytes(siteId));
    }

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
    function _consume(OrdoSig calldata s, string memory action, string memory siteId, string memory entity) internal returns (address) {
        return _consumeAt(s, action, siteKey(siteId), entity);
    }

    /// `_consume` for a site given by its key (keccak256 of the site id).
    function _consumeAt(OrdoSig calldata s, string memory action, bytes32 k, string memory entity) internal returns (address) {
        if (keccak256(bytes(s.action)) != keccak256(bytes(action))) revert WrongAction();
        if (keccak256(bytes(s.site)) != k) revert WrongSite();
        if (keccak256(bytes(s.entity)) != keccak256(bytes(entity))) revert WrongEntity();
        bytes32 n = keccak256(bytes(s.nonce));
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return _recover(digest(s), s.signature);
    }

    function roleName(uint8 role) public pure returns (string memory) {
        if (role == OPERATOR) return "OPERATOR";
        if (role == SUPERVISOR) return "SUPERVISOR";
        if (role == VALIDATOR) return "VALIDATOR";
        if (role == PLANT_MANAGER) return "PLANT_MANAGER";
        if (role == ADMIN) return "ADMIN";
        if (role == VENDOR) return "VENDOR";
        if (role == DEVICE) return "DEVICE";
        if (role == TESTER) return "TESTER";
        if (role == MANAGER) return "MANAGER";
        revert BadRole();
    }

    function _roleEntity(address account, uint8 role) internal pure returns (string memory) {
        return string.concat(_hex(account), "#", roleName(role));
    }

    /// The key of a registered site; reverts for an unknown one.
    function _site(string calldata siteId) internal view returns (bytes32 k) {
        k = siteKey(siteId);
        if (!sites[k].exists) revert UnknownSite();
    }

    // ------------------------------------------------------------------ sites and roles

    /// The site's first admin registers it with signature action "site.register", entity "<siteId>#<0xtreasury>", and
    /// Ordo's registrar sends it, so only the site Ordo knows can be registered, by the admin Ordo knows.
    /// The admin becomes the site's manager (ADMIN, PLANT_MANAGER, SUPERVISOR, VALIDATOR); `treasury` is the site's
    /// quality fund (0 = the admin). The site starts with the default settings.
    function registerSite(string calldata siteId, address treasury, OrdoSig calldata sig) external {
        if (msg.sender != registrar) revert NotRegistrar();
        bytes32 k = siteKey(siteId);
        if (sites[k].exists) revert SiteExists();
        address admin = _consume(sig, "site.register", siteId, string.concat(siteId, "#", _hex(treasury)));
        sites[k] = Site(true, treasury == address(0) ? admin : treasury);
        roles[k][admin] = MANAGER;
        adminCount[k] = 1;
        _settings[k] = Settings(1e8, 2e7, 3 days, 48 hours, 3000, 5000, 5000, 1000);
        emit SiteRegistered(k, siteId, admin, sites[k].treasury);
        emit RoleGranted(k, admin, ADMIN, admin);
        emit RoleGranted(k, admin, PLANT_MANAGER, admin);
        emit RoleGranted(k, admin, SUPERVISOR, admin);
        emit RoleGranted(k, admin, VALIDATOR, admin);
    }

    /// Grant one role (or MANAGER, all four manager bits) with a site admin's signature: action "role.grant",
    /// entity "<0xaccount>#<ROLE>".
    function grantRole(string calldata siteId, address account, uint8 role, OrdoSig calldata sig) external {
        bytes32 k = _site(siteId);
        address admin = _consume(sig, "role.grant", siteId, _roleEntity(account, role));
        if (roles[k][admin] & ADMIN == 0) revert NotAuthorized(admin);
        uint8 had = roles[k][account];
        if (role & ADMIN != 0 && had & ADMIN == 0) adminCount[k]++;
        roles[k][account] = had | role;
        emit RoleGranted(k, account, role, admin);
    }

    /// Revoke one role (or MANAGER) with a site admin's signature: action "role.revoke". A site keeps at least one admin.
    function revokeRole(string calldata siteId, address account, uint8 role, OrdoSig calldata sig) external {
        bytes32 k = _site(siteId);
        address admin = _consume(sig, "role.revoke", siteId, _roleEntity(account, role));
        if (roles[k][admin] & ADMIN == 0) revert NotAuthorized(admin);
        uint8 had = roles[k][account];
        if (role & ADMIN != 0 && had & ADMIN != 0) {
            if (adminCount[k] == 1) revert LastAdmin();
            adminCount[k]--;
        }
        roles[k][account] = had & ~role;
        emit RoleRevoked(k, account, role, admin);
    }

    function hasRole(string calldata siteId, address account, uint8 role) external view returns (bool) {
        return roles[siteKey(siteId)][account] & role != 0;
    }

    // ------------------------------------------------------------------ settings

    function settings(string calldata siteId) external view returns (Settings memory) {
        return _settings[siteKey(siteId)];
    }

    /// Change a site's settings with an admin's signature: action "site.settings",
    /// entity "r<reward>#f<fee>#c<challengeWindow>#w<responseWindow>#d<defaultSlashBps>#m<maxSlashBps>#b<bountyBps>#x<falseClaimBps>".
    /// They apply to acceptances and cases made afterwards.
    function setSettings(string calldata siteId, Settings calldata s, OrdoSig calldata sig) external {
        bytes32 k = _site(siteId);
        string memory entity = string.concat("r", _dec(s.reward), "#f", _dec(s.fee), "#c", _dec(s.challengeWindow), "#w", _dec(s.responseWindow));
        entity = string.concat(entity, "#d", _dec(s.defaultSlashBps), "#m", _dec(s.maxSlashBps), "#b", _dec(s.bountyBps), "#x", _dec(s.falseClaimBps));
        address admin = _consume(sig, "site.settings", siteId, entity);
        if (roles[k][admin] & ADMIN == 0) revert NotAuthorized(admin);
        if (s.maxSlashBps > 10000 || s.bountyBps > 10000 || s.falseClaimBps > 10000 || s.defaultSlashBps > s.maxSlashBps) revert BadSettings();
        _settings[k] = s;
        emit SettingsChanged(k, s, admin);
    }

    // ------------------------------------------------------------------ staking

    function isActiveValidator(string calldata siteId, address account) public view returns (bool) {
        return _active(siteKey(siteId), account);
    }

    function isActiveTester(string calldata siteId, address account) public view returns (bool) {
        return _staked(siteKey(siteId), account, TESTER);
    }

    function _active(bytes32 k, address account) internal view returns (bool) {
        return _staked(k, account, VALIDATOR);
    }

    function _staked(bytes32 k, address account, uint8 role) internal view returns (bool) {
        Stake storage s = stakes[k][account];
        return roles[k][account] & role != 0 && s.unlockAt == 0 && s.amount >= minStake;
    }

    /// A credentialed validator or tester adds stake. Staking again cancels a pending unstake.
    function stake(string calldata siteId) external payable {
        bytes32 k = _site(siteId);
        if (roles[k][msg.sender] & (VALIDATOR | TESTER) == 0) revert NotValidator();
        Stake storage s = stakes[k][msg.sender];
        s.amount += msg.value;
        s.unlockAt = 0;
        emit Staked(k, msg.sender, msg.value, s.amount);
    }

    /// Stop staking: the account is inactive at once and can withdraw after the cooldown,
    /// so a case raised meanwhile can still slash.
    function requestUnstake(string calldata siteId) external {
        bytes32 k = siteKey(siteId);
        Stake storage s = stakes[k][msg.sender];
        if (s.amount == 0) revert NothingStaked();
        s.unlockAt = uint64(block.timestamp) + unstakeCooldown;
        emit UnstakeRequested(k, msg.sender, s.unlockAt);
    }

    function withdraw(string calldata siteId) external nonReentrant {
        _withdraw(siteKey(siteId), msg.sender);
    }

    /// After the cooldown anyone may pay a stake back to its owner. Ordo schedules this call
    /// on Hedera's Schedule Service when the unstake is requested, so the stake comes back without anyone acting.
    function withdrawFor(string calldata siteId, address validator) external nonReentrant {
        _withdraw(siteKey(siteId), validator);
    }

    /// No stake leaves while its owner is the tester or validator of an undecided case.
    function _withdraw(bytes32 k, address validator) private {
        Stake storage s = stakes[k][validator];
        if (s.amount == 0) revert NothingStaked();
        if (openCases[k][validator] != 0) revert CaseOpen();
        if (s.unlockAt == 0 || block.timestamp < s.unlockAt) revert StillLocked(s.unlockAt);
        uint256 amount = s.amount;
        s.amount = 0;
        s.unlockAt = 0;
        emit Withdrawn(k, validator, amount);
        _pay(validator, amount);
    }

    // ------------------------------------------------------------------ releases

    /// Record a released validation package. sigs = [performed, reviewed, approved], each an `OrdoRelease` that names
    /// this site, package, run and lot, this content hash and proof root, and its own meaning. Three different people:
    /// the reviewer and approver are active validators and the approver a plant manager (Ordo checks the performer is
    /// the package owner: process engineers hold no OrdoTrust role). A package is released once; it is never overwritten.
    function recordRelease(OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ReleaseSig[3] calldata sigs) external {
        bytes32 k = _site(lot.siteId);
        bytes32 pk = keccak256(bytes(lot.packageId));
        if (releases[k][pk].releasedAt != 0) revert AlreadyReleased();
        address[3] memory who;
        who[0] = _consumeRelease(sigs[0], lot, "performed");
        who[1] = _consumeRelease(sigs[1], lot, "reviewed");
        who[2] = _consumeRelease(sigs[2], lot, "approved");
        if (who[0] == who[1] || who[0] == who[2]) revert DuplicateSigner(who[0]);
        if (who[1] == who[2]) revert DuplicateSigner(who[1]);
        if (!_active(k, who[1])) revert NotAuthorized(who[1]);
        if (!_active(k, who[2]) || roles[k][who[2]] & PLANT_MANAGER == 0) revert NotAuthorized(who[2]);
        releases[k][pk] = Release(lot.contentHash, lot.proofRoot, who[0], who[1], who[2], uint64(block.timestamp));
        emit Released(k, lot.packageId, lot.runId, lot.lotLabel, lot.contentHash, lot.proofRoot, who[0], who[1], who[2]);
    }

    function _consumeRelease(OrdoProofs.ReleaseSig calldata s, OrdoProofs.ReleaseLot calldata lot, string memory meaning) internal returns (address) {
        bytes32 n = OrdoProofs.releaseNonce(s);
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return OrdoProofs.releaseSigner(s, lot, meaning);
    }

    // ------------------------------------------------------------------ rewards

    /// Anyone adds to the site's reward pool, from which selected contributions are paid.
    function fundRewards(string calldata siteId) external payable {
        bytes32 k = _site(siteId);
        rewardPool[k] += msg.value;
        emit RewardsFunded(k, msg.sender, msg.value, rewardPool[k]);
    }

    /// An active validator selects the valid contribution for a stage: action "contribution.select",
    /// entity "<contributionId>#<0xcontributor>". The reward and the validator's fee are reserved from the pool and
    /// vest after the site's challenge window.
    function recordAcceptance(string calldata siteId, string calldata contributionId, address contributor, OrdoSig calldata sig) external {
        bytes32 k = _site(siteId);
        if (bytes(contributionId).length == 0 || contributor == address(0)) revert EmptyId();
        Acceptance storage a = acceptances[k][keccak256(bytes(contributionId))];
        if (a.contributor != address(0)) revert AcceptanceExists();
        address v = _consume(sig, "contribution.select", siteId, string.concat(contributionId, "#", _hex(contributor)));
        if (v == contributor || !_active(k, v)) revert NotAuthorized(v);
        Settings storage cfg = _settings[k];
        (uint256 reward, uint256 fee) = (cfg.reward, cfg.fee);
        if (rewardPool[k] < reward + fee) revert PoolTooLow();
        rewardPool[k] -= reward + fee;
        uint64 vestAt = uint64(block.timestamp) + cfg.challengeWindow;
        acceptances[k][keccak256(bytes(contributionId))] = Acceptance(contributor, v, reward, fee, vestAt, false, false);
        emit AcceptanceRecorded(k, contributionId, contributor, v, reward, fee, vestAt);
    }

    /// After the challenge window, anyone credits an unfrozen acceptance: the reward to the contributor, the fee to the
    /// validator.
    function settle(string calldata siteId, string calldata contributionId) external {
        bytes32 k = siteKey(siteId);
        Acceptance storage a = acceptances[k][keccak256(bytes(contributionId))];
        if (a.contributor == address(0)) revert UnknownAcceptance();
        if (a.settled) revert AlreadySettled();
        if (a.frozen) revert AcceptanceFrozen();
        if (block.timestamp < a.vestAt) revert NotVested(a.vestAt);
        a.settled = true;
        claimable[k][a.contributor] += a.reward;
        claimable[k][a.validator] += a.fee;
        emit AcceptanceSettled(k, contributionId, a.contributor, a.validator, a.reward, a.fee);
    }

    /// Pay the caller's claimable balance at the site (rewards, fees, bounties, penalties).
    function claim(string calldata siteId) external nonReentrant {
        _claim(siteKey(siteId), msg.sender);
    }

    /// Anyone may pay an account's claimable balance to that account, so Ordo's relayer can pay for the gas.
    function claimFor(string calldata siteId, address account) external nonReentrant {
        _claim(siteKey(siteId), account);
    }

    function _claim(bytes32 k, address account) private {
        uint256 amount = claimable[k][account];
        if (amount == 0) revert NothingToClaim();
        claimable[k][account] = 0;
        emit Claimed(k, account, amount);
        _pay(account, amount);
    }

    // ------------------------------------------------------------------ cases

    /// An active tester accuses a validator: action "case.open", entity "<0xvalidator>#<bps>#<caseId>#<0xevidenceHash>".
    /// `acceptanceId`, if not empty, names one of the validator's acceptances still in its challenge window: it is frozen
    /// until the case is decided. The validator may respond until `respondBy`.
    function openCase(
        string calldata siteId,
        string calldata caseId,
        address validator,
        uint16 bps,
        bytes32 evidenceHash,
        string calldata acceptanceId,
        OrdoSig calldata sig
    ) external {
        bytes32 k = _site(siteId);
        Case storage c = _open(k, caseId, validator, bps, evidenceHash, sig);
        if (bytes(acceptanceId).length != 0) c.acceptance = _freeze(k, acceptanceId, validator);
        emit CaseOpened(k, caseId, c.tester, validator, bps, evidenceHash, acceptanceId, c.respondBy);
    }

    function _open(bytes32 k, string calldata caseId, address validator, uint16 bps, bytes32 evidenceHash, OrdoSig calldata sig) private returns (Case storage c) {
        if (bytes(caseId).length == 0) revert EmptyId();
        c = cases[k][keccak256(bytes(caseId))];
        if (c.status != 0) revert CaseExists();
        address tester = _consumeAt(sig, "case.open", k, string.concat(_hex(validator), "#", _dec(bps), "#", caseId, "#", _hex32(evidenceHash)));
        if (tester == validator || !_staked(k, tester, TESTER)) revert NotAuthorized(tester);
        if (roles[k][validator] & VALIDATOR == 0) revert NotValidator();
        if (bps == 0 || bps > _settings[k].maxSlashBps) revert BadBps();
        c.tester = tester;
        c.validator = validator;
        c.bps = bps;
        c.evidenceHash = evidenceHash;
        c.openedAt = uint64(block.timestamp);
        c.respondBy = uint64(block.timestamp) + _settings[k].responseWindow;
        c.status = OPEN;
        openCases[k][tester]++;
        openCases[k][validator]++;
    }

    function _freeze(bytes32 k, string calldata acceptanceId, address validator) private returns (bytes32 ak) {
        ak = keccak256(bytes(acceptanceId));
        Acceptance storage a = acceptances[k][ak];
        if (a.validator != validator) revert UnknownAcceptance();
        if (a.settled) revert AlreadySettled();
        if (a.frozen) revert AcceptanceFrozen();
        if (block.timestamp >= a.vestAt) revert ChallengeClosed();
        a.frozen = true;
    }

    /// The accused validator answers: action "case.respond", entity "<caseId>#<0xresponseHash>", before `respondBy`.
    function respond(string calldata siteId, string calldata caseId, bytes32 responseHash, OrdoSig calldata sig) external {
        bytes32 k = siteKey(siteId);
        Case storage c = cases[k][keccak256(bytes(caseId))];
        if (c.status != OPEN) revert CaseNotOpen();
        if (block.timestamp >= c.respondBy) revert TooLate(c.respondBy);
        address v = _consume(sig, "case.respond", siteId, string.concat(caseId, "#", _hex32(responseHash)));
        if (v != c.validator) revert NotAuthorized(v);
        c.responseHash = responseHash;
        c.status = RESPONDED;
        emit CaseResponded(k, caseId, v, responseHash);
    }

    /// A plant manager who is neither party decides, once the validator responded or the response window closed:
    /// action "case.decide", entity "<caseId>#uphold" or "<caseId>#reject".
    ///  - uphold: bps of the validator's stake is slashed; bountyBps of it is credited to the tester, the rest goes to
    ///    the site's quality fund. A frozen acceptance loses its validator fee (back to the pool) and unfreezes.
    ///  - reject: falseClaimBps of the tester's stake is credited to the validator; a frozen acceptance unfreezes.
    function decideCase(string calldata siteId, string calldata caseId, bool uphold, OrdoSig calldata sig) external nonReentrant {
        bytes32 k = siteKey(siteId);
        Case storage c = cases[k][keccak256(bytes(caseId))];
        if (c.status != OPEN && c.status != RESPONDED) revert CaseNotOpen();
        if (c.status == OPEN && block.timestamp < c.respondBy) revert TooEarly(c.respondBy);
        address m = _consume(sig, "case.decide", siteId, string.concat(caseId, uphold ? "#uphold" : "#reject"));
        if (roles[k][m] & PLANT_MANAGER == 0 || m == c.tester || m == c.validator) revert NotAuthorized(m);
        openCases[k][c.tester]--;
        openCases[k][c.validator]--;
        Settings storage cfg = _settings[k];
        Acceptance storage a = acceptances[k][c.acceptance];
        if (c.acceptance != 0) a.frozen = false;
        address treasury = sites[k].treasury;
        if (uphold) {
            Stake storage s = stakes[k][c.validator];
            uint256 amount = (s.amount * c.bps) / 10000;
            if (amount > s.amount) amount = s.amount;
            s.amount -= amount;
            uint256 bounty = (amount * cfg.bountyBps) / 10000;
            claimable[k][c.tester] += bounty;
            if (c.acceptance != 0) {
                rewardPool[k] += a.fee;
                a.fee = 0;
            }
            c.amount = amount;
            c.status = UPHELD;
            emit CaseDecided(k, caseId, true, m, amount, bounty, treasury);
            _pay(treasury, amount - bounty);
        } else {
            Stake storage s = stakes[k][c.tester];
            uint256 penalty = (s.amount * cfg.falseClaimBps) / 10000;
            s.amount -= penalty;
            claimable[k][c.validator] += penalty;
            c.amount = penalty;
            c.status = REJECTED;
            emit CaseDecided(k, caseId, false, m, penalty, 0, treasury);
        }
    }

    // ------------------------------------------------------------------ helpers (no mcopy: runs on any EVM)

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// secp256k1 recovery of a 65-byte signature, rejecting malleable s values.
    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
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

    /// Lowercase 0x-prefixed hex address, as Ordo writes addresses.
    function _hex(address a) internal pure returns (string memory) {
        return _hexN(uint256(uint160(a)), 20);
    }

    /// Lowercase 0x-prefixed 32-byte hex, as Ordo writes hashes.
    function _hex32(bytes32 b) internal pure returns (string memory) {
        return _hexN(uint256(b), 32);
    }

    function _hexN(uint256 v, uint256 bytesLen) private pure returns (string memory) {
        bytes memory out = new bytes(2 + bytesLen * 2);
        bytes16 digits = "0123456789abcdef";
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = out.length - 1; i > 1; i--) {
            out[i] = digits[v & 0xf];
            v >>= 4;
        }
        return string(out);
    }

    function _dec(uint256 v) internal pure returns (string memory) {
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
