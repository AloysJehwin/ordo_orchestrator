// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrdoSigned} from "./OrdoSigned.sol";
import {IExtendedResolver, ITextResolver, OrdoEnsName, OrdoEnsRoles} from "./OrdoEnsRoles.sol";
import {OrdoProofs} from "./OrdoProofs.sol";

/// The generated Groth16 verifier of circuits/stage_check.circom (OrdoStageVerifier).
interface IStageVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[14] calldata signals) external view returns (bool);
}

/// The generated Groth16 verifier of circuits/spec_check.circom (OrdoSpecVerifier).
interface ISpecVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[4] calldata signals) external view returns (bool);
}

/// The gateway call a CCIP-Read client makes for an off-chain answer (EIP-3668, as in ENS's OffchainResolver).
interface IResolverService {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory result, uint64 expires, bytes memory sig);
}

/// @title OrdoLotResolver
/// @notice Gives every production lot an ENS name, `lot-<order>.<site>.<parent>`, that resolves to its passport,
///         with no registration and no gas per lot.
///
/// It is the resolver of each site name. ENSv2 resolution walks down to the closest name with a resolver, so every
/// `lot-…` name under a site reaches it (ENSIP-10 wildcard):
///  - A lot's release record is on-chain, and it is the lot's proof of work. `recordRelease` stores it only when
///      1. three people whose ENS member names carry the right roles (OrdoEnsRoles) signed an `OrdoRelease` naming this
///         site, package, run, lot, content hash and proof root (so revoking a name stops that person releasing), and
///      2. every stage proof checks: its reading was signed by a gateway holding DEVICE or an operator at the site,
///         and its Groth16 proof (OrdoStageVerifier) shows the signed counts meet the stage's criteria, and
///      3. every parameter proof checks: its measurement was signed by such a gateway or operator, and its Groth16
///         proof (OrdoSpecVerifier) shows the signed value meets the criterion's bound; and stages, then parameters,
///         fold to the proof root the three people signed.
///    `com.ordo.release*` text records are answered from it directly.
///  - Everything else about the lot (passport URL, status, product…) comes from Ordo's ledger through CCIP-Read
///    (EIP-3668): the resolver reverts with OffchainLookup, the client asks Ordo's gateway, and `resolveWithProof`
///    accepts the answer only if Ordo's signer signed it.
///  - Names that are not lots (the site name itself) are passed to `fallbackResolver`, where their records live.
contract OrdoLotResolver is OrdoSigned {
    struct Release {
        bytes32 site;
        bytes32 contentHash;
        bytes32 proofRoot;
        uint16 stagesProven;
        uint16 paramsProven;
        address performedBy;
        address reviewedBy;
        address approvedBy;
        uint64 releasedAt;
        string packageId;
    }

    OrdoEnsRoles public immutable credentials;
    IStageVerifier public immutable stageVerifier;
    ISpecVerifier public immutable specVerifier;
    IExtendedResolver public immutable fallbackResolver;
    address public owner;
    address public signer;
    string[] private gateways;

    /// lot node (namehash) → its latest release, and how many it has had
    mapping(bytes32 => Release) public latestRelease;
    mapping(bytes32 => uint256) public releaseCount;

    event LotReleased(bytes32 indexed node, bytes32 indexed site, string lotLabel, string packageId, bytes32 contentHash, bytes32 proofRoot, address performedBy, address reviewedBy, address approvedBy);
    /// one stage of a released lot, proven: who signed its reading and the commitment the proof was checked against
    event StageProven(bytes32 indexed node, string stage, string asset, address indexed signer, uint256 commitment, bytes32 anchor);
    /// one measured parameter of a released lot, proven: who signed its measurement and the commitment the proof was checked against
    event ParameterProven(bytes32 indexed node, string stage, string criterion, address indexed signer, uint256 commitment, bytes32 anchor);
    event GatewayChanged(address signer, string[] urls);

    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    error NotOwner();
    error NotALot();
    error UnknownSite();
    error DuplicateSigner(address signer);
    error NotCredentialed(address signer, uint8 needs);
    error ExpiredAnswer();
    error BadAnswer();
    error BadProof(string stage);
    error BadParamProof(string stage, string criterion);
    error WrongProofRoot();
    error NotAttester(address signer);

    bytes4 private constant TEXT = ITextResolver.text.selector;

    constructor(OrdoEnsRoles _credentials, IStageVerifier _stageVerifier, ISpecVerifier _specVerifier, IExtendedResolver _fallback, address _signer, string[] memory _gateways) {
        credentials = _credentials;
        stageVerifier = _stageVerifier;
        specVerifier = _specVerifier;
        fallbackResolver = _fallback;
        owner = msg.sender;
        signer = _signer;
        gateways = _gateways;
    }

    function setGateway(address _signer, string[] memory urls) external {
        if (msg.sender != owner) revert NotOwner();
        signer = _signer;
        gateways = urls;
        emit GatewayChanged(_signer, urls);
    }

    function gatewayUrls() external view returns (string[] memory) {
        return gateways;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == type(IExtendedResolver).interfaceId;
    }

    // ------------------------------------------------------------------ releases

    /// Record that a lot was released, with its proof of work. sigs = [performed, reviewed, approved], each an
    /// `OrdoRelease` (OrdoProofs) for exactly this lot. Three different people: the performer must hold a role at the
    /// site, the reviewer VALIDATOR, the approver VALIDATOR and PLANT_MANAGER, all through their ENS member names.
    /// `proofs` are the lot's proven stages and `params` its proven measured parameters, in the order they fold into `lot.proofRoot`.
    function recordRelease(OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ReleaseSig[3] calldata sigs, OrdoProofs.StageProof[] calldata proofs, OrdoProofs.ParamProof[] calldata params) external {
        if (!_isLot(bytes(lot.lotLabel))) revert NotALot();
        bytes32 k = keccak256(bytes(lot.siteId));
        bytes32 node = _lotNode(k, lot.lotLabel);
        address[3] memory who = _signers(k, lot, sigs);
        if (_proveAll(k, node, lot, proofs, params) != lot.proofRoot) revert WrongProofRoot();
        _record(k, node, lot, who, uint16(proofs.length), uint16(params.length));
    }

    /// The lot's ENS node under its site's name.
    function _lotNode(bytes32 k, string calldata lotLabel) internal view returns (bytes32) {
        string[] memory site = credentials.siteLabels(k);
        if (site.length == 0) revert UnknownSite();
        return OrdoEnsName.namehash(OrdoEnsName.prepend(lotLabel, site));
    }

    /// Stages fold first, then parameters.
    function _proveAll(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.StageProof[] calldata proofs, OrdoProofs.ParamProof[] calldata params) internal returns (bytes32) {
        bytes32 root = _proveStages(k, node, lot, proofs);
        root = _proveParams(k, node, lot, params, root);
        return root;
    }

    function _record(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, address[3] memory who, uint16 stages, uint16 params) internal {
        latestRelease[node] = Release(k, lot.contentHash, lot.proofRoot, stages, params, who[0], who[1], who[2], uint64(block.timestamp), lot.packageId);
        releaseCount[node] += 1;
        emit LotReleased(node, k, lot.lotLabel, lot.packageId, lot.contentHash, lot.proofRoot, who[0], who[1], who[2]);
    }

    /// The three signers, checked: each signed exactly this lot with its meaning, all different, each credentialed.
    function _signers(bytes32 k, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ReleaseSig[3] calldata sigs) internal returns (address[3] memory who) {
        who[0] = _consumeRelease(sigs[0], lot, "performed");
        who[1] = _consumeRelease(sigs[1], lot, "reviewed");
        who[2] = _consumeRelease(sigs[2], lot, "approved");
        if (who[0] == who[1] || who[0] == who[2]) revert DuplicateSigner(who[0]);
        if (who[1] == who[2]) revert DuplicateSigner(who[1]);
        _require(k, who[0], 0);
        _require(k, who[1], credentials.VALIDATOR());
        _require(k, who[2], credentials.VALIDATOR() | credentials.PLANT_MANAGER());
    }

    /// Check every stage proof and fold them into the root the signers named.
    function _proveStages(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.StageProof[] calldata proofs) internal returns (bytes32 root) {
        uint8 attesters = credentials.DEVICE() | credentials.OPERATOR();
        for (uint256 i = 0; i < proofs.length; i++) {
            OrdoProofs.StageProof calldata p = proofs[i];
            address attester = OrdoProofs.recover(OrdoProofs.readingDigest(lot.siteId, lot.runId, p), p.readingSig);
            if (credentials.roles(k, attester) & attesters == 0) revert NotAttester(attester);
            uint256 subject = OrdoProofs.subjectOf(lot.siteId, lot.runId, p.stage);
            if (!stageVerifier.verifyProof(p.a, p.b, p.c, OrdoProofs.signals(subject, p))) revert BadProof(p.stage);
            root = OrdoProofs.fold(root, subject, p, attester);
            emit StageProven(node, p.stage, p.asset, attester, p.commitment, p.anchor);
        }
    }

    /// Check every parameter proof and fold it after the stages: the measurement's signer must hold DEVICE or OPERATOR at
    /// the site, and the spec-check proof must verify for this lot, stage and criterion with the signed commitment.
    function _proveParams(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ParamProof[] calldata params, bytes32 root) internal returns (bytes32) {
        uint8 attesters = credentials.DEVICE() | credentials.OPERATOR();
        for (uint256 i = 0; i < params.length; i++) {
            OrdoProofs.ParamProof calldata p = params[i];
            address attester = OrdoProofs.recover(OrdoProofs.measurementDigest(lot.siteId, lot.runId, p), p.sig);
            if (credentials.roles(k, attester) & attesters == 0) revert NotAttester(attester);
            uint256 subject = OrdoProofs.specSubjectOf(lot.runId, p.stage, p.criterion);
            if (!specVerifier.verifyProof(p.a, p.b, p.c, OrdoProofs.paramSignals(subject, p))) revert BadParamProof(p.stage, p.criterion);
            root = OrdoProofs.foldParam(root, subject, p, attester);
            emit ParameterProven(node, p.stage, p.criterion, attester, p.commitment, p.anchor);
        }
        return root;
    }

    /// needs = 0: any role at the site
    function _require(bytes32 site, address who, uint8 needs) internal view {
        uint8 has = credentials.roles(site, who);
        if (needs == 0 ? has == 0 : has & needs != needs) revert NotCredentialed(who, needs);
    }

    function _consumeRelease(OrdoProofs.ReleaseSig calldata s, OrdoProofs.ReleaseLot calldata lot, string memory meaning) internal returns (address) {
        bytes32 n = OrdoProofs.releaseNonce(s);
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return OrdoProofs.releaseSigner(s, lot, meaning);
    }

    // ------------------------------------------------------------------ resolution

    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        uint256 len = uint8(name[0]);
        if (!_isLot(name[1:1 + len])) return fallbackResolver.resolve(name, data);

        if (data.length >= 4 && bytes4(data[0:4]) == TEXT) {
            (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
            Release storage r = latestRelease[node];
            if (r.releasedAt != 0 && _startsWith(bytes(key), "com.ordo.release")) {
                (bool known, string memory value) = _releaseText(node, r, key);
                if (known) return abi.encode(value);
            }
        }
        bytes memory callData = abi.encodeCall(IResolverService.resolve, (name, data));
        revert OffchainLookup(address(this), gateways, callData, this.resolveWithProof.selector, callData);
    }

    /// Accept a gateway answer signed by Ordo's signer: sig over keccak256(0x1900, this, expires, keccak256(request), keccak256(result)).
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        if (expires < block.timestamp) revert ExpiredAnswer();
        bytes32 h = keccak256(abi.encodePacked(hex"1900", address(this), expires, keccak256(extraData), keccak256(result)));
        if (sig.length != 65 || this.recoverSigner(h, sig) != signer) revert BadAnswer();
        return result;
    }

    /// Exposed so resolveWithProof can recover from memory bytes through calldata.
    function recoverSigner(bytes32 h, bytes calldata sig) external pure returns (address) {
        return _recover(h, sig);
    }

    function _releaseText(bytes32 node, Release storage r, string memory key) internal view returns (bool, string memory) {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("com.ordo.release")) return (true, _hex32(r.contentHash));
        if (k == keccak256("com.ordo.release.package")) return (true, r.packageId);
        if (k == keccak256("com.ordo.release.at")) return (true, _dec(r.releasedAt));
        if (k == keccak256("com.ordo.release.count")) return (true, _dec(releaseCount[node]));
        if (k == keccak256("com.ordo.release.proofs"))
            return (true, string.concat(_dec(r.stagesProven), " stages and ", _dec(r.paramsProven), " parameters proven, root ", _hex32(r.proofRoot)));
        if (k == keccak256("com.ordo.release.signers"))
            return (true, string.concat(credentials.memberName(r.site, r.performedBy), ",", credentials.memberName(r.site, r.reviewedBy), ",", credentials.memberName(r.site, r.approvedBy)));
        return (false, "");
    }

    function _isLot(bytes memory label) internal pure returns (bool) {
        return label.length > 4 && _startsWith(label, "lot-");
    }

    function _startsWith(bytes memory b, bytes memory prefix) internal pure returns (bool) {
        if (b.length < prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) if (b[i] != prefix[i]) return false;
        return true;
    }
}
