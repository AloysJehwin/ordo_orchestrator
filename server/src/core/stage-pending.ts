/**
 * What each stage of a running run is waiting on, and what a person can do about it. A stage that waits says why
 * (the stages before it, its resources, a machine without the Runner role, a gate) and walks the chain to the first
 * thing that is stuck: for resources, the machine that buys them, its body, its wallet, its Buyer role and caps, the
 * offer and the top-ups. Each stuck link comes with its actions: retry it (start the buying machine's body again),
 * bypass it (a manager signs to start without the resources), take the next step (step the run, approve the gate,
 * record by hand) or open the page where it is fixed. Each action names the role that may take it.
 */
import type { Db } from "../db/db.js";
import { ASSET_KIND_LABEL, levelRank, type AccessLevel, type AutonomyLevel, type Role, type RunView, type StageRunView } from "../domain/types.js";
import type { RunEngine } from "../pipelines/engine.js";
import { predecessors } from "../pipelines/graph.js";
import type { PlantService } from "../plant/plant.js";
import type { Resources, ResourceWait } from "./resources.js";

export type PendingActionId = "start_body" | "restart_body" | "waive_resources" | "step_run" | "approve_gate" | "record" | "open_machine" | "open_vendors" | "open_approvals";
export interface PendingAction {
  id: PendingActionId;
  /** retry: try what failed again · bypass: go on without it · do: the next step a person takes · open: where it is fixed */
  kind: "retry" | "bypass" | "do" | "open";
  label: string;
  detail: string;
  /** the role that may take it */
  role: Role;
  assetId?: string;
}
export interface PendingItem {
  tone: "bad" | "warn" | "info" | "ok";
  text: string;
}
export interface StagePendingView {
  code: string;
  /** one line: what it waits for */
  headline: string;
  /** blocked: nothing moves until someone acts · waiting: it moves on its own (upstream running, a delivery on its way) */
  status: "blocked" | "waiting";
  /** since when it has waited, when known */
  since: string | null;
  /** the stages before it that are not done yet */
  upstream: string[];
  items: PendingItem[];
  actions: PendingAction[];
  /** the resources that have not arrived, by label (for a waiver's wording) */
  missing?: string[];
}
export interface RunPendingView {
  runId: string;
  stages: StagePendingView[];
  /** the stages holding the run up: blocked ones with nothing unfinished before them */
  blocking: string[];
}

const DONE = ["completed", "done_deviation", "skipped"];
/** a body that has not reported for this long is probably not running */
const SILENT_MS = 10 * 60_000;

interface BodyRow {
  asset_id: string;
  state: string;
  error: string | null;
  auto_start: boolean;
  last_ok_at: string | null;
}

const qty = (n: number, unit: string) => `${Math.round(n * 1000) / 1000}${unit ? ` ${unit}` : ""}`;
const ago = (iso: string, now: number) => {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const hbar = (tinybar: string) => `${(Number(tinybar) / 1e8).toFixed(8).replace(/\.?0+$/, "")} HBAR`;

export class StagePending {
  constructor(
    private db: Db,
    private engine: RunEngine,
    private plant: PlantService,
    private resources: Resources,
    private o: { buyS: number; bodies: boolean },
    private now: () => number,
  ) {}

  async of(siteId: string, runId: string, level: AccessLevel): Promise<RunPendingView> {
    const v = await this.engine.view(siteId, runId, undefined, false);
    if (v.status !== "running") return { runId, stages: [], blocking: [] };
    const views = new Map((await this.plant.views(siteId)).map((a) => [a.id, a]));
    const bodies = new Map(
      (
        await this.db.query<BodyRow>(
          "SELECT b.asset_id, b.state, b.error, b.auto_start, s.last_ok_at::text AS last_ok_at FROM machine_bodies b LEFT JOIN source_state s ON s.asset_id = b.asset_id WHERE b.site_id = $1",
          [siteId],
        )
      ).rows.map((b) => [b.asset_id, b]),
    );
    const autonomy = ((await this.db.query<{ autonomy: AutonomyLevel }>("SELECT autonomy FROM lines WHERE id = $1", [v.lineId])).rows[0]?.autonomy ?? "L2") as AutonomyLevel;
    const preds = predecessors(v.stages);
    const byCode = new Map(v.stages.map((s) => [s.code, s]));
    const out: StagePendingView[] = [];
    for (const s of v.stages) {
      if (DONE.includes(s.state)) continue;
      const before = (preds.get(s.code) ?? []).map((c) => byCode.get(c)!);
      const upstream = before.filter((p) => !DONE.includes(p.state)).map((p) => p.code);
      const p = await this.stage(siteId, v, s, before, upstream, { views, bodies, autonomy, level });
      if (p) out.push(p);
    }
    const blocked = new Set(out.filter((p) => p.status === "blocked").map((p) => p.code));
    // a stage holds the run up when it is blocked and nothing before it is blocked or waiting
    const blocking = out.filter((p) => blocked.has(p.code) && !p.upstream.length).map((p) => p.code);
    return { runId, stages: out, blocking };
  }

  private async stage(
    siteId: string,
    v: RunView,
    s: StageRunView,
    before: StageRunView[],
    upstream: string[],
    c: { views: Map<string, { id: string; name: string; kind: string }>; bodies: Map<string, BodyRow>; autonomy: AutonomyLevel; level: AccessLevel },
  ): Promise<StagePendingView | null> {
    const view = (headline: string, status: StagePendingView["status"], since: string | null, items: PendingItem[] = [], actions: PendingAction[] = []): StagePendingView => ({
      code: s.code,
      headline,
      status,
      since,
      upstream,
      items,
      actions,
    });
    const name = (code: string) => `${code} ${v.stages.find((x) => x.code === code)?.name ?? ""}`.trim();

    if (s.state === "awaiting_approval" || s.state === "held") {
      const out = s.criteriaResults.filter((x) => x.ok === false).map((x): PendingItem => ({ tone: "bad", text: `${x.label} ${x.actual ?? "?"}, target ${x.target}` }));
      const unknown = s.criteriaResults.filter((x) => x.ok === null).map((x): PendingItem => ({ tone: "warn", text: `${x.label} not measured: confirm it before release` }));
      const actions: PendingAction[] = [];
      const items = [...out, ...unknown];
      // a machine that stopped safely (0G unreachable) or failed holds its stage again after a release: restart it first
      const body = s.assetId ? c.bodies.get(s.assetId) : undefined;
      const who = s.assetId ? (c.views.get(s.assetId)?.name ?? s.assetName ?? "its machine") : null;
      if (body && who && (body.state === "safe_stopped" || body.state === "failed")) {
        items.unshift({ tone: "bad", text: body.state === "safe_stopped" ? `${who}'s body stopped safely${body.error ? `: ${body.error}` : ""}` : `${who}'s body failed${body.error ? `: ${body.error}` : ""}` });
        actions.push({ id: body.state === "failed" ? "start_body" : "restart_body", kind: "retry", label: `Restart ${who}`, detail: "Start its body again with a fresh 0G key and the latest body code, then release the stage", role: "manager", assetId: s.assetId! });
      }
      actions.push({ id: "approve_gate", kind: "do", label: s.state === "held" ? "Release the gate" : "Approve the gate", detail: "Release the stage so the run goes on", role: s.escalationRole });
      return view(s.state === "held" ? `Held at its gate for a ${s.escalationRole.replaceAll("_", " ")}` : `Waits at its gate for a ${s.escalationRole.replaceAll("_", " ")}`, "blocked", s.workDoneAt ?? s.startedAt, items, actions);
    }

    if (s.state === "running") {
      if (!s.waitingReason) return null;
      const operator = /operator|manual/i.test(s.waitingReason);
      return view(
        operator ? "An operator records it" : "Running, waiting on data",
        operator ? "blocked" : "waiting",
        s.startedAt,
        [{ tone: operator ? "warn" : "info", text: s.waitingReason }],
        operator ? [{ id: "record", kind: "do", label: "Record manually", detail: "Record units and readings by hand, signed, and complete the stage", role: "manager" }] : [],
      );
    }

    // queued
    if (upstream.length) {
      const items: PendingItem[] = upstream.map((code) => {
        const p = v.stages.find((x) => x.code === code)!;
        return { tone: "info", text: `${name(code)} is ${p.state.replaceAll("_", " ")}` };
      });
      if (s.resources.length) items.push({ tone: "info", text: `Its resources (${s.resources.map((r) => r.label).join(", ")}) are bought ahead by the machine running the stage before it` });
      return view(`Waits for ${upstream.map(name).join(", ")}`, "waiting", null, items);
    }
    const since = before.map((p) => p.endedAt).filter((x): x is string => Boolean(x)).sort().pop() ?? v.startedAt;

    if (s.resources.length) {
      const w = await this.resources.waitFor(siteId, v, s.code, c.views);
      if (w && !w.waived && w.missing.length) return this.resourceWait(v, s, w, since, c);
    }
    const reason = s.waitingReason;
    if (reason && /Runner role/.test(reason))
      return view("No machine may run it", "blocked", since, [{ tone: "bad", text: reason }], [
        { id: "open_machine", kind: "open", label: `Grant Runner on the floor`, detail: `A manager grants a ${ASSET_KIND_LABEL[s.resourceKind].toLowerCase()} the Runner role for this kind of stage`, role: "manager" },
      ]);
    if (reason && /to run on|is registered/.test(reason))
      return view("No machine to run it", "blocked", since, [{ tone: "bad", text: reason }], [
        { id: "open_machine", kind: "open", label: "Add a machine", detail: `Add a ${ASSET_KIND_LABEL[s.resourceKind].toLowerCase()} on the floor`, role: "manager" },
      ]);
    if (levelRank(c.autonomy) < 2)
      return view("Ready: a manager starts it", "blocked", since, [{ tone: "warn", text: `The line is at ${c.autonomy}, so agents do not start stages on their own` }], [
        { id: "step_run", kind: "do", label: "Step the run", detail: "Start every stage that is ready", role: "manager" },
      ]);
    return view("Starts on the next cycle", "waiting", since, [{ tone: "info", text: "Everything it needs is here: Ordo starts it within a minute" }], [
      { id: "step_run", kind: "do", label: "Start it now", detail: "Start every stage that is ready", role: "manager" },
    ]);
  }

  /** A stage ready to start whose resources have not all arrived: who buys them, and the first thing in the way. */
  private resourceWait(
    v: RunView,
    s: StageRunView,
    w: ResourceWait,
    since: string,
    c: { views: Map<string, { id: string; name: string; kind: string }>; bodies: Map<string, BodyRow>; level: AccessLevel },
  ): StagePendingView {
    const now = this.now();
    const finance = c.level >= 4;
    const items: PendingItem[] = [];
    const actions: PendingAction[] = [];
    let blocked = false;
    const add = (tone: PendingItem["tone"], text: string) => {
      items.push({ tone, text });
      if (tone === "bad") blocked = true;
    };
    for (const m of w.missing) {
      const onWay = m.pending > 0 ? `, ${qty(m.pending, m.unit)} on its way` : "";
      add(m.pending > 0 ? "info" : "warn", `${m.label}: ${qty(m.delivered, "")} of ${qty(m.need, m.unit)} arrived${onWay}`);
    }
    const waiting = w.missing.every((m) => m.delivered + m.pending >= m.need - 1e-6);
    const buyer = w.buyer;
    if (!buyer) {
      add("bad", `No ${ASSET_KIND_LABEL[s.resourceKind].toLowerCase()} with an active wallet and the Buyer role can buy them`);
      actions.push({ id: "open_machine", kind: "open", label: "Set up a buyer on the floor", detail: "Enable a machine's wallet, or grant it the Buyer role", role: "manager" });
    } else if (!waiting) {
      const who = buyer.name;
      if (w.runBudget && ["pending", "approving"].includes(w.runBudget.status)) {
        add("bad", `The run's budget waits for a manager's approval: until it is paid, ${who} has nothing to buy with`);
        actions.push({ id: "open_approvals", kind: "open", label: "Approve the run's budget", detail: "Approvals: the treasury's transfer to the machines", role: "manager" });
      } else if (w.runBudget?.status === "failed") add("warn", `The run's budget failed${w.runBudget.error ? `: ${w.runBudget.error}` : ""}`);
      if (!buyer.holdsBuyer) {
        add("bad", `${who} does not hold the Buyer role, so it may not buy`);
        actions.push({ id: "open_machine", kind: "open", label: `Grant ${who} Buyer`, detail: "A manager grants the Buyer role on the floor", role: "manager", assetId: buyer.assetId });
      } else if (!buyer.wallet || buyer.wallet.status !== "active" || !buyer.wallet.accountId) {
        add("bad", `${who} has no active Hedera account to pay from${buyer.wallet?.error ? `: ${buyer.wallet.error}` : ""}`);
        actions.push({ id: "open_machine", kind: "open", label: `Open ${who}'s wallet`, detail: "Enable or fix the machine's wallet on the floor", role: "manager", assetId: buyer.assetId });
      }
      for (const m of w.missing.filter((x) => x.delivered + x.pending < x.need - 1e-6)) {
        if (!m.offer) {
          add("bad", `No vendor sells ${m.kind}`);
          if (!actions.some((a) => a.id === "open_vendors")) actions.push({ id: "open_vendors", kind: "open", label: "Add a vendor offer", detail: `Team → Vendors: an offer for ${m.kind}`, role: "manager" });
          continue;
        }
        if (m.overCap) {
          add("bad", `${m.label} costs more than ${who}'s Buyer cap per order${finance ? ` (${hbar(m.offer.amountTinybar)})` : ""}`);
          actions.push({ id: "open_machine", kind: "open", label: `Raise ${who}'s cap`, detail: "A manager raises the Buyer cap on the floor", role: "manager", assetId: buyer.assetId });
        } else if (!m.offer.withinMax) {
          const t = w.topups.find((x) => x.resource === m.key);
          const price = finance ? `${m.offer.vendor} asks ${m.offer.price} HBAR, above the stage's ${m.maxPrice} HBAR` : "The best offer is above the stage's max price";
          if (t && ["pending", "approving"].includes(t.status)) {
            add("bad", `${m.label}: ${price}. A top-up waits for a manager's approval`);
            if (!actions.some((a) => a.id === "open_approvals")) actions.push({ id: "open_approvals", kind: "open", label: "Approve the top-up", detail: "Approvals: the treasury pays the machine the difference", role: "manager" });
          } else if (t && ["declined", "expired", "failed"].includes(t.status)) add("bad", `${m.label}: ${price}. Its top-up was ${t.status}${t.error ? ` (${t.error})` : ""}`);
          else add("warn", `${m.label}: ${price}. ${who} asks the treasury for a top-up on its next cycle`);
        }
        if (m.expired) add("warn", `${m.expired} purchase${m.expired === 1 ? "" : "s"} of ${m.label} verified but never settled`);
      }
      // the body that does the buying
      const b = c.bodies.get(buyer.assetId);
      if (!this.o.bodies && !b) add("info", `${who} buys when its gateway next checks in`);
      else if (!b) {
        add("bad", `${who} has no body running to buy them`);
        actions.push({ id: "open_machine", kind: "open", label: `Open ${who}`, detail: "Create or start its body on the floor", role: "manager", assetId: buyer.assetId });
      } else if (b.state === "failed") {
        add("bad", `${who}'s body failed${b.error ? `: ${b.error}` : ""}`);
        actions.push({ id: "start_body", kind: "retry", label: `Restart ${who}`, detail: "Start its body again: it buys what is missing on its first cycle", role: "manager", assetId: buyer.assetId });
      } else if (b.state === "stopped") {
        add(b.auto_start ? "warn" : "bad", b.auto_start ? `${who}'s body is stopped: Ordo starts it on its next look-ahead` : `A person stopped ${who}'s body`);
        actions.push({ id: "start_body", kind: "retry", label: `Start ${who} now`, detail: "Start its body: it buys what is missing on its first cycle", role: "manager", assetId: buyer.assetId });
      } else if (b.state === "starting") add("info", `${who}'s body is starting`);
      else if (b.state === "safe_stopped") {
        add("bad", `${who}'s body stopped safely, so it does not buy${b.error ? `: ${b.error}` : ""}`);
        actions.push({ id: "restart_body", kind: "retry", label: `Restart ${who}`, detail: "Stop and start its body: it comes back with a fresh 0G key and the latest body code", role: "manager", assetId: buyer.assetId });
      }
      else if (b.last_ok_at && now - Date.parse(b.last_ok_at) > SILENT_MS) {
        add("bad", `${who}'s body has not reported since ${ago(b.last_ok_at, now)}`);
        actions.push({ id: "start_body", kind: "retry", label: `Restart ${who}`, detail: "Start its body again", role: "manager", assetId: buyer.assetId });
      } else if (!blocked) add("ok", `${who} is running and buys what is missing every ${this.o.buyS} s`);
    }
    actions.push({
      id: "waive_resources",
      kind: "bypass",
      label: "Start without them",
      detail: "Signed: the stage starts without the resources that have not arrived; the waiver and its reason go on the ledger",
      role: "manager",
    });
    const headline = waiting ? "Resources on their way" : `Waiting for ${w.missing.length === 1 ? w.missing[0]!.label : `${w.missing.length} resources`}`;
    return { code: s.code, headline, status: blocked ? "blocked" : "waiting", since, upstream: [], items, actions, missing: w.missing.map((m) => m.label) };
  }
}
