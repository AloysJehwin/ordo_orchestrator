import { readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { describe, expect, it } from "vitest";
import { chain } from "./chain.js";

const zk = (f: string) => new URL(`../../server/zk/${f}`, import.meta.url);
const wasm = new Uint8Array(readFileSync(zk("spec_check.wasm")));
const zkey = new Uint8Array(readFileSync(zk("spec_check.zkey")));

/** A proof that a committed yield of 98.5 % is at least 95 %, as Ordo's server makes it for a lot passport. */
async function prove(target: bigint, op = 0n, value = 985_000n) {
  const poseidon = await buildPoseidon();
  const subject = 1234n;
  const salt = 98765n;
  const commitment = poseidon.F.toObject(poseidon([subject, value, salt]));
  return groth16.fullProve({ value, salt, subject, target, op, commitment }, wasm, zkey, undefined, undefined, { singleThread: true });
}
/** snarkjs's proof as the verifier's calldata (B's coordinates are swapped for the precompile). */
const calldata = (p: Awaited<ReturnType<typeof prove>>) =>
  [
    p.proof.pi_a.slice(0, 2).map(BigInt),
    p.proof.pi_b.slice(0, 2).map((x: string[]) => [BigInt(x[1]!), BigInt(x[0]!)]),
    p.proof.pi_c.slice(0, 2).map(BigInt),
    p.publicSignals.map(BigInt),
  ] as const;

describe("OrdoSpecVerifier", () => {
  it("accepts a proof that a lot met its target and rejects the same proof against another target", async () => {
    const { pub, deploy } = await chain();
    const v = await deploy("OrdoSpecVerifier", []);
    const p = await prove(950_000n);
    expect(p.publicSignals.slice(1, 3)).toEqual(["950000", "0"]);
    const verify = (args: ReturnType<typeof calldata>) => pub.readContract({ address: v.address, abi: v.abi, functionName: "verifyProof", args: args as never });
    expect(await verify(calldata(p))).toBe(true);
    const [a, b, c, signals] = calldata(p);
    expect(await verify([a, b, c, [signals[0]!, 900_000n, signals[2]!, signals[3]!]] as never)).toBe(false);
  });

  it("cannot prove a value that misses the target", async () => {
    await expect(prove(990_000n)).rejects.toThrow();
    await expect(prove(950_000n, 1n)).rejects.toThrow(); // "at most 95 %" does not hold for 98.5 %
  });
});
