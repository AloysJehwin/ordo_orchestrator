declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export const groth16: {
    fullProve(
      input: Record<string, bigint | string | (bigint | string)[]>,
      wasm: Uint8Array,
      zkey: Uint8Array,
      logger?: unknown,
      wtnsCalcOptions?: unknown,
      proverOptions?: { singleThread?: boolean },
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
  export const curves: { getCurveFromName(name: string, options?: { singleThread?: boolean }): Promise<unknown> };
}

declare module "circomlibjs" {
  export interface Poseidon {
    (inputs: bigint[]): Uint8Array;
    F: { toObject(x: Uint8Array): bigint };
  }
  export function buildPoseidon(): Promise<Poseidon>;
}
