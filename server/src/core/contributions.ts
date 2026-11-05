import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Signatures, TypedSignature, User } from "../auth/auth.js";
import { audioVia, type Receipt, type Router, type TrustMode } from "../chain/zg-router.js";
import type { Db } from "../db/db.js";
import { canonicalize as canonicalJson } from "../domain/canonical.js";
import type { AccessLevel, Criterion, StageRunView } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { kindOf } from "../pipelines/criteria.js";
import type { RunEngine } from "../pipelines/engine.js";
import { newId } from "../plant/plant.js";
import type { BodyService } from "./bodies.js";
import { KeyBox } from "./keybox.js";
import type { MachineOutputs } from "./outputs.js";
import type { Recorder } from "./recorder.js";
import type { Replicas, ReplicaView } from "./replicas.js";
import { scaled, specCommitment, subjectOf } from "./spec-proofs.js";
import { FIELD } from "./stage-proofs.js";

/** The two counts every contribution reports, besides the stage's own criteria */
export const GOOD = "Good units";
export const SCRAP = "Scrap units";
/** Stages that take no more proof of work: not started, skipped, or closed by a selection */
const CLOSED_STATES = new Set(["queued", "skipped"]);
const TOKEN_PREFIX = "opw1";
const MAX_RECEIPTS = 400;

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const SHA = z.string().regex(/^(sha256:)?[0-9a-f]{64}$/);
/** what the contributor says about the media the stage's machine captured for one outcome */
export const VERDICTS = ["confirm", "dispute", "unsure"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What the terminal agent posts when the contributor confirms the interview. */
export const FinishBody = z.object({
  summary: z.string().trim().min(1).max(4000),
  measurements: z.array(z.object({ criterion: z.string().min(1).max(120), value: z.number().finite(), unit: z.string().max(40).optional(), note: z.string().max(1000).optional() })).max(60),
  notes: z.array(z.object({ text: z.string().max(4000), at: z.string().max(40) })).max(200).default([]),
  evidence: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        sha256: SHA,
        size: z.number().int().min(0),
        /** the file's type as the agent detected it (image/png, audio/mpeg, …) */
        mediaType: z.string().max(100).optional(),
        /** the 0G model the contributor let read the file (an image to the chat model, a voice note to speech-to-text); unset: hash only */
        analyzedBy: z.object({ model: z.string().max(120), requestId: z.string().max(200).nullable().optional(), kind: z.enum(["vision", "transcription"]).optional() }).nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
  /** the contributor's verdict on each outcome the machine captured, bound to the file's hash they reviewed */
  confirmations: z
    .array(
      z.object({
        outcome: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
        sha256: SHA.nullable().optional(),
        verdict: z.enum(VERDICTS),
        /** the value the contributor observed for the outcome's metric, when they give one */
        observed: z.number().finite().nullable().optional(),
        note: z.string().max(2000).default(""),
      }),
    )
    .max(12)
    .default([]),
  /** voice notes transcribed through 0G (whisper): the transcript, the file's hash and the Router's request id */
  voiceNotes: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        sha256: SHA,
        size: z.number().int().min(0).optional(),
        mediaType: z.string().max(100).optional(),
        transcript: z.string().max(20_000),
        model: z.string().max(120),
        requestId: z.string().max(200).nullable(),
        at: z.string().max(40),
      }),
    )
    .max(20)
    .default([]),
  transcript: z.array(z.object({ role: z.enum(["assistant", "user"]), content: z.string().max(20_000), at: z.string().max(40) })).max(400).default([]),
  receipts: z
    .array(
      z
        .object({
          resKey: z.string().max(200).nullable().optional(),
          requestId: z.string().max(200).nullable().optional(),
          provider: z.string().max(100).nullable().optional(),
          providerIdentity: z.string().max(200).nullable().optional(),
          teeVerified: z.boolean().nullable().optional(),
          model: z.string().max(120).nullable().optional(),
          at: z.string().max(40),
          requestSha256: z.string().max(80),
          responseSha256: z.string().max(80),
        })
        .passthrough(),
    )
    .max(MAX_RECEIPTS)
    .default([]),
});
export type FinishBody = z.infer<typeof FinishBody>;

export type ContributionStatus = "unsigned" | "signed" | "selected" | "not_selected" | "withdrawn";

/** A proof of work as anyone may see it: who, when, the commitments and the TEE receipts, never the values. */
export interface ContributionView {
  id: string;
  siteId: string;
  runId: string;
  stageCode: string;
  contributor: { userId: string; address: string; name: string | null };
  status: ContributionStatus;
  createdAt: string;
  signedAt: string | null;
  recordSha256: string;
  measurements: { criterion: string; unit: string; commitment: string; subject: string; value?: number; note?: string }[];
  evidence: { name: string; sha256: string; size: number; mediaType?: string; analyzedBy?: { model: string; requestId?: string | null; kind?: string } | null }[];
  /** the machine media the record binds, one per outcome of the stage: the file the contributor reviewed, else the newest capture when they finished. The verdict from level 3. */
  outcomes: ContributionOutcome[];
  tee: TeeSummary;
  ledgerSeq: number | null;
  signatureId: string | null;
  replica: ReplicaView | null;
  selection: { by: string; byName: string | null; at: string; comment: string | null } | null;
  /** level 3 and up inside the org */
  summary?: string;
  /** level 3 and up: what the agent noted besides measurements */
  notes?: { text: string; at: string }[];
  /** level 3 and up: how many outcomes the contributor disputed */
  disputes?: number;
  /** level 3 and up: voice notes transcribed through 0G */
  voiceNotes?: SealedRecord["voiceNotes"];
  /** level 3 and up: what the agent asked the stage's machine, and its answers (relayed by Ordo) */
  machineQa?: SealedRecord["machineQa"];
}
/** One outcome of the stage as a proof of work binds it. */
export interface ContributionOutcome {
  outcome: string;
  label: string;
  media: string;
  /** the machine's file: the one reviewed, else the newest capture at finish; null when nothing was captured */
  sha256: string | null;
  version: number | null;
  /** level 3 and up (and the author): null when the contributor gave no verdict */
  verdict?: Verdict | null;
  observed?: number | null;
  note?: string;
  /** the value the machine read from that file */
  machineValue?: number | null;
}
export interface TeeSummary {
  network: string;
  /** which providers could serve: only `private` is a TEE (records from before trust modes have none: private) */
  trustMode?: TrustMode;
  model: string;
  turns: number;
  /** answers whose provider attestation the Router verified */
  verified: number;
  /** answers the Router reported as failing attestation */
  failed: number;
  providers: string[];
  /** every turn came from a TEE provider whose attestation the Router verified */
  allVerified: boolean;
}

interface SessionRow {
  id: string;
  site_id: string;
  user_id: string;
  run_id: string;
  stage_code: string;
  router_network: string;
  router_model: string;
  router_trust_mode: TrustMode;
  router_key_id: string | null;
  router_key_sealed: string | null;
  status: "open" | "submitted" | "signed" | "expired" | "cancelled";
  contribution_id: string | null;
  expires_at: string;
  machine_qa_json: string | null;
}
interface Row {
  id: string;
  site_id: string;
  run_id: string;
  stage_code: string;
  user_id: string;
  address: string;
  name: string | null;
  status: ContributionStatus;
  summary: string;
  measurements_json: string;
  evidence_json: string;
  tee_json: string;
  sealed: string;
  record_sha256: string;
  signature_id: string | null;
  signed_at: string | null;
  ledger_seq: number | null;
  replica_sha256: string | null;
  selected_by: string | null;
  selected_by_name: string | null;
  selected_at: string | null;
  select_comment: string | null;
  created_at: string;
  outcomes_json: string | null;
  disputes: number | null;
}
/** The full record, sealed per org: the values and salts behind the commitments, the conversation and the notes. */
export interface SealedRecord {
  /** 2 adds the machine's media (hashes), the contributor's verdicts, voice notes and the machine's answers */
  version: 1 | 2;
  contributionId: string;
  site: string;
  runId: string;
  stage: string;
  contributor: string;
  summary: string;
  measurements: { criterion: string; label: string; value: number; scaled: string; salt: string; subject: string; commitment: string; unit: string; note?: string }[];
  notes: { text: string; at: string }[];
  evidence: ContributionView["evidence"];
  transcript: { role: string; content: string; at: string }[];
  receipts: (Receipt & Record<string, unknown>)[];
  /** the newest file the machine had captured for each outcome when the contributor finished */
  machineOutputs?: { outcome: string; sha256: string; version: number; device: string; capturedAt: string }[];
  /** the contributor's verdicts, each bound to the file they reviewed */
  confirmations?: { outcome: string; label: string; sha256: string | null; version: number | null; machineValue: number | null; verdict: Verdict; observed: number | null; note: string }[];
  voiceNotes?: FinishBody["voiceNotes"];
  machineQa?: MachineAnswer[];
}
/** A question the terminal agent asked the stage's machine, and its answer, as Ordo relayed it. */
export interface MachineAnswer {
  question: string;
  answer: string;
  requestId: string | null;
  model: string | null;
  at: string;
}
/** The most questions one session may ask the stage's machine (each is a 0G call the machine pays for) */
const MAX_MACHINE_QUESTIONS = 30;

/**
 * The criteria a contributor reports on, as the terminal agent is told them. An outcome's metric is not one: the stage's
 * machine reads and signs it, and the contributor confirms or disputes that reading instead (`confirmations`).
 */
function reportable(st: StageRunView, quantity: number) {
  const criteria = st.criteria.filter((c) => !c.outcome).map((c) =>({ label: c.label, kind: kindOf(c), op: c.op, target: c.target, targetMax: c.targetMax ?? null, unit: c.unit, signal: c.signal ?? null }));
  return [
    { label: GOOD, kind: "count", op: ">=" as Criterion["op"], target: quantity, targetMax: null, unit: "units", signal: null },
    { label: SCRAP, kind: "count", op: "<=" as Criterion["op"], target: 0, targetMax: null, unit: "units", signal: null },
    ...criteria,
  ];
}

const SELECT = `SELECT c.*, u.display_name AS name, s.display_name AS selected_by_name FROM contributions c JOIN users u ON u.id = c.user_id LEFT JOIN users s ON s.address = c.selected_by`;

/**
 * Proof of work through 0G Private Computer. A member opens a running stage and starts a session: Ordo mints a
 * short-lived Router key pinned to TEE providers and hands back a one-line command with an opaque token. The terminal
 * agent fetches the stage and the key with the token, interviews the contributor through the Router, and posts the
 * record; Ordo commits each measured value with Poseidon, seals the record per org, revokes the key, and returns a
 * signing link. Once the contributor signs it with their wallet, the proof of work is in the ledger and a sealed copy
 * goes to 0G Storage. A stage takes any number of contributions; a validator selects the valid one.
 */
export class Contributions {
  /** Called with the contribution a validator selected, to close the stage from it (set by the selection flow). */
  replicas: Replicas | null = null;
  /** the media the stages' machines captured, which the terminal agent shows the contributor (set in wiring) */
  outputs: MachineOutputs | null = null;

  constructor(
    private db: Db,
    private engine: RunEngine,
    private rec: Recorder,
    private sigs: Signatures,
    readonly router: Router,
    private secret: string,
    private pkg: string,
    private sessionMs: number,
    private now: () => number,
  ) {}

  private box(siteId: string) {
    return new KeyBox(`contribution:${siteId}`, this.secret);
  }

  // ---------------------------------------------------------------- sessions (console side)

  /** Start a session for this member on this stage; returns the command they paste into a terminal. */
  async start(siteId: string, user: User, runId: string, stageCode: string, base: string) {
    const run = await this.engine.view(siteId, runId);
    const st = run.stages.find((s) => s.code === stageCode);
    if (!st) throw new HttpError(404, "Stage not found");
    await this.assertOpen(siteId, runId, st);
    // one open session per person and stage: a new one replaces the old
    const old = await this.db.query<{ id: string }>("SELECT id FROM contribution_sessions WHERE site_id = $1 AND user_id = $2 AND run_id = $3 AND stage_code = $4 AND status = 'open'", [siteId, user.id, runId, stageCode]);
    for (const o of old.rows) await this.close(o.id, "cancelled");
    const key = await this.router.mintSessionKey(`ordo ${run.orderRef} ${stageCode}`, this.sessionMs).catch((e: Error) => {
      throw new HttpError(502, `Could not get a 0G Private Computer key: ${e.message}`);
    });
    const id = newId("pows");
    const secret = randomBytes(24).toString("base64url");
    const expiresAt = new Date(this.now() + this.sessionMs);
    await this.db.query(
      `INSERT INTO contribution_sessions (id, site_id, user_id, run_id, stage_code, secret_hash, router_network, router_model, router_trust_mode, router_key_id, router_key_sealed, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, siteId, user.id, runId, stageCode, sha256(secret), this.router.network, this.router.model, this.router.trustMode, key.keyId, this.box(siteId).seal(key.key), expiresAt],
    );
    const token = `${TOKEN_PREFIX}.${b64url(base.replace(/\/$/, ""))}.${secret}`;
    return {
      sessionId: id,
      expiresAt: expiresAt.toISOString(),
      token,
      command: `npx ${this.pkg}@latest ${token}`,
      router: { network: this.router.network, model: this.router.model, trustMode: this.router.trustMode },
    };
  }

  private async assertOpen(siteId: string, runId: string, st: StageRunView) {
    if (CLOSED_STATES.has(st.state)) throw new HttpError(409, `Stage ${st.code} is ${st.state.replaceAll("_", " ")}: it takes proof of work once it runs`);
    const sel = await this.db.query("SELECT 1 FROM contributions WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 AND status = 'selected'", [siteId, runId, st.code]);
    if (sel.rows.length) throw new HttpError(409, `A validator already selected the proof of work for ${st.code}`);
  }

  /** My sessions that are still open, so the console can show the command again. */
  async mySessions(siteId: string, userId: string) {
    const r = await this.db.query<{ id: string; run_id: string; stage_code: string; status: string; expires_at: string; contribution_id: string | null; created_at: string }>(
      "SELECT id, run_id, stage_code, status, expires_at::text, contribution_id, created_at::text FROM contribution_sessions WHERE site_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 30",
      [siteId, userId],
    );
    return r.rows.map((x) => ({ id: x.id, runId: x.run_id, stageCode: x.stage_code, status: x.status, expiresAt: new Date(x.expires_at).toISOString(), contributionId: x.contribution_id, createdAt: new Date(x.created_at).toISOString() }));
  }

  async cancel(siteId: string, userId: string, sessionId: string) {
    const r = await this.db.query<{ id: string }>("SELECT id FROM contribution_sessions WHERE id = $1 AND site_id = $2 AND user_id = $3 AND status = 'open'", [sessionId, siteId, userId]);
    if (!r.rows[0]) throw new HttpError(404, "No open session");
    await this.close(sessionId, "cancelled");
  }

  /** A selection closed the stage: open sessions on it end and their keys are revoked. */
  async closeStageSessions(siteId: string, runId: string, stageCode: string) {
    const r = await this.db.query<{ id: string }>("SELECT id FROM contribution_sessions WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 AND status = 'open'", [siteId, runId, stageCode]);
    for (const s of r.rows) await this.close(s.id, "cancelled");
  }

  /** Close a session and revoke its Router key (best effort: an expired key stops working anyway). */
  private async close(sessionId: string, status: SessionRow["status"]) {
    const r = await this.db.query<{ router_key_id: string | null; key_revoked_at: string | null }>(
      "UPDATE contribution_sessions SET status = $2, closed_at = COALESCE(closed_at, now()) WHERE id = $1 RETURNING router_key_id, key_revoked_at::text",
      [sessionId, status],
    );
    await this.revoke(sessionId, r.rows[0]?.router_key_id ?? null, r.rows[0]?.key_revoked_at ?? null);
  }
  private async revoke(sessionId: string, keyId: string | null, revokedAt: string | null) {
    if (!keyId || revokedAt) return;
    try {
      await this.router.revokeKey(keyId);
      await this.db.query("UPDATE contribution_sessions SET key_revoked_at = now(), router_key_sealed = NULL WHERE id = $1", [sessionId]);
    } catch (e) {
      console.error("[ordo] revoke router key", e);
    }
  }

  // ---------------------------------------------------------------- sessions (terminal side, by token)

  private async bySecret(secret: string): Promise<SessionRow> {
    if (!secret || secret.length < 20) throw new HttpError(401, "Missing session token");
    const r = await this.db.query<SessionRow>("SELECT *, expires_at::text FROM contribution_sessions WHERE secret_hash = $1", [sha256(secret)]);
    const s = r.rows[0];
    if (!s) throw new HttpError(404, "Unknown session. Start a new one from the stage in the console.");
    if (s.status === "open" && Date.parse(s.expires_at) <= this.now()) {
      await this.close(s.id, "expired");
      s.status = "expired";
    }
    if (s.status === "expired" || s.status === "cancelled") throw new HttpError(410, `This session ${s.status === "expired" ? "expired" : "was replaced or cancelled"}. Start a new one from the stage in the console.`);
    return s;
  }

  /**
   * What the terminal agent needs: the org, the stage and what to ask about, the Router key, and the stage's outcomes
   * with what its machine captured for each (the file's hash, the value it read, its on-board agent's 0G reading). The
   * files themselves come from `sessionOutput`, behind the same token.
   */
  async sessionInfo(secret: string, bodies: BodyService | null = null) {
    const s = await this.bySecret(secret);
    const run = await this.engine.view(s.site_id, s.run_id);
    const st = run.stages.find((x) => x.code === s.stage_code);
    if (!st) throw new HttpError(404, "Stage not found");
    const site = (await this.db.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [s.site_id])).rows[0];
    const user = (await this.db.query<{ address: string; display_name: string | null }>("SELECT address, display_name FROM users WHERE id = $1", [s.user_id])).rows[0]!;
    const criteria = reportable(st, run.quantity);
    const parameters = st.criteria.filter((c) => c.signal && !c.outcome).map((c) => ({ signal: c.signal!, unit: c.unit || undefined, label: c.label }));
    const open = s.status === "open";
    const outcomes = await this.sessionOutcomes(s.site_id, run.id, st);
    const machine = st.assetId ? { id: st.assetId, name: st.assetName, answers: Boolean(bodies) } : null;
    return {
      sessionId: s.id,
      status: s.status,
      expiresAt: new Date(s.expires_at).toISOString(),
      org: { id: s.site_id, name: site?.name ?? s.site_id },
      contributor: { address: user.address, name: user.display_name },
      stage: { runId: run.id, orderRef: run.orderRef, templateName: run.templateName, code: st.code, name: st.name, state: st.state, resource: st.resourceKind, assetName: st.assetName, quantity: run.quantity, criteria, parameters, outcomes, machine },
      guide: guideFor(run.templateName, run.templateDescription, st, criteria),
      router: {
        baseUrl: this.router.baseUrl,
        apiKey: open && s.router_key_sealed ? this.box(s.site_id).unseal(s.router_key_sealed) : "",
        model: s.router_model,
        audioModel: this.router.audioModel,
        audioVia: audioVia(this.router.audioModel),
        trustMode: s.router_trust_mode ?? "private",
        network: s.router_network,
      },
    };
  }

  /** The stage's outcomes for the terminal agent: each with the newest file its machine captured, if any. */
  private async sessionOutcomes(siteId: string, runId: string, st: StageRunView) {
    if (!st.outcomes.length) return [];
    const views = this.outputs ? await this.outputs.forStage(siteId, runId, st, 3) : null;
    return st.outcomes.map((o) => {
      const v = views?.find((x) => x.key === o.key);
      const out = v?.output ?? null;
      return {
        key: o.key,
        label: o.label,
        media: o.media,
        mediaLabel: v?.mediaLabel ?? o.media,
        instrument: o.instrument,
        required: o.required,
        metric: o.metric,
        ok: v?.ok ?? null,
        captured: Boolean(v?.captured),
        capturedAt: v?.capturedAt ?? null,
        output: out
          ? { version: out.version, versions: out.versions, mime: out.mime, size: out.size, sha256: out.sha256, hasPreview: out.hasPreview, value: out.value, device: out.device, analysis: out.analysis ?? null }
          : null,
      };
    });
  }

  /** A file the stage's machine captured (or its preview: the video's keyframe, the audio's spectrogram, a chart), for the terminal agent. */
  async sessionOutput(secret: string, key: string, which: "file" | "preview", version?: number) {
    const s = await this.bySecret(secret);
    if (s.status !== "open") throw new HttpError(409, "This session is finished");
    if (!this.outputs) throw new HttpError(404, "Nothing captured for this outcome");
    return this.outputs.file(s.site_id, s.run_id, s.stage_code, key, which, version);
  }

  /**
   * Relay a question from the interviewer to the stage's machine: its body answers from its own episode log through
   * 0G. Ordo keeps every question and answer with the session; they go into the sealed record when it is finished.
   */
  async askMachine(secret: string, question: string, bodies: BodyService | null): Promise<MachineAnswer & { machine: { id: string; name: string | null } }> {
    const s = await this.bySecret(secret);
    if (s.status !== "open") throw new HttpError(409, "This session is finished");
    const run = await this.engine.view(s.site_id, s.run_id);
    const st = run.stages.find((x) => x.code === s.stage_code);
    if (!st) throw new HttpError(404, "Stage not found");
    if (!st.assetId) throw new HttpError(409, "This stage has no machine to ask");
    if (!bodies) throw new HttpError(503, "This stage's machine has no running body");
    const asked = JSON.parse(s.machine_qa_json ?? "[]") as MachineAnswer[];
    if (asked.length >= MAX_MACHINE_QUESTIONS) throw new HttpError(429, `A session may ask the machine ${MAX_MACHINE_QUESTIONS} questions`);
    const a = await bodies.ask(s.site_id, st.assetId, question).catch((e: Error) => {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `The machine did not answer: ${e.message}`);
    });
    const entry: MachineAnswer = { question, answer: a.answer.slice(0, 8000), requestId: a.requestId, model: a.model, at: new Date(this.now()).toISOString() };
    await this.db.query("UPDATE contribution_sessions SET machine_qa_json = (COALESCE(machine_qa_json, '[]')::jsonb || $2::jsonb)::text WHERE id = $1", [s.id, JSON.stringify([entry])]);
    return { ...entry, machine: { id: st.assetId, name: st.assetName } };
  }

  /** The interview is over: commit, seal and keep the record, revoke the key, and hand back the signing link. */
  async finish(secret: string, body: FinishBody, base: string) {
    const s = await this.bySecret(secret);
    if (s.status !== "open") {
      if (s.contribution_id) return { contributionId: s.contribution_id, signUrl: signUrl(base, s.site_id, s.contribution_id) };
      throw new HttpError(409, "This session is already finished");
    }
    const run = await this.engine.view(s.site_id, s.run_id);
    const st = run.stages.find((x) => x.code === s.stage_code);
    if (!st) throw new HttpError(404, "Stage not found");
    await this.assertOpen(s.site_id, s.run_id, st);
    const criteria = reportable(st, run.quantity);
    const user = (await this.db.query<{ address: string }>("SELECT address FROM users WHERE id = $1", [s.user_id])).rows[0]!;
    const id = newId("pow");

    // each measured value: Poseidon(subject, value × 10⁴, salt), the commitment the spec-check circuit opens
    const seen = new Set<string>();
    const measurements: SealedRecord["measurements"] = [];
    for (const m of body.measurements) {
      const c = criteria.find((x) => x.label === m.criterion) ?? criteria.find((x) => x.signal === m.criterion);
      if (!c) throw new HttpError(400, `${m.criterion} is not a criterion or parameter of stage ${st.code}`);
      if (seen.has(c.label)) throw new HttpError(400, `${c.label} is reported twice`);
      seen.add(c.label);
      const v = scaled(m.value);
      if (v === null) throw new HttpError(400, `${c.label}: a measurement is a non-negative number`);
      if ((c.label === GOOD || c.label === SCRAP) && !Number.isInteger(m.value)) throw new HttpError(400, `${c.label} is a whole number`);
      const subject = subjectOf(s.run_id, st.code, c.label);
      const salt = BigInt(`0x${randomBytes(31).toString("hex")}`) % FIELD;
      const commitment = await specCommitment(subject, v, salt);
      measurements.push({ criterion: m.criterion, label: c.label, value: m.value, scaled: v.toString(), salt: salt.toString(), subject: subject.toString(), commitment: commitment.toString(), unit: m.unit ?? c.unit, note: m.note });
    }
    const evidence: SealedRecord["evidence"] = body.evidence.map((e) => ({
      name: e.name,
      sha256: `sha256:${e.sha256.replace(/^sha256:/, "")}`,
      size: e.size,
      ...(e.mediaType ? { mediaType: e.mediaType } : {}),
      ...(e.analyzedBy ? { analyzedBy: e.analyzedBy } : {}),
    }));
    const receipts = body.receipts as SealedRecord["receipts"];
    const tee = teeSummary(s.router_network, s.router_model, receipts, s.router_trust_mode ?? "private");
    const media = await this.bindMedia(s.site_id, s.run_id, st, body.confirmations);
    const machineQa = JSON.parse(s.machine_qa_json ?? "[]") as MachineAnswer[];
    const voiceNotes = body.voiceNotes.map((v) => ({ ...v, sha256: `sha256:${v.sha256.replace(/^sha256:/, "")}` }));
    // the machine's media hashes, the verdicts, voice notes and the machine's answers are part of what the contributor signs (version 2)
    const extra = {
      ...(media.machineOutputs.length ? { machineOutputs: media.machineOutputs } : {}),
      ...(media.confirmations.length ? { confirmations: media.confirmations } : {}),
      ...(voiceNotes.length ? { voiceNotes } : {}),
      ...(machineQa.length ? { machineQa } : {}),
    };
    const record: SealedRecord = {
      version: Object.keys(extra).length ? 2 : 1,
      contributionId: id,
      site: s.site_id,
      runId: s.run_id,
      stage: st.code,
      contributor: user.address,
      summary: body.summary,
      measurements,
      notes: body.notes,
      evidence,
      transcript: body.transcript,
      receipts,
      ...extra,
    };
    const json = canonicalJson(record);
    const recordSha = sha256(json);
    const publicMeasurements = measurements.map((m) => ({ criterion: m.label, unit: m.unit, subject: m.subject, commitment: m.commitment }));
    await this.db.tx(async (q) => {
      const upd = await q.query("UPDATE contribution_sessions SET status = 'submitted', contribution_id = $2 WHERE id = $1 AND status = 'open' RETURNING id", [s.id, id]);
      if (!upd.rows.length) throw new HttpError(409, "This session is already finished");
      await q.query(
        `INSERT INTO contributions (id, site_id, run_id, stage_code, user_id, address, session_id, status, summary, measurements_json, evidence_json, receipts_json, tee_json, sealed, record_sha256, outcomes_json, disputes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'unsigned',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id,
          s.site_id,
          s.run_id,
          st.code,
          s.user_id,
          user.address,
          s.id,
          this.box(s.site_id).seal(body.summary),
          JSON.stringify(publicMeasurements),
          JSON.stringify(evidence),
          JSON.stringify(receipts.map(publicReceipt)),
          JSON.stringify(tee),
          this.box(s.site_id).seal(json),
          `sha256:${recordSha}`,
          JSON.stringify(media.outcomes),
          media.confirmations.filter((c) => c.verdict === "dispute").length,
        ],
      );
    });
    // the interview is over: the key is no longer needed
    await this.revoke(s.id, s.router_key_id, null);
    return { contributionId: id, signUrl: signUrl(base, s.site_id, id) };
  }

  /**
   * The machine media a record binds. Each verdict names an outcome of the stage and, when it names a file, one the
   * machine captured for that outcome (any version); "confirm" must name one. Every outcome then gets one public entry:
   * the file reviewed, else the newest capture when the contributor finished.
   */
  private async bindMedia(siteId: string, runId: string, st: StageRunView, given: FinishBody["confirmations"]) {
    const captures = (
      await this.db.query<{ outcome_key: string; version: number; sha256: string; value_scaled: string; device: string; captured_at: string }>(
        "SELECT outcome_key, version, sha256, value_scaled, device, captured_at::text FROM stage_outputs WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 ORDER BY version DESC",
        [siteId, runId, st.code],
      )
    ).rows;
    const latest = new Map<string, (typeof captures)[number]>();
    for (const r of captures) if (!latest.has(r.outcome_key)) latest.set(r.outcome_key, r);
    const confirmations: NonNullable<SealedRecord["confirmations"]> = [];
    for (const k of given) {
      const o = st.outcomes.find((x) => x.key === k.outcome);
      if (!o) throw new HttpError(400, `${k.outcome} is not an outcome of stage ${st.code}`);
      if (confirmations.some((c) => c.outcome === o.key)) throw new HttpError(400, `${o.label} has two verdicts`);
      const sha = k.sha256 ? `sha256:${k.sha256.replace(/^sha256:/, "")}` : null;
      const cap = sha ? captures.find((r) => r.outcome_key === o.key && r.sha256 === sha) : undefined;
      if (sha && !cap) throw new HttpError(400, `${o.label}: ${sha.slice(0, 19)}… is not a file the machine captured for it`);
      if (k.verdict === "confirm" && !cap) throw new HttpError(400, `${o.label}: a confirmation names the machine's file it confirms (sha256)`);
      confirmations.push({
        outcome: o.key,
        label: o.label,
        sha256: sha,
        version: cap ? Number(cap.version) : null,
        machineValue: cap ? Number(BigInt(cap.value_scaled)) / 1e4 : null,
        verdict: k.verdict,
        observed: k.observed ?? null,
        note: k.note.trim(),
      });
    }
    const machineOutputs = st.outcomes.flatMap((o) => {
      const r = latest.get(o.key);
      return r ? [{ outcome: o.key, sha256: r.sha256, version: Number(r.version), device: r.device, capturedAt: new Date(r.captured_at).toISOString() }] : [];
    });
    const outcomes: ContributionOutcome[] = st.outcomes.map((o) => {
      const c = confirmations.find((x) => x.outcome === o.key);
      const m = machineOutputs.find((x) => x.outcome === o.key);
      return { outcome: o.key, label: o.label, media: o.media, sha256: c?.sha256 ?? m?.sha256 ?? null, version: c?.sha256 ? c.version : (m?.version ?? null), verdict: c?.verdict ?? null };
    });
    return { confirmations, machineOutputs, outcomes };
  }

  async status(secret: string, base: string) {
    const s = await this.bySecret(secret).catch((e: HttpError) => {
      if (e.status === 410) return null;
      throw e;
    });
    if (!s) return { status: "expired" as const, contributionId: null, signUrl: null, proofUrl: null };
    const c = s.contribution_id ? (await this.db.query<{ status: string }>("SELECT status FROM contributions WHERE id = $1", [s.contribution_id])).rows[0] : null;
    const signed = c && c.status !== "unsigned";
    return {
      status: signed ? ("signed" as const) : s.status === "submitted" ? ("submitted" as const) : ("open" as const),
      contributionId: s.contribution_id,
      signUrl: s.contribution_id ? signUrl(base, s.site_id, s.contribution_id) : null,
      proofUrl: s.contribution_id && signed ? proofUrl(base, s.contribution_id) : null,
    };
  }

  // ---------------------------------------------------------------- signing (console side)

  private async row(siteId: string, id: string): Promise<Row> {
    const r = await this.db.query<Row>(`${SELECT} WHERE c.id = $1 AND c.site_id = $2`, [id, siteId]);
    if (!r.rows[0]) throw new HttpError(404, "Proof of work not found");
    return r.rows[0];
  }

  /** What the contributor signs: that this record, by its hash, is their work on this stage. */
  async signRequest(siteId: string, user: User, id: string, chainId: number): Promise<TypedSignature> {
    const c = await this.row(siteId, id);
    if (c.user_id !== user.id) throw new HttpError(403, "Only the contributor signs their proof of work");
    if (c.status !== "unsigned") throw new HttpError(409, "Already signed");
    return this.sigs.request(user, {
      action: "contribution.sign",
      entity: `${id}#${c.record_sha256}`,
      meaning: `I did the work this record describes on stage ${c.stage_code} of run ${c.run_id}`,
      comment: "",
      site: siteId,
      chainId,
    });
  }

  async sign(siteId: string, user: User, id: string, proof: { nonce: string; signature: `0x${string}` }) {
    const c = await this.row(siteId, id);
    if (c.user_id !== user.id) throw new HttpError(403, "Only the contributor signs their proof of work");
    if (c.status !== "unsigned") throw new HttpError(409, "Already signed");
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "contribution.sign", entity: `${id}#${c.record_sha256}` }, proof);
      const upd = await q.query("UPDATE contributions SET status = 'signed', signature_id = $2, signed_at = now() WHERE id = $1 AND status = 'unsigned' RETURNING id", [id, s.id]);
      if (!upd.rows.length) throw new HttpError(409, "Already signed");
      await q.query("UPDATE contribution_sessions SET status = 'signed' WHERE id = (SELECT session_id FROM contributions WHERE id = $1)", [id]);
      return s;
    });
    const tee = JSON.parse(c.tee_json) as TeeSummary;
    const measurements = JSON.parse(c.measurements_json) as ContributionView["measurements"];
    const evidence = JSON.parse(c.evidence_json) as ContributionView["evidence"];
    const media = (JSON.parse(c.outcomes_json ?? "[]") as ContributionOutcome[]).filter((o) => o.sha256).map((o) => ({ outcome: o.outcome, sha256: o.sha256, verdict: o.verdict ?? null }));
    // the ledger gets who, the record's hash, the commitments and the receipts' verdict, never the values or the conversation
    const d = await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "contribution.signed",
      runId: c.run_id,
      stageCode: c.stage_code,
      summary: `Proof of work on ${c.stage_code} signed: ${measurements.length} value${measurements.length === 1 ? "" : "s"} committed, ${evidence.length} evidence file${evidence.length === 1 ? "" : "s"} hashed, ${media.length ? `${media.length} machine output${media.length === 1 ? "" : "s"} bound${c.disputes ? ` (${c.disputes} disputed)` : ""}, ` : ""}${tee.turns} turn${tee.turns === 1 ? "" : "s"} on 0G Private Computer${tee.allVerified ? ", every one TEE-verified" : ""}`,
      data: { contributionId: id, contributor: user.address, recordSha256: c.record_sha256, signatureId: sig.id, commitments: measurements.map((m) => ({ criterion: m.criterion, commitment: m.commitment })), evidence, tee, ...(media.length ? { media } : {}) },
    });
    await this.db.query("UPDATE contributions SET ledger_seq = $2 WHERE id = $1", [id, d.ledgerSeq ?? null]);
    // a sealed copy on 0G Storage keeps the record available if Ordo's database is lost
    if (this.replicas) {
      const bytes = Buffer.from(c.sealed, "utf8");
      const hex = sha256(bytes);
      await this.db.query("INSERT INTO blobs (sha256, mime, size, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING", [hex, "application/vnd.ordo.sealed+json", bytes.byteLength, bytes]);
      await this.db.query("UPDATE contributions SET replica_sha256 = $2 WHERE id = $1", [id, `sha256:${hex}`]);
      await this.replicas.request(siteId, `sha256:${hex}`).catch((e) => console.error("[ordo] contribution replica", e));
    }
    return this.view(siteId, id, 3);
  }

  // ---------------------------------------------------------------- views

  private async toViews(rows: Row[], level: AccessLevel): Promise<ContributionView[]> {
    const replicas = this.replicas ? await this.replicas.of(rows.map((r) => r.replica_sha256).filter((x): x is string => Boolean(x))) : new Map<string, ReplicaView>();
    return rows.map((r) => {
      const v: ContributionView = {
        id: r.id,
        siteId: r.site_id,
        runId: r.run_id,
        stageCode: r.stage_code,
        contributor: { userId: r.user_id, address: r.address, name: r.name },
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
        signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
        recordSha256: r.record_sha256,
        measurements: JSON.parse(r.measurements_json),
        evidence: JSON.parse(r.evidence_json),
        outcomes: (JSON.parse(r.outcomes_json ?? "[]") as ContributionOutcome[]).map(({ verdict: _v, ...o }) => o),
        tee: JSON.parse(r.tee_json),
        ledgerSeq: r.ledger_seq === null ? null : Number(r.ledger_seq),
        signatureId: r.signature_id,
        replica: r.replica_sha256 ? (replicas.get(r.replica_sha256) ?? null) : null,
        selection: r.selected_by && r.selected_at ? { by: r.selected_by, byName: r.selected_by_name, at: new Date(r.selected_at).toISOString(), comment: r.select_comment } : null,
      };
      if (level >= 3) {
        const rec = JSON.parse(this.box(r.site_id).unseal(r.sealed)) as SealedRecord;
        v.summary = rec.summary;
        v.notes = rec.notes;
        v.measurements = v.measurements.map((m) => {
          const s = rec.measurements.find((x) => x.label === m.criterion);
          return s ? { ...m, value: s.value, note: s.note } : m;
        });
        // the contributor's verdicts on the machine's media: validators see the disputes
        const bound = JSON.parse(r.outcomes_json ?? "[]") as ContributionOutcome[];
        v.outcomes = bound.map((o) => {
          const k = rec.confirmations?.find((x) => x.outcome === o.outcome);
          return { ...o, verdict: k?.verdict ?? null, observed: k?.observed ?? null, note: k?.note ?? "", machineValue: k?.machineValue ?? null };
        });
        v.disputes = Number(r.disputes ?? 0);
        if (rec.voiceNotes?.length) v.voiceNotes = rec.voiceNotes;
        if (rec.machineQa?.length) v.machineQa = rec.machineQa;
      }
      return v;
    });
  }

  async view(siteId: string, id: string, level: AccessLevel): Promise<ContributionView> {
    return (await this.toViews([await this.row(siteId, id)], level))[0]!;
  }

  /** A stage's contributions: everyone's at level 3 and up, otherwise only the caller's own. Unsigned ones only to their author. */
  async forStage(siteId: string, runId: string, stageCode: string, viewer: { userId: string; level: AccessLevel }) {
    const r = await this.db.query<Row>(`${SELECT} WHERE c.site_id = $1 AND c.run_id = $2 AND c.stage_code = $3 AND c.status <> 'withdrawn' ORDER BY c.created_at`, [siteId, runId, stageCode]);
    const rows = r.rows.filter((x) => x.user_id === viewer.userId || (viewer.level >= 3 && x.status !== "unsigned"));
    const mine = await this.toViews(rows.filter((x) => x.user_id === viewer.userId), 3);
    const others = await this.toViews(rows.filter((x) => x.user_id !== viewer.userId), viewer.level);
    const all = [...mine, ...others].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { contributions: all, total: r.rows.filter((x) => x.status !== "unsigned").length };
  }

  async mine(siteId: string, userId: string) {
    const r = await this.db.query<Row>(`${SELECT} WHERE c.site_id = $1 AND c.user_id = $2 ORDER BY c.created_at DESC LIMIT 100`, [siteId, userId]);
    return this.toViews(r.rows, 3);
  }

  /** Proof-of-work counts per stage of a run, for stage cards. */
  async countsForRun(siteId: string, runId: string): Promise<Record<string, { signed: number; selected: boolean; disputed: number }>> {
    const r = await this.db.query<{ stage_code: string; n: string; sel: boolean; d: string }>(
      "SELECT stage_code, COUNT(*) FILTER (WHERE status <> 'unsigned')::text AS n, BOOL_OR(status = 'selected') AS sel, COUNT(*) FILTER (WHERE status <> 'unsigned' AND COALESCE(disputes, 0) > 0)::text AS d FROM contributions WHERE site_id = $1 AND run_id = $2 AND status <> 'withdrawn' GROUP BY stage_code",
      [siteId, runId],
    );
    return Object.fromEntries(r.rows.map((x) => [x.stage_code, { signed: Number(x.n), selected: Boolean(x.sel), disputed: Number(x.d) }]));
  }

  /** A signed proof of work, for anyone: who, when, the commitments, evidence hashes and TEE receipts, never the values. */
  async publicView(id: string) {
    const r = await this.db.query<Row & { site_name: string; order_ref: string }>(
      `SELECT c.*, u.display_name AS name, s2.display_name AS selected_by_name, s.name AS site_name, r.order_ref FROM contributions c JOIN users u ON u.id = c.user_id
       LEFT JOIN users s2 ON s2.address = c.selected_by JOIN sites s ON s.id = c.site_id JOIN runs r ON r.id = c.run_id WHERE c.id = $1 AND c.status <> 'unsigned' AND c.status <> 'withdrawn'`,
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new HttpError(404, "No signed proof of work with that id");
    const [v] = await this.toViews([row], 1);
    const receipts = (JSON.parse((await this.db.query<{ receipts_json: string }>("SELECT receipts_json FROM contributions WHERE id = $1", [id])).rows[0]!.receipts_json) as ReturnType<typeof publicReceipt>[]).slice(0, 100);
    const sig = row.signature_id ? (await this.db.query<{ signature: string; typed_data: string }>("SELECT signature, typed_data FROM signatures WHERE id = $1", [row.signature_id])).rows[0] : null;
    return { ...v!, site: row.site_name, orderRef: row.order_ref, receipts, signature: sig ? { signature: sig.signature, typed: JSON.parse(sig.typed_data) } : null };
  }

  /** The full record, for the manager (and a tester during a case). */
  async sealedRecord(siteId: string, id: string): Promise<SealedRecord> {
    const c = await this.row(siteId, id);
    return JSON.parse(this.box(siteId).unseal(c.sealed)) as SealedRecord;
  }

  /** Expire sessions past their time and revoke their keys. */
  async reconcile() {
    const r = await this.db.query<{ id: string }>("SELECT id FROM contribution_sessions WHERE status = 'open' AND expires_at < now() LIMIT 50");
    for (const s of r.rows) await this.close(s.id, "expired");
    const stale = await this.db.query<{ id: string; router_key_id: string }>(
      "SELECT id, router_key_id FROM contribution_sessions WHERE status <> 'open' AND router_key_id IS NOT NULL AND key_revoked_at IS NULL LIMIT 50",
    );
    for (const s of stale.rows) await this.revoke(s.id, s.router_key_id, null);
  }
}

const signUrl = (base: string, siteId: string, id: string) => `${base.replace(/\/$/, "")}/#/pow/${id}/sign?site=${encodeURIComponent(siteId)}`;
const proofUrl = (base: string, id: string) => `${base.replace(/\/$/, "")}/#/pow/${id}`;

/** Receipts as the public sees them: which provider served each turn and whether the Router verified its TEE. */
const publicReceipt = (r: FinishBody["receipts"][number]) => ({
  at: r.at,
  provider: r.provider ?? null,
  model: r.model ?? null,
  resKey: r.resKey ?? null,
  requestId: r.requestId ?? null,
  teeVerified: r.teeVerified ?? null,
  requestSha256: r.requestSha256,
  responseSha256: r.responseSha256,
  // a voice note's speech-to-text call, beside the interview's turns
  kind: (r as { kind?: unknown }).kind === "transcription" ? ("transcription" as const) : ("chat" as const),
});

export function teeSummary(network: string, model: string, receipts: { teeVerified?: boolean | null; provider?: string | null; model?: string | null }[], trustMode: TrustMode = "private"): TeeSummary {
  const verified = receipts.filter((r) => r.teeVerified === true).length;
  const failed = receipts.filter((r) => r.teeVerified === false).length;
  return {
    network,
    trustMode,
    model: receipts.find((r) => r.model)?.model ?? model,
    turns: receipts.length,
    verified,
    failed,
    providers: [...new Set(receipts.map((r) => r.provider).filter((p): p is string => Boolean(p)))],
    allVerified: receipts.length > 0 && verified === receipts.length,
  };
}

/** The interviewer's brief for this stage, appended to the terminal agent's own instructions. */
function guideFor(template: string, description: string, st: StageRunView, criteria: ReturnType<typeof reportable>) {
  const lines = criteria.map((c) => {
    const target = c.targetMax !== null ? `between ${c.target} and ${c.targetMax}` : `${c.op === ">=" ? "at least" : c.op === "<=" ? "at most" : "exactly"} ${c.target}`;
    return `- ${c.label}${c.unit ? ` (${c.unit})` : ""}: target ${target}${c.signal ? `; the machine reports it as ${c.signal}` : ""}`;
  });
  return [
    `You are interviewing a contributor about the work they did on stage ${st.code} "${st.name}" of the pipeline "${template}".`,
    description ? `About the pipeline: ${description}` : "",
    `The stage runs on a ${st.resourceKind.replaceAll("_", " ")}${st.assetName ? ` (${st.assetName})` : ""}.`,
    "Ask for each of these, one at a time, with its unit, and record exactly what they report. Do not suggest values and never invent them; if they did not measure something, note that instead.",
    ...lines,
    ...(st.outcomes.length
      ? [
          `The stage's machine${st.assetName ? ` (${st.assetName})` : ""} captures these outcomes and reads each value itself; the contributor does not report them. Show each captured one to the contributor (review_outcome), and record whether they confirm or dispute what the machine captured (confirm_outcome):`,
          ...st.outcomes.map((o) => `- ${o.label} (${o.media}, ${o.instrument}${o.required ? "" : ", optional"}): ${o.metric.label}${o.metric.unit ? ` in ${o.metric.unit}` : ""}`),
        ]
      : []),
    "Then ask what evidence they have (photos, instrument exports, logs, voice notes) and attach each file by its path, ask about anything unusual, and confirm a short summary before finishing.",
  ]
    .filter(Boolean)
    .join("\n");
}
