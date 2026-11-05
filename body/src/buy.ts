import { X402Buyer, x402Network } from "../../server/src/chain/x402.js";
import { purchaseAhead, type EdgeClient, type OverBudget, type PurchaseAheadResult, type ResourceBuyer } from "../../server/src/edge/purchasing.js";
import type { Brain, BrainReply } from "./brain.js";
import type { NewEntry } from "./episode.js";

/** How often a running body buys ahead (it also does when a stage starts) */
export const BUY_EVERY_MS = 60_000;
/** A top-up request that Ordo did not schedule is asked again after this long */
const ASK_AGAIN_MS = 15 * 60_000;

type Network = NonNullable<ReturnType<typeof x402Network>>;

export interface BuyOptions {
  url: string;
  asset: string;
  /** the kind of machine, for its agent's prompt */
  kind: string;
  /** the machine's own Hedera account and its key; null: it buys nothing */
  account: { network: string; accountId: string; key: string } | null;
  brain: Brain | null;
  gw: EdgeClient;
  /** the stage the machine is working now, under which its purchases are logged */
  working: () => { runId: string; stage: string } | null;
  add: (e: NewEntry) => void;
  log: (line: string) => void;
  everyMs?: number;
}

const tb = (t: string | bigint) => `${(Number(t) / 1e8).toFixed(8).replace(/\.?0+$/, "")} HBAR`;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Pays each purchase over x402 from the machine's own account, never more than what Ordo's plan said it costs: the
 * spend control is set per payment to that amount, so a 402 asking for more is refused by the client.
 */
class MachineBuyer implements ResourceBuyer {
  constructor(private a: { network: Network; accountId: string; key: string }) {
    // the key parses now, not at the first purchase
    new X402Buyer({ network: a.network, agentId: a.accountId, agentKey: a.key, maxPerCall: 1n });
  }
  async post<T>(url: string, body: unknown, opts?: { maxTinybar?: bigint }) {
    if (!opts?.maxTinybar || opts.maxTinybar <= 0n) throw new Error("No quoted price to cap the payment at");
    return new X402Buyer({ network: this.a.network, agentId: this.a.accountId, agentKey: this.a.key, maxPerCall: opts.maxTinybar }).post<T>(url, body);
  }
}

/**
 * The body's buying ahead. Each cycle it asks Ordo what the stages after its running one (or its own stage waiting to
 * start) still need and buys it over x402 on Hedera from the machine's own account (server/src/edge/purchasing.ts).
 * What is over budget it asks the org's treasury to top up: its 0G agent writes the justification when it has one,
 * otherwise the request carries the facts and no 0G request id. Each purchase, skip and top-up request goes in the
 * episode log. One cycle at a time; a cycle never throws.
 */
export class Purchasing {
  private buyer: ResourceBuyer | null = null;
  private why: string | null = null;
  private running: Promise<void> | null = null;
  private last = 0;
  private lastError = "";
  private told = false;
  /** top-ups asked for, by run/stage/resource, until the purchase leaves the over-budget list */
  private asked = new Map<string, { at: number; ok: boolean }>();
  /** the last reason each purchase was skipped, so a skip is logged when it changes */
  private skipped = new Map<string, string>();

  constructor(private o: BuyOptions) {
    const a = o.account;
    if (!a) {
      this.why = "the machine has no Hedera account (MACHINE_ACCOUNT_ID and MACHINE_ACCOUNT_KEY unset)";
      return;
    }
    const network = x402Network(a.network);
    if (!network) {
      this.why = `HEDERA_NETWORK ${a.network} has no x402 network (testnet or mainnet)`;
      return;
    }
    try {
      this.buyer = new MachineBuyer({ network, accountId: a.accountId, key: a.key });
    } catch (e) {
      this.why = `the machine account's key does not parse (${(e as Error).message})`;
    }
  }

  get enabled() {
    return Boolean(this.buyer);
  }

  /** Buy ahead now (`force`, when a stage starts) or when a minute has passed since the last cycle; never two at once. */
  run(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.last < (this.o.everyMs ?? BUY_EVERY_MS)) return Promise.resolve();
    this.last = Date.now();
    this.running = this.cycle()
      .catch((e: Error) => this.o.log(`buying ahead failed: ${e.message}`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** The cycle in flight, if any (a stopping body waits for it). */
  settle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** a purchase's entry goes under the stage the machine is working, when it is of the same run */
  private place(runId: string, forStage: string) {
    const w = this.o.working();
    return { runId, stage: w && w.runId === runId ? w.stage : forStage, forStage };
  }

  private async cycle() {
    if (!this.buyer) {
      if (!this.told) {
        this.told = true;
        this.o.log(`not buying ahead: ${this.why}`);
        this.o.add({ kind: "note", text: `Not buying ahead: ${this.why}` });
      }
      return;
    }
    let r: PurchaseAheadResult;
    try {
      r = await purchaseAhead(this.o.gw, this.buyer, { url: this.o.url, assetId: this.o.asset });
      this.lastError = "";
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== this.lastError) this.o.log(`could not read what to buy ahead: ${msg}`);
      this.lastError = msg;
      return;
    }
    const keyOf = (x: { runId: string; stage: string; resource: string }) => `${x.runId}/${x.stage}/${x.resource}`;

    for (const b of r.bought) {
      this.skipped.delete(keyOf(b));
      this.asked.delete(keyOf(b));
      this.o.log(`${b.runId} · ${b.stage} · ${b.resource}: bought ${b.qty} (${b.sku}) from ${b.vendorId} for ${tb(b.amountTinybar)}${b.approved ? ", within an approved top-up" : ""}${b.txId ? ` (${b.txId})` : ""}`);
      this.o.add({
        kind: "purchase",
        event: "bought",
        ...this.place(b.runId, b.stage),
        resource: b.resource,
        qty: b.qty,
        amountTinybar: b.amountTinybar,
        vendorId: b.vendorId,
        sku: b.sku,
        purchaseId: b.purchaseId,
        txId: b.txId,
        txUrl: b.txUrl,
        approved: b.approved,
      });
    }

    const nowSkipped = new Set<string>();
    for (const s of r.skipped) {
      const k = keyOf(s);
      nowSkipped.add(k);
      if (this.skipped.get(k) === s.reason) continue;
      this.skipped.set(k, s.reason);
      this.o.log(`${s.runId} · ${s.stage} · ${s.resource}: not bought: ${s.reason}`);
      this.o.add({ kind: "purchase", event: "skipped", ...this.place(s.runId, s.stage), resource: s.resource, reason: s.reason.slice(0, 500) });
    }
    for (const k of [...this.skipped.keys()]) if (!nowSkipped.has(k)) this.skipped.delete(k);

    // a purchase no longer over budget (bought, or no longer needed) is resolved: a later one is asked about afresh
    const over = new Set(r.overBudget.map(keyOf));
    for (const k of [...this.asked.keys()]) if (!over.has(k)) this.asked.delete(k);
    for (const ob of r.overBudget) {
      const prior = this.asked.get(keyOf(ob));
      if (prior && (prior.ok || Date.now() - prior.at < ASK_AGAIN_MS)) continue;
      await this.askTopUp(ob);
    }
  }

  /** What the report says, as a sentence anyone can check against the stage and the offer. */
  private facts(ob: OverBudget) {
    const why =
      ob.reason === "price_above_max"
        ? `the best offer, ${ob.sku} from ${ob.vendorId} at ${tb(ob.priceTinybar)} per ${ob.unit || "unit"}, is above the stage's max price of ${tb(ob.maxPriceTinybar)}`
        : `it costs more than the machine holds (${ob.balanceTinybar === null ? "balance unknown" : tb(ob.balanceTinybar)})`;
    return `${ob.qty} ${ob.unit} of ${ob.label} for stage ${ob.stage} of run ${ob.runId} costs ${tb(ob.amountTinybar)}, and ${why}. Stage ${ob.stage} cannot start until it is bought.`;
  }

  /** Ask the treasury for a top-up: the agent's justification (or the facts, without a brain), then the device-signed report. */
  private async askTopUp(ob: OverBudget) {
    const facts = this.facts(ob);
    let reasoning = `No 0G brain on this machine, so this is its report of the facts: ${facts}`;
    let valueAtRisk: string | null = `Stage ${ob.stage} of ${ob.runId} waits for it`;
    let reply: BrainReply | null = null;
    if (this.o.brain) {
      try {
        reply = await this.o.brain.chat(
          [
            { role: "system", content: "You are the on-board agent of a machine in a factory pipeline. You buy what its next stages consume from its own Hedera account. Be factual and brief. Answer only with the JSON asked for." },
            {
              role: "user",
              content: [
                `You are the agent of a ${this.o.kind.replace("_", " ")}. A purchase is over budget, so you are asking the plant manager to approve a top-up from the org's treasury.`,
                facts,
                ob.detail,
                `Write two or three sentences the manager reads before approving: why this purchase is needed now and why the price or amount is reasonable. Then say in a few words what is at risk if it is not bought.`,
                `Answer with only JSON: {"reasoning": string, "valueAtRisk": string}.`,
              ].join("\n"),
            },
          ],
          300,
          45_000,
        );
      } catch (e) {
        // not asked yet: the next cycle tries again, once 0G answers
        this.o.log(`${ob.runId} · ${ob.stage} · ${ob.resource}: over budget, but 0G did not answer for the justification: ${(e as Error).message}`);
        return;
      }
      const j = reply.json ?? {};
      const said = str(j.reasoning, 3800) || reply.text.slice(0, 3800);
      reasoning = said.length >= 10 ? said : facts;
      valueAtRisk = str(j.valueAtRisk, 120) || valueAtRisk;
    }
    const zg = reply ? { requestId: reply.requestId, provider: reply.provider, teeVerified: reply.teeVerified, model: reply.model } : { requestId: null, provider: null, teeVerified: null, model: null };
    const entry = {
      kind: "purchase" as const,
      event: "over_budget" as const,
      ...this.place(ob.runId, ob.stage),
      resource: ob.resource,
      label: ob.label,
      qty: ob.qty,
      unit: ob.unit,
      amountTinybar: ob.amountTinybar,
      vendorId: ob.vendorId,
      sku: ob.sku,
      reason: ob.reason,
      detail: ob.detail,
      reasoning,
      valueAtRisk,
      ...zg,
    };
    try {
      const v = await this.o.gw.request<{ id: string; status: string; scheduleId: string | null; total: string; error: string | null }>("POST", "/v1/edge/overbudget", {
        ...ob,
        detail: ob.detail.slice(0, 500),
        reasoning,
        ...(zg.requestId ? { requestId: zg.requestId } : {}),
        ...(valueAtRisk ? { valueAtRisk: valueAtRisk.slice(0, 120) } : {}),
      });
      // a top-up that waits, ran, or a manager declined or let lapse is not asked for again; one that failed to schedule is, later
      this.asked.set(`${ob.runId}/${ob.stage}/${ob.resource}`, { at: Date.now(), ok: !["failed", "skipped"].includes(v.status) });
      this.o.add({ ...entry, topUp: { id: v.id, status: v.status, scheduleId: v.scheduleId, total: v.total }, ...(v.error ? { error: v.error } : {}) });
      this.o.log(`${ob.runId} · ${ob.stage} · ${ob.resource}: over budget (${ob.reason}); asked the treasury for ${tb(v.total)}: top-up ${v.id} ${v.status}${v.scheduleId ? ` (Hedera schedule ${v.scheduleId})` : ""}${v.error ? `: ${v.error}` : ""}`);
    } catch (e) {
      const msg = (e as Error).message;
      this.asked.set(`${ob.runId}/${ob.stage}/${ob.resource}`, { at: Date.now(), ok: false });
      this.o.add({ ...entry, topUp: null, error: msg.slice(0, 500) });
      this.o.log(`${ob.runId} · ${ob.stage} · ${ob.resource}: over budget (${ob.reason}); the top-up request was refused: ${msg}`);
    }
  }
}
