import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import type { Signatures, User } from "../auth/auth.js";
import type { AgentPayer } from "../chain/agent.js";
import { chainErrorMessage } from "../chain/errors.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import type { Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { newId } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";
import type { Assessments, AssessmentView } from "./assessments.js";
import { sigArg, type SigArg } from "../chain/trust.js";
import type { RelayView, Trust } from "./trust.js";
import { SCHEDULE_GRACE_MS, type Schedules, type ScheduleView } from "./schedules.js";

/** Hours of work the agent budgets for, by priority. */
const HOURS: Record<string, number> = { high: 2, medium: 1, low: 1 };
/** An unreleased escrow can be refunded this long after the work order opens. */
export const ESCROW_TTL_SECONDS = 72 * 3600;

type Status = "unassigned" | "assigned" | "escrowing" | "escrowed" | "escrow_failed" | "releasing" | "released" | "refunded";

interface Row {
  id: string;
  site_id: string;
  asset_id: string | null;
  run_id: string | null;
  title: string;
  priority: string;
  vendor_id: string | null;
  vendor_address: string | null;
  amount: string | null;
  incident_hash: string | null;
  status: Status;
  payer: string | null;
  escrow_tx: string | null;
  escrow_url: string | null;
  expires_at: string | null;
  released_by: string | null;
  error: string | null;
  opened_by: string;
  created_at: string;
  updated_at: string;
  company: string | null;
}

export interface WorkOrderView {
  id: string;
  title: string;
  priority: string;
  assetId: string | null;
  runId: string | null;
  vendor: { id: string; company: string; address: string } | null;
  amount: string | null;
  status: Status;
  payer: string | null;
  escrow: { tx: string; url: string | null; expiresAt: string | null } | null;
  releasedBy: string | null;
  error: string | null;
  openedBy: string;
  createdAt: string;
  updatedAt: string;
  release: RelayView | null;
  /** The vibration assessment the agent bought over x402 for this work order */
  assessment: AssessmentView | null;
  /** The Hedera schedule that refunds the escrow if nobody releases it */
  refundSchedule: ScheduleView | null;
}

/**
 * Work orders the maintenance agent opens, and how vendors get paid: the agent escrows from the site's fund in
 * OrdoWorkOrders (within caps an admin signed), a maintenance lead signs that the work is done to release it, and
 * an unreleased escrow is refunded after it expires. Without the contract, work orders still assign a vendor.
 */
export class WorkOrders {
  /** Set when the agent buys assessments over x402 */
  assessments: Assessments | null = null;
  /** Set when Hedera's Schedule Service refunds expired escrows */
  schedules: Schedules | null = null;
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private trust: Trust,
    readonly payer: AgentPayer | null,
    private now: () => number,
  ) {
    trust.onRetry("workorder.release", async (siteId, ref, p) => {
      const tx = await this.chain().releaseWorkOrder(siteId, ref, p.sig);
      await this.db.query("UPDATE work_orders SET status = 'released', error = NULL, updated_at = now() WHERE id = $1 AND site_id = $2", [ref, siteId]);
      return tx;
    });
    trust.onRetry("agent.caps", (siteId, _ref, p) => this.chain().setAgent(siteId, p.agent, BigInt(p.perOrder), BigInt(p.perDay), p.sig));
    trust.onRetry("agent.pause", (siteId, _ref, p) => this.chain().setPaused(siteId, p.stop, p.sig));
  }

  /** The contract is configured and the agent has an account to escrow from. */
  get live(): boolean {
    return Boolean(this.trust.chain?.cfg.workOrders && this.payer);
  }
  private chain() {
    const c = this.trust.chain;
    if (!c?.cfg.workOrders) throw new HttpError(409, "Agent payments need the OrdoWorkOrders contract (TRUST_WORKORDERS_ADDRESS)");
    return c;
  }
  private units(amount: string): string {
    const c = this.trust.chain;
    return c ? `${formatUnits(BigInt(amount), c.cfg.decimals)} ${c.cfg.symbol}` : amount;
  }

  // ---------------------------------------------------------------- set-up: fund, caps, pause
  async status(siteId: string) {
    const c = this.trust.chain;
    const agent = (await this.db.query<{ address: string; per_order: string; per_day: string; set_by: string; updated_at: string }>(
      "SELECT address, per_order, per_day, set_by, updated_at::text FROM site_agents WHERE site_id = $1",
      [siteId],
    )).rows[0];
    const base = {
      configured: Boolean(c?.cfg.workOrders),
      contract: c?.cfg.workOrders ?? null,
      chainId: c?.cfg.chainId ?? null,
      chainName: c?.cfg.name ?? null,
      explorerUrl: c?.cfg.explorerUrl ?? null,
      symbol: c?.cfg.symbol ?? null,
      decimals: c?.cfg.decimals ?? null,
      agent: this.payer ? { address: this.payer.address, via: this.payer.kind } : null,
      caps: agent ? { perOrder: agent.per_order, perDay: agent.per_day, setBy: agent.set_by, updatedAt: new Date(agent.updated_at).toISOString() } : null,
      capsRelay: await this.trust.relayOf(siteId, `agent.caps:${siteId}`),
      siteRegistered: await this.trust.siteRegistered(siteId),
      onchain: null as null | { funds: string; paused: boolean; perOrder: string; perDay: string; spentToday: string } | { error: string },
    };
    if (c?.cfg.workOrders && base.siteRegistered) {
      base.onchain = await Promise.all([c.fundOf(siteId), this.payer ? c.agentOf(siteId, this.payer.address) : null])
        .then(([f, a]) => ({ ...f, perOrder: a?.perOrder ?? "0", perDay: a?.perDay ?? "0", spentToday: a?.spentToday ?? "0" }))
        .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
    return base;
  }

  private agentAddress(): Address {
    if (!this.payer) throw new HttpError(409, "No agent account is configured (HEDERA_AGENT_KEY)");
    return this.payer.address;
  }
  private capsEntity(perOrder: string, perDay: string) {
    return `${this.agentAddress().toLowerCase()}#${perOrder}#${perDay}`;
  }
  private checkCaps(i: { perOrder: string; perDay: string }) {
    if (!/^\d+$/.test(i.perOrder) || !/^\d+$/.test(i.perDay)) throw new HttpError(400, "Caps are whole numbers of contract units");
    if (BigInt(i.perOrder) > BigInt(i.perDay)) throw new HttpError(400, "The per-order cap cannot exceed the daily cap");
  }
  capsRequest(siteId: string, user: User, roles: Role[], i: { perOrder: string; perDay: string }) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager sets the agent's spending caps");
    this.checkCaps(i);
    return this.sigs.request(user, {
      action: "agent.caps",
      entity: this.capsEntity(i.perOrder, i.perDay),
      meaning: `Let the maintenance agent escrow up to ${this.units(i.perOrder)} per work order and ${this.units(i.perDay)} per day`,
      comment: "",
      site: siteId,
      chainId: this.chain().cfg.chainId,
    });
  }
  async setCaps(siteId: string, user: User, roles: Role[], i: { perOrder: string; perDay: string; nonce: string; signature: Hex }) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager sets the agent's spending caps");
    this.checkCaps(i);
    const agent = this.agentAddress();
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "agent.caps", entity: this.capsEntity(i.perOrder, i.perDay) }, i);
      await q.query(
        `INSERT INTO site_agents (site_id, address, per_order, per_day, set_by, signature_id) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (site_id) DO UPDATE SET address = EXCLUDED.address, per_order = EXCLUDED.per_order, per_day = EXCLUDED.per_day, set_by = EXCLUDED.set_by, signature_id = EXCLUDED.signature_id, updated_at = now()`,
        [siteId, agent, i.perOrder, i.perDay, user.address, s.id],
      );
      return s;
    });
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "agent.caps_set", summary: `Agent spending caps: ${this.units(i.perOrder)} per order, ${this.units(i.perDay)} per day`, data: { agent, perOrder: i.perOrder, perDay: i.perDay, signatureId: sig.id } });
    const arg = sigArg(sig.typed, i.signature);
    return this.trust.relay(siteId, "agent.caps", `agent.caps:${siteId}`, { agent, perOrder: i.perOrder, perDay: i.perDay, sig: arg }, () => this.chain().setAgent(siteId, agent, BigInt(i.perOrder), BigInt(i.perDay), arg), true, this.chain().cfg.workOrders!);
  }

  pauseRequest(siteId: string, user: User, roles: Role[], stop: boolean) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager stops or resumes the agent");
    return this.sigs.request(user, {
      action: stop ? "agent.pause" : "agent.resume",
      entity: siteId,
      meaning: stop ? "Stop the maintenance agent from spending" : "Let the maintenance agent spend again",
      comment: "",
      site: siteId,
      chainId: this.chain().cfg.chainId,
    });
  }
  async setPaused(siteId: string, user: User, roles: Role[], stop: boolean, proof: { nonce: string; signature: Hex }) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager stops or resumes the agent");
    const sig = await this.db.tx((q) => this.sigs.consume(q, user, { action: stop ? "agent.pause" : "agent.resume", entity: siteId }, proof));
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: stop ? "agent.paused" : "agent.resumed", summary: stop ? "Agent spending stopped" : "Agent spending resumed", data: { signatureId: sig.id } });
    const arg = sigArg(sig.typed, proof.signature);
    return this.trust.relay(siteId, "agent.pause", `agent.pause:${siteId}`, { stop, sig: arg }, () => this.chain().setPaused(siteId, stop, arg), true, this.chain().cfg.workOrders!);
  }

  // ---------------------------------------------------------------- the agent opens and escrows
  /** Called when the agent's open_work_order action runs: assign a vendor and, when payments are live, escrow. */
  async open(siteId: string, actor: string, i: { assetId: string; assetName: string; assetKind: string; runId: string; priority: string; incidentHash: string | null }): Promise<WorkOrderView> {
    const vendors = await this.db.query<{ id: string; address: string; company: string; categories: string; hourly_rate: string | null }>(
      "SELECT id, address, company, categories, hourly_rate FROM vendors WHERE site_id = $1 AND status = 'approved' ORDER BY created_at",
      [siteId],
    );
    const kind = i.assetKind.toLowerCase();
    const vendor = vendors.rows.find((v) => v.categories.toLowerCase().split(/[,;]\s*/).some((c) => c && (kind.includes(c) || c.includes(kind)))) ?? vendors.rows[0] ?? null;
    const id = newId("wo");
    const caps = (await this.db.query<{ per_order: string }>("SELECT per_order FROM site_agents WHERE site_id = $1", [siteId])).rows[0];
    let amount: string | null = null;
    const rate = vendor?.hourly_rate ? Number.parseFloat(vendor.hourly_rate) : Number.NaN;
    const c = this.trust.chain;
    if (vendor && c && Number.isFinite(rate) && rate > 0) {
      const units = parseUnits((rate * (HOURS[i.priority] ?? 1)).toFixed(c.cfg.decimals), c.cfg.decimals);
      amount = (caps && units > BigInt(caps.per_order) ? BigInt(caps.per_order) : units).toString();
    }
    const incidentHash = i.incidentHash ? `0x${i.incidentHash.replace(/^sha256:/, "").padStart(64, "0").slice(0, 64)}` : `0x${"0".repeat(64)}`;
    const status: Status = !vendor ? "unassigned" : this.live && amount && caps && (await this.trust.siteRegistered(siteId)) ? "escrowing" : "assigned";
    await this.db.query(
      `INSERT INTO work_orders (id, site_id, asset_id, run_id, title, priority, vendor_id, vendor_address, amount, incident_hash, status, payer, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, siteId, i.assetId, i.runId, `Maintenance · ${i.assetName}`, i.priority, vendor?.id ?? null, vendor?.address.toLowerCase() ?? null, amount, incidentHash, status, status === "escrowing" ? this.payer!.kind : null, actor],
    );
    if (status === "escrowing") await this.escrow(siteId, id);
    await this.assessments?.request(siteId, id, i.assetId);
    return this.get(siteId, id);
  }

  private async escrow(siteId: string, id: string) {
    const w = await this.row(siteId, id);
    try {
      const r = await this.payer!.escrow({ siteId, workOrderId: id, vendor: w.vendor_address as Address, amount: BigInt(w.amount!), ttlSeconds: ESCROW_TTL_SECONDS, incidentHash: w.incident_hash as Hex });
      const expires = new Date(this.now() + ESCROW_TTL_SECONDS * 1000).toISOString();
      await this.db.query("UPDATE work_orders SET status = 'escrowed', escrow_tx = $1, escrow_url = $2, expires_at = $3, error = NULL, updated_at = now() WHERE id = $4", [r.txId, r.url, expires, id]);
      await this.rec.decide(siteId, { agent: `agent:maintenance`, kind: "work_order.escrowed", summary: `Escrowed ${this.units(w.amount!)} for ${w.company ?? "the vendor"} on ${id}`, data: { workOrderId: id, vendor: w.vendor_address, amount: w.amount, tx: r.txId, url: r.url, via: this.payer!.kind } });
    } catch (e) {
      const msg = chainErrorMessage(e);
      await this.db.query("UPDATE work_orders SET status = 'escrow_failed', error = $1, updated_at = now() WHERE id = $2", [msg, id]);
      await this.rec.event("agent:maintenance", "work_order.escrow_failed", id, { site: siteId, error: msg });
    }
  }

  /** Retry a failed escrow (maintenance lead). */
  async retryEscrow(siteId: string, roles: Role[], id: string) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager retries a payment");
    const w = await this.row(siteId, id);
    if (w.status !== "escrow_failed") throw new HttpError(409, "Only a failed escrow can be retried");
    if (!this.live) throw new HttpError(409, "Agent payments are not configured");
    await this.db.query("UPDATE work_orders SET status = 'escrowing', updated_at = now() WHERE id = $1", [id]);
    await this.escrow(siteId, id);
    return this.get(siteId, id);
  }

  /** Buy the assessment again after the job gave up (maintenance lead). */
  async retryAssessment(siteId: string, roles: Role[], id: string) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager retries an assessment");
    if (!this.assessments) throw new HttpError(409, "x402 assessments are not configured");
    await this.row(siteId, id);
    await this.assessments.retry(id);
    return this.get(siteId, id);
  }

  /** Agent Kit policy: the agent may escrow only what Ordo opened. Returns why not, or null. */
  async checkEscrow(p: { siteId: string; workOrderId: string; vendor: string; amount: string }): Promise<string | null> {
    const w = (await this.db.query<{ status: string; vendor_address: string | null; amount: string | null }>("SELECT status, vendor_address, amount FROM work_orders WHERE id = $1 AND site_id = $2", [p.workOrderId, p.siteId])).rows[0];
    if (!w) return `no work order ${p.workOrderId} at ${p.siteId}`;
    if (w.status !== "escrowing") return `work order ${p.workOrderId} is ${w.status}, not awaiting escrow`;
    if (w.vendor_address !== p.vendor.toLowerCase()) return "vendor differs from the one Ordo assigned";
    if (w.amount !== p.amount) return `amount ${p.amount} differs from the agreed ${w.amount}`;
    return null;
  }

  // ---------------------------------------------------------------- people release
  private releaseEntity(w: Row) {
    return `${w.id}#${w.vendor_address}#${w.amount}`;
  }
  private async releasable(siteId: string, user: User, roles: Role[], id: string) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager confirms the work and pays");
    const w = await this.row(siteId, id);
    if (w.status !== "escrowed") throw new HttpError(409, `Work order is ${w.status.replace("_", " ")}`);
    // past expiry the escrow is refundable by anyone (and Hedera's schedule refunds it): a release would revert
    if (w.expires_at && Date.parse(w.expires_at) <= this.now()) throw new HttpError(409, "The escrow has expired and returns to the site's fund");
    if (w.vendor_address === user.address.toLowerCase()) throw new HttpError(403, "The vendor cannot release its own payment");
    return w;
  }
  async releaseRequest(siteId: string, user: User, roles: Role[], id: string) {
    const w = await this.releasable(siteId, user, roles, id);
    return this.sigs.request(user, {
      action: "workorder.release",
      entity: this.releaseEntity(w),
      meaning: `Work done on ${w.title}: pay ${w.company ?? w.vendor_address} ${this.units(w.amount!)}`,
      comment: "",
      site: siteId,
      chainId: this.chain().cfg.chainId,
    });
  }
  async release(siteId: string, user: User, roles: Role[], id: string, proof: { nonce: string; signature: Hex }) {
    const w = await this.releasable(siteId, user, roles, id);
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "workorder.release", entity: this.releaseEntity(w) }, proof);
      await q.query("UPDATE work_orders SET status = 'releasing', released_by = $1, updated_at = now() WHERE id = $2", [user.address, id]);
      return s;
    });
    const arg: SigArg = sigArg(sig.typed, proof.signature);
    // it stays `releasing` until the receipt lands: in this request when the chain is quick, in the background otherwise
    await this.trust.relay(siteId, "workorder.release", id, { sig: arg }, () => this.chain().releaseWorkOrder(siteId, id, arg), true, this.chain().cfg.workOrders!, {
      then: async (relay) => {
        if (relay.status === "done") {
          await this.db.query("UPDATE work_orders SET status = 'released', updated_at = now() WHERE id = $1", [id]);
          await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "work_order.released", summary: `Paid ${w.company ?? w.vendor_address} ${this.units(w.amount!)} for ${id}`, data: { workOrderId: id, txHash: relay.txHash, signatureId: sig.id } });
        } else if (relay.status === "failed") {
          // back to escrowed, so the refund timer and refundExpired still cover it and someone can sign again
          await this.db.query("UPDATE work_orders SET status = 'escrowed', released_by = NULL, error = $1, updated_at = now() WHERE id = $2", [relay.error, id]);
        }
      },
    });
    return this.get(siteId, id);
  }

  /**
   * Return expired escrows to the site's fund. With Hedera's Schedule Service the refund is a scheduled transaction
   * the network runs at expiry, and this only records it; otherwise, or if the schedule has not run a few minutes
   * later, the relayer calls refund itself (anyone may).
   */
  async refundExpired(): Promise<number> {
    if (!this.trust.chain?.cfg.workOrders) return 0;
    const due = await this.db.query<{ id: string; site_id: string; amount: string }>("SELECT id, site_id, amount FROM work_orders WHERE status = 'escrowed' AND expires_at < $1 ORDER BY expires_at LIMIT 20", [new Date(this.now()).toISOString()]);
    for (const w of due.rows) {
      const schedule = await this.schedules?.of("workorder.refund", w.id);
      if (schedule?.status === "scheduled") {
        const onchain = await this.chain().workOrder(w.site_id, w.id).catch(() => null);
        if (onchain?.status === "refunded") {
          await this.db.query("UPDATE work_orders SET status = 'refunded', updated_at = now() WHERE id = $1", [w.id]);
          await this.schedules!.refunded(w.id);
          await this.rec.decide(w.site_id, {
            agent: "system:scheduler",
            kind: "work_order.refunded",
            summary: `${w.id} expired unreleased: Hedera schedule ${schedule.scheduleId} returned ${this.units(w.amount)} to the site's fund`,
            data: { workOrderId: w.id, scheduleId: schedule.scheduleId, url: schedule.url },
          });
          continue;
        }
        if (this.now() < Date.parse(schedule.executeAt) + SCHEDULE_GRACE_MS) continue;
      }
      const relay = await this.trust.relay(w.site_id, "workorder.refund", w.id, {}, () => this.chain().refundWorkOrder(w.site_id, w.id), true, this.chain().cfg.workOrders!, { wait: Infinity });
      if (relay.status === "done") {
        await this.db.query("UPDATE work_orders SET status = 'refunded', updated_at = now() WHERE id = $1", [w.id]);
        await this.rec.decide(w.site_id, { agent: "system:relayer", kind: "work_order.refunded", summary: `${w.id} expired unreleased: ${this.units(w.amount)} back to the site's fund`, data: { workOrderId: w.id, txHash: relay.txHash } });
      }
    }
    return due.rows.length;
  }

  // ---------------------------------------------------------------- reads
  private async row(siteId: string, id: string): Promise<Row> {
    const r = (await this.db.query<Row>(
      `SELECT w.id, w.site_id, w.asset_id, w.run_id, w.title, w.priority, w.vendor_id, w.vendor_address, w.amount, w.incident_hash, w.status, w.payer,
              w.escrow_tx, w.escrow_url, w.expires_at::text AS expires_at, w.released_by, w.error, w.opened_by, w.created_at::text AS created_at, w.updated_at::text AS updated_at, v.company
       FROM work_orders w LEFT JOIN vendors v ON v.id = w.vendor_id WHERE w.id = $1 AND w.site_id = $2`,
      [id, siteId],
    )).rows[0];
    if (!r) throw new HttpError(404, "Work order not found");
    return r;
  }
  private async view(w: Row): Promise<WorkOrderView> {
    return {
      id: w.id,
      title: w.title,
      priority: w.priority,
      assetId: w.asset_id,
      runId: w.run_id,
      vendor: w.vendor_id && w.vendor_address ? { id: w.vendor_id, company: w.company ?? w.vendor_address, address: w.vendor_address } : null,
      amount: w.amount,
      status: w.status,
      payer: w.payer,
      escrow: w.escrow_tx ? { tx: w.escrow_tx, url: w.escrow_url, expiresAt: w.expires_at ? new Date(w.expires_at).toISOString() : null } : null,
      releasedBy: w.released_by,
      error: w.error,
      openedBy: w.opened_by,
      createdAt: new Date(w.created_at).toISOString(),
      updatedAt: new Date(w.updated_at).toISOString(),
      release: w.status === "releasing" || w.status === "released" ? await this.trust.relayOf(w.site_id, w.id) : null,
      assessment: (await this.assessments?.of(w.id)) ?? null,
      refundSchedule: (await this.schedules?.of("workorder.refund", w.id)) ?? null,
    };
  }
  async get(siteId: string, id: string) {
    return this.view(await this.row(siteId, id));
  }
  async list(siteId: string): Promise<WorkOrderView[]> {
    const ids = await this.db.query<{ id: string }>("SELECT id FROM work_orders WHERE site_id = $1 ORDER BY created_at DESC LIMIT 100", [siteId]);
    return Promise.all(ids.rows.map((r) => this.get(siteId, r.id)));
  }
}
