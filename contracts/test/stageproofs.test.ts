import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { chain } from "./chain.js";
import { ORDO_MEASUREMENT, ORDO_READING, ORDO_RELEASE, PROOF_DOMAIN } from "./sigs.js";

const zk = (f: string) => new URL(`../../server/zk/${f}`, import.meta.url);
const wasm = new Uint8Array(readFileSync(zk("stage_check.wasm")));
const zkey = new Uint8Array(readFileSync(zk("stage_check.zkey")));
const specWasm = new Uint8Array(readFileSync(zk("spec_check.wasm")));
const specZkey = new Uint8Array(readFileSync(zk("spec_check.zkey")));
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SITE = "site_pune1";
const RUN = "run_7781";

const subjectOf = (site: string, run: string, stage: string) => BigInt(`0x${createHash("sha256").update(`ordo:stage:${site}:${run}:${stage}`).digest("hex")}`) % FIELD;
/** a parameter's subject: the lot, stage and criterion; `label#max` (a range's upper bound) shares the label's subject */
const specSubjectOf = (run: string, stage: string, criterion: string) => BigInt(`0x${createHash("sha256").update(`ordo:spec:${run}:${stage}:${criterion.replace(/#max$/, "")}`).digest("hex")}`) % FIELD;
type Counts = { good: bigint; scrap: bigint; startedAt: bigint; endedAt: bigint };
// yield ≥ 98 %, scrap ≤ 2 %, cycle time ≤ 45 s, one unused slot
type Slots = [bigint, bigint, bigint, bigint];
const CRITERIA: { kind: Slots; op: Slots; target: Slots } = { kind: [1n, 2n, 4n, 0n], op: [0n, 1n, 1n, 0n], target: [980_000n, 20_000n, 450_000n, 0n] };

async function prove(stage: string, c: Counts, criteria = CRITERIA) {
  const poseidon = await buildPoseidon();
  const subject = subjectOf(SITE, RUN, stage);
  const salt = 4242n;
  const commitment = poseidon.F.toObject(poseidon([subject, c.good, c.scrap, c.startedAt, c.endedAt, salt])) as bigint;
  const { proof, publicSignals } = await groth16.fullProve({ subject, commitment, ...criteria, ...c, salt }, wasm, zkey, undefined, undefined, { singleThread: true });
  return { proof, publicSignals, subject, commitment };
}
/** snarkjs's proof as the verifier's calldata (B's coordinates are swapped for the precompile). */
const abiProof = (p: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }) => ({
  a: p.pi_a.slice(0, 2).map(BigInt) as [bigint, bigint],
  b: p.pi_b.slice(0, 2).map((x) => [BigInt(x[1]!), BigInt(x[0]!)]) as [[bigint, bigint], [bigint, bigint]],
  c: p.pi_c.slice(0, 2).map(BigInt) as [bigint, bigint],
});
const good: Counts = { good: 990n, scrap: 10n, startedAt: 1_760_000_000n, endedAt: 1_760_000_000n + 40n * 990n };

describe("stage-check circuit and OrdoStageVerifier", () => {
  let t: Awaited<ReturnType<typeof chain>>;
  let verifier: Awaited<ReturnType<typeof t.deploy>>;
  let harness: Awaited<ReturnType<typeof t.deploy>>;
  beforeAll(async () => {
    t = await chain();
    verifier = await t.deploy("OrdoStageVerifier", []);
    const specVerifier = await t.deploy("OrdoSpecVerifier", []);
    harness = await t.deploy("ProofsHarness", [verifier.address, specVerifier.address]);
  });
  const read = <T>(fn: string, args: unknown[]) => t.pub.readContract({ address: harness.address, abi: harness.abi, functionName: fn, args } as never) as Promise<T>;

  async function stageProof(stage: string, c: Counts, signer = 1) {
    const p = await prove(stage, c);
    const reading = { site: SITE, runId: RUN, stage, asset: "ast_cnc05", commitment: p.commitment, anchor: `0x${"aa".repeat(32)}` as Hex, signedAt: 1_760_100_000n };
    const readingSig = await t.wallet(signer).signTypedData({ domain: PROOF_DOMAIN, types: ORDO_READING, primaryType: "OrdoReading", message: reading });
    return { ...p, arg: { stage, asset: reading.asset, commitment: p.commitment, anchor: reading.anchor, signedAt: reading.signedAt, readingSig, ...abiProof(p.proof), kinds: CRITERIA.kind, ops: CRITERIA.op, targets: CRITERIA.target } };
  }

  it("verifies on-chain that a gateway-signed reading meets yield, scrap and cycle time, and folds it into the proof root", async () => {
    const s = await stageProof("02", good);
    expect(s.publicSignals.map(BigInt)).toEqual([s.subject, s.commitment, ...CRITERIA.kind, ...CRITERIA.op, ...CRITERIA.target]);
    expect(await read<bigint>("subjectOf", [SITE, RUN, "02"])).toBe(s.subject);
    const [attester, root] = await read<[Address, Hex]>("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, s.arg]);
    expect(attester).toBe(t.accounts[1]);
    const leaf = keccak256(
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256[4]" }, { type: "uint256[4]" }, { type: "uint256[4]" }, { type: "address" }], [s.subject, s.commitment, CRITERIA.kind, CRITERIA.op, CRITERIA.target, t.accounts[1]!]),
    );
    expect(root).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [`0x${"00".repeat(32)}`, leaf])));
  });

  it("a proof cannot be moved to another stage or lot, or checked against looser criteria", async () => {
    const s = await stageProof("02", good);
    await expect(read("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, { ...s.arg, stage: "03" }])).rejects.toThrow();
    await expect(read("checkStage", [SITE, "run_other", `0x${"00".repeat(32)}`, s.arg])).rejects.toThrow();
    await expect(read("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, { ...s.arg, targets: [950_000n, 20_000n, 450_000n, 0n] }])).rejects.toThrow();
    // a different commitment (counts edited after signing) is not what the gateway signed: another signer is recovered
    const [attester] = await read<[Address, Hex]>("checkStage", [SITE, RUN, `0x${"00".repeat(32)}`, s.arg]);
    expect(attester).toBe(t.accounts[1]);
  });

  it("cannot prove counts that miss a criterion", async () => {
    await expect(prove("02", { ...good, scrap: 30n })).rejects.toThrow(); // 97.0 % yield, 2.9 % scrap
    await expect(prove("02", { ...good, endedAt: good.startedAt + 50n * 990n })).rejects.toThrow(); // 50 s a part
    await expect(prove("02", { good: 0n, scrap: 0n, startedAt: 1n, endedAt: 2n }, { kind: [1n, 0n, 0n, 0n], op: [1n, 0n, 0n, 0n], target: [1_000_000n, 0n, 0n, 0n] })).rejects.toThrow(); // no units
    // defects in ppm and cycle time in minutes
    const ppm: typeof CRITERIA = { kind: [3n, 5n, 0n, 0n], op: [1n, 1n, 0n, 0n], target: [15_000n * 10_000n, 7_000n, 0n, 0n] };
    await expect(prove("02", good, ppm)).resolves.toBeTruthy(); // 10 000 ppm ≤ 15 000; 0.667 min ≤ 0.7
    await expect(prove("02", good, { ...ppm, target: [9_000n * 10_000n, 7_000n, 0n, 0n] })).rejects.toThrow();
  });

  /** A source-signed measurement and its spec-check proof: `value` (× 10⁴) meets `target` under `op`, committed as Poseidon(subject, value, salt). */
  async function paramProof(stage: string, criterion: string, value: bigint, op: bigint, target: bigint, signer = 1) {
    const poseidon = await buildPoseidon();
    const subject = specSubjectOf(RUN, stage, criterion);
    const salt = 777n;
    const commitment = poseidon.F.toObject(poseidon([subject, value, salt])) as bigint;
    const { proof, publicSignals } = await groth16.fullProve({ value, salt, subject, target, op, commitment }, specWasm, specZkey, undefined, undefined, { singleThread: true });
    const m = { site: SITE, runId: RUN, stage, asset: "ast_br01", criterion, commitment, anchor: `0x${"aa".repeat(32)}` as Hex, signedAt: 1_760_100_000n };
    const sig = await t.wallet(signer).signTypedData({ domain: PROOF_DOMAIN, types: ORDO_MEASUREMENT, primaryType: "OrdoMeasurement", message: m });
    return { subject, commitment, publicSignals, arg: { stage, asset: m.asset, criterion, commitment, anchor: m.anchor, signedAt: m.signedAt, sig, ...abiProof(proof), op, target } };
  }

  it("verifies on-chain that a gateway-signed measurement meets its bound, and folds both bounds of a range after the stages", async () => {
    // culture temperature stayed within 35–39 °C: the window minimum (36.1) is at least 35, the maximum (38.4) at most 39
    const lo = await paramProof("02", "Culture temperature", 361_000n, 0n, 350_000n);
    const hi = await paramProof("02", "Culture temperature#max", 384_000n, 1n, 390_000n);
    expect(hi.subject).toBe(lo.subject);
    expect(await read<bigint>("specSubjectOf", [RUN, "02", "Culture temperature#max"])).toBe(lo.subject);
    expect(lo.publicSignals.map(BigInt)).toEqual([lo.subject, 350_000n, 0n, lo.commitment]);
    const root0 = `0x${"11".repeat(32)}` as Hex; // whatever the stages folded to
    const [signer, root1] = await read<[Address, Hex]>("checkParam", [SITE, RUN, root0, lo.arg]);
    expect(signer).toBe(t.accounts[1]);
    const leaf = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], [keccak256(new TextEncoder().encode("ordo:param")), lo.subject, lo.commitment, 0n, 350_000n, t.accounts[1]!]),
    );
    expect(root1).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [root0, leaf])));
    const [, root2] = await read<[Address, Hex]>("checkParam", [SITE, RUN, root1, hi.arg]);
    expect(root2).not.toBe(root1);
    // a proof cannot be moved to another criterion, stage or lot, nor checked against a looser bound
    await expect(read("checkParam", [SITE, RUN, root0, { ...lo.arg, criterion: "Cell density" }])).rejects.toThrow();
    await expect(read("checkParam", [SITE, RUN, root0, { ...lo.arg, stage: "03" }])).rejects.toThrow();
    await expect(read("checkParam", [SITE, "run_other", root0, lo.arg])).rejects.toThrow();
    await expect(read("checkParam", [SITE, RUN, root0, { ...lo.arg, target: 340_000n }])).rejects.toThrow();
    // a value below the bound cannot be proven at all
    await expect(paramProof("02", "Culture temperature", 349_000n, 0n, 350_000n)).rejects.toThrow();
  });

  it("recovers each release signer only for exactly the lot, content and proof root it signed", async () => {
    const lot = { siteId: SITE, lotLabel: "lot-so-7781", packageId: "vp_1", runId: RUN, contentHash: `0x${"ab".repeat(32)}` as Hex, proofRoot: `0x${"cd".repeat(32)}` as Hex };
    const message = { site: SITE, packageId: "vp_1", runId: RUN, lot: lot.lotLabel, meaning: "approved", statement: "Approved by — VP-101", comment: "", contentHash: lot.contentHash, proofRoot: lot.proofRoot, nonce: "n1", deadline: 4_000_000_000n };
    const signature = await t.wallet(2).signTypedData({ domain: PROOF_DOMAIN, types: ORDO_RELEASE, primaryType: "OrdoRelease", message });
    expect(await read<Address>("releaseSigner", [{ ...message, signature }, lot, "approved"])).toBe(t.accounts[2]);
    await expect(read("releaseSigner", [{ ...message, signature }, { ...lot, contentHash: `0x${"00".repeat(32)}` }, "approved"])).rejects.toThrow();
  });
});
