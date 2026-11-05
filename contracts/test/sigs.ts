import type { Address } from "viem";

/** Ordo's typed data, as the console and the gateway sign it. */
export const ORDO_SIGNATURE = {
  OrdoSignature: [
    { name: "action", type: "string" },
    { name: "entity", type: "string" },
    { name: "meaning", type: "string" },
    { name: "comment", type: "string" },
    { name: "site", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
  ],
} as const;
export const ORDO_RELEASE = {
  OrdoRelease: [
    { name: "site", type: "string" },
    { name: "packageId", type: "string" },
    { name: "runId", type: "string" },
    { name: "lot", type: "string" },
    { name: "meaning", type: "string" },
    { name: "statement", type: "string" },
    { name: "comment", type: "string" },
    { name: "contentHash", type: "bytes32" },
    { name: "proofRoot", type: "bytes32" },
    { name: "nonce", type: "string" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
export const ORDO_READING = {
  OrdoReading: [
    { name: "site", type: "string" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "asset", type: "string" },
    { name: "commitment", type: "uint256" },
    { name: "anchor", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;

export const ORDO_MEASUREMENT = {
  OrdoMeasurement: [
    { name: "site", type: "string" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "asset", type: "string" },
    { name: "criterion", type: "string" },
    { name: "commitment", type: "uint256" },
    { name: "anchor", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;

/** OrdoTrust's domain: version 2 names the deployment, so its signatures cannot be replayed on another one. */
export const trustDomain = (chainId: number, verifyingContract: Address) => ({ name: "Ordo", version: "2", chainId, verifyingContract }) as const;
/** Release and reading statements: no chain, no contract (see OrdoProofs.sol). */
export const PROOF_DOMAIN = { name: "Ordo", version: "2" } as const;
