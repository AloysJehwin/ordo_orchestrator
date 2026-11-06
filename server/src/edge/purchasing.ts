/**
 * Look-ahead buying on the machine's side. Each cycle a machine's body asks Ordo (device-signed) what the stages after
 * its running stage still need, then buys each from the best vendor's offer over x402 with its own Hedera account:
 * the payment goes straight to the vendor, Ordo records it and answers with a delivery receipt it signs. What costs
 * more than the stage allows (maxPrice), or more than the machine holds, is not bought: it comes back as over budget,
 * for the treasury to fund (a scheduled top-up the manager approves) before the machine tries again. Once a top-up for
 * it has executed, Ordo counts the offer within budget up to the amount the manager approved (`offer.approvedTinybar`).
 */
import type { DeliveryView, NeededResource, NeededView } from "../core/resources.js";

/**
 * Pays over x402 from the machine's own account (chain/x402.ts X402Buyer). `maxTinybar` is what the plan says the
 * purchase costs: a buyer that honours it never pays more than that, whatever the 402 asks.
 */
export interface ResourceBuyer {
  post<T>(url: string, body: unknown, opts?: { maxTinybar?: bigint }): Promise<{ body: T; payment: { transaction: string; url: string; payer: string | null; network: string } | null }>;
}
/** Signs requests with the machine's device key (edge/gateway.ts Gateway). */
export interface EdgeClient {
  request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

export interface PurchaseAheadOptions {
  /** Ordo's base URL, where the storefront is */
  url: string;
  /** buy for this machine only (one of the device's assets); default: every machine of the device */
  assetId?: string;
  /** what the machine may spend this cycle, in tinybars; default: its balance as Ordo reports it */
  balance?: bigint;
  /** only plan: report what it would buy */
  dryRun?: boolean;
  log?: (line: string) => void;
}
export interface Bought {
  runId: string;
  stage: string;
  resource: string;
  qty: number;
  amountTinybar: string;
  vendorId: string;
  sku: string;
  purchaseId: string;
  txId: string | null;
  txUrl: string | null;
  receipt: DeliveryView["receipt"];
  /** above the stage's maxPrice, within a top-up the manager approved */
  approved: boolean;
}
export type OverBudgetReason = "price_above_max" | "balance_short";
/** A purchase the machine did not make: the treasury turns it into a scheduled top-up (`POST /v1/edge/overbudget`). */
export interface OverBudget {
  resource: string;
  amountTinybar: string;
  reason: OverBudgetReason;
  runId: string;
  stage: string;
  label: string;
  kind: string;
  qty: number;
  unit: string;
  assetId: string;
  /** the offer it would buy, and what the stage allows for it */
  vendorId: string;
  sku: string;
  priceTinybar: string;
  maxPriceTinybar: string;
  /** the machine's balance when it decided, in tinybars (null when unknown) */
  balanceTinybar: string | null;
  detail: string;
}
export interface PurchaseAheadResult {
  bought: Bought[];
  overBudget: OverBudget[];
  /** nothing sells it, or the purchase failed */
  skipped: { runId: string; stage: string; resource: string; reason: string }[];
}

const fmt = (t: bigint) => `${(Number(t) / 1e8).toFixed(8).replace(/\.?0+$/, "")} HBAR`;

/** One cycle of look-ahead buying. Never throws for one bad item: the rest are still bought. */
export async function purchaseAhead(gw: EdgeClient, buyer: ResourceBuyer, opts: PurchaseAheadOptions): Promise<PurchaseAheadResult> {
  const out: PurchaseAheadResult = { bought: [], overBudget: [], skipped: [] };
  const plan = await gw.request<NeededView>("GET", "/v1/edge/purchases/needed");
  const items = plan.needed.filter((n) => !opts.assetId || n.buyerAsset === opts.assetId);
  // what each machine can still spend this cycle
  const left = new Map<string, bigint | null>();
  const balanceOf = (assetId: string) => {
    if (!left.has(assetId)) {
      const w = plan.wallets.find((x) => x.assetId === assetId);
      left.set(assetId, opts.balance ?? (w?.balanceTinybar != null ? BigInt(w.balanceTinybar) : null));
    }
    return left.get(assetId)!;
  };
  const base = opts.url.replace(/\/$/, "");
  for (const n of items) {
    const tag = `${n.runId} · ${n.stage} · ${n.resource}`;
    if (!n.offer) {
      out.skipped.push({ runId: n.runId, stage: n.stage, resource: n.resource, reason: `No vendor sells ${n.kind}` });
      opts.log?.(`${tag}: no vendor sells ${n.kind}`);
      continue;
    }
    const amount = BigInt(n.offer.amountTinybar);
    const balance = balanceOf(n.buyerAsset);
    const over = (reason: OverBudgetReason, detail: string) => {
      out.overBudget.push({
        resource: n.resource,
        amountTinybar: amount.toString(),
        reason,
        runId: n.runId,
        stage: n.stage,
        label: n.label,
        kind: n.kind,
        qty: n.remaining,
        unit: n.unit,
        assetId: n.buyerAsset,
        vendorId: n.offer!.vendorId,
        sku: n.offer!.sku,
        priceTinybar: n.offer!.priceTinybar,
        maxPriceTinybar: n.maxPriceTinybar,
        balanceTinybar: balance === null ? null : balance.toString(),
        detail,
      });
      opts.log?.(`${tag}: over budget, ${detail}`);
    };
    // the machine's Buyer caps: more needs a manager to raise them (on the floor), not a top-up
    if (n.capOrderTinybar != null && amount > BigInt(n.capOrderTinybar)) {
      out.skipped.push({ runId: n.runId, stage: n.stage, resource: n.resource, reason: `${fmt(amount)} is over the machine's Buyer cap of ${fmt(BigInt(n.capOrderTinybar))} an order: a manager raises it on the floor` });
      opts.log?.(`${tag}: over the Buyer cap per order`);
      continue;
    }
    if (n.capDailyLeftTinybar != null && amount > BigInt(n.capDailyLeftTinybar)) {
      out.skipped.push({ runId: n.runId, stage: n.stage, resource: n.resource, reason: `${fmt(amount)} is more than the ${fmt(BigInt(n.capDailyLeftTinybar))} left of the machine's Buyer cap today` });
      opts.log?.(`${tag}: over the Buyer cap for today`);
      continue;
    }
    if (!n.offer.withinMax) {
      over("price_above_max", `${n.offer.vendor} asks ${n.offer.price} HBAR per ${n.unit || "unit"}, above the stage's ${n.maxPrice} HBAR`);
      continue;
    }
    if (balance !== null && amount > balance) {
      over("balance_short", `${n.remaining} ${n.unit} of ${n.label} costs ${fmt(amount)}; the machine holds ${fmt(balance)}`);
      continue;
    }
    // above the stage's maxPrice, but within a top-up a manager approved for it
    const approved = BigInt(n.offer.priceTinybar) > BigInt(n.maxPriceTinybar);
    if (opts.dryRun) {
      opts.log?.(`${tag}: would buy ${n.remaining} ${n.unit} from ${n.offer.vendor} for ${fmt(amount)}`);
      continue;
    }
    try {
      const r = await buyer.post<DeliveryView>(`${base}${n.offer.path}`, {}, { maxTinybar: amount });
      if (balance !== null) left.set(n.buyerAsset, balance - amount);
      out.bought.push({
        runId: n.runId,
        stage: n.stage,
        resource: n.resource,
        qty: r.body.qty,
        amountTinybar: r.body.amountTinybar,
        vendorId: n.offer.vendorId,
        sku: n.offer.sku,
        purchaseId: r.body.purchaseId,
        txId: r.body.txId ?? r.payment?.transaction ?? null,
        txUrl: r.body.txUrl ?? r.payment?.url ?? null,
        receipt: r.body.receipt,
        approved,
      });
      opts.log?.(`${tag}: bought ${r.body.qty} ${n.unit} from ${n.offer.vendor} for ${fmt(BigInt(r.body.amountTinybar))}${approved ? " (within the top-up a manager approved)" : ""}${r.body.txId ? ` (${r.body.txId})` : ""}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      out.skipped.push({ runId: n.runId, stage: n.stage, resource: n.resource, reason });
      opts.log?.(`${tag}: not bought: ${reason}`);
    }
  }
  return out;
}

export type { NeededResource, NeededView };
