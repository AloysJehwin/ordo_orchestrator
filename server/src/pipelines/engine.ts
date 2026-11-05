import type { Db, Queryable } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import { AGENT_INFO, ASSET_KIND_LABEL, levelRank, type AgentKey, type AssetView, type AutonomyLevel, type InboxOption, type Role, type RunStatus, type RunView, type StageRunView, type StageSpec, type StageState, type TemplateView } from "../domain/types.js";
import { newId, type PlantService } from "../plant/plant.js";
import type { Recorder } from "../core/recorder.js";
import type { Templates } from "../core/templates.js";
import type { Inbox } from "../core/inbox.js";
import type { Schedules } from "../core/schedules.js";
import { evaluateCriteria, reshape, signalsOf, type SignalStats, type StageMeasurements } from "./criteria.js";
import type { StageSeries } from "./stage-series.js";
import { predecessors } from "./graph.js";

const RUN_ID_LOCK = 4243;

const DONE: StageState[] = ["completed", "done_deviation", "skipped"];
const ACTIVE: StageState[] = ["running", "awaiting_approval", "held"];

interface StageData {
  name?: string;
  workDone?: boolean;
  timeoutRaised?: boolean;
  gateItemId?: string | null;
  reworkUnits?: number;
  waitingReason?: string | null;
  criteria?: StageRunView["criteriaResults"];
  confirmedBy?: string;
  /** when the work finished: the end of the window a signed reading covers */
  workDoneAt?: string;
  /** parameter values an operator recorded for a stage with no asset to hold them as telemetry */
  readings?: Record<string, { value: number; ts: string }>;
}
interface StageRow {
  run_id: string;
  code: string;
  state: StageState;
  asset_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  units_good: number;
  units_scrap: number;
  baseline_json: string;
  outcome: string | null;
  deviation: boolean;
  data_json: string;
}
interface RunRow {
  id: string;
  site_id: string;
  line_id: string | null;
  template_version_id: string;
  order_ref: string;
  quantity: number;
  status: RunStatus;
  started_by: string | null;
  started_at: string;
  due_at: string | null;
  finished_at: string | null;
}

const agentActor = (a: AgentKey) => `agent:${a}`;
const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);

/**
 * Executes pipeline runs from real plant data. Progress comes from each asset's part counter
 * (MTConnect PartCount or an uploaded dataset) or from what an operator records; it is never
 * invented. Gates stop the run until a person with the stage's escalation role signs.
 */
export class RunEngine {
  /** set after construction (the inbox executes engine actions and the engine raises inbox items) */
  inbox!: Inbox;
  /** Set when stage timeouts run on Hedera's Schedule Service */
  timeouts: Pick<Schedules, "stageTimeout"> | null = null;
  /** Set when the signals a stage's criteria read are snapshotted with the run as its work finishes */
  series: StageSeries | null = null;
  constructor(
    private db: Db,
    private plant: PlantService,
    private templates: Templates,
    private rec: Recorder,
    private now: () => number = Date.now,
  ) {}

  // ---------------- Lifecycle ----------------
  async start(siteId: string, actor: string, input: { templateVersionId: string; orderRef: string; quantity: number; dueAt?: string | null; lineId?: string | null }): Promise<string> {
    const tpl = await this.templates.version(input.templateVersionId);
    const line = await this.line(siteId, input.lineId ?? null);
    // run ids are unique across every site (runs.id is the key, and passports and public pages use it), so number globally
    const id = await this.db.tx(async (q) => {
      if (this.db.kind === "postgres") await q.query("SELECT pg_advisory_xact_lock($1)", [RUN_ID_LOCK]);
      const max = Number((await q.query<{ n: string }>("SELECT COALESCE(MAX(CAST(substring(id FROM 3) AS INTEGER)), 1000)::text n FROM runs WHERE id ~ '^R-[0-9]+$'")).rows[0]!.n);
      const id = `R-${max + 1}`;
      await q.query("INSERT INTO runs (id, site_id, line_id, template_version_id, order_ref, quantity, status, started_by, due_at) VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8)", [
        id,
        siteId,
        line.id,
        tpl.versionId,
        input.orderRef,
        input.quantity,
        actor,
        input.dueAt ?? null,
      ]);
      for (const s of tpl.spec.stages) await q.query("INSERT INTO stage_runs (run_id, code, state, data_json) VALUES ($1,$2,'queued',$3)", [id, s.code, JSON.stringify({ name: s.name })]);
      return id;
    });
    await this.rec.decide(siteId, { agent: actor, kind: "run.started", runId: id, summary: `Started ${tpl.name} v${tpl.version} for ${input.orderRef} · ${input.quantity} units`, data: { templateVersionId: tpl.versionId, line: line.name, autonomy: line.autonomy } });
    await this.tickRun(siteId, id);
    return id;
  }

  async abort(siteId: string, actor: string, runId: string, reason: string) {
    const run = await this.runRow(siteId, runId);
    if (run.status !== "running") throw new HttpError(409, "Run is not running");
    await this.db.query("UPDATE runs SET status = 'aborted', finished_at = now() WHERE id = $1", [runId]);
    await this.db.query("UPDATE inbox_items SET status = 'expired' WHERE run_id = $1 AND status = 'pending'", [runId]);
    await this.rec.decide(siteId, { agent: actor, kind: "run.aborted", runId, summary: `Run aborted`, reason });
  }

  /** Advance every running run of every site (called once per request cycle, under a lease). */
  async tick(): Promise<void> {
    const runs = await this.db.query<{ id: string; site_id: string }>("SELECT id, site_id FROM runs WHERE status = 'running' ORDER BY started_at");
    for (const r of runs.rows) await this.tickRun(r.site_id, r.id).catch((e) => console.error(`[ordo] run ${r.id}`, e));
  }

  /** Step run: start every stage whose upstream is complete, even at L1. A pending gate is returned instead. */
  async step(siteId: string, actor: string, runId: string): Promise<{ started: string[]; gateItemId: string | null }> {
    const ctx = await this.context(siteId, runId);
    const gate = ctx.rows.find((r) => r.state === "awaiting_approval" || r.state === "held");
    if (gate) return { started: [], gateItemId: (JSON.parse(gate.data_json) as StageData).gateItemId ?? null };
    const started = await this.startReady(ctx, actor, true);
    await this.tickRun(siteId, runId);
    return { started, gateItemId: null };
  }

  // ---------------- Operator actions ----------------
  /** Record units for a stage (manual stages, or assets without a part counter), and the parameter values its criteria need. */
  async record(siteId: string, actor: string, runId: string, code: string, input: { good: number; scrap: number; complete: boolean; note?: string; readings?: { signal: string; value: number }[] }) {
    const ctx = await this.context(siteId, runId);
    const row = this.row(ctx, code);
    if (row.state !== "running") throw new HttpError(409, `Stage ${code} is ${row.state.replace("_", " ")}`);
    const hasCounter = await this.hasCounter(row.asset_id);
    const spec = this.spec(ctx.tpl, code);
    const good = hasCounter && spec.mode !== "manual" ? Number(row.units_good) : Math.max(0, Math.round(input.good));
    await this.db.query("UPDATE stage_runs SET units_good = $1, units_scrap = $2 WHERE run_id = $3 AND code = $4", [good, Math.max(0, Math.round(input.scrap)), runId, code]);
    if (input.readings?.length) {
      // measured on the stage's asset when it has one (the same path a manual data source uses), else kept with the stage
      const readings = input.readings.map((r) => ({ signal: r.signal.trim().toLowerCase().replace(/\s+/g, "_"), value: r.value }));
      if (row.asset_id) for (const r of readings) await this.plant.manualReading(siteId, row.asset_id, { signal: r.signal, value: r.value, text: null });
      else {
        const data = JSON.parse(row.data_json) as StageData;
        const ts = new Date(this.now()).toISOString();
        await this.patchData(runId, code, { readings: { ...(data.readings ?? {}), ...Object.fromEntries(readings.map((r) => [r.signal, { value: r.value, ts }])) } });
      }
      await this.rec.decide(siteId, { agent: actor, kind: "stage.parameters_recorded", runId, stageCode: code, summary: `Recorded ${readings.length} parameter reading(s) for ${code} ${spec.name}`, data: { readings } });
    }
    await this.rec.decide(siteId, {
      agent: actor,
      kind: "stage.recorded",
      runId,
      stageCode: code,
      summary: `Recorded ${good} good · ${Math.round(input.scrap)} scrap${input.complete ? " and marked work complete" : ""}`,
      reason: input.note ?? null,
    });
    if (input.complete) await this.patchData(runId, code, { workDone: true, confirmedBy: actor });
    await this.tickRun(siteId, runId);
  }

  /** An operator raises a hold on a running stage. */
  async hold(siteId: string, actor: string, runId: string, code: string, reason: string, agent?: AgentKey) {
    const ctx = await this.context(siteId, runId);
    const row = this.row(ctx, code);
    if (!["running", "awaiting_approval"].includes(row.state)) throw new HttpError(409, `Stage ${code} cannot be held while ${row.state.replace("_", " ")}`);
    const spec = this.spec(ctx.tpl, code);
    await this.db.query("UPDATE stage_runs SET state = 'held' WHERE run_id = $1 AND code = $2", [runId, code]);
    await this.rec.decide(siteId, { agent: actor, kind: "stage.held", runId, stageCode: code, summary: `Held ${code} ${spec.name}`, reason });
    await this.ensureGate(ctx, row, spec, { held: true, reason, agent: agent ?? spec.agent });
  }

  /** Release a gate (approve) — called by the inbox after the signature was verified. */
  async release(siteId: string, runId: string, code: string) {
    const q: Queryable = this.db;
    const ctx = await this.context(siteId, runId);
    const row = this.row(ctx, code);
    if (row.state !== "awaiting_approval" && row.state !== "held") throw new HttpError(409, `Stage ${code} has no gate waiting`);
    const data = JSON.parse(row.data_json) as StageData;
    const spec = this.spec(ctx.tpl, code);
    if (!data.workDone) {
      // A hold on unfinished work: releasing resumes it.
      await q.query("UPDATE stage_runs SET state = 'running' WHERE run_id = $1 AND code = $2", [runId, code]);
      await this.patchData(runId, code, { gateItemId: null }, q);
      return { resumed: true, spec };
    }
    const failed = (data.criteria ?? []).some((c) => c.ok === false);
    await q.query("UPDATE stage_runs SET state = $1, ended_at = COALESCE(ended_at, now()), deviation = $2 WHERE run_id = $3 AND code = $4", [failed ? "done_deviation" : "completed", failed, runId, code]);
    await this.patchData(runId, code, { gateItemId: null }, q);
    return { resumed: false, spec };
  }

  /** Send a stage's scrapped units back to the rework target stage. */
  async sendBack(runId: string, code: string) {
    const q: Queryable = this.db;
    await this.patchData(runId, code, { workDone: false, gateItemId: null }, q);
    await q.query("UPDATE stage_runs SET state = 'running' WHERE run_id = $1 AND code = $2", [runId, code]);
  }

  async reassign(siteId: string, actor: string, runId: string, code: string, targetAssetId: string) {
    const ctx = await this.context(siteId, runId);
    const row = this.row(ctx, code);
    const spec = this.spec(ctx.tpl, code);
    const target = (await this.plant.views(siteId)).find((a) => a.id === targetAssetId);
    if (!target) throw new HttpError(404, "Asset not found");
    if (target.kind !== spec.resourceKind) throw new HttpError(400, `${target.name} is not a ${ASSET_KIND_LABEL[spec.resourceKind]}`);
    if (!ACTIVE.includes(row.state)) throw new HttpError(409, `Stage ${code} is not active`);
    const baseline = target.latest.part_count?.value ?? null;
    await this.db.query("UPDATE stage_runs SET asset_id = $1, baseline_json = $2 WHERE run_id = $3 AND code = $4", [
      target.id,
      JSON.stringify({ part_count: baseline, carried: Number(row.units_good) }),
      runId,
      code,
    ]);
    await this.rec.decide(siteId, { agent: actor, kind: "stage.reassigned", runId, stageCode: code, assetId: target.id, summary: `Moved ${code} ${spec.name} to ${target.name}` });
  }

  // ---------------- The tick ----------------
  async tickRun(siteId: string, runId: string): Promise<void> {
    const ctx = await this.context(siteId, runId);
    if (ctx.run.status !== "running") return;
    const now = this.now();
    // 1. running stages: measure, finish, gate, time out
    for (const row of ctx.rows.filter((r) => r.state === "running")) {
      const spec = this.spec(ctx.tpl, row.code);
      const data = JSON.parse(row.data_json) as StageData;
      const asset = row.asset_id ? ctx.assets.get(row.asset_id) ?? null : null;
      let good = Number(row.units_good);
      let scrap = Number(row.units_scrap);
      if (spec.resourceKind !== "system" && spec.mode !== "manual" && asset?.latest.part_count?.value != null) {
        const base = JSON.parse(row.baseline_json) as { part_count: number | null; carried?: number; scrap?: number | null };
        const rejects = asset.latest.scrap?.value ?? null;
        if (base.part_count === null) {
          await this.db.query("UPDATE stage_runs SET baseline_json = $1 WHERE run_id = $2 AND code = $3", [JSON.stringify({ ...base, part_count: asset.latest.part_count.value, scrap: rejects }), runId, row.code]);
        } else {
          let delta = asset.latest.part_count.value - base.part_count;
          if (delta < 0) delta = asset.latest.part_count.value; // counter reset on the controller
          good = Math.min(ctx.run.quantity, (base.carried ?? 0) + Math.round(delta));
          if (good !== Number(row.units_good)) await this.db.query("UPDATE stage_runs SET units_good = $1 WHERE run_id = $2 AND code = $3", [good, runId, row.code]);
          // a machine that counts its rejects owns the scrap count too, as its gateway signs both
          if (rejects !== null && base.scrap != null) {
            scrap = Math.max(0, Math.round(rejects - base.scrap));
            if (scrap !== Number(row.units_scrap)) await this.db.query("UPDATE stage_runs SET units_scrap = $1 WHERE run_id = $2 AND code = $3", [scrap, runId, row.code]);
          }
        }
      }
      // a batch process may close on its phase signal instead of its counts; the whole order counts as made when it does
      const phase = spec.completeOn && asset ? asset.latest[spec.completeOn.signal] : undefined;
      const phaseReached = Boolean(spec.completeOn && phase && (!row.started_at || Date.parse(phase.ts) >= Date.parse(row.started_at)) && String(phase.text ?? phase.value ?? "").toLowerCase() === spec.completeOn.equals.toLowerCase());
      if (phaseReached && good + scrap === 0) {
        good = ctx.run.quantity;
        await this.db.query("UPDATE stage_runs SET units_good = $1 WHERE run_id = $2 AND code = $3", [good, runId, row.code]);
      }
      const total = good + scrap;
      const workDone = data.workDone || (spec.mode !== "manual" && spec.resourceKind !== "system" && (spec.completeOn ? phaseReached : total >= ctx.run.quantity && total > 0));
      if (workDone) {
        await this.finishWork(ctx, { ...row, units_good: good, units_scrap: scrap }, spec);
        continue;
      }
      const startedAt = row.started_at ? Date.parse(row.started_at) : now;
      const deadline = startedAt + spec.timeoutMin * 60_000;
      const timeout = data.timeoutRaised
        ? null
        : this.timeouts && row.started_at
          ? await this.timeouts.stageTimeout({ siteId, runId, code: row.code, name: spec.name, startedAt, deadline }).catch(() => ({ due: now > deadline, schedule: null }))
          : { due: now > deadline, schedule: null };
      if (timeout?.due) {
        const onHedera = timeout.schedule?.status === "executed" ? timeout.schedule : null;
        await this.patchData(runId, row.code, { timeoutRaised: true });
        await this.inbox.raise(siteId, {
          kind: "exception",
          category: "Timeout",
          title: `${row.code} ${spec.name} is past its ${spec.timeoutMin} min timeout`,
          body: `${good} of ${ctx.run.quantity} units recorded after ${Math.round((now - startedAt) / 60_000)} min${asset ? ` on ${asset.name}` : ""}. ${asset && asset.status !== "running" ? `${asset.name} is ${asset.status.replace("_", " ")}: ${asset.statusDetail}.` : ""}`.trim(),
          agent: agentActor(spec.agent),
          severity: "warn",
          runId,
          stageCode: row.code,
          assetId: asset?.id ?? null,
          metrics: [
            { label: "Recorded", value: `${good} / ${ctx.run.quantity}` },
            { label: "Elapsed", value: `${Math.round((now - startedAt) / 60_000)} min` },
            { label: "Asset", value: asset ? `${asset.name} · ${asset.status}` : "None assigned" },
            ...(onHedera ? [{ label: "Timed out on Hedera", value: `Schedule ${onHedera.scheduleId} · ${onHedera.executedAt}` }] : []),
          ],
          options: [
            { label: "Keep running", detail: "Acknowledge the delay; the stage continues", action: { tool: "none", args: {} } },
            { label: `Hold ${row.code}`, detail: "Stop the stage at its gate and pause downstream", action: { tool: "hold_stage", args: { runId, stageCode: row.code, reason: "Timeout exceeded" } } },
          ],
          recommended: asset && asset.status !== "running" ? 1 : 0,
          confidence: null,
          requiredRole: spec.escalationRole,
        });
      }
    }
    // 2. queued stages whose upstream is complete
    const fresh = await this.context(siteId, runId);
    if (levelRank(fresh.line.autonomy) >= 2) await this.startReady(fresh, agentActor("planning"), false);
    // 3. completion
    const end = await this.context(siteId, runId);
    if (end.rows.every((r) => DONE.includes(r.state))) {
      await this.db.query("UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1 AND status = 'running'", [runId]);
      const v = await this.view(siteId, runId);
      await this.rec.decide(siteId, {
        agent: agentActor("planning"),
        kind: "run.completed",
        runId,
        summary: `${v.templateName} completed for ${v.orderRef}${v.metrics.rolledYield !== null ? ` · rolled yield ${(v.metrics.rolledYield * 100).toFixed(1)}%` : ""}`,
        data: v.metrics,
      });
    }
  }

  private async startReady(ctx: Ctx, actor: string, manual: boolean): Promise<string[]> {
    const preds = predecessors(ctx.tpl.spec.stages);
    const state = new Map(ctx.rows.map((r) => [r.code, r.state]));
    const started: string[] = [];
    const busy = new Map<string, number>();
    const act = await this.db.query<{ asset_id: string; n: string }>("SELECT asset_id, COUNT(*)::text n FROM stage_runs sr JOIN runs r ON r.id = sr.run_id WHERE r.status = 'running' AND sr.state IN ('running','awaiting_approval','held') AND sr.asset_id IS NOT NULL GROUP BY asset_id");
    for (const r of act.rows) busy.set(r.asset_id, Number(r.n));
    for (const row of ctx.rows) {
      if (row.state !== "queued") continue;
      if (!(preds.get(row.code) ?? []).every((p) => DONE.includes(state.get(p)!))) continue;
      const spec = this.spec(ctx.tpl, row.code);
      if (spec.resourceKind === "system") {
        await this.db.query("UPDATE stage_runs SET state = 'running', started_at = now() WHERE run_id = $1 AND code = $2", [ctx.run.id, row.code]);
        await this.db.query("UPDATE stage_runs SET state = 'completed', ended_at = now(), units_good = $1, outcome = $2 WHERE run_id = $3 AND code = $4", [
          ctx.run.quantity,
          `${ctx.run.order_ref} · ${ctx.run.quantity} units released to the floor`,
          ctx.run.id,
          row.code,
        ]);
        await this.rec.decide(ctx.run.site_id, { agent: agentActor(spec.agent), kind: "stage.completed", runId: ctx.run.id, stageCode: row.code, summary: `${spec.name}: ${ctx.run.order_ref} · ${ctx.run.quantity} units released`, confidence: 1 });
        state.set(row.code, "completed");
        started.push(row.code);
        continue;
      }
      const candidates = [...ctx.assets.values()].filter((a) => a.kind === spec.resourceKind);
      const usable = candidates.filter((a) => !["offline", "alarm", "no_data"].includes(a.status));
      const pick = (usable.length ? usable : candidates).sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0) || (a.status === "idle" ? -1 : 1))[0] ?? null;
      const baseline = pick?.latest.part_count?.value ?? null;
      const waiting = !pick
        ? `No ${ASSET_KIND_LABEL[spec.resourceKind].toLowerCase()} is registered: an operator records this stage`
        : pick.latest.part_count && spec.mode !== "manual"
          ? null
          : `${pick.name} has no part counter: an operator records units and completes the stage`;
      await this.db.query("UPDATE stage_runs SET state = 'running', started_at = now(), asset_id = $1, baseline_json = $2 WHERE run_id = $3 AND code = $4", [
        pick?.id ?? null,
        JSON.stringify({ part_count: baseline, scrap: pick?.latest.scrap?.value ?? null }),
        ctx.run.id,
        row.code,
      ]);
      await this.patchData(ctx.run.id, row.code, { waitingReason: spec.mode === "manual" ? "Manual stage: the operator executes and records" : waiting });
      if (pick) busy.set(pick.id, (busy.get(pick.id) ?? 0) + 1);
      await this.rec.decide(ctx.run.site_id, {
        agent: manual ? actor : agentActor(spec.agent),
        kind: "stage.started",
        runId: ctx.run.id,
        stageCode: row.code,
        assetId: pick?.id ?? null,
        summary: `Started ${row.code} ${spec.name}${pick ? ` on ${pick.name}` : ""}`,
        reason: pick ? `${pick.name} is ${pick.status.replace("_", " ")} with ${busy.get(pick.id)! - 1} other active stage(s); ${candidates.length} ${ASSET_KIND_LABEL[spec.resourceKind].toLowerCase()}(s) registered` : waiting,
        confidence: pick ? (pick.status === "running" || pick.status === "idle" ? 0.9 : 0.6) : null,
      });
      state.set(row.code, "running");
      started.push(row.code);
    }
    return started;
  }

  private async finishWork(ctx: Ctx, row: StageRow, spec: StageSpec) {
    const runId = ctx.run.id;
    const good = Number(row.units_good);
    const scrap = Number(row.units_scrap);
    const startedAt = row.started_at ? Date.parse(row.started_at) : this.now();
    const durationMin = (this.now() - startedAt) / 60_000;
    const asset = row.asset_id ? ctx.assets.get(row.asset_id) : undefined;
    const criteria = evaluateCriteria(spec.criteria, await this.measurements(row, spec, { good, scrap, durationMin, activeOee: asset?.oee ?? null }, startedAt, true));
    const failed = criteria.filter((c) => c.ok === false);
    const unknown = criteria.filter((c) => c.ok === null);
    const total = good + scrap;
    const yieldTxt = total ? `${((good / total) * 100).toFixed(1)}% yield` : "no units counted";
    const outcome = `${good} good · ${scrap} scrap · ${yieldTxt} in ${Math.round(durationMin)} min${asset ? ` on ${asset.name}` : ""}`;
    await this.db.query("UPDATE stage_runs SET outcome = $1 WHERE run_id = $2 AND code = $3", [outcome, runId, row.code]);
    await this.patchData(runId, row.code, { workDone: true, criteria, workDoneAt: new Date(this.now()).toISOString() });
    const signals = signalsOf(spec.criteria);
    if (this.series && signals.length && row.asset_id) await this.series.capture(runId, row.code, row.asset_id, signals, startedAt, this.now()).catch((e) => console.error(`[ordo] stage series ${runId}/${row.code}`, e));
    const rework = ctx.tpl.spec.rework;
    if (rework && rework.from === row.code && scrap > 0) {
      await this.patchData(runId, rework.to, { reworkUnits: scrap });
      await this.rec.decide(ctx.run.site_id, { agent: agentActor(spec.agent), kind: "stage.rework", runId, stageCode: row.code, summary: `${scrap} unit(s) routed back to ${rework.to} for rework` });
    }
    const autonomous = levelRank(ctx.line.autonomy) >= 4;
    const needsGate = spec.mode === "approve" ? !(autonomous && failed.length === 0 && unknown.length === 0) : failed.length > 0 || (spec.mode === "auto" && unknown.length > 0);
    if (!needsGate) {
      await this.db.query("UPDATE stage_runs SET state = 'completed', ended_at = now() WHERE run_id = $1 AND code = $2", [runId, row.code]);
      await this.rec.decide(ctx.run.site_id, {
        agent: agentActor(spec.agent),
        kind: "stage.completed",
        runId,
        stageCode: row.code,
        assetId: asset?.id ?? null,
        summary: `${row.code} ${spec.name} complete: ${outcome}`,
        reason: criteria.length ? `All ${criteria.length} success criteria met on measured values` : "Stage has no success criteria",
        confidence: 0.95,
        data: { criteria },
      });
      return;
    }
    await this.db.query("UPDATE stage_runs SET state = 'awaiting_approval' WHERE run_id = $1 AND code = $2", [runId, row.code]);
    await this.ensureGate(ctx, { ...row, outcome }, spec, { held: false, reason: failed.length ? `${failed.map((c) => `${c.label} ${c.actual} (target ${c.target})`).join(", ")}` : unknown.length ? `Not measured: ${unknown.map((c) => c.label).join(", ")}` : null, criteria, agent: spec.agent });
  }

  private async ensureGate(ctx: Ctx, row: StageRow, spec: StageSpec, g: { held: boolean; reason: string | null; criteria?: StageRunView["criteriaResults"]; agent: AgentKey }) {
    const runId = ctx.run.id;
    const data = JSON.parse(row.data_json) as StageData;
    if (data.gateItemId) {
      const open = await this.db.query("SELECT 1 FROM inbox_items WHERE id = $1 AND status = 'pending'", [data.gateItemId]);
      if (open.rows.length) return;
    }
    const criteria = reshape(spec.criteria, g.criteria ?? data.criteria ?? []);
    const failed = criteria.filter((c) => c.ok === false);
    const options: InboxOption[] = [{ label: g.held ? `Release ${row.code}` : `Approve ${row.code}`, detail: g.held ? "Lift the hold and continue the run" : "Release this stage's output to the next stage", action: { tool: "release_gate", args: { runId, stageCode: row.code } } }];
    if (!g.held) options.push({ label: `Hold ${row.code}`, detail: "Keep the output at the gate and pause downstream scheduling", action: { tool: "hold_stage", args: { runId, stageCode: row.code, reason: g.reason ?? "Held at quality gate" } } });
    if (row.asset_id && ["inspection", "cnc", "robot", "process_vessel"].includes(spec.resourceKind))
      options.push({ label: "Raise inspection", detail: "Sample 100% of the next units on this asset", action: { tool: "request_inspection", args: { assetId: row.asset_id, sampleRatePct: 100 } } });
    const total = Number(row.units_good) + Number(row.units_scrap);
    const recommended = g.held ? 0 : failed.length ? 1 : 0;
    const item = await this.inbox.raise(ctx.run.site_id, {
      kind: "approval",
      category: g.held ? "Hold" : "Quality gate",
      title: g.held ? `${row.code} ${spec.name} is held` : `${row.code} ${spec.name} is ready for release`,
      body: g.held ? `Held: ${g.reason ?? "no reason given"}.` : `${row.outcome ?? "Work complete"}.${g.reason ? ` ${failed.length ? "Out of target" : "Needs confirmation"}: ${g.reason}.` : ""}`,
      agent: agentActor(g.agent),
      severity: failed.length ? "warn" : null,
      runId,
      stageCode: row.code,
      assetId: row.asset_id,
      metrics: [
        { label: "Good / scrap", value: `${row.units_good} / ${row.units_scrap}` },
        { label: "Yield", value: total ? `${((Number(row.units_good) / total) * 100).toFixed(1)}%` : "—" },
        ...criteria.map((c) => ({
          label: c.label,
          value: `${c.actual ?? "not measured"} · target ${c.target}${c.ok === false ? " ▲" : ""}`,
          band: { lo: c.band.lo, hi: c.band.hi, value: c.measured?.value ?? null, valueMax: c.measuredMax?.value ?? null, ok: c.ok, unit: c.unit },
        })),
      ],
      options,
      recommended,
      confidence: criteria.length ? Math.round((criteria.filter((c) => c.ok === true).length / criteria.length) * 100) / 100 : null,
      requiredRole: spec.escalationRole,
    });
    await this.patchData(runId, row.code, { gateItemId: item.id });
  }

  // ---------------- Views ----------------
  async list(siteId: string, f: { days?: number; status?: RunStatus } = {}): Promise<RunView[]> {
    const since = new Date(this.now() - (f.days ?? 7) * 86_400_000).toISOString();
    const r = await this.db.query<{ id: string }>(`SELECT id FROM runs WHERE site_id = $1 AND (started_at >= $2 OR status = 'running') ${f.status ? "AND status = $3" : ""} ORDER BY started_at DESC LIMIT 200`, f.status ? [siteId, since, f.status] : [siteId, since]);
    const assets = await this.assetMap(siteId);
    const out: RunView[] = [];
    for (const x of r.rows) out.push(await this.view(siteId, x.id, assets, false));
    return out;
  }

  /** One run with every stage. `live` reads the telemetry behind a running stage's measured-signal criteria; the list view skips that. */
  async view(siteId: string, runId: string, assetsIn?: Map<string, AssetView>, live = true): Promise<RunView> {
    const run = await this.runRow(siteId, runId);
    const tpl = await this.templates.version(run.template_version_id);
    const rows = await this.rowsOf(runId);
    const assets = assetsIn ?? (await this.assetMap(siteId));
    const counts = await this.db.query<{ stage_code: string | null; n: string }>("SELECT stage_code, COUNT(*)::text n FROM decisions WHERE run_id = $1 GROUP BY stage_code", [runId]);
    const perStage = new Map(counts.rows.map((c) => [c.stage_code, Number(c.n)]));
    const decisions = counts.rows.reduce((a, c) => a + Number(c.n), 0);
    const items = await this.db.query<{ status: string; n: string }>("SELECT status, COUNT(*)::text n FROM inbox_items WHERE run_id = $1 GROUP BY status", [runId]);
    const escalated = items.rows.reduce((a, c) => a + Number(c.n), 0);
    const now = this.now();
    const stages: StageRunView[] = [];
    for (const s of tpl.spec.stages) {
      const row = rows.find((r) => r.code === s.code)!;
      const data = JSON.parse(row.data_json) as StageData;
      const good = Number(row.units_good);
      const scrap = Number(row.units_scrap);
      const total = good + scrap;
      const start = row.started_at ? Date.parse(row.started_at) : null;
      const end = row.ended_at ? Date.parse(row.ended_at) : null;
      const durationMin = start ? ((end ?? now) - start) / 60_000 : null;
      const asset = row.asset_id ? assets.get(row.asset_id) : undefined;
      const criteriaResults = data.criteria
        ? reshape(s.criteria, data.criteria)
        : evaluateCriteria(s.criteria, await this.measurements(row, s, { good, scrap, durationMin, activeOee: asset?.oee ?? null }, start ?? now, live && start !== null));
      stages.push({
        ...s,
        state: row.state,
        assetId: row.asset_id,
        assetName: asset?.name ?? null,
        startedAt: iso(row.started_at),
        endedAt: iso(row.ended_at),
        unitsGood: good,
        unitsScrap: scrap,
        yieldPct: total ? (good / total) * 100 : null,
        throughputPerHour: durationMin && durationMin > 0.5 && good ? (good / durationMin) * 60 : null,
        durationMin: durationMin === null ? null : Math.round(durationMin * 10) / 10,
        progress: DONE.includes(row.state) ? 1 : Math.min(1, total / run.quantity),
        outcome: row.outcome,
        deviation: Boolean(row.deviation),
        criteriaResults,
        decisions: perStage.get(s.code) ?? 0,
        gateItemId: data.gateItemId ?? null,
        waitingReason: data.waitingReason ?? null,
        reworkUnits: data.reworkUnits ?? 0,
        workDoneAt: data.workDoneAt ?? null,
      } as StageRunView);
    }
    const completed = stages.filter((s) => DONE.includes(s.state)).length;
    const measured = stages.filter((s) => s.unitsGood + s.unitsScrap > 0 && s.resourceKind !== "system");
    const rolledYield = measured.length ? measured.reduce((p, s) => p * (s.unitsGood / (s.unitsGood + s.unitsScrap)), 1) : null;
    const elapsedH = ((run.finished_at ? Date.parse(run.finished_at) : now) - Date.parse(run.started_at)) / 3_600_000;
    const lastCol = Math.max(...stages.map((s) => s.column));
    const shipped = stages.filter((s) => s.column === lastCol).reduce((m, s) => Math.min(m, s.unitsGood), Infinity);
    const progress = stages.reduce((a, s) => a + s.progress, 0) / stages.length;
    const etaMs = run.status === "running" && progress > 0.05 ? Date.parse(run.started_at) + (now - Date.parse(run.started_at)) / progress : null;
    return {
      id: run.id,
      siteId,
      lineId: run.line_id,
      templateId: tpl.id,
      templateName: tpl.name,
      templateCategory: tpl.category,
      templateDescription: tpl.description,
      templateVersion: tpl.version,
      orderRef: run.order_ref,
      quantity: Number(run.quantity),
      status: run.status,
      startedBy: run.started_by,
      startedAt: iso(run.started_at)!,
      dueAt: iso(run.due_at),
      finishedAt: iso(run.finished_at),
      rework: tpl.spec.rework,
      stages,
      metrics: {
        completed,
        total: stages.length,
        rolledYield,
        throughputPerHour: shipped > 0 && Number.isFinite(shipped) && elapsedH > 0.01 ? shipped / elapsedH : null,
        eta: etaMs ? new Date(etaMs).toISOString() : run.finished_at ? iso(run.finished_at) : null,
        onTrack: etaMs && run.due_at ? etaMs <= Date.parse(run.due_at) : null,
        decisions,
        escalated,
        gatesPending: stages.filter((s) => s.state === "awaiting_approval" || s.state === "held").length,
      },
    };
  }

  // ---------------- helpers ----------------
  /** What a stage's criteria are judged on: its counts and time, its asset's OEE, and the signals its criteria read over the stage window. */
  private async measurements(row: StageRow, spec: StageSpec, base: Omit<StageMeasurements, "signals">, startedAt: number, live: boolean): Promise<StageMeasurements> {
    const wanted = signalsOf(spec.criteria);
    if (!wanted.length || !live) return base;
    const signals: Record<string, SignalStats> = row.asset_id ? await this.plant.windowStats(row.asset_id, wanted, startedAt, this.now()) : {};
    const data = JSON.parse(row.data_json) as StageData;
    for (const [signal, r] of Object.entries(data.readings ?? {})) if (!signals[signal]?.n) signals[signal] = { last: r.value, min: r.value, max: r.value, mean: r.value, n: 1 };
    return { ...base, signals };
  }
  private async line(siteId: string, lineId: string | null) {
    const r = await this.db.query<{ id: string; name: string; autonomy: AutonomyLevel }>(`SELECT id, name, autonomy FROM lines WHERE site_id = $1 ${lineId ? "AND id = $2" : ""} ORDER BY created_at LIMIT 1`, lineId ? [siteId, lineId] : [siteId]);
    if (!r.rows[0]) throw new HttpError(404, "Line not found");
    return r.rows[0];
  }
  private async runRow(siteId: string, runId: string): Promise<RunRow> {
    const r = await this.db.query<RunRow>("SELECT id, site_id, line_id, template_version_id, order_ref, quantity, status, started_by, started_at::text, due_at::text, finished_at::text FROM runs WHERE id = $1 AND site_id = $2", [runId, siteId]);
    if (!r.rows[0]) throw new HttpError(404, "Run not found");
    return r.rows[0];
  }
  private async rowsOf(runId: string): Promise<StageRow[]> {
    return (await this.db.query<StageRow>("SELECT run_id, code, state, asset_id, started_at::text, ended_at::text, units_good, units_scrap, baseline_json, outcome, deviation, data_json FROM stage_runs WHERE run_id = $1 ORDER BY code", [runId])).rows;
  }
  private async assetMap(siteId: string) {
    return new Map((await this.plant.views(siteId)).map((a) => [a.id, a]));
  }
  private async context(siteId: string, runId: string): Promise<Ctx> {
    const run = await this.runRow(siteId, runId);
    const [tpl, rows, assets, line] = await Promise.all([this.templates.version(run.template_version_id), this.rowsOf(runId), this.assetMap(siteId), this.line(siteId, run.line_id)]);
    return { run: { ...run, quantity: Number(run.quantity) }, tpl, rows, assets, line };
  }
  private row(ctx: Ctx, code: string): StageRow {
    const r = ctx.rows.find((x) => x.code === code);
    if (!r) throw new HttpError(404, `Stage ${code} not found`);
    return r;
  }
  private spec(tpl: TemplateView, code: string): StageSpec {
    return tpl.spec.stages.find((s) => s.code === code)!;
  }
  private async hasCounter(assetId: string | null) {
    if (!assetId) return false;
    const r = await this.db.query<{ latest_json: string }>("SELECT latest_json FROM source_state WHERE asset_id = $1", [assetId]);
    return Boolean(r.rows[0] && (JSON.parse(r.rows[0].latest_json) as Record<string, unknown>).part_count);
  }
  private async patchData(runId: string, code: string, patch: Partial<StageData>, q: Queryable = this.db) {
    const r = await q.query<{ data_json: string }>("SELECT data_json FROM stage_runs WHERE run_id = $1 AND code = $2", [runId, code]);
    if (!r.rows[0]) return;
    await q.query("UPDATE stage_runs SET data_json = $1 WHERE run_id = $2 AND code = $3", [JSON.stringify({ ...JSON.parse(r.rows[0].data_json), ...patch }), runId, code]);
  }
}

interface Ctx {
  run: RunRow;
  tpl: TemplateView;
  rows: StageRow[];
  assets: Map<string, AssetView>;
  line: { id: string; name: string; autonomy: AutonomyLevel };
}

export const stageAgentLabel = (a: AgentKey) => AGENT_INFO[a].label;
export type { Role };
