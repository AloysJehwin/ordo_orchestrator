import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Groth16Proof } from "snarkjs";
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { PROOF_DOMAIN, READING_TYPES } from "../auth/auth.js";
import type { Db } from "../db/db.js";
import type { Criterion, CriterionKind } from "../domain/types.js";
import { kindOf } from "../pipelines/criteria.js";
import type { RunEngine } from "../pipelines/engine.js";
import { snark } from "./spec-proofs.js";

/**
 * Proof of work for each stage of a lot, from counts signed where they were made.
 *
 * A machine's gateway (or the operator, for a manual stage) signs an OrdoReading: a Poseidon commitment to the stage's
 * good and scrap units and its start and end, never the counts themselves (Readings checks and stores it). Here each
 * reading gets a Groth16 proof (circuits/stage_check.circom) that the committed counts meet the stage's criteria. The
 * proven stages of a lot fold into one proof root, which the three people who release the lot sign, and which
 * OrdoLotResolver re-checks stage by stage on-chain before it records the release.
 */

/** The BN254 scalar field: everything the circuit takes is an element of it. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const SCALE = 10_000n;
/** criteria slots in the circuit */
export const SLOTS = 4;
const OPS: Record<Criterion["op"], bigint> = { ">=": 0n, "<=": 1n, "==": 2n };
const MAX_ATTEMPTS = 3;
const VERIFY_TTL_MS = 60_000;
export const ZERO_ROOT = `0x${"00".repeat(32)}` as Hex;

/** The field element a stage's reading and proof are bound to: this site, this lot (run), this stage. */
export const stageSubject = (siteId: string, runId: string, stage: string) => BigInt(`0x${createHash("sha256").update(`ordo:stage:${siteId}:${runId}:${stage}`).digest("hex")}`) % FIELD;

let poseidonP: Promise<import("circomlibjs").Poseidon> | null = null;
/** Poseidon(subject, good, scrap, startedAt, endedAt, salt): what a reading commits to. */
export async function readingCommitment(subject: bigint, c: { good: bigint; scrap: bigint; startedAt: bigint; endedAt: bigint }, salt: bigint): Promise<bigint> {
  await snark(); // loads circomlibjs before snarkjs, so their curves do not clash
  poseidonP ??= import("circomlibjs").then((m) => m.buildPoseidon());
  const p = await poseidonP;
  return p.F.toObject(p([subject, c.good, c.scrap, c.startedAt, c.endedAt, salt])) as bigint;
}

/** One criterion as the circuit takes it: kind (1 yield %, 2 scrap %, 3 defects ppm, 4 cycle time s, 5 cycle time min), op, target × 10⁴. */
export interface Slot {
  label: string;
  kind: bigint;
  op: bigint;
  target: bigint;
}
/** Which criteria the circuit can prove, as slots; the rest (OEE, measured signals, anything not from counts and times) it cannot. A range is left to the spec proofs. */
export function slotOf(c: Criterion): Slot | null {
  const kinds: Partial<Record<CriterionKind, bigint>> = { yield: 1n, scrap_pct: 2n, defects_ppm: 3n, cycle_time: c.unit === "s" ? 4n : 5n };
  const kind = kinds[kindOf(c)] ?? null;
  if (kind === null || c.target < 0 || c.targetMax !== undefined) return null;
  const target = BigInt(Math.round(c.target * Number(SCALE)));
  if (Math.abs(c.target * Number(SCALE) - Number(target)) > 1e-6 || target >= 2n ** 64n) return null;
  return { label: c.label, kind, op: OPS[c.op], target };
}
/** The same comparison the circuit makes, in whole numbers: does this criterion hold for these counts? */
export function holds(s: Slot, c: { good: bigint; scrap: bigint; startedAt: bigint; endedAt: bigint }): boolean {
  const total = c.good + c.scrap;
  const dur = c.endedAt - c.startedAt;
  let l: bigint;
  let r: bigint;
  if (s.kind <= 3n) {
    if (total === 0n) return false;
    l = s.kind === 1n ? c.good * 1_000_000n : s.kind === 2n ? c.scrap * 1_000_000n : c.scrap * 10_000_000_000n;
    r = s.target * total;
  } else {
    if (c.good === 0n) return false;
    l = dur * SCALE;
    r = s.target * c.good * (s.kind === 5n ? 60n : 1n);
  }
  return s.op === 0n ? l >= r : s.op === 1n ? l <= r : l === r;
}

/** A stage proof as OrdoLotResolver.recordRelease takes it (OrdoProofs.StageProof). */
export interface StageProofArg {
  stage: string;
  asset: string;
  commitment: bigint;
  anchor: Hex;
  signedAt: bigint;
  readingSig: Hex;
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  kinds: [bigint, bigint, bigint, bigint];
  ops: [bigint, bigint, bigint, bigint];
  targets: [bigint, bigint, bigint, bigint];
}
/** root = keccak256(root, keccak256(subject, commitment, kinds, ops, targets, attester)), stage by stage (OrdoProofs.fold). */
export function foldRoot(root: Hex, subject: bigint, p: Pick<StageProofArg, "commitment" | "kinds" | "ops" | "targets">, attester: Address): Hex {
  const leaf = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256[4]" }, { type: "uint256[4]" }, { type: "uint256[4]" }, { type: "address" }], [subject, p.commitment, p.kinds, p.ops, p.targets, attester]),
  );
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [root, leaf]));
}

export interface ReadingRow {
  run_id: string;
  stage_code: string;
  site_id: string;
  asset_id: string | null;
  signer: string;
  signer_kind: "device" | "operator";
  good: number;
  scrap: number;
  started_at_s: string;
  ended_at_s: string;
  salt: string;
  subject: string;
  commitment: string;
  anchor: string;
  signed_at_s: string;
  signature: string;
  matches: boolean;
  ledger_seq: number | null;
}
interface ProofRow {
  run_id: string;
  stage_code: string;
  status: "pending" | "proven" | "failed" | "not_met";
  criteria_json: string;
  proof_json: string | null;
  error: string | null;
  attempts: number;
}

/** What the public passport shows for one stage: who signed its counts and the proof, never the counts. */
export interface StageProofView {
  stage: string;
  /** who signed the reading: the machine's gateway, or the operator for a manual stage */
  signer: string;
  signerKind: "device" | "operator";
  /** the counts the signer signed are the counts Ordo recorded */
  matches: boolean;
  commitment: string;
  /** the HCS ledger anchor the signer had seen: the reading is no older than it */
  anchor: string;
  signedAt: string;
  status: "proven" | "pending" | "failed" | "not_met";
  /** the criteria the proof covers */
  criteria: string[];
  system: "groth16-bn254";
  circuit: "stage_check";
  /** [subject, commitment, kind[4], op[4], target[4]] */
  publicSignals: string[] | null;
  proof: Groth16Proof | null;
  /** checked here just now: the reading's signature recovers the signer, and the proof verifies against its commitment */
  verified: boolean | null;
  detail: string;
  /** the signed OrdoReading, so anyone can recover its signer themselves */
  reading: { site: string; runId: string; stage: string; asset: string; commitment: string; anchor: string; signedAt: string; signature: string };
}

interface Artifacts {
  wasm: Uint8Array;
  zkey: Uint8Array;
  vkey: unknown;
  ceremony: unknown;
}
function loadArtifacts(): Artifacts | null {
  const dirs = [process.env.ORDO_ZK_DIR, fileURLToPath(new URL("../../zk/", import.meta.url)), fileURLToPath(new URL("./zk/", import.meta.url))].filter(Boolean) as string[];
  const dir = dirs.find((d) => existsSync(join(d, "stage_check.zkey")));
  if (!dir) return null;
  return {
    wasm: new Uint8Array(readFileSync(join(dir, "stage_check.wasm"))),
    zkey: new Uint8Array(readFileSync(join(dir, "stage_check.zkey"))),
    vkey: JSON.parse(readFileSync(join(dir, "stage_verification_key.json"), "utf8")),
    ceremony: existsSync(join(dir, "stage_check.ceremony.json")) ? JSON.parse(readFileSync(join(dir, "stage_check.ceremony.json"), "utf8")) : null,
  };
}

/** snarkjs's proof as the verifier's calldata (B's coordinates are swapped for the precompile). */
const abiProof = (p: Groth16Proof) => ({
  a: [BigInt(p.pi_a[0]!), BigInt(p.pi_a[1]!)] as [bigint, bigint],
  b: [
    [BigInt(p.pi_b[0]![1]!), BigInt(p.pi_b[0]![0]!)],
    [BigInt(p.pi_b[1]![1]!), BigInt(p.pi_b[1]![0]!)],
  ] as [[bigint, bigint], [bigint, bigint]],
  c: [BigInt(p.pi_c[0]!), BigInt(p.pi_c[1]!)] as [bigint, bigint],
});
const four = (xs: bigint[]) => [0, 1, 2, 3].map((i) => xs[i] ?? 0n) as [bigint, bigint, bigint, bigint];

export class StageProofs {
  private artifacts: Artifacts | null | undefined;
  private checked = new Map<string, { at: number; ok: boolean; detail: string }>();

  constructor(
    private db: Db,
    private engine: RunEngine,
    private now: () => number,
  ) {}

  private get zk() {
    if (this.artifacts === undefined) this.artifacts = loadArtifacts();
    return this.artifacts;
  }
  get enabled() {
    return this.zk !== null;
  }
  verificationKey() {
    return this.zk?.vkey ?? null;
  }
  ceremony() {
    return this.zk?.ceremony ?? null;
  }

  // ---------------------------------------------------------------- engine cycle
  /** Plan a proof for every new reading, then prove a few. */
  async reconcile(limit = 2): Promise<void> {
    if (!this.enabled) return;
    const fresh = await this.db.query<ReadingRow>("SELECT r.* FROM stage_readings r LEFT JOIN stage_proofs p ON p.run_id = r.run_id AND p.stage_code = r.stage_code WHERE p.run_id IS NULL LIMIT 20");
    for (const r of fresh.rows) await this.plan(r);
    const due = await this.db.query<ProofRow>("SELECT * FROM stage_proofs WHERE status = 'pending' ORDER BY created_at LIMIT $1", [limit]);
    for (const p of due.rows) await this.prove(p);
  }

  /** The stage's provable criteria, checked first against the signed counts so a miss says which criterion. */
  private async plan(r: ReadingRow) {
    const run = await this.engine.view(r.site_id, r.run_id);
    const stage = run.stages.find((s) => s.code === r.stage_code);
    const slots = (stage?.criteria ?? []).map(slotOf).filter((s): s is Slot => s !== null).slice(0, SLOTS);
    const counts = this.countsOf(r);
    const missed = slots.filter((s) => !holds(s, counts));
    await this.db.query("INSERT INTO stage_proofs (run_id, stage_code, status, criteria_json, error) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [
      r.run_id,
      r.stage_code,
      missed.length ? "not_met" : "pending",
      JSON.stringify(slots.map((s) => ({ ...s, kind: s.kind.toString(), op: s.op.toString(), target: s.target.toString() }))),
      missed.length ? `The signed counts do not meet: ${missed.map((s) => s.label).join(", ")}` : null,
    ]);
  }

  private countsOf(r: ReadingRow) {
    return { good: BigInt(r.good), scrap: BigInt(r.scrap), startedAt: BigInt(r.started_at_s), endedAt: BigInt(r.ended_at_s) };
  }
  private slotsOf(p: ProofRow) {
    const slots = (JSON.parse(p.criteria_json) as { label: string; kind: string; op: string; target: string }[]).map((s) => ({ label: s.label, kind: BigInt(s.kind), op: BigInt(s.op), target: BigInt(s.target) }));
    return { slots, kinds: four(slots.map((s) => s.kind)), ops: four(slots.map((s) => s.op)), targets: four(slots.map((s) => s.target)) };
  }

  private async prove(p: ProofRow) {
    const r = (await this.db.query<ReadingRow>("SELECT * FROM stage_readings WHERE run_id = $1 AND stage_code = $2", [p.run_id, p.stage_code])).rows[0];
    if (!r) return;
    const { kinds, ops, targets } = this.slotsOf(p);
    try {
      const snarkjs = await snark();
      const input: Record<string, string | string[]> = { subject: r.subject, commitment: r.commitment, kind: kinds.map(String), op: ops.map(String), target: targets.map(String), ...Object.fromEntries(Object.entries(this.countsOf(r)).map(([k, v]) => [k, v.toString()])), salt: r.salt };
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, this.zk!.wasm, this.zk!.zkey, undefined, undefined, { singleThread: true });
      await this.db.query("UPDATE stage_proofs SET status = 'proven', proof_json = $1, error = NULL, proven_at = now() WHERE run_id = $2 AND stage_code = $3", [JSON.stringify({ proof, publicSignals }), p.run_id, p.stage_code]);
    } catch (e) {
      const attempts = Number(p.attempts) + 1;
      await this.db.query("UPDATE stage_proofs SET status = $1, attempts = $2, error = $3 WHERE run_id = $4 AND stage_code = $5", [
        attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        e instanceof Error ? e.message : String(e),
        p.run_id,
        p.stage_code,
      ]);
    }
  }

  // ---------------------------------------------------------------- what a release carries
  /** The lot's stages whose signed reading is still being proven: a release waits for them, so its root includes them. */
  async pendingStages(runId: string): Promise<string[]> {
    if (!this.enabled) return [];
    const r = await this.db.query<{ stage_code: string }>(
      "SELECT r.stage_code FROM stage_readings r LEFT JOIN stage_proofs p ON p.run_id = r.run_id AND p.stage_code = r.stage_code WHERE r.run_id = $1 AND (p.status IS NULL OR p.status = 'pending') ORDER BY r.stage_code",
      [runId],
    );
    return r.rows.map((x) => x.stage_code);
  }

  /** The lot's proven stages (or just `only`), in stage order, as the release contract takes them, and the root they fold to. */
  async bundle(runId: string, only?: string[]): Promise<{ root: Hex; proofs: StageProofArg[]; stages: { stage: string; signer: string; subject: string; commitment: string }[] }> {
    const rows = await this.db.query<ReadingRow & { criteria_json: string; proof_json: string }>(
      "SELECT r.*, p.criteria_json, p.proof_json FROM stage_readings r JOIN stage_proofs p ON p.run_id = r.run_id AND p.stage_code = r.stage_code WHERE r.run_id = $1 AND p.status = 'proven' ORDER BY r.stage_code",
      [runId],
    );
    let root = ZERO_ROOT;
    const proofs: StageProofArg[] = [];
    const stages = [];
    for (const r of rows.rows) {
      if (only && !only.includes(r.stage_code)) continue;
      const { kinds, ops, targets } = this.slotsOf(r as unknown as ProofRow);
      const { proof } = JSON.parse(r.proof_json) as { proof: Groth16Proof };
      const arg: StageProofArg = { stage: r.stage_code, asset: r.asset_id ?? "", commitment: BigInt(r.commitment), anchor: r.anchor as Hex, signedAt: BigInt(r.signed_at_s), readingSig: r.signature as Hex, ...abiProof(proof), kinds, ops, targets };
      root = foldRoot(root, BigInt(r.subject), arg, r.signer as Address);
      proofs.push(arg);
      stages.push({ stage: r.stage_code, signer: r.signer, subject: r.subject, commitment: r.commitment });
    }
    return { root, proofs, stages };
  }

  // ---------------------------------------------------------------- reads
  /** Each stage of a lot that has a signed reading, with its proof, checked. */
  async forRun(runId: string): Promise<Map<string, StageProofView>> {
    const out = new Map<string, StageProofView>();
    const rows = await this.db.query<ReadingRow & { status: ProofRow["status"] | null; criteria_json: string | null; proof_json: string | null; error: string | null }>(
      "SELECT r.*, p.status, p.criteria_json, p.proof_json, p.error FROM stage_readings r LEFT JOIN stage_proofs p ON p.run_id = r.run_id AND p.stage_code = r.stage_code WHERE r.run_id = $1",
      [runId],
    );
    for (const r of rows.rows) {
      const proven = r.status === "proven" && r.proof_json ? (JSON.parse(r.proof_json) as { proof: Groth16Proof; publicSignals: string[] }) : null;
      const criteria = r.criteria_json ? (JSON.parse(r.criteria_json) as { label: string }[]).map((c) => c.label) : [];
      const base = {
        stage: r.stage_code,
        signer: r.signer,
        signerKind: r.signer_kind,
        matches: Boolean(r.matches),
        commitment: r.commitment,
        anchor: r.anchor,
        signedAt: new Date(Number(r.signed_at_s) * 1000).toISOString(),
        criteria,
        system: "groth16-bn254" as const,
        circuit: "stage_check" as const,
        reading: { site: r.site_id, runId: r.run_id, stage: r.stage_code, asset: r.asset_id ?? "", commitment: r.commitment, anchor: r.anchor, signedAt: String(r.signed_at_s), signature: r.signature },
      };
      if (proven) {
        const check = await this.check(r, proven);
        out.set(r.stage_code, { ...base, status: "proven", publicSignals: proven.publicSignals, proof: proven.proof, verified: check.ok, detail: check.detail });
      } else {
        const status = (r.status ?? "pending") as StageProofView["status"];
        const detail = status === "not_met" ? (r.error ?? "The signed counts do not meet the stage's criteria") : status === "failed" ? "The proof could not be generated" : "Signed at the source; the proof is being generated";
        out.set(r.stage_code, { ...base, status, publicSignals: null, proof: null, verified: null, detail });
      }
    }
    return out;
  }

  /** What anyone can check: the reading's signature recovers its signer, and the proof verifies for this subject and commitment. */
  private async check(r: ReadingRow, p: { proof: Groth16Proof; publicSignals: string[] }) {
    const key = `${r.run_id}|${r.stage_code}`;
    const hit = this.checked.get(key);
    if (hit && this.now() - hit.at < VERIFY_TTL_MS) return hit;
    let res: { ok: boolean; detail: string };
    const signer = await recoverTypedDataAddress({
      domain: PROOF_DOMAIN,
      types: READING_TYPES,
      primaryType: "OrdoReading",
      message: { site: r.site_id, runId: r.run_id, stage: r.stage_code, asset: r.asset_id ?? "", commitment: BigInt(r.commitment), anchor: r.anchor as Hex, signedAt: BigInt(r.signed_at_s) },
      signature: r.signature as Hex,
    }).catch(() => null);
    if (signer?.toLowerCase() !== r.signer.toLowerCase()) res = { ok: false, detail: "The reading's signature does not recover its signer" };
    else if (p.publicSignals[0] !== stageSubject(r.site_id, r.run_id, r.stage_code).toString() || p.publicSignals[1] !== r.commitment) res = { ok: false, detail: "The proof is for another stage or reading" };
    else {
      const snarkjs = await snark();
      const ok = await snarkjs.groth16.verify(this.zk!.vkey, p.publicSignals, p.proof).catch(() => false);
      res = { ok, detail: ok ? "Zero-knowledge proof verified against the commitment the signer signed" : "The proof does not verify" };
    }
    const v = { at: this.now(), ...res };
    this.checked.set(key, v);
    return v;
  }
}

