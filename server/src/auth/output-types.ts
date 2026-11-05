/**
 * The OrdoOutput a stage's machine signs for each media file it captures (EIP-712, PROOF_DOMAIN: no chain, so the same
 * signature is checked anywhere). It binds the file's hash to the lot, stage and outcome, the value the machine read
 * from it (× 10⁴, signed), and when it was captured.
 */
export const OUTPUT_TYPES = {
  OrdoOutput: [
    { name: "site", type: "string" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "asset", type: "string" },
    { name: "outcome", type: "string" },
    { name: "sha256", type: "bytes32" },
    { name: "value", type: "int256" },
    { name: "capturedAt", type: "uint64" },
  ],
} as const;

export interface OutputMessage {
  site: string;
  runId: string;
  stage: string;
  asset: string;
  outcome: string;
  sha256: `0x${string}`;
  value: bigint;
  capturedAt: bigint;
}

/** A measured value as the whole number the signature and the commitments carry: value × 10⁴, rounded. */
export const scaleValue = (v: number): bigint => BigInt(Math.round(v * 1e4));
