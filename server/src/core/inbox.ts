import type { Hex } from "viem";
import type { Signatures, User } from "../auth/auth.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import { ROLE_LABEL, type InboxItemView, type InboxOption, type Role, type ToolCall } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { newId, type PlantService } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";
import type { Templates } from "./templates.js";
import type { Trust } from "./trust.js";
import type { WorkOrders } from "./workorders.js";

export type RaiseInput = Omit<InboxItemView, "id" | "status" | "decidedBy" | "decidedOption" | "reason" | "signatureId" | "createdAt" | "decidedAt" | "incidentId"> & { incidentId?: string | null };
export type ActionCall = InboxOption["action"];

interface Row {
  id: string;
  kind: "approval" | "exception";
  category: string;
  title: string;
  body: string;
  agent: string;
  severity: string | null;
  run_id: string | null;
  stage_code: string | null;
  asset_id: string | null;
  incident_id: string | null;
  metrics_json: string;
  options_json: string;
  recommended: number | null;
  confidence: number | null;
  required_role: Role;
  status: InboxItemView["status"];
  decided_by: string | null;
  decided_option: number | null;
  reason: string | null;
  signature_id: string | null;
  created_at: string;
  decided_at: string | null;
}
const toView = (r: Row): InboxItemView => ({
  id: r.id,
  kind: r.kind,
  category: r.category,
  title: r.title,
  body: r.body,
  agent: r.agent,
  severity: r.severity,
  runId: r.run_id,
  stageCode: r.stage_code,
  assetId: r.asset_id,
  incidentId: r.incident_id,
  metrics: JSON.parse(r.metrics_json),
  options: JSON.parse(r.options_json),
  recommended: r.recommended === null ? null : Number(r.recommended),
  confidence: r.confidence === null ? null : Number(r.confidence),
  requiredRole: r.required_role,
  status: r.status,
  decidedBy: r.decided_by,
  decidedOption: r.decided_option === null ? null : Number(r.decided_option),
  reason: r.reason,
  signatureId: r.signature_id,
  createdAt: new Date(r.created_at).toISOString(),
  decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
});

export const REJECT = -1;

/**
 * The operational inbox: quality gates, holds, timeouts and agent recommendations that need a
 * person. Every decision is signed with the decider's wallet (EIP-712) and written to the ledger.
 */
export class Inbox {
  /** set after construction */
  trust!: Trust;
  workOrders?: WorkOrders;
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private engine: RunEngine,
    private plant: PlantService,
    private templates: Templates,
    private chainId: number,
  ) {}

  async raise(siteId: string, i: RaiseInput): Promise<InboxItemView> {
    const id = newId("ibx");
    await this.db.query(
      `INSERT INTO inbox_items (id, site_id, kind, category, title, body, agent, severity, run_id, stage_code, asset_id, incident_id, metrics_json, options_json, recommended, confidence, required_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, siteId, i.kind, i.category, i.title, i.body, i.agent, i.severity, i.runId, i.stageCode, i.assetId, i.incidentId ?? null, JSON.stringify(i.metrics), JSON.stringify(i.options), i.recommended, i.confidence, i.requiredRole],
    );
    await this.rec.decide(siteId, {
      agent: i.agent,
      kind: "inbox.raised",
      runId: i.runId,
      stageCode: i.stageCode,
      assetId: i.assetId,
      incidentId: i.incidentId ?? null,
      summary: `${i.category}: ${i.title}`,
      reason: `Needs ${ROLE_LABEL[i.requiredRole]}${i.recommended !== null && i.options[i.recommended] ? ` · recommends “${i.options[i.recommended]!.label}”` : ""}`,
      confidence: i.confidence,
      data: { itemId: id },
    });
    return this.get(siteId, id);
  }

  async list(siteId: string, f: { status?: string; runId?: string } = {}): Promise<InboxItemView[]> {
    const where = ["site_id = $1"];
    const params: unknown[] = [siteId];
    if (f.status && f.status !== "all") where.push(`status = $${params.push(f.status)}`);
    if (f.runId) where.push(`run_id = $${params.push(f.runId)}`);
    const r = await this.db.query<Row>(`SELECT id, kind, category, title, body, agent, severity, run_id, stage_code, asset_id, incident_id, metrics_json, options_json, recommended, confidence, required_role, status, decided_by, decided_option, reason, signature_id, created_at::text AS created_at, decided_at::text AS decided_at FROM inbox_items WHERE ${where.join(" AND ")} ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200`, params);
    return r.rows.map(toView);
  }

  async get(siteId: string, id: string): Promise<InboxItemView> {
    const r = await this.db.query<Row>("SELECT id, kind, category, title, body, agent, severity, run_id, stage_code, asset_id, incident_id, metrics_json, options_json, recommended, confidence, required_role, status, decided_by, decided_option, reason, signature_id, created_at::text AS created_at, decided_at::text AS decided_at FROM inbox_items WHERE id = $1 AND site_id = $2", [id, siteId]);
    if (!r.rows[0]) throw new HttpError(404, "Item not found");
    return toView(r.rows[0]);
  }

  /** Releasing product through a quality gate is a validator's decision. */
  private async qualityGate(siteId: string, user: User, item: InboxItemView, option: number) {
    if (item.category === "Quality gate" && option !== REJECT && item.options[option]?.action.tool === "release_gate") await this.trust.requireValidator(siteId, user);
  }

  private optionLabel(item: InboxItemView, option: number): string {
    if (option === REJECT) return item.runId && item.stageCode ? `Reject & hold ${item.stageCode}` : "Reject";
    const o = item.options[option];
    if (!o) throw new HttpError(400, "Unknown option");
    return o.label;
  }

  /** The exact typed data the decider's wallet signs. The option is part of the signed entity. */
  async signatureRequest(siteId: string, user: User, roles: Role[], id: string, option: number, comment: string, chainId = this.chainId) {
    const item = await this.get(siteId, id);
    if (item.status !== "pending") throw new HttpError(409, "Already decided");
    if (!canApproveAny(roles, item.requiredRole)) throw new HttpError(403, `Needs a ${ROLE_LABEL[item.requiredRole]}`);
    await this.qualityGate(siteId, user, item, option);
    return this.sigs.request(user, { action: "inbox.decide", entity: `${id}#${option}`, meaning: `${this.optionLabel(item, option)} — ${item.title}`, comment, site: siteId, chainId });
  }

  async decide(siteId: string, user: User, roles: Role[], id: string, input: { option: number; reason: string; nonce: string; signature: Hex }): Promise<InboxItemView> {
    const item = await this.get(siteId, id);
    if (item.status !== "pending") throw new HttpError(409, "Already decided");
    if (!canApproveAny(roles, item.requiredRole)) throw new HttpError(403, `Needs a ${ROLE_LABEL[item.requiredRole]}`);
    await this.qualityGate(siteId, user, item, input.option);
    const label = this.optionLabel(item, input.option);
    const actor = `user:${user.address}`;
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "inbox.decide", entity: `${id}#${input.option}` }, { nonce: input.nonce, signature: input.signature });
      const r = await q.query("UPDATE inbox_items SET status = $1, decided_by = $2, decided_option = $3, reason = $4, signature_id = $5, decided_at = now() WHERE id = $6 AND status = 'pending' RETURNING id", [
        input.option === REJECT ? "rejected" : "approved",
        user.address,
        input.option,
        input.reason || null,
        s.id,
        id,
      ]);
      if (!r.rows.length) throw new HttpError(409, "Already decided");
      return s;
    });
    const d = await this.rec.decide(siteId, {
      agent: actor,
      kind: "inbox.decided",
      runId: item.runId,
      stageCode: item.stageCode,
      assetId: item.assetId,
      incidentId: item.incidentId,
      summary: `${label}`,
      reason: input.reason || null,
      data: { itemId: id, option: input.option, signatureId: sig.id, typedData: sig.typed, signature: input.signature, recommended: item.recommended, followedRecommendation: item.recommended === input.option },
    });
    await this.db.query("UPDATE signatures SET ledger_seq = $1 WHERE id = $2", [d.ledgerSeq, sig.id]);
    const action: ActionCall =
      input.option === REJECT ? (item.runId && item.stageCode ? { tool: "hold_stage", args: { runId: item.runId, stageCode: item.stageCode, reason: input.reason || "Rejected" } } : { tool: "none", args: {} }) : item.options[input.option]!.action;
    await this.execute(siteId, actor, action, sig.id);
    if (item.incidentId && input.option !== REJECT) await this.db.query("UPDATE incidents SET status = 'actioned' WHERE id = $1 AND status = 'open'", [item.incidentId]);
    return this.get(siteId, id);
  }

  /** Carry out an allow-listed action — after the policy guard allowed it, or a person signed it. */
  async execute(siteId: string, actor: string, action: ActionCall, signatureId: string | null = null): Promise<string> {
    switch (action.tool) {
      case "none":
        return "No action";
      case "release_gate": {
        const { runId, stageCode } = action.args;
        const out = await this.engine.release(siteId, runId, stageCode);
        await this.rec.decide(siteId, { agent: actor, kind: out.resumed ? "stage.resumed" : "gate.released", runId, stageCode, summary: out.resumed ? `Resumed ${stageCode} ${out.spec.name}` : `Released gate ${stageCode} ${out.spec.name}`, data: { signatureId } });
        await this.engine.tickRun(siteId, runId);
        return "Released";
      }
      case "hold_stage": {
        const { runId, stageCode, reason } = action.args;
        await this.engine.hold(siteId, actor, runId, stageCode, reason);
        return "Held";
      }
      case "reassign_stage":
        await this.engine.reassign(siteId, actor, action.args.runId, action.args.stageCode, action.args.targetAssetId);
        return "Reassigned";
      case "request_inspection": {
        const a = await this.plant.asset(siteId, action.args.assetId);
        await this.rec.decide(siteId, { agent: actor, kind: "inspection.requested", assetId: a.id, summary: `Inspection sampling on ${a.name} raised to ${action.args.sampleRatePct}%`, data: action.args });
        await this.raise(siteId, {
          kind: "exception",
          category: "Inspection",
          title: `Inspect ${action.args.sampleRatePct}% of units from ${a.name}`,
          body: `Sampling raised by ${actor.replace(/^\w+:/, "")}. Record the inspection result when done.`,
          agent: actor,
          severity: null,
          runId: null,
          stageCode: null,
          assetId: a.id,
          metrics: [],
          options: [{ label: "Inspection done", detail: "Results recorded on the stage", action: { tool: "none", args: {} } }],
          recommended: 0,
          confidence: null,
          requiredRole: "manager",
        });
        return "Inspection requested";
      }
      case "notify_operator": {
        const a = await this.plant.asset(siteId, action.args.assetId);
        await this.raise(siteId, {
          kind: "exception",
          category: "Instruction",
          title: `${a.name}: ${action.args.instruction}`,
          body: `Instruction from ${actor.replace(/^\w+:/, "")}. Confirm when carried out.`,
          agent: actor,
          severity: null,
          runId: null,
          stageCode: null,
          assetId: a.id,
          metrics: [],
          options: [{ label: "Done", detail: "The instruction was carried out", action: { tool: "none", args: {} } }],
          recommended: 0,
          confidence: null,
          requiredRole: "manager",
        });
        return "Operator notified";
      }
      case "open_work_order": {
        const a = await this.plant.asset(siteId, action.args.assetId);
        const pm = (await this.templates.list(siteId)).find((t) => t.key === "predictive-maintenance");
        if (!pm) throw new HttpError(404, "Predictive maintenance template missing");
        const due = new Date(Date.now() + (action.args.windowMinutes + 120) * 60_000).toISOString();
        const runId = await this.engine.start(siteId, actor, { templateVersionId: pm.versionId, orderRef: `WO · ${a.name} · ${action.args.priority}`, quantity: 1, dueAt: due });
        await this.rec.decide(siteId, { agent: actor, kind: "work_order.opened", assetId: a.id, runId, summary: `Work order for ${a.name} (${action.args.priority}) opened as ${runId}`, data: action.args });
        const wo = await this.workOrders?.open(siteId, actor, { assetId: a.id, assetName: a.name, assetKind: a.kind, runId, priority: action.args.priority, incidentHash: await this.rec.headHash() });
        if (!wo) return `Work order ${runId}`;
        const pay = wo.status === "escrowed" ? `, payment escrowed for ${wo.vendor!.company}` : wo.status === "escrow_failed" ? ", escrow failed" : wo.vendor ? `, assigned to ${wo.vendor.company}` : ", no vendor yet";
        return `Work order ${wo.id} (run ${runId})${pay}`;
      }
    }
  }
}

export type { ToolCall };
