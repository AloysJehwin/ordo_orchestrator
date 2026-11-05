import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { toLabel } from "../chain/ensv2.js";
import type { ReleaseLot } from "../chain/trust.js";
import { hashOf } from "../domain/canonical.js";
import type { Signatures, User } from "../auth/auth.js";
import type { Db } from "../db/db.js";
import type { LedgerStore } from "../db/ledger-store.js";
import { canApproveAny } from "../domain/policy.js";
import { ROLE_LABEL, SIGNAL_AGG_LABEL, type PackageType, type Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { kindOf, targetText } from "../pipelines/criteria.js";
import type { RunEngine } from "../pipelines/engine.js";
import { renderParameterChart } from "../pipelines/param-chart.js";
import type { StageSeries } from "../pipelines/stage-series.js";
import { newId } from "../plant/plant.js";
import type { Inbox } from "./inbox.js";
import type { LotNames } from "./lot-names.js";
import type { Replicas, ReplicaView } from "./replicas.js";
import type { Trust } from "./trust.js";
import type { Recorder } from "./recorder.js";
import type { SpecProofs } from "./spec-proofs.js";
import { ZERO_ROOT, type StageProofs } from "./stage-proofs.js";

export const PACKAGE_LABEL: Record<PackageType, string> = {
  stage_validation: "Stage validation",
  process_change: "Process change",
  pilot_validation: "Pilot validation",
  proof_of_concept: "Proof of concept",
  operational_qualification: "Operational qualification",
};
const REQUIRED_EVIDENCE: Record<PackageType, string[]> = {
  stage_validation: ["Inspection report"],
  process_change: ["Change description", "Trial results"],
  pilot_validation: ["Pilot batch records"],
  proof_of_concept: ["Concept report"],
  operational_qualification: ["Calibration certificate", "Qualification run data"],
};
/** Ordered signature chain. */
export const CHAIN: { meaning: "performed" | "reviewed" | "approved"; role: Role; label: string; step: Step }[] = [
  { meaning: "performed", role: "contributor", label: "Performed by", step: "draft" },
  { meaning: "reviewed", role: "validator", label: "Reviewed by", step: "qe_review" },
  { meaning: "approved", role: "manager", label: "Approved by", step: "approval" },
];
type Step = "draft" | "qe_review" | "approval" | "released";
type Status = "draft" | "in_review" | "changes_requested" | "rejected" | "released";
const MAX_FILE = 4 * 1024 * 1024;

interface PkgRow {
  id: string;
  site_id: string;
  number: number;
  type: PackageType;
  title: string;
  owner_id: string;
  status: Status;
  step: Step;
  objective: string;
  acceptance: string;
  sample_plan: string;
  window_start: string | null;
  window_end: string | null;
  run_id: string | null;
  stage_code: string | null;
  template_id: string | null;
  asset_id: string | null;
  outcome: string;
  precheck_json: string | null;
  returned_comment: string | null;
  created_at: string;
  updated_at: string;
}

const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What the three release signatures bind: the lot, the package's content and the root of the lot's stage proofs. */
interface ReleaseStatement {
  runId: string;
  lot: string;
  contentHash: Hex;
  proofRoot: Hex;
  /** the stages folded into proofRoot, in order */
  stages: string[];
  /** the source-signed parameters folded after them, keyed `stage|label` */
  params?: string[];
}

export class Validation {
  constructor(
    private db: Db,
    private rec: Recorder,
    private ledger: LedgerStore,
    private sigs: Signatures,
    private engine: RunEngine,
    private inbox: Inbox,
    private chainId: number,
    private trust: Trust,
  ) {}
  /** Copies of evidence on 0G Storage, when configured */
  replicas: Replicas | null = null;
  /** Lot names on ENS: releases are recorded there against the signers' ENS credentials */
  lots: LotNames | null = null;
  /** Zero-knowledge proofs of each stage's signed counts: their root is part of what a release signs */
  stageProofs: StageProofs | null = null;
  /** Zero-knowledge proofs of each measured parameter: the source-signed ones fold into the same root, after the stages */
  specProofs: SpecProofs | null = null;
  /** Set when stage series are kept: the agent pre-check then attaches a parameter chart as evidence */
  series: StageSeries | null = null;

  /** The release statement as it stands now. The content is the package's checks and evidence, which are locked once Performed by is signed. */
  private async statementOf(siteId: string, p: PkgRow): Promise<ReleaseStatement> {
    const full = await this.get(siteId, p.id);
    const content = { packageId: p.id, type: p.type, title: p.title, checks: full.checks.map((c) => [c.criterion, c.target, c.status, c.actual]), evidence: full.evidence.filter((e) => e.sha256 && !e.removedAt).map((e) => e.sha256) };
    const runId = p.run_id ?? "";
    const proofs = runId && this.stageProofs ? await this.stageProofs.bundle(runId) : { root: ZERO_ROOT, stages: [] };
    const params = runId && this.specProofs ? await this.specProofs.bundle(runId, proofs.root) : { root: proofs.root, keys: [] };
    return { runId, lot: runId ? await this.lotLabel(siteId, runId) : "", contentHash: `0x${hashOf(content).replace("sha256:", "")}` as Hex, proofRoot: params.root, stages: proofs.stages.map((s) => s.stage), params: params.keys };
  }
  /** The lot's ENS label, which the release signatures name, so OrdoLotResolver records it under the same name. */
  private async lotLabel(siteId: string, runId: string): Promise<string> {
    const named = await this.lots?.labelFor(siteId, runId);
    if (named) return named;
    const r = await this.db.query<{ order_ref: string }>("SELECT order_ref FROM runs WHERE id = $1", [runId]);
    return `lot-${toLabel(r.rows[0]?.order_ref ?? runId)}`;
  }
  private async signedStatement(id: string): Promise<ReleaseStatement> {
    const r = await this.db.query<{ release_json: string | null }>("SELECT release_json FROM validation_packages WHERE id = $1", [id]);
    if (!r.rows[0]?.release_json) throw new HttpError(409, "This package was submitted before release statements: return it so the owner signs it again");
    return JSON.parse(r.rows[0].release_json) as ReleaseStatement;
  }

  private async row(siteId: string, id: string): Promise<PkgRow> {
    const r = await this.db.query<PkgRow>("SELECT id, site_id, number, type, title, owner_id, status, step, objective, acceptance, sample_plan, run_id, stage_code, template_id, asset_id, outcome, precheck_json, returned_comment, created_at::text AS created_at, updated_at::text AS updated_at, window_start::text AS window_start, window_end::text AS window_end FROM validation_packages WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (!r.rows[0]) throw new HttpError(404, "Package not found");
    return r.rows[0];
  }
  private async audit(siteId: string, actor: string, id: string, type: string, payload: Record<string, unknown>) {
    await this.rec.event(actor, `validation.${type}`, id, { site: siteId, ...payload });
    await this.db.query("UPDATE validation_packages SET updated_at = now() WHERE id = $1", [id]);
  }

  async create(siteId: string, owner: User, input: { type: PackageType; title: string; objective: string; acceptance: string; samplePlan: string; windowStart?: string | null; windowEnd?: string | null; runId?: string | null; stageCode?: string | null; templateId?: string | null; assetId?: string | null }) {
    const n = Number((await this.db.query<{ n: string }>("SELECT COUNT(*)::text n FROM validation_packages WHERE site_id = $1", [siteId])).rows[0]!.n);
    const id = newId("vp");
    let checks: { criterion: string; method: string; target: string; auto: boolean }[] = [];
    if (input.runId && input.stageCode) {
      const run = await this.engine.view(siteId, input.runId);
      const st = run.stages.find((s) => s.code === input.stageCode);
      if (!st) throw new HttpError(404, "Stage not found");
      checks = st.criteria.map((c) => ({ criterion: c.label, method: kindOf(c) === "signal" ? `Measured: ${c.signal} (${SIGNAL_AGG_LABEL[c.agg ?? "last"].toLowerCase()}) over the stage` : kindOf(c) === "manual" ? "Confirmed by a person" : "Measured from run data", target: targetText(c), auto: true }));
    }
    await this.db.tx(async (q) => {
      await q.query(
        `INSERT INTO validation_packages (id, site_id, number, type, title, owner_id, status, step, objective, acceptance, sample_plan, window_start, window_end, run_id, stage_code, template_id, asset_id)
         VALUES ($1,$2,$3,$4,$5,$6,'draft','draft',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, siteId, 101 + n, input.type, input.title, owner.id, input.objective, input.acceptance, input.samplePlan, input.windowStart ?? null, input.windowEnd ?? null, input.runId ?? null, input.stageCode ?? null, input.templateId ?? null, input.assetId ?? null],
      );
      let sort = 0;
      for (const c of checks) await q.query("INSERT INTO validation_checks (id, package_id, sort, criterion, method, target, source, auto) VALUES ($1,$2,$3,$4,$5,$6,'agent',true)", [newId("chk"), id, sort++, c.criterion, c.method, c.target]);
      for (const name of REQUIRED_EVIDENCE[input.type]) await q.query("INSERT INTO evidence (id, package_id, name, requirement, required) VALUES ($1,$2,$3,'Required',true)", [newId("evd"), id, name]);
    });
    await this.audit(siteId, `user:${owner.address}`, id, "created", { type: input.type, title: input.title, runId: input.runId ?? null, stageCode: input.stageCode ?? null });
    return this.get(siteId, id);
  }

  async update(siteId: string, user: User, id: string, patch: { title?: string; objective?: string; acceptance?: string; samplePlan?: string; windowStart?: string | null; windowEnd?: string | null }) {
    const p = await this.editable(siteId, user, id);
    await this.db.query(
      "UPDATE validation_packages SET title = $1, objective = $2, acceptance = $3, sample_plan = $4, window_start = $5, window_end = $6 WHERE id = $7",
      [patch.title ?? p.title, patch.objective ?? p.objective, patch.acceptance ?? p.acceptance, patch.samplePlan ?? p.sample_plan, patch.windowStart === undefined ? p.window_start : patch.windowStart, patch.windowEnd === undefined ? p.window_end : patch.windowEnd, id],
    );
    await this.audit(siteId, `user:${user.address}`, id, "edited", { fields: Object.keys(patch) });
    return this.get(siteId, id);
  }

  private async editable(siteId: string, user: User, id: string) {
    const p = await this.row(siteId, id);
    if (p.owner_id !== user.id) throw new HttpError(403, "Only the package owner can change it");
    if (p.status !== "draft" && p.status !== "changes_requested") throw new HttpError(409, "The package is locked while in review");
    return p;
  }

  async addCheck(siteId: string, user: User, id: string, c: { criterion: string; method: string; target: string }) {
    await this.editable(siteId, user, id);
    const n = Number((await this.db.query<{ n: string }>("SELECT COUNT(*)::text n FROM validation_checks WHERE package_id = $1", [id])).rows[0]!.n);
    await this.db.query("INSERT INTO validation_checks (id, package_id, sort, criterion, method, target, source) VALUES ($1,$2,$3,$4,$5,$6,'manual')", [newId("chk"), id, n, c.criterion, c.method, c.target]);
    await this.audit(siteId, `user:${user.address}`, id, "check.added", c);
    return this.get(siteId, id);
  }
  async removeCheck(siteId: string, user: User, id: string, checkId: string) {
    await this.editable(siteId, user, id);
    await this.db.query("DELETE FROM validation_checks WHERE id = $1 AND package_id = $2 AND auto = false", [checkId, id]);
    await this.audit(siteId, `user:${user.address}`, id, "check.removed", { checkId });
    return this.get(siteId, id);
  }
  async recordCheck(siteId: string, user: User, id: string, checkId: string, r: { status: "pass" | "fail"; result: string }) {
    await this.editable(siteId, user, id);
    const c = await this.db.query("UPDATE validation_checks SET status = $1, result = $2, recorded_by = $3, recorded_at = now() WHERE id = $4 AND package_id = $5 RETURNING id", [r.status, r.result, user.address, checkId, id]);
    if (!c.rows.length) throw new HttpError(404, "Check not found");
    await this.audit(siteId, `user:${user.address}`, id, "check.recorded", { checkId, ...r });
    return this.get(siteId, id);
  }

  /** The owning agent fills automated checks from the linked run's measured data and attaches the run record. */
  async precheck(siteId: string, user: User, id: string) {
    const p = await this.editable(siteId, user, id);
    const checks = (await this.db.query<{ id: string; criterion: string; auto: boolean }>("SELECT id, criterion, auto FROM validation_checks WHERE package_id = $1 ORDER BY sort", [id])).rows;
    const figures: { label: string; value: string }[] = [];
    let measured = 0;
    let passed = 0;
    let agent = "agent:vision_qa";
    if (p.run_id && p.stage_code) {
      const run = await this.engine.view(siteId, p.run_id);
      const st = run.stages.find((s) => s.code === p.stage_code)!;
      agent = `agent:${st.agent}`;
      for (const c of checks.filter((x) => x.auto)) {
        const r = st.criteriaResults.find((x) => x.label === c.criterion);
        if (!r || r.ok === null) {
          await this.db.query("UPDATE validation_checks SET status = 'pending', actual = NULL, result = 'Not measured: record it manually' WHERE id = $1", [c.id]);
          continue;
        }
        measured += 1;
        if (r.ok) passed += 1;
        await this.db.query("UPDATE validation_checks SET status = $1, actual = $2, result = $2, recorded_by = $3, recorded_at = now() WHERE id = $4", [r.ok ? "pass" : "fail", r.actual, agent, c.id]);
      }
      figures.push({ label: "Units good / scrap", value: `${st.unitsGood} / ${st.unitsScrap}` }, { label: "Yield", value: st.yieldPct === null ? "—" : `${st.yieldPct.toFixed(1)}%` }, { label: "Duration", value: st.durationMin === null ? "—" : `${st.durationMin} min` });
      const decisions = await this.rec.decisions(siteId, { runId: p.run_id, limit: 500 });
      const record = { run: { id: run.id, template: `${run.templateName} v${run.templateVersion}`, order: run.orderRef, quantity: run.quantity }, stage: st, decisions: decisions.filter((d) => d.stageCode === p.stage_code) };
      await this.storeEvidence(id, { name: `Run record ${run.id} · ${st.code}`, filename: `${run.id}-${st.code}-record.json`, mime: "application/json", bytes: new TextEncoder().encode(JSON.stringify(record, null, 2)), origin: "agent", by: agent });
      // the parameter chart: each criterion against its band, with the signal's trend over the stage window (values stay behind this authenticated route)
      if (st.criteriaResults.length) {
        const series = this.series ? await this.series.read(run.id, st) : null;
        const svg = renderParameterChart({ title: `${run.id} · ${st.code} ${st.name}`, subtitle: `${run.templateName} v${run.templateVersion} · ${run.orderRef}${st.assetName ? ` · ${st.assetName}` : ""}`, criteria: st.criteriaResults, series });
        await this.storeEvidence(id, { name: `Parameter chart ${run.id} · ${st.code}`, filename: `${run.id}-${st.code}-parameters.svg`, mime: "image/svg+xml", bytes: new TextEncoder().encode(svg), origin: "agent", by: agent });
      }
    }
    const auto = checks.filter((c) => c.auto).length;
    const confidence = auto ? Math.round((measured / auto) * (passed / Math.max(1, measured)) * 100) / 100 : null;
    const assessment = {
      ranAt: new Date().toISOString(),
      agent,
      summary: !p.run_id
        ? "No run is linked to this package, so there is no measured data to check automatically. Record each check manually."
        : `${passed} of ${measured} measured check(s) meet target${auto - measured ? `; ${auto - measured} could not be measured from run data and need a manual result` : ""}.`,
      figures,
      confidence,
    };
    await this.db.query("UPDATE validation_packages SET precheck_json = $1 WHERE id = $2", [JSON.stringify(assessment), id]);
    await this.audit(siteId, agent, id, "precheck", assessment);
    return this.get(siteId, id);
  }

  async storeEvidence(id: string, f: { slotId?: string | null; name: string; filename: string; mime: string; bytes: Uint8Array; origin: "upload" | "agent"; by: string }) {
    if (f.bytes.byteLength > MAX_FILE) throw new HttpError(400, "Files are limited to 4 MB");
    const hex = sha256hex(f.bytes);
    await this.db.query("INSERT INTO blobs (sha256, mime, size, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING", [hex, f.mime, f.bytes.byteLength, Buffer.from(f.bytes)]);
    if (this.replicas) {
      const site = (await this.db.query<{ site_id: string }>("SELECT site_id FROM validation_packages WHERE id = $1", [id])).rows[0];
      if (site) await this.replicas.request(site.site_id, `sha256:${hex}`);
    }
    const prev = f.slotId
      ? (await this.db.query<{ id: string; name: string; required: boolean; version: number; sha256: string | null }>("SELECT id, name, required, version, sha256 FROM evidence WHERE id = $1 AND package_id = $2", [f.slotId, id])).rows[0]
      : (await this.db.query<{ id: string; name: string; required: boolean; version: number; sha256: string | null }>("SELECT id, name, required, version, sha256 FROM evidence WHERE package_id = $1 AND name = $2 AND removed_at IS NULL", [id, f.name])).rows[0];
    if (prev && !prev.sha256) {
      await this.db.query("UPDATE evidence SET filename=$1, mime=$2, size=$3, sha256=$4, uploaded_by=$5, uploaded_at=now(), origin=$6 WHERE id=$7", [f.filename, f.mime, f.bytes.byteLength, `sha256:${hex}`, f.by, f.origin, prev.id]);
    } else {
      if (prev) await this.db.query("UPDATE evidence SET removed_at = now() WHERE id = $1", [prev.id]);
      await this.db.query("INSERT INTO evidence (id, package_id, name, requirement, required, filename, mime, size, sha256, uploaded_by, uploaded_at, origin, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12)", [
        newId("evd"),
        id,
        prev?.name ?? f.name,
        prev?.required ? "Required" : f.origin === "agent" ? "Generated" : "Optional",
        prev?.required ?? false,
        f.filename,
        f.mime,
        f.bytes.byteLength,
        `sha256:${hex}`,
        f.by,
        f.origin,
        (prev?.version ?? 0) + 1,
      ]);
    }
    return `sha256:${hex}`;
  }

  async attach(siteId: string, user: User, id: string, f: { slotId?: string | null; name: string; filename: string; mime: string; bytes: Uint8Array }) {
    await this.editable(siteId, user, id);
    const hash = await this.storeEvidence(id, { ...f, origin: "upload", by: user.address });
    await this.audit(siteId, `user:${user.address}`, id, "evidence.attached", { name: f.name, filename: f.filename, sha256: hash, size: f.bytes.byteLength });
    return this.get(siteId, id);
  }
  /** Fetch the evidence file's copy from 0G Storage and check it matches. */
  async verifyOnZeroG(siteId: string, id: string, evidenceId: string) {
    await this.row(siteId, id);
    if (!this.replicas) throw new HttpError(409, "0G Storage is not configured");
    const e = (await this.db.query<{ sha256: string | null }>("SELECT sha256 FROM evidence WHERE id = $1 AND package_id = $2", [evidenceId, id])).rows[0];
    if (!e?.sha256) throw new HttpError(404, "Evidence not found");
    return this.replicas.verify(e.sha256);
  }
  async removeEvidence(siteId: string, user: User, id: string, evidenceId: string) {
    await this.editable(siteId, user, id);
    const e = (await this.db.query<{ required: boolean; name: string; sha256: string | null }>("SELECT required, name, sha256 FROM evidence WHERE id = $1 AND package_id = $2", [evidenceId, id])).rows[0];
    if (!e) throw new HttpError(404, "Evidence not found");
    await this.db.query("UPDATE evidence SET removed_at = now() WHERE id = $1", [evidenceId]);
    if (e.required) await this.db.query("INSERT INTO evidence (id, package_id, name, requirement, required) VALUES ($1,$2,$3,'Required',true)", [newId("evd"), id, e.name]);
    await this.audit(siteId, `user:${user.address}`, id, "evidence.removed", { name: e.name, sha256: e.sha256 });
    return this.get(siteId, id);
  }
  async blob(siteId: string, id: string, evidenceId: string) {
    await this.row(siteId, id);
    const r = await this.db.query<{ filename: string; mime: string; bytes: Uint8Array }>("SELECT e.filename, b.mime, b.bytes FROM evidence e JOIN blobs b ON 'sha256:' || b.sha256 = e.sha256 WHERE e.id = $1 AND e.package_id = $2", [evidenceId, id]);
    if (!r.rows[0]) throw new HttpError(404, "File not found");
    return r.rows[0];
  }

  private readiness(p: PkgRow, checks: { status: string }[], evidence: { required: boolean; sha256: string | null; removedAt: string | null }[], proofsPending: string[]) {
    const req = evidence.filter((e) => e.required && !e.removedAt);
    const items = [
      { label: "Agent pre-check run", ok: Boolean(p.precheck_json) },
      { label: `Checks recorded ${checks.filter((c) => c.status !== "pending").length}/${checks.length}`, ok: checks.length > 0 && checks.every((c) => c.status !== "pending") },
      { label: checks.some((c) => c.status === "fail") ? `${checks.filter((c) => c.status === "fail").length} failed check(s)` : "No failed checks", ok: !checks.some((c) => c.status === "fail") },
      { label: `Required evidence ${req.filter((e) => e.sha256).length}/${req.length}`, ok: req.every((e) => e.sha256) },
    ];
    if (proofsPending.length) items.push({ label: `Stage proofs being generated (${proofsPending.join(", ")})`, ok: false });
    return { ready: items.every((i) => i.ok), items };
  }

  private currentChain(step: Step) {
    return CHAIN.find((c) => c.step === step) ?? null;
  }

  async signatureRequest(siteId: string, user: User, roles: Role[], id: string, action: "sign" | "return" | "reject", comment: string, clientChainId?: number) {
    const p = await this.row(siteId, id);
    const link = this.authorize(p, user, roles, action, comment);
    await this.segregation(siteId, id, user, action, link.meaning);
    await this.validatorGate(siteId, user, action, link.meaning);
    if (action === "sign") {
      // each link signs the same release statement: the owner's fixes it, and the others sign exactly that
      const st = link.meaning === "performed" ? await this.statementOf(siteId, p) : await this.signedStatement(id);
      return this.sigs.requestRelease(user, {
        site: siteId,
        packageId: id,
        runId: st.runId,
        lot: st.lot,
        meaning: link.meaning,
        statement: `${link.label} — VP-${p.number} ${p.title}`,
        comment,
        contentHash: st.contentHash,
        proofRoot: st.proofRoot,
      });
    }
    const chainId = clientChainId ?? this.chainId;
    return this.sigs.request(user, {
      action: `validation.${action}`,
      entity: `${id}#${link.meaning}`,
      meaning: `${action === "return" ? "Request changes" : "Reject"} — VP-${p.number} ${p.title}`,
      comment,
      site: siteId,
      chainId,
    });
  }

  /** Only a validator signs "Reviewed by" and "Approved by"; with the trust contract, a staked one. */
  private async validatorGate(siteId: string, user: User, action: string, meaning: string) {
    if (action === "sign" && meaning !== "performed") await this.trust.requireValidator(siteId, user);
  }

  /**
   * Separation of duties: one person signs at most one link of a package's signature chain. One exception: in an org
   * with a single manager, that manager may approve a package they performed, so a one-manager org can still release;
   * a different person still reviews it, and the ledger records that the approver also performed it.
   * Returns whether that exception applied.
   */
  private async segregation(siteId: string, id: string, user: User, action: string, meaning: string): Promise<boolean> {
    if (action !== "sign") return false;
    const r = await this.db.query<{ meaning: string }>("SELECT meaning FROM package_signatures WHERE package_id = $1 AND user_id = $2 AND cleared_at IS NULL", [id, user.id]);
    if (!r.rows.length) return false;
    if (meaning === "approved" && r.rows.every((x) => x.meaning === "performed")) {
      const managers = await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM memberships WHERE site_id = $1 AND role = 'manager'", [siteId]);
      if (Number(managers.rows[0]?.n ?? 0) === 1) return true;
    }
    throw new HttpError(403, "You already signed this package: another person must sign the next step");
  }

  private authorize(p: PkgRow, user: User, roles: Role[], action: "sign" | "return" | "reject", comment: string) {
    if (p.status === "released" || p.status === "rejected") throw new HttpError(409, "The package is closed");
    const link = this.currentChain(p.step);
    if (!link) throw new HttpError(409, "Nothing to sign");
    if (link.meaning === "performed") {
      if (action !== "sign") throw new HttpError(409, "A draft can only be signed and submitted by its owner");
      if (p.owner_id !== user.id) throw new HttpError(403, "Only the package owner signs Performed by");
    }
    if (!canApproveAny(roles, link.role)) throw new HttpError(403, `This step needs a ${ROLE_LABEL[link.role]}`);
    if (action !== "sign" && comment.trim().length < 5) throw new HttpError(400, "A comment is required");
    return link;
  }

  async act(siteId: string, user: User, roles: Role[], id: string, input: { action: "sign" | "return" | "reject"; comment: string; nonce: string; signature: Hex }) {
    const p = await this.row(siteId, id);
    const link = this.authorize(p, user, roles, input.action, input.comment);
    const soleManager = await this.segregation(siteId, id, user, input.action, link.meaning);
    await this.validatorGate(siteId, user, input.action, link.meaning);
    if (input.action === "sign" && link.meaning === "performed") {
      const full = await this.get(siteId, id);
      if (!full.readiness.ready) throw new HttpError(409, "Not ready to submit: " + full.readiness.items.filter((i) => !i.ok).map((i) => i.label).join(", "));
    }
    // what this signature must state: for Performed by, the package as it is now; after that, what the owner signed
    let expected: ReleaseStatement | null = null;
    if (input.action === "sign") {
      expected = link.meaning === "performed" ? await this.statementOf(siteId, p) : await this.signedStatement(id);
      if (link.meaning !== "performed" && (await this.statementOf(siteId, p)).contentHash !== expected.contentHash) throw new HttpError(409, "The package changed after it was submitted: return it to the owner");
    }
    const actor = `user:${user.address}`;
    const nextStep: Record<Step, Step> = { draft: "qe_review", qe_review: "approval", approval: "released", released: "released" };
    const sig = await this.db.tx(async (q) => {
      const proof = { nonce: input.nonce, signature: input.signature };
      const s = expected ? await this.sigs.consumeRelease(q, user, { packageId: id, meaning: link.meaning }, proof) : await this.sigs.consume(q, user, { action: `validation.${input.action}`, entity: `${id}#${link.meaning}` }, proof);
      if (expected) {
        const m = (s as Awaited<ReturnType<Signatures["consumeRelease"]>>).typed.message;
        if (m.site !== siteId || m.runId !== expected.runId || m.lot !== expected.lot || m.contentHash !== expected.contentHash || m.proofRoot !== expected.proofRoot)
          throw new HttpError(409, "The package or its stage proofs changed since this signature was prepared: sign again");
        if (link.meaning === "performed") {
          await q.query("UPDATE package_signatures SET cleared_at = now() WHERE package_id = $1 AND cleared_at IS NULL", [id]);
          await q.query("UPDATE validation_packages SET release_json = $1 WHERE id = $2", [JSON.stringify(expected), id]);
        }
        await q.query("INSERT INTO package_signatures (id, package_id, meaning, role, user_id, address, signature_id, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [newId("psg"), id, link.meaning, link.role, user.id, user.address, s.id, input.comment || null]);
        const step = nextStep[p.step];
        await q.query("UPDATE validation_packages SET step = $1, status = $2, returned_comment = NULL WHERE id = $3", [step, step === "released" ? "released" : "in_review", id]);
      } else if (input.action === "return") {
        await q.query("UPDATE package_signatures SET cleared_at = now() WHERE package_id = $1 AND cleared_at IS NULL", [id]);
        await q.query("UPDATE validation_packages SET step = 'draft', status = 'changes_requested', returned_comment = $1 WHERE id = $2", [input.comment, id]);
      } else {
        await q.query("UPDATE validation_packages SET status = 'rejected', returned_comment = $1 WHERE id = $2", [input.comment, id]);
      }
      return s;
    });
    const type = input.action === "sign" ? `signed.${link.meaning}` : input.action === "return" ? "changes_requested" : "rejected";
    await this.audit(siteId, actor, id, type, { role: link.role, comment: input.comment || null, signatureId: sig.id, typedData: sig.typed, signature: input.signature, ...(soleManager ? { soleManager: true } : {}) });
    const label = input.action === "sign" ? `${link.label}${soleManager ? " (the org's only manager, who also performed it)" : ""}` : type.replace("_", " ");
    await this.rec.decide(siteId, { agent: actor, kind: `validation.${type}`, runId: p.run_id, stageCode: p.stage_code, summary: `VP-${p.number} ${p.title}: ${label}`, reason: input.comment || null, data: { packageId: id, signatureId: sig.id, ...(soleManager ? { soleManager: true } : {}) } });
    if (input.action === "sign" && link.meaning === "approved") await this.release(siteId, actor, p);
    return this.get(siteId, id);
  }

  /** Apply the package's outcome. */
  private async release(siteId: string, actor: string, p: PkgRow) {
    let outcome = `${PACKAGE_LABEL[p.type]} released`;
    if (p.type === "stage_validation" && p.run_id && p.stage_code) {
      const run = await this.engine.view(siteId, p.run_id);
      const st = run.stages.find((s) => s.code === p.stage_code);
      if (st && (st.state === "awaiting_approval" || st.state === "held")) {
        if (st.gateItemId) await this.db.query("UPDATE inbox_items SET status = 'approved', decided_by = $1, reason = $2, decided_at = now() WHERE id = $3 AND status = 'pending'", [actor.replace("user:", ""), `Released by validation package VP-${p.number}`, st.gateItemId]);
        await this.inbox.execute(siteId, actor, { tool: "release_gate", args: { runId: p.run_id, stageCode: p.stage_code } });
        outcome = `Gate ${p.run_id} · ${p.stage_code} released`;
      } else outcome = `Stage ${p.run_id} · ${p.stage_code} validated`;
    }
    await this.db.query("UPDATE validation_packages SET outcome = $1 WHERE id = $2", [outcome, p.id]);
    await this.audit(siteId, actor, p.id, "released", { outcome });
    const st = await this.signedStatement(p.id);
    const lot: ReleaseLot = { siteId, lotLabel: st.lot, packageId: p.id, runId: st.runId, contentHash: st.contentHash, proofRoot: st.proofRoot };
    const relay = await this.trust.recordRelease(siteId, lot);
    // OrdoLotResolver re-checks every stage and parameter proof the root folds before it records the release
    const stages = st.stages.length && this.stageProofs ? await this.stageProofs.bundle(st.runId, st.stages) : { root: ZERO_ROOT, proofs: [] };
    const params = st.params?.length && this.specProofs ? (await this.specProofs.bundle(st.runId, stages.root, st.params)).params : [];
    if (st.runId) await this.lots?.release(siteId, lot, stages.proofs, params).catch((e: unknown) => console.error("[ordo] ens release", e));
    if (relay) await this.audit(siteId, "system:relayer", p.id, relay.status === "done" ? "recorded_onchain" : "onchain_failed", { txHash: relay.txHash, error: relay.error });
  }

  async list(siteId: string, user: User, roles: Role[]) {
    const rows = (await this.db.query<PkgRow & { owner_address: string; owner_name: string | null; checks_total: string; checks_done: string }>(
      `SELECT p.id, p.site_id, p.number, p.type, p.title, p.owner_id, p.status, p.step, p.objective, p.acceptance, p.sample_plan, p.run_id, p.stage_code, p.template_id, p.asset_id, p.outcome, p.precheck_json, p.returned_comment, p.created_at::text AS created_at, p.updated_at::text AS updated_at, p.window_start::text AS window_start, p.window_end::text AS window_end, u.address AS owner_address, u.display_name AS owner_name,
        (SELECT COUNT(*)::text FROM validation_checks c WHERE c.package_id = p.id) AS checks_total,
        (SELECT COUNT(*)::text FROM validation_checks c WHERE c.package_id = p.id AND c.status <> 'pending') AS checks_done
       FROM validation_packages p JOIN users u ON u.id = p.owner_id WHERE p.site_id = $1 ORDER BY p.updated_at DESC`,
      [siteId],
    )).rows;
    return rows.map((p) => {
      const link = this.currentChain(p.step);
      const waitingOn = p.status === "released" || p.status === "rejected" ? null : p.status === "draft" || p.status === "changes_requested" ? "Owner" : link ? ROLE_LABEL[link.role] : null;
      const needsMe = (p.status === "draft" || p.status === "changes_requested") ? p.owner_id === user.id : Boolean(link && p.status === "in_review" && canApproveAny(roles, link.role));
      return {
        id: p.id,
        number: p.number,
        code: `VP-${p.number}`,
        type: p.type,
        typeLabel: PACKAGE_LABEL[p.type],
        title: p.title,
        status: p.status,
        step: p.step,
        stepIndex: this.stepIndex(p),
        waitingOn,
        needsMe,
        owner: { address: p.owner_address, name: p.owner_name },
        runId: p.run_id,
        stageCode: p.stage_code,
        checks: { total: Number(p.checks_total), done: Number(p.checks_done) },
        updatedAt: new Date(p.updated_at).toISOString(),
      };
    });
  }

  private stepIndex(p: PkgRow) {
    if (p.status === "released") return 5;
    if (p.step === "approval") return 4;
    if (p.step === "qe_review") return 3;
    return p.precheck_json ? 1 : 0;
  }

  async get(siteId: string, id: string) {
    const p = await this.row(siteId, id);
    const owner = (await this.db.query<{ address: string; display_name: string | null }>("SELECT address, display_name FROM users WHERE id = $1", [p.owner_id])).rows[0]!;
    const checks = (await this.db.query<{ id: string; criterion: string; method: string; target: string; source: string; result: string | null; actual: string | null; status: string; auto: boolean; recorded_by: string | null; recorded_at: string | null }>(
      "SELECT id, criterion, method, target, source, result, actual, status, auto, recorded_by, recorded_at::text FROM validation_checks WHERE package_id = $1 ORDER BY sort",
      [id],
    )).rows.map((c) => ({ id: c.id, criterion: c.criterion, method: c.method, target: c.target, source: c.source, result: c.result, actual: c.actual, status: c.status, auto: c.auto, recordedBy: c.recorded_by, recordedAt: c.recorded_at ? new Date(c.recorded_at).toISOString() : null }));
    const evidence = (await this.db.query<{ id: string; name: string; requirement: string; required: boolean; filename: string | null; mime: string | null; size: number | null; sha256: string | null; uploaded_by: string | null; uploaded_at: string | null; origin: string; version: number; removed_at: string | null }>(
      "SELECT id, name, requirement, required, filename, mime, size, sha256, uploaded_by, uploaded_at::text, origin, version, removed_at::text FROM evidence WHERE package_id = $1 ORDER BY required DESC, name, version",
      [id],
    )).rows.map((e) => ({ id: e.id, name: e.name, requirement: e.requirement, required: e.required, filename: e.filename, mime: e.mime, size: e.size === null ? null : Number(e.size), sha256: e.sha256, uploadedBy: e.uploaded_by, uploadedAt: e.uploaded_at ? new Date(e.uploaded_at).toISOString() : null, origin: e.origin, version: Number(e.version), removedAt: e.removed_at ? new Date(e.removed_at).toISOString() : null, zeroG: null as ReplicaView | null }));
    const copies = this.replicas ? await this.replicas.of(evidence.flatMap((e) => (e.sha256 ? [e.sha256] : []))) : null;
    for (const e of evidence) e.zeroG = (e.sha256 && copies?.get(e.sha256)) || null;
    const sigRows = (await this.db.query<{ meaning: string; role: Role; address: string; display_name: string | null; signature_id: string; comment: string | null; created_at: string; ledger_seq: number | null; signature: string }>(
      "SELECT ps.meaning, ps.role, ps.address, u.display_name, ps.signature_id, ps.comment, ps.created_at::text, s.ledger_seq, s.signature FROM package_signatures ps JOIN users u ON u.id = ps.user_id JOIN signatures s ON s.id = ps.signature_id WHERE ps.package_id = $1 AND ps.cleared_at IS NULL ORDER BY ps.created_at",
      [id],
    )).rows;
    const chain = CHAIN.map((c) => {
      const s = sigRows.find((x) => x.meaning === c.meaning);
      const current = this.currentChain(p.step)?.meaning === c.meaning && p.status !== "rejected";
      return {
        meaning: c.meaning,
        label: c.label,
        role: c.role,
        roleLabel: ROLE_LABEL[c.role],
        state: s ? "signed" : p.status === "changes_requested" && c.meaning !== "performed" ? "returned" : current ? "awaiting" : "pending",
        signer: s ? { address: s.address, name: s.display_name } : null,
        signedAt: s ? new Date(s.created_at).toISOString() : null,
        signature: s?.signature ?? null,
        comment: s?.comment ?? null,
      };
    });
    const audit = (await this.ledger.latest(300, id)).reverse().map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type.replace("validation.", ""), payload: e.payload, entryHash: e.entryHash }));
    const live = evidence.filter((e) => !e.removedAt);
    // the linked stage's parameters as judged, so each automated check can be drawn against its band
    const parameters = p.run_id && p.stage_code ? ((await this.engine.view(siteId, p.run_id).catch(() => null))?.stages.find((s) => s.code === p.stage_code)?.criteriaResults ?? []) : [];
    return {
      id: p.id,
      number: p.number,
      code: `VP-${p.number}`,
      type: p.type,
      typeLabel: PACKAGE_LABEL[p.type],
      title: p.title,
      status: p.status,
      step: p.step,
      stepIndex: this.stepIndex(p),
      owner: { id: p.owner_id, address: owner.address, name: owner.display_name },
      objective: p.objective,
      acceptance: p.acceptance,
      samplePlan: p.sample_plan,
      windowStart: p.window_start ? new Date(p.window_start).toISOString() : null,
      windowEnd: p.window_end ? new Date(p.window_end).toISOString() : null,
      runId: p.run_id,
      stageCode: p.stage_code,
      templateId: p.template_id,
      assetId: p.asset_id,
      outcome: p.outcome,
      returnedComment: p.returned_comment,
      assessment: p.precheck_json ? JSON.parse(p.precheck_json) : null,
      checks,
      parameters,
      evidence,
      chain,
      readiness: this.readiness(p, checks, live, p.run_id && this.stageProofs && p.status !== "released" ? await this.stageProofs.pendingStages(p.run_id) : []),
      onchain: await this.trust.relayOf(siteId, id),
      audit,
      createdAt: new Date(p.created_at).toISOString(),
      updatedAt: new Date(p.updated_at).toISOString(),
    };
  }
}
