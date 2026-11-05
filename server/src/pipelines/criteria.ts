import type { Criterion, CriterionKind, CriterionResult } from "../domain/types.js";

/** Aggregates of one signal over the stage window, from the stage's asset. */
export interface SignalStats {
  last: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  n: number;
}

export interface StageMeasurements {
  good: number;
  scrap: number;
  durationMin: number | null;
  activeOee: number | null;
  /** per signal name, what the asset reported over the stage window */
  signals?: Record<string, SignalStats>;
}
export type { CriterionResult };

/** What a criterion measures: as declared, or inferred from the label on older specs (yield, scrap, defects ppm, cycle time, OEE), else a person confirms it. */
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
const unitOf = (c: Criterion) => (c.unit ? ` ${c.unit}` : "");

/** The target as people read it: "≥ 95 %", "≤ ±2 °C", "35–39 °C". */
export function targetText(c: Criterion): string {
  if (c.targetMax !== undefined) return `${c.target}–${c.targetMax}${unitOf(c)}`;
  return `${SIGN[c.op]} ${c.abs ? "±" : ""}${c.target}${unitOf(c)}`.trim();
}

/** The acceptable region: where a value passes. An open end is null. */
export function bandOf(c: Criterion): { lo: number | null; hi: number | null } {
  if (c.targetMax !== undefined) return { lo: c.target, hi: c.targetMax };
  if (c.op === "==") return { lo: c.target, hi: c.target };
  if (c.op === ">=") return { lo: c.target, hi: null };
  return { lo: c.abs ? -c.target : null, hi: c.target };
}

/** The signals a stage's criteria read on its asset. */
export const signalsOf = (criteria: Criterion[]): string[] => [...new Set(criteria.filter((c) => kindOf(c) === "signal" && c.signal).map((c) => c.signal!))];

/** The constant part of a result: what the criterion is, before any value. */
function shape(c: Criterion): Omit<CriterionResult, "actual" | "ok"> {
  const kind = kindOf(c);
  return { label: c.label, kind, ...(c.signal ? { signal: c.signal } : {}), ...(kind === "signal" ? { agg: c.agg ?? "last" } : {}), unit: c.unit, target: targetText(c), band: bandOf(c) };
}

/** Results stored when a stage closed, in the shape newer clients expect (older rows have no kind, unit or band). */
export function reshape(criteria: Criterion[], stored: Partial<CriterionResult>[]): CriterionResult[] {
  return stored.map((r) => {
    const c = criteria.find((x) => x.label === r.label);
    const base = c ? shape(c) : { label: r.label ?? "", kind: "manual" as const, unit: "", target: r.target ?? "", band: { lo: null, hi: null } };
    return { ...base, ...r, actual: r.actual ?? null, ok: r.ok ?? null } as CriterionResult;
  });
}

const decimals = (v: number) => (Number.isInteger(v) ? 0 : Math.abs(v) >= 100 ? 1 : 2);
const fmt = (v: number, unit: string) => `${v.toFixed(decimals(v))}${unit ? ` ${unit}` : ""}`;
/** both ends of a window at the same precision: "33.90–38.00 °C", not "33.90–38 °C" */
const fmtPair = (a: number, b: number, unit: string) => {
  const d = Math.max(decimals(a), decimals(b));
  return `${a.toFixed(d)}–${b.toFixed(d)}${unit ? ` ${unit}` : ""}`;
};

function passes(v: number, c: Criterion): boolean {
  if (c.targetMax !== undefined) return v >= c.target && v <= c.targetMax;
  return c.op === ">=" ? v >= c.target : c.op === "<=" ? v <= c.target : v === c.target;
}

/**
 * Evaluate success criteria against what was actually measured: the stage's counts and time, its asset's OEE, and the
 * signals its criteria read over the stage window. A criterion with no measurement returns ok = null: a person must
 * confirm it, it is never assumed to pass.
 */
export function evaluateCriteria(criteria: Criterion[], m: StageMeasurements): CriterionResult[] {
  const total = m.good + m.scrap;
  return criteria.map((c) => {
    const base = shape(c);
    let value: number | null = null;
    let shown: string | null = null;
    let n: number | undefined;
    switch (base.kind) {
      case "yield":
        if (total > 0) (value = (m.good / total) * 100), (shown = `${value.toFixed(1)}%`);
        break;
      case "scrap_pct":
        if (total > 0) (value = (m.scrap / total) * 100), (shown = `${value.toFixed(2)}%`);
        break;
      case "defects_ppm":
        if (total > 0) (value = (m.scrap / total) * 1e6), (shown = `${Math.round(value)} ppm`);
        break;
      case "cycle_time":
        if (m.good > 0 && m.durationMin !== null) (value = c.unit === "s" ? (m.durationMin * 60) / m.good : m.durationMin / m.good), (shown = `${value.toFixed(c.unit === "s" ? 0 : 2)} ${c.unit}`.trim());
        break;
      case "oee":
        if (m.activeOee !== null) (value = m.activeOee * 100), (shown = `${value.toFixed(0)}%`);
        break;
      case "signal": {
        const st = c.signal ? m.signals?.[c.signal] : undefined;
        if (!st || !st.n) break;
        n = st.n;
        const agg = c.agg ?? "last";
        if (agg === "envelope") {
          if (st.min === null || st.max === null || c.targetMax === undefined) break;
          const ok = st.min >= c.target && st.max <= c.targetMax;
          return { ...base, actual: fmtPair(st.min, st.max, c.unit), ok, n, measured: { value: st.min, op: ">=", target: c.target }, measuredMax: { value: st.max, op: "<=", target: c.targetMax } };
        }
        value = st[agg];
        if (value !== null) shown = fmt(value, c.unit);
        break;
      }
      case "manual":
        break;
    }
    if (value === null) return { ...base, actual: null, ok: null };
    const v = c.abs ? Math.abs(value) : value;
    const range = c.targetMax !== undefined;
    return {
      ...base,
      actual: shown,
      ok: passes(v, c),
      ...(n !== undefined ? { n } : {}),
      measured: { value: v, op: range ? ">=" : c.op, target: c.target },
      ...(range ? { measuredMax: { value: v, op: "<=" as const, target: c.targetMax! } } : {}),
    };
  });
}
