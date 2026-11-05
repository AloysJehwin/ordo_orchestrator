// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrdoProofs
/// @notice The two statements Ordo's proof of work rests on, as EIP-712 typed data (domain {name:"Ordo",version:"2"}):
///  - `OrdoReading`: a machine's gateway (or the operator, for a manual stage) signs a commitment to the counts it saw
///    for one stage: Poseidon(subject, good, scrap, startedAt, endedAt, salt). The counts stay private; the stage-check
///    circuit proves from the same commitment that they meet the stage's criteria. `anchor` is the newest HCS ledger
///    anchor the signer had seen, so the reading cannot predate it.
///  - `OrdoMeasurement`: the source of a measured parameter (an instrument's gateway, or the operator) signs a commitment
///    to the value it measured for one stage's criterion: Poseidon(subject, value × 10⁴, salt), exactly what the
///    spec-check circuit hashes, so the same commitment proves the value meets the criterion's bound. The upper bound
///    of a range is a second statement, with criterion `label#max`, over the same subject.
///  - `OrdoRelease`: each of the three people who release a package (performed, reviewed, approved) signs exactly what
///    is released: the site, package, run and lot, the content hash and the root of the stage and parameter proofs.
/// The domain has no chain id: both are statements about a lot, not instructions to one contract. Replaying one can
/// only state the same thing again, and each contract burns nonces and checks the release deadline.
library OrdoProofs {
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version)");
    bytes32 internal constant RELEASE_TYPEHASH =
        keccak256(
            "OrdoRelease(string site,string packageId,string runId,string lot,string meaning,string statement,string comment,bytes32 contentHash,bytes32 proofRoot,string nonce,uint64 deadline)"
        );
    bytes32 internal constant READING_TYPEHASH =
        keccak256("OrdoReading(string site,string runId,string stage,string asset,uint256 commitment,bytes32 anchor,uint64 signedAt)");
    bytes32 internal constant MEASUREMENT_TYPEHASH =
        keccak256("OrdoMeasurement(string site,string runId,string stage,string asset,string criterion,uint256 commitment,bytes32 anchor,uint64 signedAt)");
    /// marks a parameter leaf in the proof root, so it can never be read as a stage leaf
    bytes32 internal constant PARAM_LEAF = keccak256("ordo:param");
    /// the BN254 scalar field, where the circuit's inputs live
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct ReleaseSig {
        string site;
        string packageId;
        string runId;
        string lot;
        string meaning;
        string statement;
        string comment;
        bytes32 contentHash;
        bytes32 proofRoot;
        string nonce;
        uint64 deadline;
        bytes signature;
    }

    /// What a release names, as every signature and proof must.
    struct ReleaseLot {
        string siteId;
        string lotLabel;
        string packageId;
        string runId;
        bytes32 contentHash;
        bytes32 proofRoot;
    }

    /// One stage's proof: the signed reading and the Groth16 proof that its committed counts meet the criteria.
    struct StageProof {
        string stage;
        string asset;
        uint256 commitment;
        bytes32 anchor;
        uint64 signedAt;
        bytes readingSig;
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[4] kinds;
        uint256[4] ops;
        uint256[4] targets;
    }

    /// One parameter's proof: the source-signed measurement commitment and the Groth16 proof (spec_check) that the
    /// committed value meets the criterion's bound. `criterion` is the criterion's label, or `label#max` for the upper
    /// bound of a range; both bounds share one subject.
    struct ParamProof {
        string stage;
        string asset;
        string criterion;
        uint256 commitment;
        bytes32 anchor;
        uint64 signedAt;
        bytes sig;
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        /// 0 at least, 1 at most, 2 exactly
        uint256 op;
        /// the bound × 10⁴
        uint256 target;
    }

    error BadSignature();
    error WrongRelease();
    error WrongMeaning();
    error Expired();

    /// Check one release signature covers exactly this lot with this meaning and has not expired; return its signer.
    /// The caller burns `releaseNonce(s)`.
    function releaseSigner(ReleaseSig calldata s, ReleaseLot calldata l, string memory meaning) internal view returns (address) {
        if (
            keccak256(abi.encode(s.site, s.packageId, s.runId, s.lot, s.contentHash, s.proofRoot)) !=
            keccak256(abi.encode(l.siteId, l.packageId, l.runId, l.lotLabel, l.contentHash, l.proofRoot))
        ) revert WrongRelease();
        if (keccak256(bytes(s.meaning)) != keccak256(bytes(meaning))) revert WrongMeaning();
        if (s.deadline < block.timestamp) revert Expired();
        return recover(releaseDigest(s), s.signature);
    }

    function releaseNonce(ReleaseSig calldata s) internal pure returns (bytes32) {
        return keccak256(bytes(string.concat("release:", s.nonce)));
    }

    function domainSeparator() internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ordo"), keccak256("2")));
    }

    function releaseDigest(ReleaseSig calldata s) internal pure returns (bytes32) {
        bytes32 h = keccak256(
            bytes.concat(
                abi.encode(RELEASE_TYPEHASH, keccak256(bytes(s.site)), keccak256(bytes(s.packageId)), keccak256(bytes(s.runId)), keccak256(bytes(s.lot)), keccak256(bytes(s.meaning))),
                abi.encode(keccak256(bytes(s.statement)), keccak256(bytes(s.comment)), s.contentHash, s.proofRoot, keccak256(bytes(s.nonce)), s.deadline)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), h));
    }

    function readingDigest(string calldata site, string calldata runId, StageProof calldata p) internal pure returns (bytes32) {
        bytes32 h = keccak256(
            abi.encode(READING_TYPEHASH, keccak256(bytes(site)), keccak256(bytes(runId)), keccak256(bytes(p.stage)), keccak256(bytes(p.asset)), p.commitment, p.anchor, p.signedAt)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), h));
    }

    function measurementDigest(string calldata site, string calldata runId, ParamProof calldata p) internal pure returns (bytes32) {
        bytes32 h = keccak256(
            abi.encode(
                MEASUREMENT_TYPEHASH,
                keccak256(bytes(site)),
                keccak256(bytes(runId)),
                keccak256(bytes(p.stage)),
                keccak256(bytes(p.asset)),
                keccak256(bytes(p.criterion)),
                p.commitment,
                p.anchor,
                p.signedAt
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), h));
    }

    /// The field element a parameter proof is bound to: this run (lot), this stage, this criterion. Both bounds of a
    /// range share it (`label#max` names the same criterion as `label`).
    function specSubjectOf(string calldata runId, string calldata stage, string calldata criterion) internal pure returns (uint256) {
        return uint256(sha256(bytes(string.concat("ordo:spec:", runId, ":", stage, ":", baseLabel(criterion))))) % FIELD;
    }

    /// `label#max` is the upper bound of `label`.
    function baseLabel(string calldata criterion) internal pure returns (string memory) {
        bytes calldata b = bytes(criterion);
        uint256 n = b.length;
        if (n > 4 && b[n - 4] == "#" && b[n - 3] == "m" && b[n - 2] == "a" && b[n - 1] == "x") return string(b[0:n - 4]);
        return criterion;
    }

    /// The spec-check circuit's public signals: [subject, target, op, commitment].
    function paramSignals(uint256 subject, ParamProof calldata p) internal pure returns (uint256[4] memory s) {
        s[0] = subject;
        s[1] = p.target;
        s[2] = p.op;
        s[3] = p.commitment;
    }

    /// Parameter proofs fold after the stages: root = keccak256(root, keccak256(PARAM_LEAF, subject, commitment, op, target, signer)).
    function foldParam(bytes32 root, uint256 subject, ParamProof calldata p, address signer) internal pure returns (bytes32) {
        bytes32 leaf = keccak256(abi.encode(PARAM_LEAF, subject, p.commitment, p.op, p.target, signer));
        return keccak256(abi.encode(root, leaf));
    }

    /// The field element a stage proof is bound to: this site, this run (lot), this stage.
    function subjectOf(string calldata site, string calldata runId, string calldata stage) internal pure returns (uint256) {
        return uint256(sha256(bytes(string.concat("ordo:stage:", site, ":", runId, ":", stage)))) % FIELD;
    }

    /// The public signals in the circuit's order: [subject, commitment, kind[4], op[4], target[4]].
    function signals(uint256 subject, StageProof calldata p) internal pure returns (uint256[14] memory s) {
        s[0] = subject;
        s[1] = p.commitment;
        for (uint256 i = 0; i < 4; i++) {
            s[2 + i] = p.kinds[i];
            s[6 + i] = p.ops[i];
            s[10 + i] = p.targets[i];
        }
    }

    /// The proof root folds each stage in order: root = keccak256(root, keccak256(subject, commitment, criteria, signer)).
    function fold(bytes32 root, uint256 subject, StageProof calldata p, address signer) internal pure returns (bytes32) {
        bytes32 leaf = keccak256(abi.encode(subject, p.commitment, p.kinds, p.ops, p.targets, signer));
        return keccak256(abi.encode(root, leaf));
    }

    /// secp256k1 recovery of a 65-byte signature, rejecting malleable s values.
    function recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
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
}
