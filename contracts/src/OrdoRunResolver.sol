// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrdoSigned} from "./OrdoSigned.sol";
import {IEnsV2Registry, IExtendedResolver, ITextResolver, OrdoEnsName} from "./OrdoEns.sol";
import {OrdoNames} from "./OrdoNames.sol";
import {OrdoProofs} from "./OrdoProofs.sol";

/// The generated Groth16 verifier of circuits/stage_check.circom (OrdoStageVerifier).
interface IStageVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[14] calldata signals) external view returns (bool);
}

/// The generated Groth16 verifier of circuits/spec_check.circom (OrdoSpecVerifier).
interface ISpecVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[4] calldata signals) external view returns (bool);
}

/// @title OrdoRunResolver
/// @notice The resolver of every run's ENS name (`so-7781.runs.acme.ordo.eth`, the lot), which carries the lot's
///         release on-chain: its proof of work.
///
/// `recordRelease` stores a release only when
///  1. three different people signed an `OrdoRelease` naming this site, package, run, lot (the run's full name),
///     content hash and proof root, each holding the role names it needs right now (OrdoNames): the performer any
///     role, the reviewer a validator name, the approver a manager name; revoke a name and that person can no longer
///     release;
///  2. every stage proof checks: its reading was signed by the machine that ran the stage, or by a contributor
///     (OPERATOR) for a stage run by hand, and its Groth16 proof (OrdoStageVerifier) shows the signed counts meet
///     the stage's criteria. Which machine ran a stage is the run name's `com.ordo.machine.<stage>` record, which
///     Ordo writes: the machine's label, or `manual`. A machine attests only those stages, and only while it holds
///     its machine name (DEVICE) and its attester name (`<label>.attesters.<org>`, slot ATTESTERS);
///  3. every parameter proof checks the same way against OrdoSpecVerifier; stages, then parameters, fold to the
///     proof root the three people signed.
/// `com.ordo.release*` text records are answered from it, with the signers by their ENS names. Every other record of
/// a run name is passed to Ordo's PermissionedResolver, where Ordo writes it.
contract OrdoRunResolver is OrdoSigned {
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

    OrdoNames public immutable names;
    IStageVerifier public immutable stageVerifier;
    ISpecVerifier public immutable specVerifier;
    IExtendedResolver public immutable fallbackResolver;

    /// run node (namehash of the run's name) → its latest release, and how many it has had
    mapping(bytes32 => Release) public latestRelease;
    mapping(bytes32 => uint256) public releaseCount;

    event LotReleased(bytes32 indexed node, bytes32 indexed site, string runName, string packageId, bytes32 contentHash, bytes32 proofRoot, address performedBy, address reviewedBy, address approvedBy);
    /// one stage of a released lot, proven: who signed its reading and the commitment the proof was checked against
    event StageProven(bytes32 indexed node, string stage, string asset, address indexed signer, uint256 commitment, bytes32 anchor);
    /// one measured parameter of a released lot, proven: who signed its measurement and the commitment the proof was checked against
    event ParameterProven(bytes32 indexed node, string stage, string criterion, address indexed signer, uint256 commitment, bytes32 anchor);

    error NotALot(string runName);
    error UnknownSite();
    error DuplicateSigner(address signer);
    error NotCredentialed(address signer, uint8 needs);
    error BadProof(string stage);
    error BadParamProof(string stage, string criterion);
    error WrongProofRoot();
    error NotAttester(address signer);
    /// the stage was not this attester's to sign: another machine ran it, it was run by hand, or the machine lost its attester name
    error WrongMachine(string stage, address signer);

    /// OrdoNames slot of the org's attesters collection (machines that sign their own stages); its presence marks v2
    uint8 public constant ATTESTERS = 9;

    bytes4 private constant TEXT = ITextResolver.text.selector;
    /// multicall(bytes[]), as the Universal Resolver batches record reads
    bytes4 private constant MULTICALL = 0xac9650d8;

    constructor(OrdoNames _names, IStageVerifier _stageVerifier, ISpecVerifier _specVerifier, IExtendedResolver _fallback) {
        names = _names;
        stageVerifier = _stageVerifier;
        specVerifier = _specVerifier;
        fallbackResolver = _fallback;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == type(IExtendedResolver).interfaceId;
    }

    // ------------------------------------------------------------------ releases

    /// Record that a lot was released, with its proof of work. sigs = [performed, reviewed, approved], each an
    /// `OrdoRelease` (OrdoProofs) for exactly this lot; `lot.lotLabel` is the run's full ENS name.
    /// `proofs` are the lot's proven stages and `params` its proven measured parameters, in the order they fold into `lot.proofRoot`.
    function recordRelease(OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ReleaseSig[3] calldata sigs, OrdoProofs.StageProof[] calldata proofs, OrdoProofs.ParamProof[] calldata params) external {
        bytes32 k = keccak256(bytes(lot.siteId));
        bytes32 node = runNode(k, lot.lotLabel);
        address[3] memory who = _signers(k, lot, sigs);
        if (_proveAll(k, node, lot, proofs, params) != lot.proofRoot) revert WrongProofRoot();
        _record(k, node, lot, who, uint16(proofs.length), uint16(params.length));
    }

    /// Stages fold first, then parameters.
    function _proveAll(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.StageProof[] calldata proofs, OrdoProofs.ParamProof[] calldata params) internal returns (bytes32) {
        bytes32 root = _proveStages(k, node, lot, proofs);
        return _proveParams(k, node, lot, params, root);
    }

    function _record(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, address[3] memory who, uint16 stages, uint16 params) internal {
        latestRelease[node] = Release(k, lot.contentHash, lot.proofRoot, stages, params, who[0], who[1], who[2], uint64(block.timestamp), lot.packageId);
        releaseCount[node] += 1;
        emit LotReleased(node, k, lot.lotLabel, lot.packageId, lot.contentHash, lot.proofRoot, who[0], who[1], who[2]);
    }

    /// The node of a run name: `<run>.runs.<org>`, registered in the site's runs registry.
    function runNode(bytes32 site, string calldata runName) public view returns (bytes32) {
        string[] memory org = names.orgLabels(site);
        if (org.length == 0) revert UnknownSite();
        string[] memory labels = OrdoEnsName.split(runName);
        if (labels.length != org.length + 2 || keccak256(bytes(labels[1])) != keccak256("runs")) revert NotALot(runName);
        for (uint256 i = 0; i < org.length; i++) if (keccak256(bytes(labels[i + 2])) != keccak256(bytes(org[i]))) revert NotALot(runName);
        address runs = names.registryOf(site, names.RUNS());
        if (runs == address(0) || IEnsV2Registry(runs).findOwner(labels[0]) == address(0)) revert NotALot(runName);
        return OrdoEnsName.namehash(labels);
    }

    /// The three signers, checked: each signed exactly this lot with its meaning, all different, each credentialed.
    function _signers(bytes32 k, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ReleaseSig[3] calldata sigs) internal returns (address[3] memory who) {
        who[0] = _consumeRelease(sigs[0], lot, "performed");
        who[1] = _consumeRelease(sigs[1], lot, "reviewed");
        who[2] = _consumeRelease(sigs[2], lot, "approved");
        if (who[0] == who[1] || who[0] == who[2]) revert DuplicateSigner(who[0]);
        if (who[1] == who[2]) revert DuplicateSigner(who[1]);
        _require(k, who[0], 0);
        _require(k, who[1], names.VALIDATOR());
        _require(k, who[2], names.VALIDATOR() | names.PLANT_MANAGER());
    }

    /// Check every stage proof and fold them into the root the signers named.
    function _proveStages(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.StageProof[] calldata proofs) internal returns (bytes32 root) {
        for (uint256 i = 0; i < proofs.length; i++) {
            OrdoProofs.StageProof calldata p = proofs[i];
            address attester = OrdoProofs.recover(OrdoProofs.readingDigest(lot.siteId, lot.runId, p), p.readingSig);
            _attest(k, node, lot.lotLabel, p.stage, attester);
            uint256 subject = OrdoProofs.subjectOf(lot.siteId, lot.runId, p.stage);
            if (!stageVerifier.verifyProof(p.a, p.b, p.c, OrdoProofs.signals(subject, p))) revert BadProof(p.stage);
            root = OrdoProofs.fold(root, subject, p, attester);
            emit StageProven(node, p.stage, p.asset, attester, p.commitment, p.anchor);
        }
    }

    /// Check every parameter proof and fold it after the stages.
    function _proveParams(bytes32 k, bytes32 node, OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ParamProof[] calldata params, bytes32 root) internal returns (bytes32) {
        for (uint256 i = 0; i < params.length; i++) {
            OrdoProofs.ParamProof calldata p = params[i];
            address attester = OrdoProofs.recover(OrdoProofs.measurementDigest(lot.siteId, lot.runId, p), p.sig);
            _attest(k, node, lot.lotLabel, p.stage, attester);
            uint256 subject = OrdoProofs.specSubjectOf(lot.runId, p.stage, p.criterion);
            if (!specVerifier.verifyProof(p.a, p.b, p.c, OrdoProofs.paramSignals(subject, p))) revert BadParamProof(p.stage, p.criterion);
            root = OrdoProofs.foldParam(root, subject, p, attester);
            emit ParameterProven(node, p.stage, p.criterion, attester, p.commitment, p.anchor);
        }
        return root;
    }

    /// Whether `attester` may sign for `stage` of this run. A machine (it holds its machine name) signs only a stage the
    /// run name records as its own, and only while it holds its attester name; a person (a contributor) signs only a
    /// stage run by hand, whose record is empty or `manual`.
    function _attest(bytes32 k, bytes32 node, string calldata runName, string calldata stage, address attester) internal view {
        uint8 has = names.roles(k, attester);
        string memory ran = _text(runName, node, string.concat("com.ordo.machine.", stage));
        string memory m = names.memberLabel(k, names.MACHINE(), attester);
        if (bytes(m).length != 0 && has & names.DEVICE() != 0) {
            address reg = names.registryOf(k, ATTESTERS);
            if (reg == address(0) || IEnsV2Registry(reg).findOwner(m) != attester || keccak256(bytes(ran)) != keccak256(bytes(m))) revert WrongMachine(stage, attester);
            return;
        }
        if (has & names.OPERATOR() == 0) revert NotAttester(attester);
        if (bytes(ran).length != 0 && keccak256(bytes(ran)) != keccak256("manual")) revert WrongMachine(stage, attester);
    }

    /// A text record of the run name, as Ordo's resolver holds it ("" when unset).
    function _text(string calldata runName, bytes32 node, string memory key) internal view returns (string memory) {
        bytes memory out = fallbackResolver.resolve(OrdoEnsName.dns(OrdoEnsName.split(runName)), abi.encodeWithSelector(TEXT, node, key));
        return out.length == 0 ? "" : abi.decode(out, (string));
    }

    /// needs = 0: any role at the site
    function _require(bytes32 site, address who, uint8 needs) internal view {
        uint8 has = names.roles(site, who);
        if (needs == 0 ? has == 0 : has & needs != needs) revert NotCredentialed(who, needs);
    }

    function _consumeRelease(OrdoProofs.ReleaseSig calldata s, OrdoProofs.ReleaseLot calldata lot, string memory meaning) internal returns (address) {
        bytes32 n = OrdoProofs.releaseNonce(s);
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return OrdoProofs.releaseSigner(s, lot, meaning);
    }

    // ------------------------------------------------------------------ resolution

    /// Release records from storage; everything else from Ordo's resolver. A multicall is answered call by call.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        if (data.length >= 4 && bytes4(data[0:4]) == MULTICALL) {
            bytes[] memory calls = abi.decode(data[4:], (bytes[]));
            bytes[] memory out = new bytes[](calls.length);
            for (uint256 i = 0; i < calls.length; i++) out[i] = this.resolveOne(name, calls[i]);
            return abi.encode(out);
        }
        return this.resolveOne(name, data);
    }

    /// One record read (external so `resolve` can pass memory calls through calldata).
    function resolveOne(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        if (data.length >= 4 && bytes4(data[0:4]) == TEXT) {
            (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
            Release storage r = latestRelease[node];
            if (r.releasedAt != 0 && _startsWith(bytes(key), "com.ordo.release")) {
                (bool known, string memory value) = _releaseText(node, r, key);
                if (known) return abi.encode(value);
            }
        }
        return fallbackResolver.resolve(name, data);
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
            return (true, string.concat(names.nameOf(r.site, r.performedBy), ",", names.nameOf(r.site, r.reviewedBy), ",", names.nameOf(r.site, r.approvedBy)));
        return (false, "");
    }

    function _startsWith(bytes memory b, bytes memory prefix) internal pure returns (bool) {
        if (b.length < prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) if (b[i] != prefix[i]) return false;
        return true;
    }
}
