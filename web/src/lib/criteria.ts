import type { Criterion, CriterionKind, SignalAgg } from "../types";

/** The console's side of the criteria vocabulary (the server's is server/src/pipelines/criteria.ts; keep them in step). */
export const KINDS: CriterionKind[] = ["yield", "scrap_pct", "defects_ppm", "cycle_time", "oee", "signal", "manual"];
export const KIND_LABEL: Record<CriterionKind, string> = {
  yield: "Yield %",
  scrap_pct: "Scrap %",
  defects_ppm: "Defects ppm",
  cycle_time: "Cycle time",
  oee: "OEE %",
  signal: "Measured signal",
  manual: "Confirmed by a person",
};
export const AGGS: SignalAgg[] = ["last", "min", "max", "mean", "envelope"];
export const AGG_LABEL: Record<SignalAgg, string> = { last: "Final value", min: "Minimum", max: "Maximum", mean: "Mean", envelope: "Stays within" };

/** What a criterion measures: as declared, or inferred from the label on older specs. */
export function kindOf(c: Criterion): CriterionKind {
  if (c.kind) return c.kind;
  const label = c.label.toLowerCase();
  if (/yield/.test(label)) return "yield";
  if (/^scrap/.test(label)) return "scrap_pct";
  if (/^defects/.test(label) && c.unit === "ppm") return "defects_ppm";
  if (/cycle time/.test(label)) return "cycle_time";
  if (/^oee/.test(label)) return "oee";
  return "manual";
}
const SIGN: Record<Criterion["op"], string> = { ">=": "≥", "<=": "≤", "==": "=" };
export function targetText(c: Criterion): string {
  const unit = c.unit ? ` ${c.unit}` : "";
  if (c.targetMax !== undefined) return `${c.target}–${c.targetMax}${unit}`;
  return `${SIGN[c.op]} ${c.abs ? "±" : ""}${c.target}${unit}`.trim();
}
export function bandOf(c: Criterion): { lo: number | null; hi: number | null } {
  if (c.targetMax !== undefined) return { lo: c.target, hi: c.targetMax };
  if (c.op === "==") return { lo: c.target, hi: c.target };
  if (c.op === ">=") return { lo: c.target, hi: null };
  return { lo: c.abs ? -c.target : null, hi: c.target };
}
export const signalsOf = (criteria: Criterion[]): string[] => [...new Set(criteria.filter((c) => kindOf(c) === "signal" && c.signal).map((c) => c.signal!))];

export const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
/** a bound or value as people read it: "35", "0.5", "37.25", "120.4" (trailing zeros dropped) */
export const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));

/** A linear domain that shows the band with room around it and always includes the values. */
export function bandDomain(lo: number | null, hi: number | null, values: number[]): [number, number] {
  const pts = [lo, hi, ...values].filter(isNum);
  if (!pts.length) return [0, 1];
  let a = Math.min(...pts);
  let b = Math.max(...pts);
  if (isNum(lo) && isNum(hi)) {
    const span = hi - lo || Math.abs(lo) * 0.1 || 1;
    a = Math.min(a, lo - span * 0.25);
    b = Math.max(b, hi + span * 0.25);
  } else if (isNum(lo)) {
    const span = Math.max(...values.map((v) => Math.abs(v - lo)), Math.abs(lo) * 0.1, 1);
    a = Math.min(a, lo - span * 0.5);
    b = Math.max(b, lo + span * 1.5);
  } else if (isNum(hi)) {
    const span = Math.max(...values.map((v) => Math.abs(hi - v)), Math.abs(hi) * 0.1, 1);
    a = Math.min(a, hi - span * 1.5);
    b = Math.max(b, hi + span * 0.5);
  }
  if (a === b) (a -= 1), (b += 1);
  return [a, b];
}
