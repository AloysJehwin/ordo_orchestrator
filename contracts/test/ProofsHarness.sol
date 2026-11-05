// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrdoProofs} from "../src/OrdoProofs.sol";
import {ISpecVerifier, IStageVerifier} from "../src/OrdoLotResolver.sol";

/// Exposes OrdoProofs to the tests, and checks one stage or parameter proof the way OrdoLotResolver does (which needs ENSv2 to run).
contract ProofsHarness {
    IStageVerifier public immutable verifier;
    ISpecVerifier public immutable specVerifier;

    constructor(IStageVerifier _verifier, ISpecVerifier _specVerifier) {
        verifier = _verifier;
        specVerifier = _specVerifier;
    }

    function releaseSigner(OrdoProofs.ReleaseSig calldata s, OrdoProofs.ReleaseLot calldata lot, string calldata meaning) external view returns (address) {
        return OrdoProofs.releaseSigner(s, lot, meaning);
    }

    function subjectOf(string calldata site, string calldata runId, string calldata stage) external pure returns (uint256) {
        return OrdoProofs.subjectOf(site, runId, stage);
    }

    function specSubjectOf(string calldata runId, string calldata stage, string calldata criterion) external pure returns (uint256) {
        return OrdoProofs.specSubjectOf(runId, stage, criterion);
    }

    /// The reading's signer, if the proof verifies; and the proof root after folding this stage into `root`.
    function checkStage(string calldata site, string calldata runId, bytes32 root, OrdoProofs.StageProof calldata p) external view returns (address attester, bytes32 next) {
        attester = OrdoProofs.recover(OrdoProofs.readingDigest(site, runId, p), p.readingSig);
        uint256 subject = OrdoProofs.subjectOf(site, runId, p.stage);
        require(verifier.verifyProof(p.a, p.b, p.c, OrdoProofs.signals(subject, p)), "bad proof");
        next = OrdoProofs.fold(root, subject, p, attester);
    }

    /// The measurement's signer, if the spec-check proof verifies for this lot, stage and criterion; and the root after folding it.
    function checkParam(string calldata site, string calldata runId, bytes32 root, OrdoProofs.ParamProof calldata p) external view returns (address signer, bytes32 next) {
        signer = OrdoProofs.recover(OrdoProofs.measurementDigest(site, runId, p), p.sig);
        uint256 subject = OrdoProofs.specSubjectOf(runId, p.stage, p.criterion);
        require(specVerifier.verifyProof(p.a, p.b, p.c, OrdoProofs.paramSignals(subject, p)), "bad proof");
        next = OrdoProofs.foldParam(root, subject, p, signer);
    }
}
