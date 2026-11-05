import { encodeFunctionData, type Address, type Hex } from "viem";
import type { TrustChain } from "../chain/trust.js";
import { ORDO_WORK_ORDERS_ABI } from "../chain/ordo-contracts-abi.js";
import { ORDO_TRUST_ABI } from "../chain/ordo-trust-abi.js";
import type { Db } from "../db/db.js";
import { newId } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";

/** A network scheduler: transactions it executes on its own at a set time. */
export interface ScheduleRail {
  kind: string;
  contractCall(i: { contract: Address; data: Hex; gas: number; at: Date; memo: string }): Promise<{ scheduleId: string; txId: string }>;
  topicMessage(i: { message: string; at: Date; memo: string }): Promise<{ scheduleId: string; txId: string }>;
  cancel(scheduleId: string): Promise<void>;
  state(scheduleId: string): Promise<{ state: "pending" | "executed" | "deleted"; executedAt: string | null }>;
  url(scheduleId: string): string;
}

export type ScheduleKind = "workorder.refund" | "stake.withdraw" | "stage.timeout";
type Status = "scheduled" | "executed" | "cancelled" | "failed" | "skipped";

interface Row {
  id: string;
  site_id: string;
  kind: ScheduleKind;
  ref: string;
  execute_at: string;
  schedule_id: string | null;
  tx_id: string | null;
  status: Status;
  executed_at: string | null;
  error: string | null;
  next_check_at: string;
}

export interface ScheduleView {
  kind: ScheduleKind;
  status: Status;
  executeAt: string;
  scheduleId: string | null;
  url: string | null;
  executedAt: string | null;
  error: string | null;
}

/** Hedera needs the expiration time in the future; schedules closer than this are left to the server. */
const MIN_LEAD_MS = 60_000;
/** Long-term schedules may wait at most 62 days (HIP-423). */
const MAX_LEAD_MS = 62 * 24 * 3600_000;
/** Seconds after the deadline at which the schedule runs, so block.timestamp is past it on-chain too. */
const AFTER_S = 5;
/** How long Ordo waits for a schedule to run before doing the job itself. */
export const SCHEDULE_GRACE_MS = 5 * 60_000;
const REFUND_GAS = 120_000;
const WITHDRAW_GAS = 120_000;

/**
 * Deadlines that Hedera's Schedule Service enforces instead of Ordo's server: the refund of an unreleased
 * work-order escrow when it expires, the return of a validator's stake when the unstake cooldown ends, and a
 * stage's timeout, written to the ledger topic at the deadline. Each is a scheduled transaction Hedera executes
 * at its expiration time, so it happens even if Ordo is down. Ordo deletes a schedule that is no longer needed
 * (the work order was released, the validator staked again, the stage finished) and only does the job itself if
 * a schedule could not be created or has not run a few minutes after its time.
 */
export class Schedules {
  private lastStakeScan = 0;
  private withdrawFor: Promise<boolean> | null = null;
  constructor(
    private db: Db,
    private rec: Recorder,
    readonly rail: ScheduleRail,
    private chain: () => TrustChain | null,
    private now: () => number,
  ) {}

  /** The trust chain, when contract calls can be scheduled on it (it is on the scheduler's Hedera network). */
  private contracts(): TrustChain | null {
    return this.chain();
  }

  // ---------------------------------------------------------------- rows
  async of(kind: ScheduleKind, ref: string): Promise<ScheduleView | null> {
    const r = await this.row(kind, ref);
    return r ? this.view(r) : null;
  }
  private async row(kind: ScheduleKind, ref: string): Promise<Row | null> {
    return (
      (await this.db.query<Row>(
        "SELECT id, site_id, kind, ref, execute_at::text, schedule_id, tx_id, status, executed_at::text, error, next_check_at::text FROM hedera_schedules WHERE kind = $1 AND ref = $2",
        [kind, ref],
      )).rows[0] ?? null
    );
  }
  private view(r: Row): ScheduleView {
    return {
      kind: r.kind,
      status: r.status,
      executeAt: new Date(r.execute_at).toISOString(),
      scheduleId: r.schedule_id,
      url: r.schedule_id ? this.rail.url(r.schedule_id) : null,
      executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
      error: r.error,
    };
  }
  private async set(id: string, status: Status, extra: { error?: string | null; executedAt?: string | null } = {}) {
    await this.db.query("UPDATE hedera_schedules SET status = $1, error = COALESCE($2, error), executed_at = COALESCE($3, executed_at), updated_at = now() WHERE id = $4", [
      status,
      extra.error ?? null,
      extra.executedAt ?? null,
      id,
    ]);
  }

  /** Create the schedule and remember it; a failure is remembered too, and the server keeps the job. */
  private async create(siteId: string, kind: ScheduleKind, ref: string, at: Date, make: () => Promise<{ scheduleId: string; txId: string }>, summary: string): Promise<ScheduleView> {
    const id = newId("hs");
    const lead = at.getTime() - this.now();
    let status: Status = "scheduled";
    let created: { scheduleId: string; txId: string } | null = null;
    let error: string | null = null;
    if (lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) {
      status = "skipped";
      error = lead < MIN_LEAD_MS ? "Too close to its deadline to schedule" : "More than 62 days away";
    } else {
      try {
        created = await make();
      } catch (e) {
        status = "failed";
        error = e instanceof Error ? e.message : String(e);
      }
    }
    await this.db.query(
      "INSERT INTO hedera_schedules (id, site_id, kind, ref, execute_at, schedule_id, tx_id, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (kind, ref) DO NOTHING",
      [id, siteId, kind, ref, at.toISOString(), created?.scheduleId ?? null, created?.txId ?? null, status, error],
    );
    if (created)
      await this.rec.decide(siteId, {
        agent: "system:scheduler",
        kind: "schedule.created",
        summary: `${summary}: Hedera schedule ${created.scheduleId} runs it at ${at.toISOString()}`,
        data: { kind, ref, scheduleId: created.scheduleId, transactionId: created.txId, executeAt: at.toISOString(), url: this.rail.url(created.scheduleId) },
      });
    return (await this.of(kind, ref))!;
  }

  private async cancel(r: Row, why: string) {
    if (!r.schedule_id) return this.set(r.id, "cancelled");
    try {
      await this.rail.cancel(r.schedule_id);
      await this.set(r.id, "cancelled", { error: why });
      await this.rec.decide(r.site_id, { agent: "system:scheduler", kind: "schedule.deleted", summary: `Deleted Hedera schedule ${r.schedule_id}: ${why}`, data: { kind: r.kind, ref: r.ref, scheduleId: r.schedule_id } });
    } catch (e) {
      // it may have run or expired already; once its time has passed there is nothing left to stop
      if (Date.parse(r.execute_at) < this.now()) await this.set(r.id, "cancelled", { error: `${why}; delete failed: ${e instanceof Error ? e.message : e}` });
      else console.error("[ordo] schedule delete", r.schedule_id, e);
    }
  }

  // ---------------------------------------------------------------- work-order refunds
  /** Schedule the refund of each new escrow at its on-chain expiry; delete it once the order is released. */
  private async workOrders(c: TrustChain) {
    if (!c.cfg.workOrders) return;
    const fresh = await this.db.query<{ id: string; site_id: string }>(
      "SELECT w.id, w.site_id FROM work_orders w WHERE w.status = 'escrowed' AND NOT EXISTS (SELECT 1 FROM hedera_schedules h WHERE h.kind = 'workorder.refund' AND h.ref = w.id) ORDER BY w.created_at LIMIT 5",
    );
    for (const w of fresh.rows) {
      const onchain = await c.workOrder(w.site_id, w.id).catch(() => null);
      if (!onchain || onchain.status !== "escrowed") continue;
      const at = new Date((onchain.expiresAt + AFTER_S) * 1000);
      const data = encodeFunctionData({ abi: ORDO_WORK_ORDERS_ABI, functionName: "refund", args: [w.site_id, w.id] });
      await this.create(w.site_id, "workorder.refund", w.id, at, () => this.rail.contractCall({ contract: c.cfg.workOrders!, data, gas: REFUND_GAS, at, memo: `ordo refund ${w.id}` }), `Refund of ${w.id} if it is not released`);
    }
    const done = await this.db.query<Row>(
      "SELECT h.id, h.site_id, h.kind, h.ref, h.execute_at::text, h.schedule_id, h.status FROM hedera_schedules h JOIN work_orders w ON w.id = h.ref WHERE h.kind = 'workorder.refund' AND h.status = 'scheduled' AND w.status = 'released'",
    );
    for (const r of done.rows) await this.cancel(r, `${r.ref} was released`);
  }

  /** The schedule refunded this work order on-chain. */
  async refunded(workOrderId: string) {
    const r = await this.row("workorder.refund", workOrderId);
    if (r) await this.set(r.id, "executed", { executedAt: new Date(this.now()).toISOString() });
  }

  // ---------------------------------------------------------------- validator stakes
  private supportsWithdrawFor(c: TrustChain): Promise<boolean> {
    return (this.withdrawFor ??= c.hasFunction("withdrawFor(string,address)").catch(() => {
      this.withdrawFor = null;
      return false;
    }));
  }

  /**
   * Bring a validator's payout schedule in line with their stake on-chain: an unstake request gets a schedule that
   * pays the stake back when the cooldown ends; staking again deletes it.
   */
  async syncStake(siteId: string, address: string): Promise<ScheduleView | null> {
    const c = this.contracts();
    if (!c || !(await this.supportsWithdrawFor(c))) return null;
    const addr = address.toLowerCase();
    const stake = await c.stakeOf(siteId, addr);
    const want = BigInt(stake.amount) > 0n && stake.unlockAt > 0 ? `${siteId}:${addr}:${stake.unlockAt}` : null;
    const open = await this.db.query<Row>("SELECT id, site_id, kind, ref, execute_at::text, schedule_id, status FROM hedera_schedules WHERE kind = 'stake.withdraw' AND status = 'scheduled' AND ref LIKE $1", [`${siteId}:${addr}:%`]);
    for (const r of open.rows) if (r.ref !== want) await this.cancel(r, "the validator staked again");
    if (!want) return null;
    const have = await this.of("stake.withdraw", want);
    if (have) return have;
    const at = new Date((stake.unlockAt + AFTER_S) * 1000);
    const data = encodeFunctionData({ abi: ORDO_TRUST_ABI, functionName: "withdrawFor", args: [siteId, addr as Address] } as never);
    return this.create(siteId, "stake.withdraw", want, at, () => this.rail.contractCall({ contract: c.cfg.address, data, gas: WITHDRAW_GAS, at, memo: `ordo unstake ${addr}` }), `Return of ${addr}'s stake when the cooldown ends`);
  }

  /** The latest payout schedule for a validator, for the console. */
  async stakeSchedule(siteId: string, address: string): Promise<ScheduleView | null> {
    const r = (await this.db.query<Row>(
      "SELECT id, site_id, kind, ref, execute_at::text, schedule_id, tx_id, status, executed_at::text, error, next_check_at::text FROM hedera_schedules WHERE kind = 'stake.withdraw' AND ref LIKE $1 ORDER BY created_at DESC LIMIT 1",
      [`${siteId}:${address.toLowerCase()}:%`],
    )).rows[0];
    return r ? this.view(r) : null;
  }

  private async stakes(c: TrustChain) {
    // a stake that went back: the schedule ran
    const due = await this.db.query<Row>(
      "SELECT id, site_id, kind, ref, execute_at::text, schedule_id, status FROM hedera_schedules WHERE kind = 'stake.withdraw' AND status = 'scheduled' AND execute_at < $1",
      [new Date(this.now()).toISOString()],
    );
    for (const r of due.rows) {
      const [siteId, addr] = r.ref.split(":");
      const stake = await c.stakeOf(siteId!, addr!).catch(() => null);
      if (!stake) continue;
      if (stake.amount === "0") {
        await this.set(r.id, "executed", { executedAt: new Date(this.now()).toISOString() });
        await this.rec.decide(r.site_id, { agent: "system:scheduler", kind: "stake.returned", summary: `Hedera schedule ${r.schedule_id} returned ${addr}'s stake at the end of the cooldown`, data: { scheduleId: r.schedule_id, validator: addr } });
      } else if (this.now() > Date.parse(r.execute_at) + SCHEDULE_GRACE_MS) {
        await this.set(r.id, "failed", { error: "The schedule did not return the stake; the validator can withdraw from their wallet" });
      }
    }
    // unstake requests made straight from a wallet: look for them now and then
    if (this.now() - this.lastStakeScan < 10 * 60_000) return;
    this.lastStakeScan = this.now();
    const vs = await this.db.query<{ site_id: string; address: string }>("SELECT v.site_id, u.address FROM validators v JOIN users u ON u.id = v.user_id WHERE v.status = 'approved'");
    for (const v of vs.rows) await this.syncStake(v.site_id, v.address).catch((e) => console.error("[ordo] stake schedule", e));
  }

  // ---------------------------------------------------------------- stage timeouts
  /**
   * Whether a running stage is past its timeout. The deadline is a scheduled message to the ledger topic: when
   * Hedera executes it, the timeout is a consensus fact Ordo reads back from the mirror node.
   */
  async stageTimeout(i: { siteId: string; runId: string; code: string; name: string; startedAt: number; deadline: number }): Promise<{ due: boolean; schedule: ScheduleView | null }> {
    const ref = `${i.runId}:${i.code}:${i.startedAt}`;
    const now = this.now();
    let r = await this.row("stage.timeout", ref);
    if (!r) {
      const at = new Date(i.deadline);
      const message = JSON.stringify({ v: 2, app: "ordo", kind: "stage.timeout", site: i.siteId, runId: i.runId, stage: i.code, deadline: at.toISOString() });
      await this.create(i.siteId, "stage.timeout", ref, at, () => this.rail.topicMessage({ message, at, memo: `ordo timeout ${i.runId} ${i.code}` }), `Timeout of ${i.code} ${i.name} in ${i.runId}`);
      r = (await this.row("stage.timeout", ref))!;
    }
    if (r.status === "executed") return { due: true, schedule: this.view(r) };
    if (r.status !== "scheduled") return { due: now > i.deadline, schedule: null };
    const at = Date.parse(r.execute_at);
    if (now < at || now < Date.parse(r.next_check_at)) return { due: false, schedule: this.view(r) };
    const s = await this.rail.state(r.schedule_id!).catch(() => null);
    if (s?.state === "executed") {
      await this.set(r.id, "executed", { executedAt: s.executedAt ?? new Date(now).toISOString() });
      return { due: true, schedule: this.view((await this.row("stage.timeout", ref))!) };
    }
    if (now > at + SCHEDULE_GRACE_MS) {
      await this.set(r.id, "failed", { error: `Not executed ${SCHEDULE_GRACE_MS / 60_000} min after its time; Ordo raised the timeout itself` });
      return { due: true, schedule: null };
    }
    await this.db.query("UPDATE hedera_schedules SET next_check_at = $1 WHERE id = $2", [new Date(now + 15_000).toISOString(), r.id]);
    return { due: false, schedule: this.view(r) };
  }

  private async stages() {
    const open = await this.db.query<Row & { state: string | null; started_at: string | null }>(
      `SELECT h.id, h.site_id, h.kind, h.ref, h.execute_at::text, h.schedule_id, h.status, sr.state, sr.started_at::text AS started_at
       FROM hedera_schedules h LEFT JOIN stage_runs sr ON h.ref LIKE sr.run_id || ':' || sr.code || ':%'
       WHERE h.kind = 'stage.timeout' AND h.status = 'scheduled'`,
    );
    for (const r of open.rows) {
      const started = Number(r.ref.split(":").pop());
      const live = r.state === "running" && r.started_at !== null && Date.parse(r.started_at) === started;
      if (!live) await this.cancel(r, `${r.ref.split(":").slice(0, 2).join(" ")} finished in time`);
    }
  }

  /** One pass, from the engine cycle. */
  async reconcile() {
    const c = this.contracts();
    if (c) {
      await this.workOrders(c).catch((e) => console.error("[ordo] refund schedules", e));
      if (await this.supportsWithdrawFor(c)) await this.stakes(c).catch((e) => console.error("[ordo] stake schedules", e));
    }
    await this.stages().catch((e) => console.error("[ordo] timeout schedules", e));
  }
}
