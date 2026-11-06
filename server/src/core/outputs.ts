import { createHash } from "node:crypto";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { PROOF_DOMAIN } from "../auth/auth.js";
import { OUTPUT_TYPES, scaleValue } from "../auth/output-types.js";
import type { Db } from "../db/db.js";
import { OUTCOME_MEDIA_LABEL, OUTCOME_MIME, outcomeSignal, type AccessLevel, type Outcome, type StageRunView } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { newId, type PlantService } from "../plant/plant.js";
import type { Readings } from "./readings.js";
import type { Recorder } from "./recorder.js";
import type { Replicas } from "./replicas.js";

/** The largest media file a machine may upload for one outcome, and its preview */
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const PREVIEW_MIME = ["image/png", "image/jpeg"];
/** how far a capture time may be from Ordo's clock */
const CAPTURE_SKEW_S = 600;

/** What the machine says about the file it uploads, beside the file (multipart field `meta`). */
export const OutputMeta = z.object({
  runId: z.string().min(1).max(64),
  stage: z.string().min(1).max(32),
  outcome: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  /** unix seconds */
  capturedAt: z.number().int().positive(),
  /** the metric the machine read from the media, in the outcome's unit */
  value: z.number().finite(),
  /** hex SHA-256 of the file */
  sha256: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
  /** the machine's EIP-712 OrdoOutput signature */
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  /** how the machine's on-board agent read the media through 0G: kept beside the output, shown at level 3 */
  analysis: z
    .object({
      summary: z.string().trim().max(2000),
      value: z.number().finite().optional(),
      anomaly: z.string().trim().max(500).optional(),
      requestId: z.string().max(200).optional(),
      model: z.string().max(120).optional(),
      provider: z.string().max(120).optional(),
      teeVerified: z.boolean().nullable().optional(),
    })
    .optional(),
});
export type OutputMeta = z.infer<typeof OutputMeta>;

export interface UploadedFile {
  bytes: Uint8Array;
  mime: string;
}

interface OutputRow {
  id: string;
  run_id: string;
  stage_code: string;
  outcome_key: string;
  version: number;
  asset_id: string | null;
  media: string;
  mime: string;
  size: number;
  sha256: string;
  preview_sha256: string | null;
  preview_mime: string | null;
  value_scaled: string;
  device: string;
  signature: string;
  captured_at: string;
  analysis_json: string | null;
  ledger_seq: number | null;
}

/** One outcome of a stage as a member sees it: what the machine must capture and, by level, what it captured. */
export interface OutcomeView {
  key: string;
  label: string;
  media: Outcome["media"];
  mediaLabel: string;
  instrument: string;
  required: boolean;
  metric: Outcome["metric"];
  /** the metric's criterion: null until measured. Level 2. */
  ok: boolean | null;
  captured: boolean;
  capturedAt: string | null;
  /** level 3: the latest output and its machine's reading */
  output: {
    id: string;
    version: number;
    versions: number;
    mime: string;
    size: number;
    sha256: string;
    hasPreview: boolean;
    value: number;
    device: string;
    signature: string;
    ledgerSeq: number | null;
    analysis: OutputMeta["analysis"] | null;
    replica: { status: string; root: string | null; url: string | null } | null;
  } | null;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * The media each stage's machine captures for its outcomes: a thermal image, a micrograph, audio, video, a spectrum or a
 * document, each with the value the machine read from it. The machine signs every file (OrdoOutput) and uploads it over
 * its signed edge channel; Ordo keeps the bytes, copies them encrypted to 0G Storage when that rail is on, and records the
 * value as the asset's `outcome.<key>` signal, so the outcome's criterion is judged, and later signed and proven in zero
 * knowledge, like any measured parameter.
 */
export class MachineOutputs {
  replicas: Replicas | null = null;

  constructor(
    private db: Db,
    private engine: RunEngine,
    private readings: Readings,
    private plant: PlantService,
    private rec: Recorder,
    private now: () => number,
  ) {}

  async ingest(device: Address, meta: OutputMeta, file: UploadedFile, preview: UploadedFile | null) {
    const run = await this.db.query<{ site_id: string }>("SELECT site_id FROM runs WHERE id = $1", [meta.runId]);
    const siteId = run.rows[0]?.site_id;
    if (!siteId) throw new HttpError(404, "Run not found");
    const st = (await this.engine.view(siteId, meta.runId)).stages.find((x) => x.code === meta.stage);
    if (!st) throw new HttpError(404, "Stage not found");
    if (!st.assetId || !(await this.readings.attesting(device)).some((a) => a.id === st.assetId)) throw new HttpError(403, "This machine is not the one running that stage, or it is not an Attester");
    if (!st.startedAt || st.state === "queued" || st.state === "skipped") throw new HttpError(409, "The stage has not started");
    const outcome = st.outcomes.find((o) => o.key === meta.outcome);
    if (!outcome) throw new HttpError(400, `${meta.outcome} is not an outcome of stage ${st.code}`);

    if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_OUTPUT_BYTES) throw new HttpError(400, `A file is 1 byte to ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`);
    const mime = file.mime.split(";")[0]!.trim().toLowerCase();
    if (!OUTCOME_MIME[outcome.media].includes(mime)) throw new HttpError(400, `${OUTCOME_MEDIA_LABEL[outcome.media]} is uploaded as ${OUTCOME_MIME[outcome.media].join(", ")}, not ${mime || "an unknown type"}`);
    const hex = sha(file.bytes);
    if (hex !== meta.sha256.replace(/^0x/, "").toLowerCase()) throw new HttpError(400, "sha256 is not the file's hash");
    let previewHex: string | null = null;
    let previewMime: string | null = null;
    if (preview) {
      previewMime = preview.mime.split(";")[0]!.trim().toLowerCase();
      if (!PREVIEW_MIME.includes(previewMime)) throw new HttpError(400, "A preview is a PNG or JPEG image");
      if (preview.bytes.byteLength === 0 || preview.bytes.byteLength > MAX_PREVIEW_BYTES) throw new HttpError(400, `A preview is at most ${MAX_PREVIEW_BYTES / 1024 / 1024} MB`);
      previewHex = sha(preview.bytes);
    }

    const nowS = this.now() / 1000;
    if (Math.abs(meta.capturedAt - nowS) > CAPTURE_SKEW_S) throw new HttpError(400, "capturedAt is too far from Ordo's clock");
    if (meta.capturedAt < Date.parse(st.startedAt) / 1000 - 60) throw new HttpError(400, "capturedAt is before the stage started");

    const value = scaleValue(meta.value);
    const message = { site: siteId, runId: meta.runId, stage: st.code, asset: st.assetId, outcome: outcome.key, sha256: `0x${hex}` as Hex, value, capturedAt: BigInt(meta.capturedAt) };
    const signer = await recoverTypedDataAddress({ domain: PROOF_DOMAIN, types: OUTPUT_TYPES, primaryType: "OrdoOutput", message, signature: meta.signature as Hex }).catch(() => null);
    if (signer?.toLowerCase() !== device) throw new HttpError(401, "The OrdoOutput signature is not the machine's");

    await this.db.query("INSERT INTO blobs (sha256, mime, size, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING", [hex, mime, file.bytes.byteLength, file.bytes]);
    if (preview && previewHex) await this.db.query("INSERT INTO blobs (sha256, mime, size, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING", [previewHex, previewMime, preview.bytes.byteLength, preview.bytes]);

    const id = newId("out");
    const capturedAt = new Date(meta.capturedAt * 1000).toISOString();
    const version = await this.db.tx(async (q) => {
      const v = Number((await q.query<{ v: number | null }>("SELECT MAX(version) AS v FROM stage_outputs WHERE run_id = $1 AND stage_code = $2 AND outcome_key = $3", [meta.runId, st.code, outcome.key])).rows[0]?.v ?? 0) + 1;
      await q.query(
        `INSERT INTO stage_outputs (id, site_id, run_id, stage_code, outcome_key, version, asset_id, media, mime, size, sha256, preview_sha256, preview_mime, value_scaled, device, signature, captured_at, analysis_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [id, siteId, meta.runId, st.code, outcome.key, v, st.assetId, outcome.media, mime, file.bytes.byteLength, `sha256:${hex}`, previewHex ? `sha256:${previewHex}` : null, previewMime, value.toString(), device, meta.signature, capturedAt, meta.analysis ? JSON.stringify(meta.analysis) : null],
      );
      return v;
    });
    // the value becomes the asset's `outcome.<key>` signal over the stage window: the outcome's criterion reads it
    // (capture times are whole seconds: one in the stage's first second still falls inside its window)
    const inWindow = new Date(Math.max(meta.capturedAt * 1000, Date.parse(st.startedAt))).toISOString();
    await this.plant.outcomeObservation(st.assetId, outcomeSignal(outcome.key), inWindow, meta.value);
    // the ledger gets the file's hash and who signed it, never the value
    const e = await this.rec.event(`device:${device}`, "outcome.captured", `${meta.runId}/${st.code}`, {
      site: siteId,
      outputId: id,
      outcome: outcome.key,
      media: outcome.media,
      version,
      sha256: `sha256:${hex}`,
      previewSha256: previewHex ? `sha256:${previewHex}` : null,
      signer: device,
      agentRequestId: meta.analysis?.requestId ?? null,
    });
    await this.db.query("UPDATE stage_outputs SET ledger_seq = $2 WHERE id = $1", [id, e.seq]);
    await this.replicas?.request(siteId, `sha256:${hex}`).catch((err: Error) => console.error("[ordo] output replica", err.message));
    return { id, outcome: outcome.key, version, sha256: `sha256:${hex}`, previewSha256: previewHex ? `sha256:${previewHex}` : null, ledgerSeq: e.seq };
  }

  /** A stage's outcomes as one member sees them: at level 2 whether each was captured and met its target; at level 3 the files' details, values and the machine's readings. */
  async forStage(siteId: string, runId: string, stage: StageRunView, level: AccessLevel): Promise<OutcomeView[]> {
    const rows = (
      await this.db.query<OutputRow>(
        "SELECT id, run_id, stage_code, outcome_key, version, asset_id, media, mime, size, sha256, preview_sha256, preview_mime, value_scaled, device, signature, captured_at::text, analysis_json, ledger_seq FROM stage_outputs WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 ORDER BY version DESC",
        [siteId, runId, stage.code],
      )
    ).rows;
    const latest = new Map<string, OutputRow>();
    const count = new Map<string, number>();
    for (const r of rows) {
      if (!latest.has(r.outcome_key)) latest.set(r.outcome_key, r);
      count.set(r.outcome_key, (count.get(r.outcome_key) ?? 0) + 1);
    }
    const replicas = level >= 3 && this.replicas ? await this.replicas.of([...latest.values()].map((r) => r.sha256)) : new Map();
    return stage.outcomes.map((o) => {
      const r = latest.get(o.key);
      const criterion = stage.criteriaResults.find((c) => c.signal === outcomeSignal(o.key));
      const rep = r ? replicas.get(r.sha256) : undefined;
      return {
        key: o.key,
        label: o.label,
        media: o.media,
        mediaLabel: OUTCOME_MEDIA_LABEL[o.media],
        instrument: o.instrument,
        required: o.required,
        metric: o.metric,
        ok: criterion?.ok ?? null,
        captured: Boolean(r),
        capturedAt: r ? new Date(r.captured_at).toISOString() : null,
        output:
          r && level >= 3
            ? {
                id: r.id,
                version: Number(r.version),
                versions: count.get(o.key) ?? 1,
                mime: r.mime,
                size: Number(r.size),
                sha256: r.sha256,
                hasPreview: Boolean(r.preview_sha256),
                value: Number(BigInt(r.value_scaled)) / 1e4,
                device: r.device,
                signature: r.signature,
                ledgerSeq: r.ledger_seq === null ? null : Number(r.ledger_seq),
                analysis: r.analysis_json ? (JSON.parse(r.analysis_json) as OutputMeta["analysis"]) : null,
                replica: rep ? { status: rep.status, root: rep.root, url: rep.url } : null,
              }
            : null,
      };
    });
  }

  /** The bytes of an outcome's file or its preview: the latest capture, or a given version. */
  async file(siteId: string, runId: string, stageCode: string, outcome: string, which: "file" | "preview", version?: number) {
    const r = (
      await this.db.query<{ sha256: string; preview_sha256: string | null; outcome_key: string; version: number }>(
        `SELECT sha256, preview_sha256, outcome_key, version FROM stage_outputs WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 AND outcome_key = $4 ${version ? "AND version = $5" : ""} ORDER BY version DESC LIMIT 1`,
        version ? [siteId, runId, stageCode, outcome, version] : [siteId, runId, stageCode, outcome],
      )
    ).rows[0];
    const hash = which === "file" ? r?.sha256 : r?.preview_sha256;
    if (!r || !hash) throw new HttpError(404, which === "file" ? "Nothing captured for this outcome" : "This output has no preview");
    const b = (await this.db.query<{ mime: string; bytes: Uint8Array }>("SELECT mime, bytes FROM blobs WHERE sha256 = $1", [hash.replace(/^sha256:/, "")])).rows[0];
    if (!b) throw new HttpError(404, "File not found");
    return { mime: b.mime, bytes: new Uint8Array(b.bytes), name: `${runId}-${stageCode}-${outcome}-v${r.version}${which === "preview" ? "-preview" : ""}` };
  }
}
