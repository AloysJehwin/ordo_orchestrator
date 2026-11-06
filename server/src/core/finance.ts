import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import type { User } from "../auth/auth.js";
import type { PartyBank } from "../chain/machine-bank.js";
import type { PayOnProofChain } from "../chain/payonproof.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import type { Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { newId } from "../plant/plant.js";
import type { Jobs } from "./jobs.js";
import { KeyBox } from "./keybox.js";
import type { Names } from "./names.js";
import type { Recorder } from "./recorder.js";

const JOB = { party: "finance.party", cashIn: "finance.cashin", fund: "finance.fund", offer: "finance.offer", take: "finance.take", waive: "finance.waive" } as const;
const DAY_S = 86_400;

export type PartyKind = "plant" | "customer" | "financier";
interface PartyRow {
  id: string;
  site_id: string;
  kind: PartyKind;
  name: string;
  account_id: string | null;
  evm_address: string | null;
  key_enc: string | null;
  status: "opening" | "active" | "failed";
  open_tx: string | null;
  error: string | null;
}
type OrderStatus = "funding" | "open" | "paid" | "refunded" | "failed";
interface OrderRow {
  id: string;
  site_id: string;
  package_id: string;
  run_id: string | null;
  customer_id: string;
  amount: string;
  expires_at: string;
  hold_id: string | null;
  chain_key: string | null;
  payee_id: string;
  ask: string;
  status: OrderStatus;
  txs_json: string;
  note: string | null;
  error: string | null;
  created_at: string;
}
interface Tx {
  kind: string;
  hash: string;
  url: string | null;
  at: string;
}

export interface PartyView {
  id: string;
  kind: PartyKind;
  name: string;
  status: PartyRow["status"];
  accountId: string | null;
  accountUrl: string | null;
  address: string | null;
  balance: string | null;
  error: string | null;
}
export interface FinanceOrderView {
  id: string;
  packageId: string;
  packageTitle: string;
  packageStatus: string;
  runId: string | null;
  customer: { id: string; name: string };
  payee: { id: string; name: string; kind: PartyKind };
  amount: string;
  ask: string | null;
  expiresAt: string;
  status: OrderStatus;
  holdId: string | null;
  key: string | null;
  txs: Tx[];
  note: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Pay on proof, with supply-chain finance. A customer pays for a lot in Ordo USD (a Stablecoin Studio stablecoin)
 * by locking the price in a hold that OrdoPayOnProof releases only when OrdoTrust records the lot's validation
 * release: three signatures by different people, the reviewer and approver staked validators. Before then, the
 * plant can sell that receivable to a financier at a discount and have the cash at once; the financier is paid in
 * full on proof. Ordo runs the parties' accounts here (each its own Hedera account and key, sealed at rest); every
 * step is a transaction its party signs, and the escrow rules are the contract's, not Ordo's.
 */
export class PayOnProof {
  private keys: KeyBox;
  /** ENS names: a customer's or financier's account memo is its name, so HashScan shows it */
  names: Pick<Names, "ensure"> | null = null;
  constructor(
    private db: Db,
    private rec: Recorder,
    private jobs: Jobs,
    readonly chain: PayOnProofChain | null,
    private bank: PartyBank | null,
    secret: string,
    private now: () => number,
  ) {
    this.keys = new KeyBox("finance-parties", secret);
    jobs.register(JOB.party, (_p, j) => this.openParty(j.ref));
    jobs.register(JOB.cashIn, (p: { partyId: string; amount: string; by: string }, j) => this.doCashIn(j.siteId!, p));
    jobs.register(JOB.fund, (_p, j) => this.fund(j.ref));
    jobs.register(JOB.offer, (p: { orderId: string; ask: string; by: string }) => this.doOffer(p));
    jobs.register(JOB.take, (p: { orderId: string; financierId: string; price: string; by: string }) => this.doTake(p));
    jobs.register(JOB.waive, (p: { orderId: string; by: string }) => this.doWaive(p));
  }

  get live() {
    return Boolean(this.chain && this.bank);
  }
  private get unit() {
    return { symbol: this.chain?.cfg.symbol ?? "OUSD", decimals: this.chain?.cfg.decimals ?? 6 };
  }
  private fmt(units: string | bigint) {
    return `${formatUnits(BigInt(units), this.unit.decimals)} ${this.unit.symbol}`;
  }
  private parse(amount: string): bigint {
    if (!/^\d+(\.\d+)?$/.test(amount)) throw new HttpError(400, `Amounts are in ${this.unit.symbol}, like 250 or 99.5`);
    let v: bigint;
    try {
      v = parseUnits(amount, this.unit.decimals);
    } catch {
      throw new HttpError(400, `At most ${this.unit.decimals} decimals`);
    }
    if (v <= 0n) throw new HttpError(400, "Amounts must be above zero");
    if (v >= 2n ** 63n) throw new HttpError(400, "Too large");
    return v;
  }
  private need(roles: Role[]) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager runs pay on proof");
    if (!this.live) throw new HttpError(409, "Pay on proof needs Ordo USD and OrdoPayOnProof (Hedera setup: stablecoin, payonproof)");
  }

  // ---------------------------------------------------------------- parties
  private async party(id: string, siteId?: string): Promise<PartyRow> {
    const p = (await this.db.query<PartyRow>("SELECT * FROM finance_parties WHERE id = $1", [id])).rows[0];
    if (!p || (siteId && p.site_id !== siteId)) throw new HttpError(404, "No such party");
    return p;
  }
  private keyOf(p: PartyRow): Hex {
    if (p.status !== "active" || !p.key_enc) throw new Error(`${p.name}'s account is not open yet`);
    return this.keys.unseal(p.key_enc) as Hex;
  }

  async addParty(siteId: string, user: User, roles: Role[], i: { kind: Exclude<PartyKind, "plant">; name: string }) {
    this.need(roles);
    return this.createParty(siteId, user, i.kind, i.name);
  }
  private async createParty(siteId: string, user: User, kind: PartyKind, name: string) {
    const id = newId("party");
    await this.db.query("INSERT INTO finance_parties (id, site_id, kind, name, status, created_by) VALUES ($1,$2,$3,$4,'opening',$5)", [id, siteId, kind, name, user.address]);
    await this.jobs.enqueue(siteId, JOB.party, id, {});
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "finance.party_added", summary: `${name} (${kind}) gets a Hedera account for Ordo USD`, data: { partyId: id, kind } });
    return id;
  }
  /** The plant's own account: where it is paid on proof */
  private async plantParty(siteId: string, user: User): Promise<string> {
    const p = (await this.db.query<{ id: string }>("SELECT id FROM finance_parties WHERE site_id = $1 AND kind = 'plant' AND status <> 'failed' LIMIT 1", [siteId])).rows[0];
    if (p) return p.id;
    const site = (await this.db.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0];
    return this.createParty(siteId, user, "plant", site?.name ?? "The plant");
  }

  private async openParty(id: string) {
    const p = await this.party(id);
    if (p.status !== "opening") return { skipped: "already open" };
    try {
      const name = p.kind === "plant" ? null : await this.names?.ensure(p.site_id, p.kind === "financier" ? "financier" : "customer", id).catch(() => null);
      const a = await this.bank!.open(name && name.length <= 100 ? name : `ordo:${p.kind}:${p.name}`);
      await this.db.query("UPDATE finance_parties SET account_id = $1, evm_address = $2, key_enc = $3, open_tx = $4, status = 'active', error = NULL WHERE id = $5", [
        a.accountId,
        a.evmAddress.toLowerCase(),
        this.keys.seal(a.key),
        a.tx,
        id,
      ]);
      await this.rec.decide(p.site_id, { agent: "system:treasury", kind: "finance.party_opened", summary: `${p.name} has its account${a.accountId ? ` ${a.accountId}` : ""} (${a.evmAddress})`, data: { partyId: id, accountId: a.accountId, address: a.evmAddress, tx: a.tx } });
      return { accountId: a.accountId, address: a.evmAddress };
    } catch (e) {
      await this.db.query("UPDATE finance_parties SET error = $1 WHERE id = $2", [e instanceof Error ? e.message : String(e), id]);
      throw e;
    }
  }

  /** Stablecoin Studio's cash-in: a customer's (or financier's) deposit, minted to its account as Ordo USD */
  async cashIn(siteId: string, user: User, roles: Role[], partyId: string, amount: string) {
    this.need(roles);
    const p = await this.party(partyId, siteId);
    const v = this.parse(amount);
    await this.jobs.enqueue(siteId, JOB.cashIn, newId("cashin"), { partyId: p.id, amount: v.toString(), by: user.address });
  }
  private async doCashIn(siteId: string, i: { partyId: string; amount: string; by: string }) {
    const p = await this.party(i.partyId);
    if (p.status !== "active") throw new Error(`${p.name}'s account is not open yet`);
    const hash = await this.chain!.cashIn(p.evm_address as Address, BigInt(i.amount));
    await this.rec.decide(siteId, { agent: `user:${i.by}`, kind: "finance.cash_in", summary: `${this.fmt(i.amount)} cashed in to ${p.name} (Stablecoin Studio)`, data: { partyId: p.id, amount: i.amount, tx: hash, txUrl: this.chain!.txUrl(hash) } });
    return { tx: hash };
  }

  // ---------------------------------------------------------------- orders
  private async order(id: string, siteId?: string): Promise<OrderRow> {
    const o = (await this.db.query<OrderRow>("SELECT *, expires_at::text AS expires_at, created_at::text AS created_at FROM finance_orders WHERE id = $1", [id])).rows[0];
    if (!o || (siteId && o.site_id !== siteId)) throw new HttpError(404, "No such order");
    return o;
  }
  private async log(o: OrderRow, kind: string, hash: string, set: Record<string, string | null> = {}) {
    const txs = [...(JSON.parse(o.txs_json) as Tx[]), { kind, hash, url: this.chain?.txUrl(hash) ?? null, at: new Date(this.now()).toISOString() }];
    const cols = Object.keys(set);
    await this.db.query(`UPDATE finance_orders SET txs_json = $1, ${cols.map((c, i) => `${c} = $${i + 3}, `).join("")}error = NULL, updated_at = now() WHERE id = $2`, [JSON.stringify(txs), o.id, ...cols.map((c) => set[c])]);
    o.txs_json = JSON.stringify(txs);
  }

  /** A customer pays for a lot on proof: the price is held until the lot's validation package is released on-chain. */
  async createOrder(siteId: string, user: User, roles: Role[], i: { packageId: string; customerId: string; amount: string; days: number }) {
    this.need(roles);
    const pkg = (await this.db.query<{ id: string; status: string; run_id: string | null; title: string; number: number }>("SELECT id, status, run_id, title, number FROM validation_packages WHERE id = $1 AND site_id = $2", [i.packageId, siteId])).rows[0];
    if (!pkg) throw new HttpError(404, "No such validation package");
    if (pkg.status === "released") throw new HttpError(409, "This package is already released: there is nothing left to prove");
    const customer = await this.party(i.customerId, siteId);
    if (customer.kind !== "customer") throw new HttpError(400, "Pick a customer to pay");
    const amount = this.parse(i.amount);
    const payee = await this.plantParty(siteId, user);
    const id = newId("pop");
    const expires = new Date((Math.floor(this.now() / 1000) + i.days * DAY_S) * 1000).toISOString();
    await this.db.query(
      "INSERT INTO finance_orders (id, site_id, package_id, run_id, customer_id, amount, expires_at, payee_id, ask, status, txs_json, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0','funding','[]',$9)",
      [id, siteId, pkg.id, pkg.run_id, customer.id, amount.toString(), expires, payee, user.address],
    );
    await this.jobs.enqueue(siteId, JOB.fund, id, {});
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "finance.order_created", runId: pkg.run_id ?? undefined, summary: `${customer.name} pays ${this.fmt(amount)} for VP-${pkg.number} ${pkg.title}, on proof, within ${i.days} days`, data: { orderId: id, packageId: pkg.id, amount: amount.toString() } });
    return this.get(siteId, id);
  }

  /** The customer's hold, committed to the terms, then the order opened on OrdoPayOnProof. Safe to retry. */
  private async fund(orderId: string) {
    const o = await this.order(orderId);
    if (o.status !== "funding") return { skipped: o.status };
    const [customer, payee] = await Promise.all([this.party(o.customer_id), this.party(o.payee_id)]);
    const payeeAddress = payee.evm_address as Address;
    if (!payeeAddress || payee.status !== "active") throw new Error(`${payee.name}'s account is not open yet`);
    try {
      if (!o.hold_id) {
        const data = await this.chain!.terms(o.site_id, o.package_id, payeeAddress);
        const h = await this.chain!.hold(this.keyOf(customer), BigInt(o.amount), Math.floor(Date.parse(o.expires_at) / 1000), data);
        await this.log(o, "hold", h.hash, { hold_id: h.holdId.toString() });
        o.hold_id = h.holdId.toString();
      }
      const r = await this.chain!.open(customer.evm_address as Address, BigInt(o.hold_id), o.site_id, o.package_id, payeeAddress);
      await this.log(o, "open", r.hash, { chain_key: r.key, status: "open" });
      await this.rec.decide(o.site_id, { agent: `finance:${customer.name}`, kind: "finance.order_funded", runId: o.run_id ?? undefined, summary: `${customer.name} holds ${this.fmt(o.amount)} for ${payee.name}, released only on proof`, data: { orderId: o.id, holdId: o.hold_id, key: r.key, txUrl: this.chain!.txUrl(r.hash) } });
      return { key: r.key };
    } catch (e) {
      await this.db.query("UPDATE finance_orders SET error = $1, updated_at = now() WHERE id = $2", [e instanceof Error ? e.message : String(e), o.id]);
      throw e;
    }
  }

  private async openOrder(siteId: string, id: string) {
    const o = await this.order(id, siteId);
    if (o.status !== "open" || !o.chain_key) throw new HttpError(409, `The order is ${o.status}`);
    return o;
  }

  /** The plant offers its receivable for sale at `ask` (less than the amount) */
  async offer(siteId: string, user: User, roles: Role[], id: string, ask: string) {
    this.need(roles);
    const o = await this.openOrder(siteId, id);
    const payee = await this.party(o.payee_id);
    if (payee.kind !== "plant") throw new HttpError(409, "The plant has sold this receivable");
    const v = ask === "0" ? 0n : this.parse(ask);
    if (v >= BigInt(o.amount)) throw new HttpError(400, "The asking price must be below the amount: it is the financier's discount");
    await this.jobs.enqueue(siteId, JOB.offer, newId("offer"), { orderId: o.id, ask: v.toString(), by: user.address });
  }
  private async doOffer(i: { orderId: string; ask: string; by: string }) {
    const o = await this.order(i.orderId);
    const payee = await this.party(o.payee_id);
    const hash = await this.chain!.offer(o.chain_key as Hex, BigInt(i.ask), this.keyOf(payee));
    await this.log(o, "offer", hash, { ask: i.ask });
    await this.rec.decide(o.site_id, { agent: `user:${i.by}`, kind: "finance.receivable_offered", runId: o.run_id ?? undefined, summary: i.ask === "0" ? `${payee.name} withdrew its receivable from sale` : `${payee.name} offers its ${this.fmt(o.amount)} receivable for ${this.fmt(i.ask)}`, data: { orderId: o.id, ask: i.ask } });
    return { tx: hash };
  }

  /** A financier buys the receivable at its asking price: the plant has the cash now */
  async take(siteId: string, user: User, roles: Role[], id: string, financierId: string) {
    this.need(roles);
    const o = await this.openOrder(siteId, id);
    const f = await this.party(financierId, siteId);
    if (f.kind !== "financier") throw new HttpError(400, "Pick a financier");
    if (o.ask === "0") throw new HttpError(409, "The receivable is not for sale");
    await this.jobs.enqueue(siteId, JOB.take, newId("take"), { orderId: o.id, financierId: f.id, price: o.ask, by: user.address });
  }
  private async doTake(i: { orderId: string; financierId: string; price: string; by: string }) {
    const o = await this.order(i.orderId);
    const [f, seller] = await Promise.all([this.party(i.financierId), this.party(o.payee_id)]);
    const hash = await this.chain!.take(o.chain_key as Hex, BigInt(i.price), this.keyOf(f));
    await this.log(o, "sale", hash, { payee_id: f.id, ask: "0" });
    await this.rec.decide(o.site_id, { agent: `finance:${f.name}`, kind: "finance.receivable_sold", runId: o.run_id ?? undefined, summary: `${f.name} bought ${seller.name}'s ${this.fmt(o.amount)} receivable for ${this.fmt(i.price)}: paid now, repaid on proof`, data: { orderId: o.id, price: i.price, txUrl: this.chain!.txUrl(hash) } });
    return { tx: hash };
  }

  /** The plant gives the payment up (a rejected lot): the customer's hold is released back to it */
  async waive(siteId: string, user: User, roles: Role[], id: string) {
    this.need(roles);
    const o = await this.openOrder(siteId, id);
    if ((await this.party(o.payee_id)).kind !== "plant") throw new HttpError(409, "The plant has sold this receivable: only its buyer can waive it");
    await this.jobs.enqueue(siteId, JOB.waive, o.id, { orderId: o.id, by: user.address });
  }
  private async doWaive(i: { orderId: string; by: string }) {
    const o = await this.order(i.orderId);
    if (o.status !== "open") return { skipped: o.status };
    const payee = await this.party(o.payee_id);
    const hash = await this.chain!.waive(o.chain_key as Hex, this.keyOf(payee));
    await this.log(o, "waive", hash, { status: "refunded" });
    await this.rec.decide(o.site_id, { agent: `user:${i.by}`, kind: "finance.refunded", runId: o.run_id ?? undefined, summary: `${payee.name} waived ${this.fmt(o.amount)}: the customer has it back`, data: { orderId: o.id, txUrl: this.chain!.txUrl(hash) } });
    return { tx: hash };
  }

  /**
   * In the engine cycle: pay open orders whose package is released on-chain (anyone may call settle, Ordo does),
   * and give expired ones back to the customer.
   */
  async reconcile(limit = 5): Promise<number> {
    if (!this.chain) return 0;
    const due = await this.db.query<OrderRow & { pkg_status: string }>(
      `SELECT o.*, o.expires_at::text AS expires_at, o.created_at::text AS created_at, p.status AS pkg_status FROM finance_orders o JOIN validation_packages p ON p.id = o.package_id
       WHERE o.status = 'open' AND (p.status = 'released' OR o.expires_at < $1) ORDER BY o.updated_at LIMIT ${limit}`,
      [new Date(this.now()).toISOString()],
    );
    let done = 0;
    for (const o of due.rows) {
      const key = o.chain_key as Hex;
      try {
        // an expired hold can no longer be paid out (Stablecoin Studio refuses to execute it): it goes back to the customer
        if (Date.parse(o.expires_at) < this.now()) {
          const hash = await this.chain.refundExpired(key);
          await this.log(o, "refund", hash, { status: "refunded", note: null });
          await this.rec.decide(o.site_id, { agent: "system:pay-on-proof", kind: "finance.refunded", runId: o.run_id ?? undefined, summary: `Not proven in time: ${this.fmt(o.amount)} back to the customer`, data: { orderId: o.id, txUrl: this.chain.txUrl(hash) } });
          done++;
        } else if ((await this.chain.releasedAt(key)) > 0) {
          const payee = await this.party(o.payee_id);
          const hash = await this.chain.settle(key);
          await this.log(o, "paid", hash, { status: "paid", note: null });
          await this.rec.decide(o.site_id, { agent: "system:pay-on-proof", kind: "finance.paid_on_proof", runId: o.run_id ?? undefined, summary: `The lot is proven: ${this.fmt(o.amount)} paid to ${payee.name} from the customer's hold`, data: { orderId: o.id, txUrl: this.chain.txUrl(hash) } });
          done++;
        } else {
          // released in Ordo, not yet on-chain: look again next cycle, after the other orders
          await this.db.query("UPDATE finance_orders SET note = $1, updated_at = now() WHERE id = $2", ["Released in Ordo; paid once OrdoTrust records the release on-chain", o.id]);
        }
      } catch (e) {
        await this.db.query("UPDATE finance_orders SET error = $1, updated_at = now() WHERE id = $2", [e instanceof Error ? e.message : String(e), o.id]);
      }
    }
    return done;
  }

  // ---------------------------------------------------------------- views
  private async partyView(p: PartyRow): Promise<PartyView> {
    const balance = p.status === "active" && p.evm_address && this.chain ? await this.chain.balanceOf(p.evm_address as Address).then((b) => b.toString(), () => null) : null;
    return { id: p.id, kind: p.kind, name: p.name, status: p.status, accountId: p.account_id, accountUrl: p.account_id ? (this.bank?.accountUrl(p.account_id) ?? null) : null, address: p.evm_address, balance, error: p.error };
  }

  async get(siteId: string, id: string): Promise<FinanceOrderView> {
    return (await this.orders(siteId, id))[0]!;
  }
  private async orders(siteId: string, id?: string): Promise<FinanceOrderView[]> {
    const r = await this.db.query<OrderRow & { pkg_title: string; pkg_number: number; pkg_status: string; customer_name: string; payee_name: string; payee_kind: PartyKind }>(
      `SELECT o.*, o.expires_at::text AS expires_at, o.created_at::text AS created_at, p.title AS pkg_title, p.number AS pkg_number, p.status AS pkg_status,
         c.name AS customer_name, y.name AS payee_name, y.kind AS payee_kind
       FROM finance_orders o JOIN validation_packages p ON p.id = o.package_id JOIN finance_parties c ON c.id = o.customer_id JOIN finance_parties y ON y.id = o.payee_id
       WHERE o.site_id = $1 ${id ? "AND o.id = $2" : ""} ORDER BY o.created_at DESC LIMIT 100`,
      id ? [siteId, id] : [siteId],
    );
    if (id && !r.rows[0]) throw new HttpError(404, "No such order");
    return r.rows.map((o) => ({
      id: o.id,
      packageId: o.package_id,
      packageTitle: `VP-${o.pkg_number} ${o.pkg_title}`,
      packageStatus: o.pkg_status,
      runId: o.run_id,
      customer: { id: o.customer_id, name: o.customer_name },
      payee: { id: o.payee_id, name: o.payee_name, kind: o.payee_kind },
      amount: o.amount,
      ask: o.ask === "0" ? null : o.ask,
      expiresAt: new Date(o.expires_at).toISOString(),
      status: o.status,
      holdId: o.hold_id,
      key: o.chain_key,
      txs: JSON.parse(o.txs_json) as Tx[],
      note: o.status === "open" ? o.note : null,
      error: o.error,
      createdAt: new Date(o.created_at).toISOString(),
    }));
  }

  async view(siteId: string) {
    const parties = (await this.db.query<PartyRow>("SELECT * FROM finance_parties WHERE site_id = $1 ORDER BY kind = 'plant' DESC, created_at", [siteId])).rows;
    const c = this.chain?.cfg;
    return {
      live: this.live,
      coin: c ? { symbol: c.symbol, decimals: c.decimals, address: c.coin, token: c.token, contract: c.address, studio: "Stablecoin Studio" } : null,
      parties: await Promise.all(parties.map((p) => this.partyView(p))),
      orders: await this.orders(siteId),
    };
  }
}
