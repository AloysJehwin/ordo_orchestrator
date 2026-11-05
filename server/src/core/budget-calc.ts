import type { StageResource, TemplateSpec } from "../domain/types.js";
import { predecessors } from "../pipelines/graph.js";

/**
 * A run's budget: what its machines may spend on the resources its stages consume. Each resource costs at most
 * qty × maxPrice (qty per batch, or per unit of the run's quantity; maxPrice in HBAR per unit), plus a margin. The
 * machine of the stage before a stage buys its resources ahead (the first stage's own machine buys for it), so the
 * money goes to the buyer's account.
 *
 * Merge note: main's `core/run-budget.ts` (Batch 7) computes the same budget. Switch Budgets.plan to
 * `runBudget(spec.stages, quantity, { marginPct, machineOf })` and its `machines[].totalTinybar` (one credit per asset;
 * `stages[].lines` for the lines), then delete this file. The buyer rule here already matches it.
 */
export interface BudgetLine {
  /** the stage that consumes the resource */
  stage: string;
  /** the stage whose machine buys it */
  buyer: string;
  resource: string;
  label: string;
  kind: string;
  qty: number;
  unit: string;
  maxPrice: number;
  tinybars: bigint;
}

const TINYBARS = 100_000_000;

export const resourceTinybars = (r: StageResource, quantity: number): bigint => BigInt(Math.ceil(r.qty * (r.per === "unit" ? quantity : 1) * r.maxPrice * TINYBARS));

export function runBudget(spec: TemplateSpec, quantity: number, marginPct: number): { lines: BudgetLine[]; byBuyer: Map<string, bigint>; total: bigint } {
  const preds = predecessors(spec.stages);
  const lines: BudgetLine[] = [];
  for (const s of spec.stages) {
    // the first predecessor that runs on a machine, else the stage itself (as run-budget.ts)
    const buyer = (preds.get(s.code) ?? []).find((c) => spec.stages.find((x) => x.code === c)?.resourceKind !== "system") ?? s.code;
    for (const r of s.resources ?? []) lines.push({ stage: s.code, buyer, resource: r.key, label: r.label, kind: r.kind, qty: r.qty * (r.per === "unit" ? quantity : 1), unit: r.unit, maxPrice: r.maxPrice, tinybars: resourceTinybars(r, quantity) });
  }
  const margin = BigInt(Math.round((100 + marginPct) * 100));
  const byBuyer = new Map<string, bigint>();
  for (const l of lines) byBuyer.set(l.buyer, (byBuyer.get(l.buyer) ?? 0n) + l.tinybars);
  // the margin, rounded up, on each buyer's share
  for (const [k, v] of byBuyer) byBuyer.set(k, (v * margin + 9_999n) / 10_000n);
  return { lines, byBuyer, total: [...byBuyer.values()].reduce((a, b) => a + b, 0n) };
}
