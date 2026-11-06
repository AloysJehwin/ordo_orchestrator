import type { User } from "../auth/auth.js";
import type { MachineBank } from "../chain/machine-bank.js";
import type { Assessment } from "../chain/x402.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import type { Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { PlantService } from "../plant/plant.js";
import { newId } from "../plant/plant.js";
import type { AssessmentBuyer } from "./assessments.js";
import type { Jobs } from "./jobs.js";
import { KeyBox } from "./keybox.js";
import type { Names } from "./names.js";
import type { MachineRoles } from "./machine-roles.js";
import type { Recorder } from "./recorder.js";

const OPEN_JOB = "machine.open";
const BUY_JOB = "machine.buy";
const DAY_MS = 86_400_000;
/** How far back a machine sends its readings for an assessment */
const WINDOW_MINUTES = 6 * 60;
const TINYBAR = 100_000_000;
export const hbar = (tinybars: string | bigint) => `${(Number(tinybars) / TINYBAR).toFixed(2).replace(/\.?0+$/, "")} HBAR`;

interface WalletRow {
  asset_id: string;
  site_id: string;
  account_id: string | null;
  evm_address: string | null;
  key_enc: string | null;
  daily_budget: string;
  per_call: string;
  status: "opening" | "active" | "paused" | "failed";
  open_tx: string | null;
  last_topup_at: string | null;
  error: string | null;
  enabled_by: string;
}
export interface PurchaseView {
  id: string;
  kind: "assessment" | "callout";
  seller: string;
  amount: string | null;
  txId: string | null;
  txUrl: string | null;
  auditTx: string | null;
  incidentId: string | null;
  result: Record<string, unknown> | null;
  at: string;
}
export interface MachineWalletView {
  assetId: string;
  status: WalletRow["status"];
  accountId: string | null;
  accountUrl: string | null;
  evmAddress: string | null;
  dailyBudget: string;
  perCall: string;
  balance: string | null;
  lastTopUpAt: string | null;
  error: string | null;
  purchases: PurchaseView[];
}

/**
 * Machines that pay for themselves. A machine can be given its own Hedera account with a daily budget: the site's
 * treasury (the operator) opens it and tops it back up to the budget once a day, so the balance is a hard cap on what
 * the machine can ever spend. When the machine drifts out of limits it buys, from its own account and with nobody's
 * approval, a vibration assessment over x402; if the assessment says the machine is in zone C or D it pays a vendor
 * directly to reserve an urgent call-out. Every purchase is in Ordo's ledger and on the HCS topic.
 */
export class Machines {
  private keys: KeyBox;
  /** ENS names: a machine's account memo is its name (cnc-07.machines.acme.ordo.eth), so HashScan shows it */
  names: Pick<Names, "ensure"> | null = null;
  /** machine roles: a wallet's first opening makes the machine a Buyer, pausing it takes Buyer away (set by wiring) */
  machineRoles: Pick<MachineRoles, "seedBuyer" | "dropBuyer" | "ofAsset"> | null = null;
  constructor(
    private db: Db,
    private rec: Recorder,
    private jobs: Jobs,
    private plant: PlantService,
    readonly bank: MachineBank | null,
    private buyerFor: (accountId: string, key: string, perCall: bigint) => AssessmentBuyer,
    private urls: { assess: string | null; base: string | null; assessPrice: bigint },
    secret: string,
    private now: () => number,
  ) {
    this.keys = new KeyBox("machine-wallets", secret);
    jobs.register(OPEN_JOB, (_p, job) => this.open(job.ref));
    jobs.register(BUY_JOB, (p: { assetId: string; incidentId: string }, job) => this.buy(job.siteId!, p.assetId, p.incidentId));
  }

  get live() {
    return Boolean(this.bank && this.urls.assess);
  }

  // ---------------------------------------------------------------- keys at rest
  private seal(plain: string): string {
    return this.keys.seal(plain);
  }
  private unseal(sealed: string): string {
    return this.keys.unseal(sealed);
  }

  // ---------------------------------------------------------------- people set it up
  private limits(i: { dailyBudget: string; perCall: string }) {
    if (!/^\d+$/.test(i.dailyBudget) || !/^\d+$/.test(i.perCall)) throw new HttpError(400, "Budgets are whole numbers of tinybars");
    const [day, call] = [BigInt(i.dailyBudget), BigInt(i.perCall)];
    if (call <= 0n || day <= 0n) throw new HttpError(400, "Budgets must be above zero");
    if (call > day) throw new HttpError(400, "The per-purchase cap cannot exceed the daily budget");
    if (day > 100n * BigInt(TINYBAR)) throw new HttpError(400, "A machine's daily budget is capped at 100 HBAR");
    return { day, call };
  }

  /** Give a machine its own Hedera account (maintenance lead, plant manager or admin). */
  async enable(siteId: string, user: User, roles: Role[], assetId: string, i: { dailyBudget: string; perCall: string }) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager gives a machine a wallet");
    if (!this.bank) throw new HttpError(409, "Machine wallets need Hedera (HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY)");
    const { day, call } = this.limits(i);
    const asset = await this.plant.asset(siteId, assetId);
    const existing = await this.row(assetId);
    if (existing && existing.site_id !== siteId) throw new HttpError(404, "Asset not found");
    if (existing && existing.status !== "failed") {
      await this.db.query("UPDATE machine_wallets SET daily_budget = $1, per_call = $2, status = CASE WHEN status = 'paused' THEN 'active' ELSE status END, updated_at = now() WHERE asset_id = $3", [day.toString(), call.toString(), assetId]);
      await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "machine.limits_set", assetId, summary: `${asset.name} may spend ${hbar(day)} a day, at most ${hbar(call)} a purchase`, data: { dailyBudget: day.toString(), perCall: call.toString() } });
    } else {
      await this.db.query(
        `INSERT INTO machine_wallets (asset_id, site_id, daily_budget, per_call, status, enabled_by) VALUES ($1,$2,$3,$4,'opening',$5)
         ON CONFLICT (asset_id) DO UPDATE SET daily_budget = EXCLUDED.daily_budget, per_call = EXCLUDED.per_call, status = 'opening', error = NULL, updated_at = now()`,
        [assetId, siteId, day.toString(), call.toString(), user.address],
      );
      await this.jobs.retry(OPEN_JOB, assetId);
      await this.jobs.enqueue(siteId, OPEN_JOB, assetId, {});
      // its first wallet makes it a Buyer, within these limits (a manager signs changes to its caps on the floor)
      await this.machineRoles?.seedBuyer(siteId, assetId, user.address);
      await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "machine.wallet_requested", assetId, summary: `${asset.name} gets its own Hedera account: ${hbar(day)} a day, at most ${hbar(call)} a purchase`, data: { dailyBudget: day.toString(), perCall: call.toString() } });
    }
    return this.get(siteId, assetId);
  }

  async pause(siteId: string, user: User, roles: Role[], assetId: string, stop: boolean) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager stops a machine's spending");
    const w = await this.row(assetId);
    if (!w || w.site_id !== siteId) throw new HttpError(404, "This machine has no wallet");
    if (w.status !== (stop ? "active" : "paused")) throw new HttpError(409, `The wallet is ${w.status}`);
    await this.db.query("UPDATE machine_wallets SET status = $1, updated_at = now() WHERE asset_id = $2", [stop ? "paused" : "active", assetId]);
    // a paused machine is no longer a Buyer; resuming lets the wallet spend again, but Buyer comes back only with a signed grant
    if (stop) await this.machineRoles?.dropBuyer(assetId);
    const asset = await this.plant.asset(siteId, assetId);
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: stop ? "machine.paused" : "machine.resumed", assetId, summary: `${asset.name} ${stop ? "may no longer spend" : "may spend again"}` });
    return this.get(siteId, assetId);
  }

  private async open(assetId: string) {
    const w = await this.row(assetId);
    if (!w || w.status !== "opening") return { skipped: "nothing to open" };
    const asset = await this.plant.asset(w.site_id, assetId);
    try {
      const name = await this.names?.ensure(w.site_id, "machine", assetId).catch(() => null);
      const a = await this.bank!.open(BigInt(w.daily_budget), name && name.length <= 100 ? name : `ordo:machine:${asset.name}`);
      await this.db.query("UPDATE machine_wallets SET account_id = $1, evm_address = $2, key_enc = $3, open_tx = $4, status = 'active', last_topup_at = $5, error = NULL, updated_at = now() WHERE asset_id = $6", [
        a.accountId,
        a.evmAddress,
        this.seal(a.key),
        a.tx,
        new Date(this.now()).toISOString(),
        assetId,
      ]);
      const audit = await this.bank!.audit({ kind: "machine.wallet_opened", site: w.site_id, asset: asset.name, account: a.accountId }).catch(() => null);
      await this.rec.decide(w.site_id, { agent: `machine:${asset.name}`, kind: "machine.wallet_opened", assetId, summary: `${asset.name} has its own Hedera account ${a.accountId}, funded with ${hbar(w.daily_budget)}`, data: { accountId: a.accountId, tx: a.tx, audit } });
      return { accountId: a.accountId, tx: a.tx };
    } catch (e) {
      await this.db.query("UPDATE machine_wallets SET error = $1, updated_at = now() WHERE asset_id = $2", [e instanceof Error ? e.message : String(e), assetId]);
      throw e;
    }
  }

  // ---------------------------------------------------------------- the machine pays
  /** Called when the monitor opens an incident on an asset. */
  async onIncident(siteId: string, assetId: string, incidentId: string) {
    if (!this.live) return;
    const w = await this.row(assetId);
    if (w?.status === "active" && w.site_id === siteId) await this.jobs.enqueue(siteId, BUY_JOB, `${siteId}:${incidentId}`, { assetId, incidentId });
  }

  private async buy(siteId: string, assetId: string, incidentId: string): Promise<Record<string, unknown>> {
    const w = await this.row(assetId);
    if (!w || w.status !== "active" || !w.account_id || !w.key_enc) return { skipped: "The machine has no active wallet" };
    // a machine spends only while it holds the Buyer role, and no more an order than its cap
    const role = this.machineRoles ? (await this.machineRoles.ofAsset(assetId)).buyer : null;
    if (this.machineRoles && !role) return { skipped: "The machine does not hold the Buyer role" };
    const asset = await this.plant.asset(siteId, assetId);
    const samples = (await this.plant.series(assetId, "vibration", WINDOW_MINUTES)).filter((p) => p.value !== null).map((p) => ({ t: p.ts, v: p.value! }));
    if (samples.length < 3) return { skipped: "Fewer than three vibration readings in the last 6 hours: nothing to assess" };
    const perCall = role?.order != null && role.order < BigInt(w.per_call) ? role.order : BigInt(w.per_call);
    const buyer = this.buyerFor(w.account_id, this.unseal(w.key_enc), perCall);
    const who = `machine:${asset.name}`;

    const a = await buyer.post<Assessment>(this.urls.assess!, { machineClass: "medium", samples });
    const p1 = await this.record(siteId, assetId, incidentId, "assessment", "Ordo condition monitoring", this.urls.assessPrice.toString(), a.payment, a.body as unknown as Record<string, unknown>);
    await this.rec.decide(siteId, {
      agent: who,
      kind: "machine.bought_assessment",
      assetId,
      incidentId,
      summary: `${asset.name} paid for its own vibration assessment from ${w.account_id}: zone ${a.body.zone} at ${a.body.level} mm/s`,
      data: { purchaseId: p1, account: w.account_id, assessment: a.body, payment: a.payment },
    });
    if (a.body.zone !== "C" && a.body.zone !== "D") return { assessment: a.body, payment: a.payment };

    // Zone C or D: the machine reserves an urgent call-out with a vendor of its kind, paying the vendor directly.
    const vendor = await this.vendorFor(siteId, asset.kind);
    if (!vendor || !this.urls.base) {
      await this.rec.decide(siteId, { agent: who, kind: "machine.no_vendor", assetId, incidentId, summary: `${asset.name} is in zone ${a.body.zone} but no vendor with a Hedera account serves it`, data: {} });
      return { assessment: a.body, payment: a.payment, callout: null };
    }
    const c = await buyer.post<{ reference: string; vendor: string; slotBy: string; deposit: string }>(`${this.urls.base}/v1/x402/vendors/${vendor.id}/callout`, {
      assetId,
      reason: `${asset.name}: vibration zone ${a.body.zone} at ${a.body.level} mm/s (${incidentId})`,
    });
    const p2 = await this.record(siteId, assetId, incidentId, "callout", vendor.company, c.body.deposit, c.payment, c.body);
    await this.rec.decide(siteId, {
      agent: who,
      kind: "machine.reserved_callout",
      assetId,
      incidentId,
      summary: `${asset.name} paid ${vendor.company} a ${hbar(c.body.deposit)} deposit for an urgent call-out by ${new Date(c.body.slotBy).toUTCString().slice(17, 22)} UTC`,
      data: { purchaseId: p2, vendorId: vendor.id, reservation: c.body, payment: c.payment },
    });
    return { assessment: a.body, payment: a.payment, callout: c.body, calloutPayment: c.payment };
  }

  private async record(siteId: string, assetId: string, incidentId: string, kind: PurchaseView["kind"], seller: string, amount: string, payment: { transaction: string; url: string } | null, result: Record<string, unknown>) {
    const id = newId("mp");
    const audit = await this.bank!.audit({ kind: `machine.${kind}`, site: siteId, asset: assetId, seller, tx: payment?.transaction ?? null }).catch(() => null);
    await this.db.query("INSERT INTO machine_purchases (id, site_id, asset_id, incident_id, kind, seller, amount, tx_id, tx_url, audit_tx, result_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      id,
      siteId,
      assetId,
      incidentId,
      kind,
      seller,
      amount,
      payment?.transaction ?? null,
      payment?.url ?? null,
      audit,
      JSON.stringify(result),
    ]);
    return id;
  }

  /** An approved vendor of the machine's kind whose wallet has a Hedera account. */
  private async vendorFor(siteId: string, kind: string) {
    const vendors = await this.db.query<{ id: string; address: string; company: string; categories: string }>("SELECT id, address, company, categories FROM vendors WHERE site_id = $1 AND status = 'approved' ORDER BY created_at", [siteId]);
    const k = kind.toLowerCase();
    const ranked = [...vendors.rows].sort((x, y) => Number(this.serves(y.categories, k)) - Number(this.serves(x.categories, k)));
    for (const v of ranked) if (await this.vendorAccount(v.id)) return v;
    return null;
  }
  private serves(categories: string, kind: string) {
    return categories.toLowerCase().split(/[,;]\s*/).some((c) => c && (kind.includes(c) || c.includes(kind)));
  }

  // ---------------------------------------------------------------- the vendor sells a call-out
  private accounts = new Map<string, { account: string | null; at: number }>();
  /** The vendor's Hedera account (from its wallet address), cached for 10 minutes. */
  async vendorAccount(vendorId: string): Promise<string | null> {
    const hit = this.accounts.get(vendorId);
    if (hit && this.now() - hit.at < 600_000) return hit.account;
    const v = (await this.db.query<{ address: string }>("SELECT address FROM vendors WHERE id = $1 AND status = 'approved'", [vendorId])).rows[0];
    const account = v && this.bank ? await this.bank.accountOf(v.address).catch(() => null) : null;
    this.accounts.set(vendorId, { account, at: this.now() });
    return account;
  }
  /** The call-out deposit: a tenth of the vendor's hourly rate, at least 0.1 HBAR. */
  async calloutDeposit(vendorId: string): Promise<bigint> {
    const v = (await this.db.query<{ hourly_rate: string | null }>("SELECT hourly_rate FROM vendors WHERE id = $1", [vendorId])).rows[0];
    const rate = v?.hourly_rate ? Number.parseFloat(v.hourly_rate) : 0;
    return BigInt(Math.max(TINYBAR / 10, Math.round((Number.isFinite(rate) ? rate : 0) * TINYBAR * 0.1)));
  }
  /** After the deposit is verified: reserve the slot. Settlement only happens if this succeeds. */
  async reserveCallout(vendorId: string, i: { assetId?: string; reason?: string; payer?: string | null }) {
    const v = (await this.db.query<{ id: string; site_id: string; company: string; response_minutes: number | null }>("SELECT id, site_id, company, response_minutes FROM vendors WHERE id = $1 AND status = 'approved'", [vendorId])).rows[0];
    if (!v) throw new HttpError(404, "No such vendor");
    const deposit = await this.calloutDeposit(vendorId);
    const slotBy = new Date(this.now() + (v.response_minutes ?? 240) * 60_000).toISOString();
    const id = newId("co");
    await this.db.query("INSERT INTO vendor_callouts (id, site_id, vendor_id, asset_id, reason, deposit, payer, slot_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      id,
      v.site_id,
      v.id,
      i.assetId ?? null,
      (i.reason ?? "").slice(0, 300),
      deposit.toString(),
      i.payer ?? null,
      slotBy,
    ]);
    return { reference: id, vendor: v.company, slotBy, deposit: deposit.toString() };
  }

  // ---------------------------------------------------------------- the treasury tops machines up
  /** Once a day, bring each active machine's balance back up to its budget. */
  async topUps(limit = 2): Promise<number> {
    if (!this.bank) return 0;
    const due = await this.db.query<WalletRow>(
      "SELECT * FROM machine_wallets WHERE status = 'active' AND account_id IS NOT NULL AND (last_topup_at IS NULL OR last_topup_at < $1) ORDER BY last_topup_at LIMIT " + limit,
      [new Date(this.now() - DAY_MS).toISOString()],
    );
    for (const w of due.rows) {
      try {
        const balance = await this.bank.balance(w.account_id!);
        const short = BigInt(w.daily_budget) - balance;
        const tx = short > 0n ? await this.bank.topUp(w.account_id!, short) : null;
        await this.db.query("UPDATE machine_wallets SET last_topup_at = $1, error = NULL, updated_at = now() WHERE asset_id = $2", [new Date(this.now()).toISOString(), w.asset_id]);
        if (tx) await this.rec.decide(w.site_id, { agent: "system:treasury", kind: "machine.topped_up", assetId: w.asset_id, summary: `Topped up ${w.account_id} by ${hbar(short)} to its daily budget of ${hbar(w.daily_budget)}`, data: { tx } });
      } catch (e) {
        await this.db.query("UPDATE machine_wallets SET error = $1, updated_at = now() WHERE asset_id = $2", [e instanceof Error ? e.message : String(e), w.asset_id]);
      }
    }
    return due.rows.length;
  }

  // ---------------------------------------------------------------- reads
  private async row(assetId: string): Promise<WalletRow | null> {
    return (await this.db.query<WalletRow>("SELECT *, last_topup_at::text AS last_topup_at FROM machine_wallets WHERE asset_id = $1", [assetId])).rows[0] ?? null;
  }

  async get(siteId: string, assetId: string): Promise<MachineWalletView | null> {
    const w = await this.row(assetId);
    if (!w || w.site_id !== siteId) return null;
    const purchases = await this.db.query<{ id: string; kind: PurchaseView["kind"]; seller: string; amount: string | null; tx_id: string | null; tx_url: string | null; audit_tx: string | null; incident_id: string | null; result_json: string | null; created_at: string }>(
      "SELECT id, kind, seller, amount, tx_id, tx_url, audit_tx, incident_id, result_json, created_at::text AS created_at FROM machine_purchases WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 20",
      [assetId],
    );
    const balance = w.account_id && this.bank ? await this.bank.balance(w.account_id).then(String).catch(() => null) : null;
    return {
      assetId,
      status: w.status,
      accountId: w.account_id,
      accountUrl: w.account_id && this.bank ? this.bank.accountUrl(w.account_id) : null,
      evmAddress: w.evm_address,
      dailyBudget: w.daily_budget,
      perCall: w.per_call,
      balance,
      lastTopUpAt: w.last_topup_at ? new Date(w.last_topup_at).toISOString() : null,
      error: w.error,
      purchases: purchases.rows.map((p) => ({
        id: p.id,
        kind: p.kind,
        seller: p.seller,
        amount: p.amount,
        txId: p.tx_id,
        txUrl: p.tx_url,
        auditTx: p.audit_tx,
        incidentId: p.incident_id,
        result: p.result_json ? JSON.parse(p.result_json) : null,
        at: new Date(p.created_at).toISOString(),
      })),
    };
  }
}
