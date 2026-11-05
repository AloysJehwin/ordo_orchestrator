declare module "snarkjs" {
  export const groth16: { verify(vk: unknown, publicSignals: string[], proof: unknown): Promise<boolean> };
}
