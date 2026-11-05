import type { Address, Hex } from "viem";
import type { Signatures, TypedSignature, User } from "../auth/auth.js";
import { budgetHash } from "../chain/schedule-body.js";
import type { TreasuryRail } from "../chain/treasury.js";
import { sigArg } from "../chain/trust.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import type { Role, TemplateSpec } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { newId } from "../plant/plant.js";
import { runBudget } from "./run-budget.js";
import type { Inbox } from "./inbox.js";
import { hbar } from "./machines.js";
import type { Recorder } from "./recorder.js";
import type { Templates } from "./templates.js";
import type { Trust } from "./trust.js";

const AGENT = "system:treasury";
/** A Hedera transfer carries at most 10 account amounts: the treasury's debit and nine credits. */
const MAX_CREDITS = 9;
/** How long after its expiry a schedule that did not run counts as lapsed (the mirror node lags a few seconds). */
const EXPIRY_GRACE_MS = 60_000;

type Kind = "run" | "topup";
type Status = "pending" | "approving" | "executed" | "expired" | "declined" | "failed" | "skipped";

interface Row {
  id: string;
  site_id: string;
  run_id: string;
  kind: Kind;
  stage_code: string | null;
  resource: string | null;
  treasury_account: string;
  credits_json: string;
  lines_json: string;
  total: string;
  budget_hash: string;
  memo: string;
  schedule_id: string | null;
  tx_id: string | null;
  expires_at: string;
  status: Status;
  error: string | null;
  reasoning: string | null;
  request_id: string | null;
  value_at_risk: string | null;
  device: string | null;
  asset_id: string | null;
  hcs_json: string | null;
  inbox_item_id: string | null;
  approved_by: string | null;
  signature_id: string | null;
  approve_tx: string | null;
  executed_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  held_at: string | null;
  created_at: string;
}
const COLS =
  "id, site_id, run_id, kind, stage_code, resource, treasury_account, credits_json, lines_json, total, budget_hash, memo, schedule_id, tx_id, expires_at::text, status, error, reasoning, request_id, value_at_risk, device, asset_id, hcs_json, inbox_item_id, approved_by, signature_id, approve_tx, executed_at::text, decided_by, decided_at::text, held_at::text, created_at::text";

/** a budget with its run's order and template */
const WITH_RUN = `SELECT ${COLS.split(", ").map((c) => `b.${c}`).join(", ")}, r.order_ref, tp.name AS template_name
  FROM budget_schedules b LEFT JOIN runs r ON r.id = b.run_id LEFT JOIN template_versions tv ON tv.id = r.template_version_id
  LEFT JOIN templates tp ON tp.id = tv.template_id`;

export interface Credit {
  accountId: string;
  amount: string;
  assetId: string;
  assetName: string;
  /** the stages whose resources this machine buys with it */
  stages: string[];
}
export interface BudgetLineView {
  stage: string;
  buyer: string;
  resource: string;
  label: string;
  qty: number;
  unit: string;
  maxPrice: number;
  tinybars: string;
  /** the buying stage's machine has a Hedera account to fund */
  funded: boolean;
  /** a top-up's purchase, as the machine reported it */
  reason?: "price_above_max" | "balance_short";
  detail?: string;
  vendorId?: string;
  sku?: string;
  priceTinybar?: string;
}
export interface BudgetView {
  id: string;
  kind: Kind;
  runId: string;
  orderRef: string | null;
  templateName: string | null;
  stageCode: string | null;
  resource: string | null;
  status: Status;
  treasuryAccount: string;
  credits: Credit[];
  lines: BudgetLineView[];
  total: string;
  budgetHash: string;
  /** what a manager signs (`budget.approve`): the schedule and the hash of its treasury and credits */
  entity: string | null;
  memo: string;
  scheduleId: string | null;
  scheduleUrl: string | null;
  txUrl: string | null;
  expiresAt: string;
  error: string | null;
  reasoning: string | null;
  requestId: string | null;
  valueAtRisk: string | null;
  device: string | null;
  assetId: string | null;
  hcs: { topicId: string; sequence: string; txId: string; url: string } | null;
  inboxItemId: string | null;
  approvedBy: string | null;
  approveTxUrl: string | null;
  executedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  heldAt: string | null;
  createdAt: string;
}
export interface TreasuryView {
  contract: string;
  contractUrl: string;
  keyAddress: string;
  keyContractId: string;
  keyUrl: string;
  accountId: string;
  accountUrl: string;
  balance: string | null;
  openedAt: string;
}
export interface BudgetsView {
  configured: boolean;
  /** why there are no budgets here, when there are none */
  note: string | null;
  contract: string | null;
  /** the org is registered in OrdoTrust (a treasury needs it) */
  registered: boolean;
  treasury: TreasuryView | null;
  budgets: BudgetView[];
  topups: BudgetView[];
}
/** A machine's over-budget report (edge/purchasing.ts OverBudget), with its reasoning, 0G request id and value at risk. */
export interface OverBudget {
  runId: string;
  /** the stage that consumes the resource */
  stage: string;
  resource: string;
  /** what the purchase costs */
  amountTinybar: string;
  reasoning: string;
  /** the 0G request behind the reasoning; absent when the machine runs without a 0G brain (its reasoning is then its own report) */
  requestId?: string;
  valueAtRisk?: string;
  reason?: "price_above_max" | "balance_short";
  /** the buying machine, when the device feeds more than one */
  assetId?: string;
  qty?: number;
  unit?: string;
  vendorId?: string;
  sku?: string;
  priceTinybar?: string;
  maxPriceTinybar?: string;
  balanceTinybar?: string | null;
  detail?: string;
}

/** `qty` units at `perUnit` tinybars each, rounded up (quantities to a millionth, as the storefront counts them) */
const priceOf = (perUnit: bigint, qty: number) => (perUnit * BigInt(Math.round(qty * 1e6)) + 999_999n) / 1_000_000n;

const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);

/**
 * Org treasuries and the budgets machines spend (OrdoTreasury on Hedera). Each org's treasury is a Hedera account
 * whose key is the org's own key contract, so HBAR leaves it only through a scheduled transfer a manager approved:
 *  - a run's budget: when a run starts, one schedule pays each of its machines what its stages' resources may cost;
 *  - a machine's top-up: a machine that finds a purchase over its balance explains why (its 0G reasoning goes to HCS
 *    before anything else), and Ordo schedules the shortfall.
 * The manager approves in the console with a `budget.approve` signature that OrdoTreasury checks before the org's key
 * signs the schedule (HIP-755); it then executes at once. Unapproved, it lapses at its expiry (HIP-423), and a stage
 * that waited on a top-up is held as not approved. With no treasury contract configured this does nothing.
 */
export class Budgets {
  /** today's cheapest offer per resource kind (tinybars per unit), so a run budget counts what machines will pay */
  offerPrices: ((siteId: string) => Promise<Map<string, bigint>>) | null = null;
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private inbox: Inbox,
    private engine: RunEngine,
    private templates: Templates,
    private trust: Trust,
    readonly rail: TreasuryRail | null,
    private opts: { marginPct: number; hours: number; seed: bigint; topUpMax: bigint },
    private now: () => number,
  ) {}

  get live() {
    return Boolean(this.rail && this.trust.chain);
  }
  private need(): TreasuryRail {
    if (!this.rail || !this.trust.chain) throw new HttpError(409, "Org treasuries need OrdoTreasury (TREASURY_CONTRACT_ADDRESS) and OrdoTrust on Hedera");
    return this.rail;
  }
  private manager(roles: Role[]) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager decides on the org's treasury");
  }

  // ---------------------------------------------------------------- the treasury
  private async treasuryRow(siteId: string) {
    return (
      (await this.db.query<{ contract: string; key_address: string; key_contract_id: string; account_id: string; created_at: string }>(
        "SELECT contract, key_address, key_contract_id, account_id, created_at::text FROM treasuries WHERE site_id = $1",
        [siteId],
      )).rows[0] ?? null
    );
  }

  /**
   * Open the org's treasury (a manager): the org's key contract in OrdoTreasury, then a Hedera account keyed to it,
   * seeded by the operator; or link an account already keyed to it (`setup:hedera treasury <site>`).
   */
  async open(siteId: string, user: User, roles: Role[], accountId?: string): Promise<BudgetsView> {
    this.manager(roles);
    const rail = this.need();
    if (await this.treasuryRow(siteId)) throw new HttpError(409, "This org already has a treasury");
    if (!(await this.trust.siteRegistered(siteId))) throw new HttpError(409, "Register the org on-chain first (Settings → On-chain): its managers' credentials approve its budgets");
    const key = await rail.openKey(siteId);
    let account: string;
    let tx: string | null = null;
    if (accountId) {
      const a = await rail.account(accountId);
      if (!a) throw new HttpError(404, `Hedera has no account ${accountId}`);
      if (a.keyContractId !== key.contractId) throw new HttpError(409, `${accountId}'s key is not this org's key contract (${key.contractId}), so OrdoTreasury could not sign for it`);
      account = accountId;
    } else {
      const opened = await rail.openAccount(key.contractId, this.opts.seed, `ordo:treasury:${siteId}`);
      [account, tx] = [opened.accountId, opened.tx];
    }
    await this.db.query("INSERT INTO treasuries (site_id, contract, key_address, key_contract_id, account_id, open_tx, opened_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      siteId,
      rail.contract,
      key.key.toLowerCase(),
      key.contractId,
      account,
      tx,
      user.address,
    ]);
    await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "treasury.opened",
      summary: `${accountId ? "Linked" : "Opened"} the org's treasury ${account}: its key is the contract ${key.contractId}, so HBAR leaves it only through schedules a manager approves`,
      data: { accountId: account, keyContract: key.key, keyContractId: key.contractId, contract: rail.contract, openSiteTx: key.tx, accountTx: tx, accountUrl: rail.accountUrl(account) },
    });
    return this.view(siteId);
  }

  // ---------------------------------------------------------------- views
  async view(siteId: string): Promise<BudgetsView> {
    const registered = await this.trust.siteRegistered(siteId).catch(() => false);
    if (!this.live) return { configured: false, note: "Org treasuries need OrdoTreasury (TREASURY_CONTRACT_ADDRESS) and OrdoTrust on Hedera", contract: null, registered, treasury: null, budgets: [], topups: [] };
    const rail = this.rail!;
    const t = await this.treasuryRow(siteId);
    const treasury: TreasuryView | null = t
      ? {
          contract: t.contract,
          contractUrl: rail.contractUrl(t.contract),
          keyAddress: t.key_address,
          keyContractId: t.key_contract_id,
          keyUrl: rail.contractUrl(t.key_contract_id),
          accountId: t.account_id,
          accountUrl: rail.accountUrl(t.account_id),
          balance: (await rail.account(t.account_id).catch(() => null))?.balance.toString() ?? null,
          openedAt: new Date(t.created_at).toISOString(),
        }
      : null;
    const views = (await this.db.query<Row & { order_ref: string | null; template_name: string | null }>(`${WITH_RUN} WHERE b.site_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [siteId])).rows.map((r) => this.toView(r));
    return {
      configured: true,
      note: t ? null : registered ? "Open the org's treasury to fund run budgets" : "Register the org on-chain, then open its treasury",
      contract: rail.contract,
      registered,
      treasury,
      budgets: views.filter((v) => v.kind === "run"),
      topups: views.filter((v) => v.kind === "topup"),
    };
  }

  private toView(r: Row & { order_ref?: string | null; template_name?: string | null }): BudgetView {
    const rail = this.rail;
    const hcs = r.hcs_json ? (JSON.parse(r.hcs_json) as { topicId: string; sequence: string; txId: string }) : null;
    return {
      id: r.id,
      kind: r.kind,
      runId: r.run_id,
      orderRef: r.order_ref ?? null,
      templateName: r.template_name ?? null,
      stageCode: r.stage_code,
      resource: r.resource,
      status: r.status,
      treasuryAccount: r.treasury_account,
      credits: JSON.parse(r.credits_json) as Credit[],
      lines: JSON.parse(r.lines_json) as BudgetLineView[],
      total: r.total,
      budgetHash: r.budget_hash,
      entity: r.schedule_id ? `${r.schedule_id}#${r.budget_hash}` : null,
      memo: r.memo,
      scheduleId: r.schedule_id,
      scheduleUrl: r.schedule_id && rail ? rail.scheduleUrl(r.schedule_id) : null,
      txUrl: r.tx_id && rail ? rail.txUrl(r.tx_id) : null,
      expiresAt: new Date(r.expires_at).toISOString(),
      error: r.error,
      reasoning: r.reasoning,
      requestId: r.request_id,
      valueAtRisk: r.value_at_risk,
      device: r.device,
      assetId: r.asset_id,
      hcs: hcs && rail ? { ...hcs, url: rail.txUrl(hcs.txId) } : null,
      inboxItemId: r.inbox_item_id,
      approvedBy: r.approved_by,
      approveTxUrl: r.approve_tx && this.trust.chain ? this.trust.chain.txUrl(r.approve_tx) : null,
      executedAt: iso(r.executed_at),
      decidedBy: r.decided_by,
      decidedAt: iso(r.decided_at),
      heldAt: iso(r.held_at),
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private async row(siteId: string, id: string): Promise<Row> {
    const r = (await this.db.query<Row>(`SELECT ${COLS} FROM budget_schedules WHERE id = $1 AND site_id = $2`, [id, siteId])).rows[0];
    if (!r) throw new HttpError(404, "No such budget");
    return r;
  }
  async get(siteId: string, id: string): Promise<BudgetView> {
    const r = (await this.db.query<Row & { order_ref: string | null; template_name: string | null }>(`${WITH_RUN} WHERE b.id = $1 AND b.site_id = $2`, [id, siteId])).rows[0];
    if (!r) throw new HttpError(404, "No such budget");
    return this.toView(r);
  }

  // ---------------------------------------------------------------- run budgets
  /**
   * The machine accounts a run's budget pays, from its stages' resources: run-budget.ts's budget (each resource's
   * quantity at its maxPrice, plus the margin), one credit per buying machine with an account.
   */
  private async plan(siteId: string, run: { id: string; quantity: number }, spec: TemplateSpec) {
    const bound = new Map((await this.db.query<{ code: string; asset_id: string | null }>("SELECT code, asset_id FROM stage_runs WHERE run_id = $1", [run.id])).rows.map((r) => [r.code, r.asset_id]));
    const assets = (await this.db.query<{ id: string; name: string; kind: string; account_id: string | null }>(
      "SELECT a.id, a.name, a.kind, w.account_id FROM assets a LEFT JOIN machine_wallets w ON w.asset_id = a.id AND w.status = 'active' WHERE a.site_id = $1 AND a.archived_at IS NULL ORDER BY a.name",
      [siteId],
    )).rows;
    const byId = new Map(assets.map((a) => [a.id, a]));
    // the machine that buys for a stage: the one bound to the buying stage, its pinned one, or a funded one of its kind
    // (the engine binds unpinned stages when they start, so a budget made at the start pays the likeliest machine)
    const machineOf = (code: string) => {
      const s = spec.stages.find((x) => x.code === code)!;
      const id = bound.get(code) ?? s.machine ?? assets.find((a) => a.kind === s.resourceKind && a.account_id)?.id ?? null;
      return id && byId.has(id) ? id : null;
    };
    const budget = runBudget(spec.stages, run.quantity, { marginPct: this.opts.marginPct, machineOf, offerPrices: this.offerPrices ? await this.offerPrices(siteId) : undefined });
    // the stages (that consume the resources) whose buying machine gets no credit
    const unfunded = new Set<string>();
    const credits = new Map<string, Credit>();
    for (const m of budget.machines) {
      const a = m.assetId ? byId.get(m.assetId) : undefined;
      if (!a?.account_id) {
        for (const s of m.stages) unfunded.add(s);
        continue;
      }
      const c = credits.get(a.account_id) ?? { accountId: a.account_id, amount: "0", assetId: a.id, assetName: a.name, stages: [] };
      c.amount = (BigInt(c.amount) + BigInt(m.totalTinybar)).toString();
      c.stages.push(...m.stages);
      credits.set(a.account_id, c);
    }
    const sorted = [...credits.values()].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    for (const c of sorted.slice(MAX_CREDITS)) for (const s of c.stages) unfunded.add(s);
    const funded = sorted.slice(0, MAX_CREDITS);
    const view: BudgetLineView[] = budget.stages.flatMap((s) =>
      s.lines.map((l) => ({ stage: s.code, buyer: s.buyer.stage, resource: l.key, label: l.label, qty: l.qty, unit: l.unit, maxPrice: l.maxPrice, tinybars: l.tinybar, funded: !unfunded.has(s.code) })),
    );
    return { credits: funded, lines: view };
  }

  /** Create the schedule and remember it; a failure is remembered too. */
  private async schedule(
    siteId: string,
    i: { runId: string; kind: Kind; treasury: string; credits: Credit[]; lines: BudgetLineView[]; memo: string; stageCode?: string; resource?: string; extra?: Partial<Record<"reasoning" | "request_id" | "value_at_risk" | "device" | "asset_id" | "hcs_json", string>> },
  ): Promise<string> {
    const rail = this.rail!;
    const id = newId("bud");
    const total = i.credits.reduce((s, c) => s + BigInt(c.amount), 0n);
    const hash = budgetHash(i.treasury, i.credits.map((c) => ({ accountId: c.accountId, amount: c.amount })));
    const expiresAt = new Date(this.now() + this.opts.hours * 3_600_000);
    let status: Status = total > 0n ? "pending" : "skipped";
    let error: string | null = total > 0n ? null : i.lines.length ? "No machine of this run has a Hedera account to fund: give its machines wallets" : "This run's stages consume no resources";
    let made: { scheduleId: string; txId: string } | null = null;
    if (status === "pending")
      try {
        made = await rail.schedule({ treasury: i.treasury, credits: i.credits.map((c) => ({ accountId: c.accountId, amount: BigInt(c.amount) })), memo: i.memo, expiresAt });
      } catch (e) {
        [status, error] = ["failed", e instanceof Error ? e.message : String(e)];
      }
    const x = i.extra ?? {};
    await this.db.query(
      `INSERT INTO budget_schedules (id, site_id, run_id, kind, stage_code, resource, treasury_account, credits_json, lines_json, total, budget_hash, memo, schedule_id, tx_id,
         expires_at, status, error, reasoning, request_id, value_at_risk, device, asset_id, hcs_json, next_check_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        id,
        siteId,
        i.runId,
        i.kind,
        i.stageCode ?? null,
        i.resource ?? null,
        i.treasury,
        JSON.stringify(i.credits),
        JSON.stringify(i.lines),
        total.toString(),
        hash,
        i.memo,
        made?.scheduleId ?? null,
        made?.txId ?? null,
        expiresAt.toISOString(),
        status,
        error,
        x.reasoning ?? null,
        x.request_id ?? null,
        x.value_at_risk ?? null,
        x.device ?? null,
        x.asset_id ?? null,
        x.hcs_json ?? null,
        new Date(this.now() + 120_000).toISOString(),
      ],
    );
    if (made)
      await this.rec.decide(siteId, {
        agent: AGENT,
        kind: i.kind === "run" ? "budget.scheduled" : "budget.topup_scheduled",
        runId: i.runId,
        stageCode: i.stageCode ?? null,
        summary: `${i.kind === "run" ? `${i.runId}'s budget` : `A top-up for ${i.resource} at ${i.stageCode}`}: ${hbar(total)} from the treasury to ${i.credits.map((c) => c.assetName).join(", ")}, waiting for a manager on Hedera schedule ${made.scheduleId} until ${expiresAt.toISOString()}`,
        data: { budgetId: id, scheduleId: made.scheduleId, transactionId: made.txId, url: rail.scheduleUrl(made.scheduleId), total: total.toString(), credits: i.credits, budgetHash: hash },
      });
    return id;
  }

  /**
   * Each running run of an org with a treasury gets one budget schedule, including runs that were running when it opened.
   * A budget that executed unfunded (the treasury could not pay) is scheduled again once the treasury covers it.
   */
  private runBudgetsBusy = false;
  private async runBudgets() {
    // one pass at a time: two overlapping ticks would both schedule the same run on Hedera before one could record it
    if (this.runBudgetsBusy) return;
    this.runBudgetsBusy = true;
    try {
      await this.runBudgetsPass();
    } finally {
      this.runBudgetsBusy = false;
    }
  }
  private async runBudgetsPass() {
    const runs = await this.db.query<{ id: string; site_id: string; quantity: number; template_version_id: string; account_id: string; unfunded: boolean }>(
      `SELECT r.id, r.site_id, r.quantity, r.template_version_id, t.account_id,
              EXISTS (SELECT 1 FROM budget_schedules b WHERE b.run_id = r.id AND b.kind = 'run') AS unfunded
       FROM runs r JOIN treasuries t ON t.site_id = r.site_id
       WHERE r.status = 'running' AND NOT EXISTS (
         SELECT 1 FROM budget_schedules b WHERE b.run_id = r.id AND b.kind = 'run' AND NOT (b.status = 'failed' AND b.executed_at IS NOT NULL))
       ORDER BY r.started_at LIMIT 5`,
    );
    for (const r of runs.rows) {
      const tpl = await this.templates.version(r.template_version_id);
      const p = await this.plan(r.site_id, { id: r.id, quantity: Number(r.quantity) }, tpl.spec);
      if (r.unfunded) {
        const need = p.credits.reduce((a, c) => a + BigInt(c.amount), 0n);
        const has = (await this.rail!.account(r.account_id).catch(() => null))?.balance ?? 0n;
        if (has < need) continue;
      }
      // another Ordo may have scheduled it meanwhile
      const live = await this.db.query("SELECT 1 FROM budget_schedules WHERE run_id = $1 AND kind = 'run' AND NOT (status = 'failed' AND executed_at IS NOT NULL)", [r.id]);
      if (live.rows.length) continue;
      await this.schedule(r.site_id, { runId: r.id, kind: "run", treasury: r.account_id, credits: p.credits, lines: p.lines, memo: `ordo:budget:${r.id}` });
    }
  }

  // ---------------------------------------------------------------- approval
  private waiting(r: Row) {
    if (r.status !== "pending" || !r.schedule_id) throw new HttpError(409, `This ${r.kind === "run" ? "budget" : "top-up"} is ${r.status}`);
    if (Date.parse(r.expires_at) <= this.now()) throw new HttpError(409, "This schedule has lapsed on Hedera");
    return { scheduleId: r.schedule_id, entity: `${r.schedule_id}#${r.budget_hash}` };
  }

  /** What the manager signs: `budget.approve` for the schedule and its credits, checked by OrdoTreasury. */
  async approveRequest(siteId: string, user: User, roles: Role[], id: string): Promise<TypedSignature> {
    this.manager(roles);
    const rail = this.need();
    const r = await this.row(siteId, id);
    const { entity } = this.waiting(r);
    const credits = JSON.parse(r.credits_json) as Credit[];
    return this.sigs.request(user, {
      action: "budget.approve",
      entity,
      meaning: `Pay ${hbar(r.total)} from the org's treasury ${r.treasury_account} to ${credits.map((c) => `${c.assetName} (${c.accountId}) ${hbar(c.amount)}`).join(", ")} for ${r.run_id}${r.kind === "topup" ? ` (top-up for ${r.resource})` : ""}`,
      comment: "",
      site: siteId,
      chainId: this.trust.chain!.cfg.chainId,
      verifyingContract: rail.contract,
    });
  }

  async approve(siteId: string, user: User, roles: Role[], id: string, proof: { nonce: string; signature: Hex }): Promise<BudgetView> {
    this.manager(roles);
    const rail = this.need();
    const r = await this.row(siteId, id);
    const { scheduleId, entity } = this.waiting(r);
    const sig = await this.db.tx((q) => this.sigs.consume(q, user, { action: "budget.approve", entity }, proof));
    const arg = sigArg(sig.typed, proof.signature);
    await this.db.query("UPDATE budget_schedules SET status = 'approving', approved_by = $1, signature_id = $2, error = NULL, updated_at = now() WHERE id = $3", [user.address, sig.id, id]);
    const relay = await this.trust.relay(siteId, "budget.approve", `budget_${id}`, { scheduleId, entity, sig: arg }, () => rail.approve(siteId, scheduleId, entity, arg), true, rail.contract);
    if (relay.status === "done") {
      await this.db.query("UPDATE budget_schedules SET approve_tx = $1, next_check_at = now(), updated_at = now() WHERE id = $2", [relay.txHash, id]);
      await this.rec.decide(siteId, {
        agent: `user:${user.address}`,
        kind: "budget.approved",
        runId: r.run_id,
        stageCode: r.stage_code,
        summary: `Approved ${hbar(r.total)} from the treasury (schedule ${scheduleId}); OrdoTreasury signed it with the org's key`,
        data: { budgetId: id, scheduleId, entity, signatureId: sig.id, txHash: relay.txHash },
      });
      await this.check(await this.row(siteId, id));
    } else {
      await this.db.query("UPDATE budget_schedules SET status = 'pending', error = $1, updated_at = now() WHERE id = $2", [relay.error ?? "The approval did not reach OrdoTreasury", id]);
    }
    return this.get(siteId, id);
  }

  /** Decline: delete the schedule (nothing moves); a stage that waited on a top-up is held as not approved. */
  async decline(siteId: string, user: User, roles: Role[], id: string, reason: string): Promise<BudgetView> {
    this.manager(roles);
    const rail = this.need();
    const r = await this.row(siteId, id);
    const { scheduleId } = this.waiting(r);
    await rail.cancel(scheduleId).catch((e: unknown) => {
      throw new HttpError(502, `Hedera did not delete schedule ${scheduleId}: ${e instanceof Error ? e.message : e}`);
    });
    await this.db.query("UPDATE budget_schedules SET status = 'declined', decided_by = $1, decided_at = now(), error = $2, updated_at = now() WHERE id = $3", [user.address, reason || null, id]);
    await this.settleInbox(r, "rejected", `Declined: ${reason || "no reason given"}`, user.address);
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "budget.declined", runId: r.run_id, stageCode: r.stage_code, summary: `Declined ${hbar(r.total)} from the treasury; deleted Hedera schedule ${scheduleId}`, reason: reason || null, data: { budgetId: id, scheduleId } });
    return this.get(siteId, id);
  }

  private async settleInbox(r: Row, status: "approved" | "rejected" | "expired", reason: string, by: string | null) {
    if (r.inbox_item_id)
      await this.db.query("UPDATE inbox_items SET status = $1, reason = $2, decided_by = $3, decided_at = now() WHERE id = $4 AND status = 'pending'", [status, reason, by, r.inbox_item_id]);
  }

  /** Read a schedule back from the mirror node: executed, deleted, or lapsed at its expiry. */
  private async check(r: Row) {
    const s = await this.rail!.read(r.schedule_id!).catch(() => null);
    const now = this.now();
    if (s?.executedAt && s.result && s.result !== "SUCCESS") {
      // approved and executed, but the treasury could not pay: nothing moved
      const why = s.result === "INSUFFICIENT_ACCOUNT_BALANCE" || s.result === "INSUFFICIENT_PAYER_BALANCE" ? `the treasury ${r.treasury_account} held less than ${hbar(r.total)}` : s.result;
      await this.db.query("UPDATE budget_schedules SET status = 'failed', executed_at = $1, error = $2, updated_at = now() WHERE id = $3", [s.executedAt, `Executed on Hedera, but the transfer failed: ${why}`, r.id]);
      await this.rec.decide(r.site_id, {
        agent: AGENT,
        kind: "budget.unfunded",
        runId: r.run_id,
        stageCode: r.stage_code,
        summary: `Hedera schedule ${r.schedule_id} executed at ${s.executedAt}, but its transfer failed (${s.result}): ${why}, so nothing moved.${r.kind === "run" ? " Fund the treasury and the run's budget is scheduled again." : ""}`,
        data: { budgetId: r.id, scheduleId: r.schedule_id, result: s.result },
      });
    } else if (s?.executedAt) {
      await this.db.query("UPDATE budget_schedules SET status = 'executed', executed_at = $1, updated_at = now() WHERE id = $2", [s.executedAt, r.id]);
      await this.settleInbox(r, "approved", `Executed on Hedera at ${s.executedAt}`, r.approved_by);
      await this.rec.decide(r.site_id, {
        agent: AGENT,
        kind: "budget.executed",
        runId: r.run_id,
        stageCode: r.stage_code,
        summary: `Hedera schedule ${r.schedule_id} executed at ${s.executedAt}: ${hbar(r.total)} moved from the treasury to the machines`,
        data: { budgetId: r.id, scheduleId: r.schedule_id, executedAt: s.executedAt },
      });
    } else if (s?.deleted) {
      await this.db.query("UPDATE budget_schedules SET status = 'declined', decided_at = COALESCE(decided_at, now()), updated_at = now() WHERE id = $1", [r.id]);
      await this.settleInbox(r, "rejected", "The schedule was deleted", null);
    } else if (now > Date.parse(r.expires_at) + EXPIRY_GRACE_MS) {
      await this.db.query("UPDATE budget_schedules SET status = 'expired', updated_at = now() WHERE id = $1", [r.id]);
      await this.settleInbox(r, "expired", "Not approved before the schedule lapsed", null);
      await this.rec.decide(r.site_id, {
        agent: AGENT,
        kind: "budget.expired",
        runId: r.run_id,
        stageCode: r.stage_code,
        summary: `Hedera schedule ${r.schedule_id} lapsed unapproved at ${new Date(r.expires_at).toISOString()}; nothing left the treasury`,
        data: { budgetId: r.id, scheduleId: r.schedule_id },
      });
    } else {
      // an approval in flight is read back every few seconds, a waiting one now and then (anyone may relay it), and
      // every schedule right after its expiry
      const next = Math.min(now + (r.status === "approving" ? 5_000 : 120_000), Date.parse(r.expires_at) + EXPIRY_GRACE_MS + 1_000);
      await this.db.query("UPDATE budget_schedules SET next_check_at = $1 WHERE id = $2", [new Date(next).toISOString(), r.id]);
    }
  }

  /** A stage that waited on a top-up that was declined or lapsed is held as not approved, once it starts. */
  private async holds() {
    const due = await this.db.query<Row & { state: string }>(
      `SELECT ${COLS.split(", ").map((c) => `b.${c}`).join(", ")}, sr.state FROM budget_schedules b
       JOIN stage_runs sr ON sr.run_id = b.run_id AND sr.code = b.stage_code JOIN runs r ON r.id = b.run_id
       WHERE b.kind = 'topup' AND b.status IN ('expired','declined') AND b.held_at IS NULL AND r.status = 'running' AND sr.state IN ('running','awaiting_approval')
         -- a later top-up for the same purchase that went through supersedes it
         AND NOT EXISTS (SELECT 1 FROM budget_schedules n WHERE n.run_id = b.run_id AND n.kind = 'topup' AND n.stage_code = b.stage_code AND n.resource = b.resource AND n.status = 'executed' AND n.created_at > b.created_at)`,
    );
    for (const r of due.rows) {
      const reason = `Not approved: the top-up for ${r.resource} (Hedera schedule ${r.schedule_id}) was ${r.status === "declined" ? "declined" : "not approved before it lapsed"}`;
      await this.engine.hold(r.site_id, AGENT, r.run_id, r.stage_code!, reason).catch((e) => console.error(`[ordo] budget hold ${r.run_id}/${r.stage_code}`, e));
      await this.db.query("UPDATE budget_schedules SET held_at = now() WHERE id = $1", [r.id]);
    }
  }

  /** One pass, from the engine cycle. */
  async reconcile() {
    if (!this.live) return;
    await this.runBudgets().catch((e) => console.error("[ordo] run budgets", e));
    const open = await this.db.query<Row>(`SELECT ${COLS} FROM budget_schedules WHERE status IN ('pending','approving') AND schedule_id IS NOT NULL AND next_check_at <= $1 ORDER BY next_check_at LIMIT 20`, [
      new Date(this.now()).toISOString(),
    ]);
    for (const r of open.rows) await this.check(r).catch((e) => console.error(`[ordo] budget ${r.id}`, e));
    await this.holds().catch((e) => console.error("[ordo] budget holds", e));
  }

  // ---------------------------------------------------------------- a machine over its budget
  /**
   * A machine whose purchase is over budget asks for a top-up: over its balance (`balance_short`), the shortfall; above
   * the stage's maxPrice (`price_above_max`), what it pays above what the stage allows, or the shortfall if that is more.
   * Its reasoning is written to HCS first, so it is consensus-timestamped before the schedule exists; then the top-up
   * is scheduled and a manager is asked.
   */
  async overBudget(device: Address, b: OverBudget): Promise<BudgetView> {
    const rail = this.need();
    const run = (await this.db.query<{ id: string; site_id: string; status: string; template_version_id: string }>("SELECT id, site_id, status, template_version_id FROM runs WHERE id = $1", [b.runId])).rows[0];
    if (!run || run.status !== "running") throw new HttpError(404, "No running run with that id");
    const t = await this.treasuryRow(run.site_id);
    // one request is one top-up (its 0G request id), and one purchase has at most one top-up waiting for a manager
    const dup = (
      await this.db.query<Row>(
        `SELECT ${COLS} FROM budget_schedules WHERE site_id = $1 AND kind = 'topup' AND (request_id = $2 OR run_id = $3 AND stage_code = $4 AND resource = $5 AND status IN ('pending','approving'))
         ORDER BY created_at DESC LIMIT 1`,
        [run.site_id, b.requestId ?? null, run.id, b.stage, b.resource],
      )
    ).rows[0];
    if (dup) return this.toView(dup);
    // the device is the data source of a machine of this run: bound to one of its stages, or pinned in its template
    const tpl = await this.templates.version(run.template_version_id);
    const stage = tpl.spec.stages.find((s) => s.code === b.stage);
    if (!stage) throw new HttpError(404, `The run has no stage ${b.stage}`);
    const resource = (stage.resources ?? []).find((r) => r.key === b.resource);
    if (!resource) throw new HttpError(400, `Stage ${b.stage} consumes no resource ${b.resource}`);
    const inRun = new Set([
      ...(await this.db.query<{ asset_id: string }>("SELECT asset_id FROM stage_runs WHERE run_id = $1 AND asset_id IS NOT NULL", [run.id])).rows.map((r) => r.asset_id),
      ...tpl.spec.stages.map((s) => s.machine).filter((m): m is string => Boolean(m)),
    ]);
    const mine = (await this.db.query<{ id: string; name: string; source_json: string; account_id: string | null }>(
      "SELECT a.id, a.name, a.source_json, w.account_id FROM assets a LEFT JOIN machine_wallets w ON w.asset_id = a.id AND w.status = 'active' WHERE a.site_id = $1 AND a.archived_at IS NULL",
      [run.site_id],
    )).rows.filter((a) => (JSON.parse(a.source_json) as { device?: string }).device?.toLowerCase() === device.toLowerCase() && inRun.has(a.id));
    const asset = b.assetId ? mine.find((a) => a.id === b.assetId) : (mine.find((a) => a.account_id) ?? mine[0]);
    if (!asset) throw new HttpError(403, b.assetId ? `${b.assetId} is not a machine of that run that this device feeds` : "This device is not the data source of a machine in that run");
    if (!asset.account_id) throw new HttpError(409, `${asset.name} has no Hedera account to top up`);
    if (!t) {
      // nothing to top it up from: tell the managers once, instead of the machine asking into the void
      await this.noTreasury(run, device, b, asset, resource.label).catch((e: Error) => console.error("[ordo] no-treasury notice", e.message));
      throw new HttpError(409, "This org has no treasury to top machines up from");
    }
    const amount = BigInt(b.amountTinybar);
    if (amount <= 0n) throw new HttpError(400, "The amount must be above zero");
    // the ledger's balance, not the machine's word for it
    const balance = (await rail.account(asset.account_id).catch(() => null))?.balance ?? (b.balanceTinybar ? BigInt(b.balanceTinybar) : 0n);
    // above maxPrice, the run budget funded only what the stage allows for it: the rest is the manager's to approve
    const allowed = b.reason === "price_above_max" ? priceOf(b.maxPriceTinybar ? BigInt(b.maxPriceTinybar) : BigInt(Math.round(resource.maxPrice * 1e8)), b.qty ?? resource.qty) : null;
    const shortfall = [amount - balance, allowed === null ? 0n : amount - allowed].reduce((a, x) => (x > a ? x : a), 0n);
    if (shortfall <= 0n)
      throw new HttpError(409, allowed === null ? `${asset.name}'s balance (${hbar(balance)}) already covers ${hbar(amount)}` : `${hbar(amount)} is within what the stage allows (${hbar(allowed)}) and ${asset.name}'s balance`);
    if (shortfall > this.opts.topUpMax) throw new HttpError(409, `A top-up is capped at ${hbar(this.opts.topUpMax)}; ${hbar(shortfall)} needs a run budget`);
    // the reasoning, consensus-timestamped on HCS before the schedule exists
    const hcs = await rail
      .audit({
        kind: "budget.overbudget",
        site: run.site_id,
        runId: run.id,
        stage: b.stage,
        resource: b.resource,
        reason: b.reason ?? "balance_short",
        amountTinybar: amount.toString(),
        balance: balance.toString(),
        allowed: allowed?.toString() ?? null,
        shortfall: shortfall.toString(),
        vendor: b.vendorId ?? null,
        sku: b.sku ?? null,
        reasoning: b.reasoning,
        // null: the machine runs without a 0G brain, and the reasoning is its own report of the facts
        requestId: b.requestId ?? null,
        valueAtRisk: b.valueAtRisk ?? null,
        device,
        asset: asset.id,
      })
      .catch((e: unknown) => {
        throw new HttpError(502, `The reasoning could not be written to HCS, so no top-up was scheduled: ${e instanceof Error ? e.message : e}`);
      });
    if (!hcs) throw new HttpError(409, "Over-budget top-ups write the machine's reasoning to HCS first: set HEDERA_TOPIC_ID");
    const credit: Credit = { accountId: asset.account_id, amount: shortfall.toString(), assetId: asset.id, assetName: asset.name, stages: [b.stage] };
    const line: BudgetLineView = {
      stage: b.stage,
      buyer: b.stage,
      resource: resource.key,
      label: resource.label,
      qty: b.qty ?? resource.qty,
      unit: b.unit ?? resource.unit,
      maxPrice: resource.maxPrice,
      tinybars: amount.toString(),
      funded: true,
      reason: b.reason ?? "balance_short",
      ...(b.detail ? { detail: b.detail } : {}),
      ...(b.vendorId ? { vendorId: b.vendorId } : {}),
      ...(b.sku ? { sku: b.sku } : {}),
      ...(b.priceTinybar ? { priceTinybar: b.priceTinybar } : {}),
    };
    const id = await this.schedule(run.site_id, {
      runId: run.id,
      kind: "topup",
      treasury: t.account_id,
      credits: [credit],
      lines: [line],
      memo: `ordo:topup:${run.id}:${b.stage}:${b.resource}`,
      stageCode: b.stage,
      resource: b.resource,
      extra: { reasoning: b.reasoning, ...(b.requestId ? { request_id: b.requestId } : {}), ...(b.valueAtRisk ? { value_at_risk: b.valueAtRisk } : {}), device: device.toLowerCase(), asset_id: asset.id, hcs_json: JSON.stringify(hcs) },
    });
    const v = await this.get(run.site_id, id);
    if (v.status === "pending") {
      const item = await this.inbox.raise(run.site_id, {
        kind: "approval",
        category: "Budget",
        title: `${asset.name} asks for ${hbar(shortfall)} more for ${resource.label}${b.reason === "price_above_max" ? " (above the stage's max price)" : ""}`,
        body: `${b.reasoning.slice(0, 600)}${b.reasoning.length > 600 ? "…" : ""}\nIts reasoning is on HCS (${hcs.topicId} #${hcs.sequence}), ${b.requestId ? `0G request ${b.requestId}` : "with no 0G request behind it (the machine runs without a 0G brain: it reports the facts)"}. Approve or decline the scheduled top-up in Finance → Machine budgets; unapproved, it lapses on Hedera at ${v.expiresAt} and ${b.stage} is held.`,
        agent: `device:${device.toLowerCase()}`,
        severity: "warn",
        runId: run.id,
        stageCode: b.stage,
        assetId: asset.id,
        metrics: [
          { label: "Shortfall", value: hbar(shortfall) },
          { label: "Price", value: hbar(amount) },
          { label: "Balance", value: hbar(balance) },
          ...(allowed === null ? [] : [{ label: "Stage allows", value: hbar(allowed) }]),
          { label: "Value at risk", value: b.valueAtRisk ?? "not stated" },
          { label: "Hedera schedule", value: v.scheduleId ?? "" },
        ],
        options: [{ label: "Review in Finance → Machine budgets", detail: "The top-up is approved there with a signature OrdoTreasury checks", action: { tool: "none", args: {} } }],
        recommended: null,
        confidence: null,
        requiredRole: "manager",
      });
      await this.db.query("UPDATE budget_schedules SET inbox_item_id = $1 WHERE id = $2", [item.id, id]);
    }
    return this.get(run.site_id, id);
  }
  /** A machine cannot pay for its stage's resources and the org has no treasury: one manager inbox item per purchase, saying how to fund it. */
  private async noTreasury(run: { id: string; site_id: string }, device: Address, b: OverBudget, asset: { id: string; name: string }, label: string) {
    const open = await this.db.query(
      "SELECT 1 FROM inbox_items WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 AND asset_id = $4 AND category = 'Budget' AND kind = 'exception' AND status = 'pending' AND title LIKE $5 LIMIT 1",
      [run.site_id, run.id, b.stage, asset.id, `%${label}%`],
    );
    if (open.rows.length) return;
    const registered = await this.trust.siteRegistered(run.site_id);
    const amount = BigInt(b.amountTinybar);
    const balance = b.balanceTinybar ? BigInt(b.balanceTinybar) : null;
    await this.inbox.raise(run.site_id, {
      kind: "exception",
      category: "Budget",
      title: `${asset.name} cannot pay for ${label}: this org has no treasury`,
      body: `${asset.name} needs ${hbar(amount)} for ${label} at stage ${b.stage} of ${run.id}${balance === null ? "" : ` and holds ${hbar(balance)}`}. Machines are funded from the org's treasury, which a manager's run budget pays out of: ${registered ? "open the treasury" : "register the org on-chain (Settings → On-chain), then open its treasury"} in Finance → Machine budgets, fund it, and approve ${run.id}'s budget. Until then stage ${b.stage} waits for its resources, unless a manager waives them in the stage's Resources.`,
      agent: `device:${device.toLowerCase()}`,
      severity: "warn",
      runId: run.id,
      stageCode: b.stage,
      assetId: asset.id,
      metrics: [
        { label: "Needs", value: hbar(amount) },
        ...(balance === null ? [] : [{ label: "Holds", value: hbar(balance) }]),
        { label: "Org on-chain", value: registered ? "registered" : "not registered" },
      ],
      options: [{ label: registered ? "Open the treasury in Finance → Machine budgets" : "Register the org in Settings → On-chain", detail: "Then fund the treasury and approve the run's budget", action: { tool: "none", args: {} } }],
      recommended: null,
      confidence: null,
      requiredRole: "manager",
    });
  }
}
