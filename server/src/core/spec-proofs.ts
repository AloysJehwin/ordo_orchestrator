import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Groth16Proof } from "snarkjs";
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, stringToBytes, type Address, type Hex } from "viem";
import { MEASUREMENT_TYPES, PROOF_DOMAIN } from "../auth/auth.js";
import type { Db } from "../db/db.js";
import type { Criterion } from "../domain/types.js";
import type { CriterionResult } from "../pipelines/criteria.js";
import type { Recorder } from "./recorder.js";

/** Measurements and targets go into the circuit as fixed point with four decimals, and must fit in 64 bits. */
export const SCALE = 10_000;
const MAX = 2n ** 64n;
const OPS: Record<Criterion["op"], number> = { ">=": 0, "<=": 1, "==": 2 };
/** The BN254 scalar field: everything the circuit takes is an element of it. */
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const VERIFY_TTL_MS = 60_000;

type Status = "committed" | "proven" | "failed" | "not_met" | "unprovable";
interface Row {
  run_id: string;
  stage_code: string;
  label: string;
  status: Status;
  subject: string | null;
  value: string | null;
  salt: string | null;
  target: string | null;
  op: number | null;
  commitment: string | null;
  ledger_seq: number | null;
  proof_json: string | null;
  error: string | null;
  /** who committed to the value: the instrument's gateway or the operator (a signed OrdoMeasurement), or null when Ordo did */
  signer: string | null;
  signer_kind: "device" | "operator" | null;
  /** the verification key the proof was made for; a new ceremony changes it, and the proof is made again */
  vkey_sha256: string | null;
}
/** The signed OrdoMeasurement behind a source-signed parameter, so anyone can recover its signer. */
export interface MeasurementRef {
  site: string;
  runId: string;
  stage: string;
  asset: string;
  criterion: string;
  commitment: string;
  anchor: string;
  signedAt: string;
  signature: string;
}
interface MeasurementRow {
  run_id: string;
  stage_code: string;
  label: string;
  site_id: string;
  asset_id: string | null;
  signer: string;
  signer_kind: "device" | "operator";
  value: string;
  salt: string;
  subject: string;
  commitment: string;
  anchor: string;
  signed_at_s: string;
  signature: string;
  matches: boolean;
}

/** What the public passport shows for one criterion: the proof and the public signals, never the measured value. */
export interface SpecProofView {
  status: "proven" | "pending" | "failed";
  /** who committed to the measured value: the instrument's gateway, the operator, or Ordo's server */
  signer: string | null;
  signerKind: "device" | "operator" | "ordo";
  /** the signed measurement when the source committed, so the signer can be recovered independently */
  measurement: MeasurementRef | null;
  /** Groth16 over BN254; verify with the key at /v1/public/zk/spec-check or OrdoSpecVerifier on-chain */
  system: "groth16-bn254";
  circuit: "spec_check";
  /** [subject, target × 10⁴, op (0 ≥, 1 ≤, 2 =), commitment] */
  publicSignals: string[] | null;
  proof: Groth16Proof | null;
  /** the ledger entry that recorded the commitment when the stage closed */
  ledgerSeq: number | null;
  /** checked here just now: the proof verifies, its commitment is the ledger's, and its subject and target are this criterion's */
  verified: boolean | null;
  detail: string;
}

/** A range criterion proves twice: its lower bound under the label, its upper bound under `label#max`, both on the criterion's subject. */
export const MAX_SUFFIX = "#max";
export const baseLabel = (label: string) => (label.endsWith(MAX_SUFFIX) ? label.slice(0, -MAX_SUFFIX.length) : label);
/** The field element a proof is bound to: this lot, this stage, this criterion. */
export function subjectOf(runId: string, stageCode: string, label: string): bigint {
  return BigInt(`0x${createHash("sha256").update(`ordo:spec:${runId}:${stageCode}:${baseLabel(label)}`).digest("hex")}`) % FIELD;
}
/** Fixed point for the circuit, rounding down: v ≥ t and v ≤ t survive the rounding exactly when t has ≤ 4 decimals. */
export function scaled(x: number): bigint | null {
  if (!Number.isFinite(x) || x < 0) return null;
  const s = BigInt(Math.floor(x * SCALE + 1e-9));
  return s < MAX ? s : null;
}

const MAX_PROVE_RETRIES = 3;

let poseidonP: Promise<import("circomlibjs").Poseidon> | null = null;
/** Poseidon(subject, value × 10⁴, salt): what a measurement commits to, and what the spec-check circuit opens. */
export async function specCommitment(subject: bigint, value: bigint, salt: bigint): Promise<bigint> {
  await snark();
  poseidonP ??= import("circomlibjs").then((m) => m.buildPoseidon());
  const p = await poseidonP;
  return p.F.toObject(p([subject, value, salt])) as bigint;
}

/** marks a parameter leaf in a release's proof root (OrdoProofs.PARAM_LEAF) */
export const PARAM_LEAF = keccak256(stringToBytes("ordo:param"));
/** A parameter proof as OrdoLotResolver.recordRelease takes it (OrdoProofs.ParamProof). */
export interface ParamProofArg {
  stage: string;
  asset: string;
  criterion: string;
  commitment: bigint;
  anchor: Hex;
  signedAt: bigint;
  sig: Hex;
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  op: bigint;
  target: bigint;
}
/** root = keccak256(root, keccak256(PARAM_LEAF, subject, commitment, op, target, signer)), after the stages (OrdoProofs.foldParam). */
export function foldParamRoot(root: Hex, subject: bigint, p: Pick<ParamProofArg, "commitment" | "op" | "target">, signer: Address): Hex {
  const leaf = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], [PARAM_LEAF, subject, p.commitment, p.op, p.target, signer]));
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [root, leaf]));
}
const abiProof = (p: Groth16Proof) => ({
  a: [BigInt(p.pi_a[0]!), BigInt(p.pi_a[1]!)] as [bigint, bigint],
  b: [
    [BigInt(p.pi_b[0]![1]!), BigInt(p.pi_b[0]![0]!)],
    [BigInt(p.pi_b[1]![1]!), BigInt(p.pi_b[1]![0]!)],
  ] as [[bigint, bigint], [bigint, bigint]],
  c: [BigInt(p.pi_c[0]!), BigInt(p.pi_c[1]!)] as [bigint, bigint],
});

let snarkjsReady: Promise<{ m: typeof import("snarkjs"); curve: unknown }> | null = null;
/**
 * snarkjs, on one thread: its worker threads cannot start from a bundled build (Vercel). Verification builds the
 * shared multi-threaded curve, so a single-threaded one is put in its place first. circomlibjs bundles its own
 * ffjavascript, which clears that shared global when it loads, so it loads first and the curve is put back on every call.
 */
export async function snark() {
  snarkjsReady ??= import("circomlibjs")
    .then(() => import("snarkjs"))
    .then(async (m) => ({ m, curve: await m.curves.getCurveFromName("bn128", { singleThread: true }) }));
  const { m, curve } = await snarkjsReady;
  (globalThis as { curve_bn128?: unknown }).curve_bn128 = curve;
  return m;
}

interface Artifacts {
  wasm: Uint8Array;
  zkey: Uint8Array;
  vkey: unknown;
  vkeySha256: string;
  /** every step of the trusted setup, when it was a public ceremony (zk-spec-setup.mjs) */
  ceremony: unknown;
}
/** The compiled circuit and its keys (server/zk, built by contracts/scripts/zk-spec-setup.mjs), wherever this build put them. */
function loadArtifacts(): Artifacts | null {
  const dirs = [process.env.ORDO_ZK_DIR, fileURLToPath(new URL("../../zk/", import.meta.url)), fileURLToPath(new URL("./zk/", import.meta.url))].filter(Boolean) as string[];
  const dir = dirs.find((d) => existsSync(join(d, "spec_check.zkey")));
  if (!dir) return null;
  const vkeyRaw = readFileSync(join(dir, "verification_key.json"));
  return {
    wasm: new Uint8Array(readFileSync(join(dir, "spec_check.wasm"))),
    zkey: new Uint8Array(readFileSync(join(dir, "spec_check.zkey"))),
    vkey: JSON.parse(vkeyRaw.toString("utf8")),
    vkeySha256: createHash("sha256").update(vkeyRaw).digest("hex"),
    ceremony: existsSync(join(dir, "spec_check.ceremony.json")) ? JSON.parse(readFileSync(join(dir, "spec_check.ceremony.json"), "utf8")) : null,
  };
}

/**
 * Zero-knowledge proof that a lot met its acceptance criteria, for the public passport, without the measurements.
 * When a stage closes, each measured criterion is committed as Poseidon(subject, value, salt) in the hash-chained
 * ledger (so it is anchored like everything else). Each criterion that passed then gets a Groth16 proof that the
 * committed value meets the target. The passport shows the proof and the commitment; the value and salt stay here.
 */
export class SpecProofs {
  private artifacts: Artifacts | null | undefined;
  private checked = new Map<string, { at: number; ok: boolean; detail: string }>();
  private retries = new Map<string, number>();

  constructor(
    private db: Db,
    private rec: Recorder,
    private now: () => number,
  ) {}

  private get zk() {
    if (this.artifacts === undefined) this.artifacts = loadArtifacts();
    return this.artifacts;
  }
  get enabled() {
    return this.zk !== null;
  }
  /** The Groth16 verification key, for anyone who wants to check a passport's proofs themselves. */
  verificationKey() {
    return this.zk?.vkey ?? null;
  }
  ceremony() {
    return this.zk?.ceremony ?? null;
  }

  private hash(subject: bigint, value: bigint, salt: bigint) {
    return specCommitment(subject, value, salt);
  }

  // ---------------------------------------------------------------- engine cycle
  /** Commit the criteria of stages that just closed, then prove a few that passed. */
  async reconcile(limit = 2): Promise<void> {
    if (!this.enabled) return;
    // a new trusted setup changes the key: proofs made for the old one are made again from the stored value and salt
    await this.db.query("UPDATE spec_proofs SET status = 'committed', proof_json = NULL, proven_at = NULL WHERE status = 'proven' AND (vkey_sha256 IS NULL OR vkey_sha256 <> $1)", [this.zk!.vkeySha256]);
    const stages = await this.db.query<{ run_id: string; code: string; data_json: string }>(
      `SELECT s.run_id, s.code, s.data_json FROM stage_runs s WHERE s.data_json LIKE '%"measured"%'
       AND NOT EXISTS (SELECT 1 FROM spec_proofs z WHERE z.run_id = s.run_id AND z.stage_code = s.code) LIMIT 20`,
    );
    for (const s of stages.rows) await this.commit(s.run_id, s.code, (JSON.parse(s.data_json) as { criteria?: CriterionResult[] }).criteria ?? []);
    const due = await this.db.query<Row>("SELECT * FROM spec_proofs WHERE status = 'committed' ORDER BY created_at LIMIT $1", [limit]);
    for (const r of due.rows) await this.prove(r);
    // a proof that failed (a timeout, a cold instance) is tried again a few times by this instance before it stays failed
    const failed = await this.db.query<Row>("SELECT * FROM spec_proofs WHERE status = 'failed' AND subject IS NOT NULL ORDER BY created_at LIMIT 5");
    for (const r of failed.rows) {
      const key = `${r.run_id}|${r.stage_code}|${r.label}`;
      const n = this.retries.get(key) ?? 0;
      if (n >= MAX_PROVE_RETRIES || due.rows.length) continue;
      this.retries.set(key, n + 1);
      await this.prove(r);
      break;
    }
  }

  private async commit(runId: string, stageCode: string, criteria: CriterionResult[]) {
    for (const c of criteria) {
      if (!c.measured) continue;
      await this.commitOne(runId, stageCode, c.label, c.ok, c.measured);
      // a range (or an envelope's window maximum) is a second statement over the same subject, with its own salt
      if (c.measuredMax) await this.commitOne(runId, stageCode, `${c.label}${MAX_SUFFIX}`, c.ok, c.measuredMax);
    }
  }

  /**
   * Commit one bound of one criterion. When its source signed a measurement whose value is the one Ordo recorded, the
   * commitment is the source's (its salt, its signature); otherwise Ordo commits to the value it holds.
   */
  private async commitOne(runId: string, stageCode: string, label: string, ok: boolean | null, m: { value: number; op: Criterion["op"]; target: number }, replace = false) {
    const value = scaled(m.value);
    const target = scaled(m.target);
    const exact = target !== null && Math.abs(m.target * SCALE - Number(target)) < 1e-6;
    let row: Partial<Row> & { status: Status };
    if (ok !== true) row = { status: "not_met" };
    else if (value === null || target === null || !exact) row = { status: "unprovable", error: "The measurement or target does not fit the circuit (non-negative, four decimals, 64 bits)" };
    else {
      const subject = subjectOf(runId, stageCode, label);
      const signed = (await this.db.query<MeasurementRow>("SELECT * FROM measurement_readings WHERE run_id = $1 AND stage_code = $2 AND label = $3 AND matches", [runId, stageCode, label])).rows[0];
      const own = signed?.value === value.toString() && signed.subject === subject.toString();
      const salt = own ? BigInt(signed.salt) : BigInt(`0x${randomBytes(31).toString("hex")}`);
      const commitment = own ? BigInt(signed.commitment) : await this.hash(subject, value, salt);
      const op = OPS[m.op];
      const entry = await this.rec.event("system:zk", "passport.spec_committed", `${runId}/${stageCode}`, {
        criterion: label,
        subject: subject.toString(),
        target: target.toString(),
        op,
        commitment: commitment.toString(),
        ...(own ? { signer: signed.signer, signerKind: signed.signer_kind } : {}),
      });
      row = { status: "committed", subject: subject.toString(), value: value.toString(), salt: salt.toString(), target: target.toString(), op, commitment: commitment.toString(), ledger_seq: entry.seq, signer: own ? signed.signer : null, signer_kind: own ? signed.signer_kind : null };
    }
    await this.db.query(
      `INSERT INTO spec_proofs (run_id, stage_code, label, status, subject, value, salt, target, op, commitment, ledger_seq, error, signer, signer_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (run_id, stage_code, label) DO ${replace ? "UPDATE SET status = EXCLUDED.status, salt = EXCLUDED.salt, commitment = EXCLUDED.commitment, ledger_seq = EXCLUDED.ledger_seq, signer = EXCLUDED.signer, signer_kind = EXCLUDED.signer_kind, proof_json = NULL, proven_at = NULL, error = NULL" : "NOTHING"}`,
      [runId, stageCode, label, row.status, row.subject ?? null, row.value ?? null, row.salt ?? null, row.target ?? null, row.op ?? null, row.commitment ?? null, row.ledger_seq ?? null, row.error ?? null, row.signer ?? null, row.signer_kind ?? null],
    );
  }

  /**
   * A source signed a measurement for a bound Ordo had already committed to itself: adopt the source's commitment, so the
   * proof (made again) opens what the instrument signed. Called by Readings once the measurement is checked and stored.
   */
  async adoptSigned(runId: string, stageCode: string, label: string): Promise<void> {
    if (!this.enabled) return;
    const st = (await this.db.query<{ data_json: string }>("SELECT data_json FROM stage_runs WHERE run_id = $1 AND code = $2", [runId, stageCode])).rows[0];
    const c = ((JSON.parse(st?.data_json ?? "{}") as { criteria?: CriterionResult[] }).criteria ?? []).find((x) => x.label === baseLabel(label));
    const m = label.endsWith(MAX_SUFFIX) ? c?.measuredMax : c?.measured;
    if (!c || !m) return;
    const have = (await this.db.query<{ signer: string | null }>("SELECT signer FROM spec_proofs WHERE run_id = $1 AND stage_code = $2 AND label = $3", [runId, stageCode, label])).rows[0];
    if (have?.signer) return; // already the source's
    await this.commitOne(runId, stageCode, label, c.ok, m, true);
  }

  private async prove(r: Row) {
    const zk = this.zk!;
    try {
      const snarkjs = await snark();
      const input = { value: r.value!, salt: r.salt!, subject: r.subject!, target: r.target!, op: String(r.op), commitment: r.commitment! };
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk.wasm, zk.zkey, undefined, undefined, { singleThread: true });
      await this.db.query("UPDATE spec_proofs SET status = 'proven', proof_json = $1, error = NULL, proven_at = now(), vkey_sha256 = $5 WHERE run_id = $2 AND stage_code = $3 AND label = $4", [
        JSON.stringify({ proof, publicSignals }),
        r.run_id,
        r.stage_code,
        r.label,
        zk.vkeySha256,
      ]);
    } catch (e) {
      await this.db.query("UPDATE spec_proofs SET status = 'failed', error = $1 WHERE run_id = $2 AND stage_code = $3 AND label = $4", [e instanceof Error ? e.message : String(e), r.run_id, r.stage_code, r.label]);
    }
  }

  // ---------------------------------------------------------------- what a release carries
  /**
   * The lot's source-signed parameter proofs (or just `only`, keyed `stage|label`), in stage and label order, as the
   * release contract takes them after the stage proofs, and the root they fold `root` to. Parameters Ordo committed to
   * itself stay off the chain: they are on the passport, but no source stands behind them.
   */
  async bundle(runId: string, root: Hex, only?: string[]): Promise<{ root: Hex; params: ParamProofArg[]; keys: string[] }> {
    const params: ParamProofArg[] = [];
    const keys: string[] = [];
    if (!this.enabled) return { root, params, keys };
    const rows = await this.db.query<Row & MeasurementRow>(
      `SELECT p.*, m.site_id, m.asset_id, m.anchor, m.signed_at_s, m.signature FROM spec_proofs p JOIN measurement_readings m ON m.run_id = p.run_id AND m.stage_code = p.stage_code AND m.label = p.label
       WHERE p.run_id = $1 AND p.status = 'proven' AND p.signer IS NOT NULL ORDER BY p.stage_code, p.label`,
      [runId],
    );
    for (const r of rows.rows) {
      const key = `${r.stage_code}|${r.label}`;
      if (only && !only.includes(key)) continue;
      const { proof } = JSON.parse(r.proof_json!) as { proof: Groth16Proof };
      const arg: ParamProofArg = { stage: r.stage_code, asset: r.asset_id ?? "", criterion: r.label, commitment: BigInt(r.commitment!), anchor: r.anchor as Hex, signedAt: BigInt(r.signed_at_s), sig: r.signature as Hex, ...abiProof(proof), op: BigInt(r.op!), target: BigInt(r.target!) };
      root = foldParamRoot(root, BigInt(r.subject!), arg, r.signer as Address);
      params.push(arg);
      keys.push(key);
    }
    return { root, params, keys };
  }

  // ---------------------------------------------------------------- reads
  /** Proofs for a lot's criteria, keyed `stageCode|label`, each checked against the proof system and the ledger. */
  async forRun(runId: string): Promise<Map<string, SpecProofView>> {
    const out = new Map<string, SpecProofView>();
    if (!this.enabled) return out;
    const rows = await this.db.query<Row & { m_site: string | null; m_asset: string | null; m_anchor: string | null; m_signed_at: string | null; m_signature: string | null }>(
      `SELECT p.*, m.site_id AS m_site, m.asset_id AS m_asset, m.anchor AS m_anchor, m.signed_at_s AS m_signed_at, m.signature AS m_signature FROM spec_proofs p
       LEFT JOIN measurement_readings m ON m.run_id = p.run_id AND m.stage_code = p.stage_code AND m.label = p.label AND p.signer IS NOT NULL
       WHERE p.run_id = $1 AND p.status IN ('committed', 'proven', 'failed')`,
      [runId],
    );
    for (const r of rows.rows) {
      const p = r.proof_json ? (JSON.parse(r.proof_json) as { proof: Groth16Proof; publicSignals: string[] }) : null;
      const measurement: MeasurementRef | null =
        r.signer && r.m_signature ? { site: r.m_site!, runId: r.run_id, stage: r.stage_code, asset: r.m_asset ?? "", criterion: r.label, commitment: r.commitment!, anchor: r.m_anchor!, signedAt: String(r.m_signed_at), signature: r.m_signature } : null;
      const base = { system: "groth16-bn254", circuit: "spec_check", ledgerSeq: r.ledger_seq === null ? null : Number(r.ledger_seq), signer: r.signer, signerKind: (r.signer ? r.signer_kind : "ordo") as SpecProofView["signerKind"], measurement } as const;
      if (r.status === "proven" && p) {
        const check = await this.check(r, p, measurement);
        out.set(`${r.stage_code}|${r.label}`, { ...base, status: "proven", publicSignals: p.publicSignals, proof: p.proof, verified: check.ok, detail: check.detail });
      } else
        out.set(`${r.stage_code}|${r.label}`, {
          ...base,
          status: r.status === "failed" ? "failed" : "pending",
          publicSignals: null,
          proof: null,
          verified: null,
          detail: r.status === "failed" ? "The proof could not be generated" : "Committed in the ledger; the proof is being generated",
        });
    }
    return out;
  }

  /** What anyone could check: the proof verifies, and its public signals are the ledger's commitment for this lot's criterion. */
  private async check(r: Row, p: { proof: Groth16Proof; publicSignals: string[] }, m: MeasurementRef | null) {
    const key = `${r.run_id}|${r.stage_code}|${r.label}`;
    const hit = this.checked.get(key);
    if (hit && this.now() - hit.at < VERIFY_TTL_MS) return hit;
    let res: { ok: boolean; detail: string };
    const [subject, target, op, commitment] = p.publicSignals;
    const entry = r.ledger_seq ? (await this.rec.ledger.range(Number(r.ledger_seq), Number(r.ledger_seq)))[0] : undefined;
    const recorded = entry?.payload as { commitment?: string; subject?: string; target?: string; op?: number } | undefined;
    const signer = m
      ? await recoverTypedDataAddress({
          domain: PROOF_DOMAIN,
          types: MEASUREMENT_TYPES,
          primaryType: "OrdoMeasurement",
          message: { site: m.site, runId: m.runId, stage: m.stage, asset: m.asset, criterion: m.criterion, commitment: BigInt(m.commitment), anchor: m.anchor as Hex, signedAt: BigInt(m.signedAt) },
          signature: m.signature as Hex,
        }).catch(() => null)
      : null;
    if (m && (signer?.toLowerCase() !== r.signer?.toLowerCase() || m.commitment !== commitment)) res = { ok: false, detail: "The measurement's signature does not recover its signer" };
    else if (subject !== subjectOf(r.run_id, r.stage_code, r.label).toString()) res = { ok: false, detail: "The proof is for another lot or criterion" };
    else if (target !== r.target || op !== String(r.op)) res = { ok: false, detail: "The proof is for another target" };
    else if (entry?.type !== "passport.spec_committed" || recorded?.commitment !== commitment || recorded?.subject !== subject || recorded?.target !== target || String(recorded?.op) !== op)
      res = { ok: false, detail: "The commitment does not match the ledger" };
    else {
      const snarkjs = await snark();
      const ok = await snarkjs.groth16.verify(this.zk!.vkey, p.publicSignals, p.proof).catch(() => false);
      res = { ok, detail: ok ? `Zero-knowledge proof verified against the commitment ${m ? `the ${r.signer_kind === "device" ? "instrument's gateway" : "operator"} signed, recorded` : ""} in ledger entry #${entry.seq}` : "The proof does not verify" };
    }
    const v = { at: this.now(), ...res };
    this.checked.set(key, v);
    return v;
  }
}
