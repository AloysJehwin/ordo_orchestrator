import type { Agents } from "../agents/agents.js";
import { signalStats } from "../agents/agents.js";
import type { Db } from "../db/db.js";
import { detectAll } from "../domain/detector.js";
import { forecast } from "../domain/forecast.js";
import { evaluate, type Policy } from "../domain/policy.js";
import { ROLE_RANK, type Anomaly, type AssetView, type AutonomyLevel, type InboxOption, type ToolCall } from "../domain/types.js";
import type { PlantService } from "../plant/plant.js";
import type { AgentLicenses } from "./agent-licenses.js";
import type { Inbox } from "./inbox.js";
import type { Recorder } from "./recorder.js";

const CLEAR_AFTER_MIN = 10;

/**
 * The agents' watch loop over real telemetry: detect → diagnose → recommend → policy guard →
 * act (in policy) or escalate to the inbox (needs a person). One open incident per asset.
 */
export class Monitor {
  /** Playbooks this site licenses from other sites' proven agents (set by the wiring) */
  licenses: AgentLicenses | null = null;
  /** Machines with their own wallet buy an assessment when an incident opens (set by the wiring) */
  machines: import("./machines.js").Machines | null = null;

  constructor(
    private db: Db,
    private plant: PlantService,
    private agents: Agents,
    private inbox: Inbox,
    private rec: Recorder,
    private policy: { policy: Policy; hash: string },
    private now: () => number = Date.now,
  ) {}

  async scan(siteId: string): Promise<{ opened: number; closed: number }> {
    const views = await this.plant.views(siteId);
    const open = new Map(
      (await this.db.query<{ id: string; asset_id: string; opened_at: string; data_json: string }>("SELECT id, asset_id, opened_at::text, data_json FROM incidents WHERE site_id = $1 AND status <> 'closed'", [siteId])).rows.map((r) => [
        r.asset_id,
        r,
      ]),
    );
    let opened = 0;
    let closed = 0;
    for (const a of views) {
      const watch = Object.keys(a.limits).length > 0 || Object.keys(a.latest).some((k) => k.startsWith("condition."));
      if (!watch) continue;
      const samples = (await this.plant.samples(a.id, 120)).map((s) => ({ ...s, unit: a.limits[s.signal]?.unit ?? "" }));
      let anomaly = detectAll(samples, a.limits);
      if (!anomaly) {
        const fault = Object.entries(a.latest).find(([k, v]) => k.startsWith("condition.") && v.text === "FAULT");
        if (fault) anomaly = { assetId: a.id, signal: fault[0], value: 1, limit: 1, level: "alarm", kind: "threshold", trendPerHour: 0, minute: Date.parse(fault[1].ts) / 60_000 };
      }
      const inc = open.get(a.id);
      if (anomaly && !inc) {
        await this.openIncident(siteId, a, anomaly, samples, views);
        opened += 1;
      } else if (!anomaly && inc) {
        const lastSeen = (JSON.parse(inc.data_json) as { lastSeenMin?: number }).lastSeenMin ?? Date.parse(inc.opened_at) / 60_000;
        if (this.now() / 60_000 - lastSeen >= CLEAR_AFTER_MIN) {
          await this.db.query("UPDATE incidents SET status = 'closed', closed_at = now() WHERE id = $1", [inc.id]);
          await this.rec.decide(siteId, { agent: `agent:${a.owningAgent}`, kind: "incident.closed", incidentId: inc.id, assetId: a.id, summary: `${a.name} back within limits for ${CLEAR_AFTER_MIN} min; incident closed` });
          closed += 1;
        }
      } else if (anomaly && inc) {
        await this.db.query("UPDATE incidents SET data_json = $1, severity = CASE WHEN $2 = 'alarm' THEN 'alarm' ELSE severity END WHERE id = $3", [
          JSON.stringify({ ...JSON.parse(inc.data_json), lastSeenMin: this.now() / 60_000, last: anomaly }),
          anomaly.level,
          inc.id,
        ]);
      }
    }
    return { opened, closed };
  }

  private async openIncident(siteId: string, a: AssetView, anomaly: Anomaly, samples: Awaited<ReturnType<PlantService["samples"]>>, views: AssetView[]) {
    const n = Number((await this.db.query<{ n: string }>("SELECT COUNT(*)::text n FROM incidents WHERE site_id = $1", [siteId])).rows[0]!.n);
    const id = `INC-${101 + n}`;
    const agent = `agent:${a.owningAgent}`;
    const unit = a.limits[anomaly.signal]?.unit ?? "";
    const title = anomaly.signal.startsWith("condition.")
      ? `${a.name}: controller fault (${anomaly.signal.replace("condition.", "")})`
      : `${a.name}: ${anomaly.signal.replaceAll("_", " ")} ${anomaly.value} ${unit} ${anomaly.kind === "drift" ? "drifting" : `over ${anomaly.level} limit`}`;
    await this.db.query("INSERT INTO incidents (id, site_id, asset_id, status, title, severity, data_json) VALUES ($1,$2,$3,'open',$4,$5,$6)", [id, siteId, a.id, title, anomaly.level, JSON.stringify({ anomaly, lastSeenMin: this.now() / 60_000 })]);
    await this.rec.decide(siteId, { agent, kind: "incident.opened", incidentId: id, assetId: a.id, summary: title, data: { anomaly } });
    await this.machines?.onIncident(siteId, a.id, id).catch((e) => console.error("[ordo] machine purchase", e));

    const alarm = a.limits[anomaly.signal]?.alarm;
    const fc = alarm !== undefined ? forecast(samples, a.id, anomaly.signal, alarm) : null;
    const conditions = Object.fromEntries(Object.entries(a.latest).filter(([k]) => k.startsWith("condition.")).map(([k, v]) => [k, v.text ?? ""]));
    const diag = await this.agents.diagnose({
      asset: { id: a.id, name: a.name, kind: a.kind, status: a.status, statusDetail: a.statusDetail },
      anomaly,
      forecast: fc,
      last30min: signalStats(samples, a.id, 30),
      limits: a.limits,
      conditions,
    });
    await this.rec.decide(siteId, { agent, kind: "incident.diagnosed", incidentId: id, assetId: a.id, summary: diag.value.rootCause, confidence: diag.value.confidence, modelId: diag.modelId, data: { ...diag.value, forecast: fc, promptHash: diag.promptHash, inputHash: diag.inputHash, fallback: diag.fallback, provider: diag.provider, attestation: diag.attestation ?? null } });

    const stage = (
      await this.db.query<{ run_id: string; code: string; name: string | null; quantity: number; good: number; scrap: number }>(
        "SELECT sr.run_id, sr.code, sr.data_json::json->>'name' AS name, r.quantity, sr.units_good AS good, sr.units_scrap AS scrap FROM stage_runs sr JOIN runs r ON r.id = sr.run_id WHERE r.site_id = $1 AND r.status = 'running' AND sr.asset_id = $2 AND sr.state = 'running' LIMIT 1",
        [siteId, a.id],
      )
    ).rows[0];
    const licensed = (await this.licenses?.playbooksFor(siteId, a.owningAgent, { assetKind: a.kind, signal: anomaly.signal }))?.[0] ?? null;
    const rec = await this.agents.recommend({
      asset: { id: a.id, name: a.name, kind: a.kind, status: a.status },
      anomaly,
      forecast: fc,
      diagnosis: { rootCause: diag.value.rootCause, confidence: diag.value.confidence },
      activeStage: stage ? { runId: stage.run_id, stageCode: stage.code, stageName: stage.name ?? stage.code, unitsLeft: Math.max(0, Number(stage.quantity) - Number(stage.good) - Number(stage.scrap)) } : null,
      alternativeAssets: views.filter((v) => v.id !== a.id && v.kind === a.kind && !["offline", "alarm", "no_data"].includes(v.status)).map((v) => ({ id: v.id, name: v.name, status: v.status })),
      tools: "",
      ...(licensed ? { licensedPlaybook: { from: licensed.from, tokenId: licensed.tokenId, record: licensed.record, cases: licensed.cases } } : {}),
    });
    const level = await this.level(siteId);
    const quality = samples.filter((s) => s.signal === anomaly.signal).slice(-10).map((s) => s.quality);
    const verdicts = rec.value.actions.map((action) => ({ action, verdict: evaluate(action, { level, confidence: rec.value.confidence, inputQuality: quality, knownAssets: views.map((v) => v.id) }, this.policy.policy, this.policy.hash) }));
    await this.rec.decide(siteId, {
      agent,
      kind: "incident.recommended",
      incidentId: id,
      assetId: a.id,
      runId: stage?.run_id ?? null,
      stageCode: stage?.code ?? null,
      summary: rec.value.reason,
      confidence: rec.value.confidence,
      modelId: rec.modelId,
      data: { ...rec.value, grounding: rec.grounding, verdicts: verdicts.map((v) => ({ tool: v.action.tool, ...v.verdict })), autonomy: level, provider: rec.provider, attestation: rec.attestation ?? null, licensed: licensed ? { licenseId: licensed.licenseId, from: licensed.from, tokenId: licensed.tokenId, cases: licensed.cases.length } : null },
    });

    const needs = verdicts.filter((v) => v.verdict.outcome === "require_approval");
    for (const v of verdicts.filter((x) => x.verdict.outcome === "allow")) {
      const done = await this.inbox.execute(siteId, agent, v.action as ToolCall);
      await this.rec.decide(siteId, { agent: "guard:policy", kind: "action.executed", incidentId: id, assetId: a.id, summary: `${describe(v.action as ToolCall)} — ${done}`, reason: v.verdict.explanation, data: { ruleIds: v.verdict.ruleIds, policyHash: this.policy.hash } });
    }
    for (const v of verdicts.filter((x) => x.verdict.outcome === "block"))
      await this.rec.decide(siteId, { agent: "guard:policy", kind: "action.blocked", incidentId: id, assetId: a.id, summary: `Blocked ${String((v.action as { tool?: string }).tool)}`, reason: v.verdict.explanation, data: { ruleIds: v.verdict.ruleIds } });
    if (needs.length) {
      const role = needs.map((v) => v.verdict.role!).reduce((m, r) => (ROLE_RANK[r] > ROLE_RANK[m] ? r : m));
      const options: InboxOption[] = needs.map((v) => ({ label: describe(v.action as ToolCall), detail: v.verdict.explanation, action: v.action as ToolCall }));
      options.push({ label: "Acknowledge only", detail: "Keep monitoring; take no action now", action: { tool: "none", args: {} } });
      await this.inbox.raise(siteId, {
        kind: "exception",
        category: "Equipment",
        title,
        body: diag.value.rootCause,
        agent,
        severity: anomaly.level,
        runId: stage?.run_id ?? null,
        stageCode: stage?.code ?? null,
        assetId: a.id,
        incidentId: id,
        metrics: [
          { label: anomaly.signal.replaceAll("_", " "), value: `${anomaly.value} ${unit} · limit ${anomaly.limit}` },
          { label: "Trend", value: `${anomaly.trendPerHour} ${unit}/h` },
          ...(fc ? [{ label: "Time to alarm limit", value: fc.ttfHours === null ? "no upward trend" : `${Math.round(fc.ttfHours * 60)} min` }, { label: "P(failure 24 h)", value: `${Math.round(fc.pFailure24h * 100)}%` }] : []),
        ],
        options,
        recommended: 0,
        confidence: rec.value.confidence,
        requiredRole: role,
      });
    }
  }

  private async level(siteId: string): Promise<AutonomyLevel> {
    const r = await this.db.query<{ autonomy: AutonomyLevel }>("SELECT autonomy FROM lines WHERE site_id = $1 ORDER BY created_at LIMIT 1", [siteId]);
    return r.rows[0]?.autonomy ?? "L2";
  }
}

export function describe(a: ToolCall): string {
  switch (a.tool) {
    case "hold_stage":
      return `Hold ${a.args.runId} · ${a.args.stageCode}`;
    case "reassign_stage":
      return `Move ${a.args.runId} · ${a.args.stageCode} to another asset`;
    case "open_work_order":
      return `Open ${a.args.priority} work order within ${a.args.windowMinutes} min`;
    case "request_inspection":
      return `Raise inspection to ${a.args.sampleRatePct}%`;
    case "notify_operator":
      return `Tell the operator: ${a.args.instruction}`;
  }
}
