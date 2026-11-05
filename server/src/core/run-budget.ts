import type { AssetKind, StageResource, StageSpec } from "../domain/types.js";
import { predecessors } from "../pipelines/graph.js";

/**
 * What a run may spend on the resources its stages consume, before anyone buys anything: for each resource its
 * quantity (per batch, or per unit of the run's quantity) at the most a machine may pay for it, plus a margin.
 * Pure arithmetic in tinybars, so the treasury can fund it (one transfer per machine) and anyone can recompute it.
 *
 * A stage's resources are bought ahead by the machine of the stage before it (its first predecessor that runs on a
 * machine); a first stage's own machine buys its own. That machine is the stage's `buyer`, and the budget is split by it.
 */
export const TINYBAR_PER_HBAR = 100_000_000n;
export const DEFAULT_MARGIN_PCT = 10;
/** quantities are counted to a millionth of their unit */
const QTY_SCALE = 1_000_000n;

/** HBAR (a decimal amount) to tinybars, rounded to the nearest tinybar. */
export const hbarToTinybar = (hbar: number | string): bigint => {
  const s = typeof hbar === "number" ? hbar.toFixed(8) : hbar.trim();
  const m = /^(\d+)(?:\.(\d{0,8})\d*)?$/.exec(s);
  if (!m) throw new Error(`Not an HBAR amount: ${hbar}`);
  return BigInt(m[1]!) * TINYBAR_PER_HBAR + BigInt((m[2] ?? "").padEnd(8, "0"));
};
/** Tinybars as HBAR, without trailing zeros: "0.25". */
export const tinybarToHbar = (tinybar: bigint | string): string => {
  const t = BigInt(tinybar);
  const neg = t < 0n;
  const a = neg ? -t : t;
  const frac = (a % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / TINYBAR_PER_HBAR}${frac ? `.${frac}` : ""}`;
};
/** A quantity rounded to a millionth, as the storefront and the gate count it. */
export const roundQty = (qty: number) => Math.round(qty * 1e6) / 1e6;
/** The price of `qty` units at `perUnit` tinybars each, rounded up to a whole tinybar. */
export const amountFor = (perUnit: bigint, qty: number): bigint => {
  const q = BigInt(Math.round(qty * Number(QTY_SCALE)));
  return (perUnit * q + QTY_SCALE - 1n) / QTY_SCALE;
};
/** How much of a resource a run consumes at a stage: per batch, or per unit of the run's quantity. */
export const resourceNeed = (r: Pick<StageResource, "qty" | "per">, quantity: number) => roundQty(r.qty * (r.per === "unit" ? Math.max(0, quantity) : 1));
const withMargin = (t: bigint, pct: number) => (t * BigInt(Math.round(pct * 100)) + 9_999n) / 10_000n;

export interface BudgetLine {
  key: string;
  label: string;
  kind: string;
  unit: string;
  /** the quantity the run consumes */
  qty: number;
  /** the most a machine may pay, HBAR per unit */
  maxPrice: number;
  /** qty × maxPrice, in tinybars */
  maxTinybar: string;
}
export interface BudgetBuyer {
  /** the machine that buys: the bound or pinned asset, null when the run has not bound one yet */
  assetId: string | null;
  /** the stage whose machine it is */
  stage: string;
  kind: AssetKind;
}
export interface StageBudget {
  code: string;
  name: string;
  buyer: BudgetBuyer;
  lines: BudgetLine[];
  subtotalTinybar: string;
}
export interface MachineBudget {
  /** the asset, or `stage:<code>` while the run has not bound a machine to that stage */
  key: string;
  assetId: string | null;
  kind: AssetKind;
  /** the stages whose resources it buys */
  stages: string[];
  subtotalTinybar: string;
  marginTinybar: string;
  totalTinybar: string;
}
export interface RunBudget {
  quantity: number;
  marginPct: number;
  subtotalTinybar: string;
  marginTinybar: string;
  totalTinybar: string;
  /** the same total in HBAR, for people */
  totalHbar: string;
  stages: StageBudget[];
  machines: MachineBudget[];
}

/**
 * A run's resource budget: Σ qty × (per unit ? quantity : 1) × maxPrice, plus `marginPct` (default 10 %), per stage
 * and per buying machine. `machineOf` names the asset a stage runs on (bound by the run, or pinned in the template).
 */
export function runBudget(stages: StageSpec[], quantity: number, opts: { marginPct?: number; machineOf?: (code: string) => string | null } = {}): RunBudget {
  const marginPct = Math.max(0, opts.marginPct ?? DEFAULT_MARGIN_PCT);
  const machineOf = opts.machineOf ?? ((code: string) => stages.find((s) => s.code === code)?.machine ?? null);
  const preds = predecessors(stages);
  const byCode = new Map(stages.map((s) => [s.code, s]));
  const out: StageBudget[] = [];
  const machines = new Map<string, { assetId: string | null; kind: AssetKind; stages: string[]; sub: bigint }>();
  for (const s of stages) {
    if (!s.resources.length) continue;
    const before = (preds.get(s.code) ?? []).map((c) => byCode.get(c)!).find((p) => p.resourceKind !== "system");
    const by = before ?? s;
    const buyer: BudgetBuyer = { assetId: machineOf(by.code), stage: by.code, kind: by.resourceKind };
    const lines = s.resources.map((r) => {
      const qty = resourceNeed(r, quantity);
      return { key: r.key, label: r.label, kind: r.kind, unit: r.unit, qty, maxPrice: r.maxPrice, maxTinybar: amountFor(hbarToTinybar(r.maxPrice), qty).toString() };
    });
    const sub = lines.reduce((a, l) => a + BigInt(l.maxTinybar), 0n);
    out.push({ code: s.code, name: s.name, buyer, lines, subtotalTinybar: sub.toString() });
    const key = buyer.assetId ?? `stage:${buyer.stage}`;
    const m = machines.get(key) ?? { assetId: buyer.assetId, kind: buyer.kind, stages: [], sub: 0n };
    m.stages.push(s.code);
    m.sub += sub;
    machines.set(key, m);
  }
  const perMachine: MachineBudget[] = [...machines.entries()].map(([key, m]) => {
    const margin = withMargin(m.sub, marginPct);
    return { key, assetId: m.assetId, kind: m.kind, stages: m.stages, subtotalTinybar: m.sub.toString(), marginTinybar: margin.toString(), totalTinybar: (m.sub + margin).toString() };
  });
  const subtotal = perMachine.reduce((a, m) => a + BigInt(m.subtotalTinybar), 0n);
  const margin = perMachine.reduce((a, m) => a + BigInt(m.marginTinybar), 0n);
  return {
    quantity,
    marginPct,
    subtotalTinybar: subtotal.toString(),
    marginTinybar: margin.toString(),
    totalTinybar: (subtotal + margin).toString(),
    totalHbar: tinybarToHbar(subtotal + margin),
    stages: out,
    machines: perMachine,
  };
}
