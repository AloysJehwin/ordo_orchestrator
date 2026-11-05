import type { Outcome } from "../../server/src/domain/types.js";
import type { Rng } from "./rng.js";

export type Metric = Outcome["metric"];

/** The target band of a metric: a lower bound, an upper bound, or both. */
export function band(m: Metric): { lo: number | null; hi: number | null } {
  if (m.targetMax !== undefined) return { lo: m.target, hi: m.targetMax };
  if (m.op === ">=") return { lo: m.target, hi: null };
  if (m.op === "<=") return { lo: null, hi: m.target };
  return { lo: m.target, hi: m.target };
}
export function inSpec(m: Metric, v: number): boolean {
  const { lo, hi } = band(m);
  return (lo === null || v >= lo - 1e-9) && (hi === null || v <= hi + 1e-9);
}
/** A metric that counts things (defects, events, deviations): whole numbers. */
export function isCount(m: Metric): boolean {
  const unit = m.unit.trim().toLowerCase();
  return (unit === "" || unit === "count" || unit === "pcs" || unit === "events") && Number.isInteger(m.target) && (m.targetMax === undefined || Number.isInteger(m.targetMax));
}
/** How many decimals a value of this metric is read to. */
export function decimals(m: Metric): number {
  if (isCount(m)) return 0;
  const t = Math.max(Math.abs(m.target), Math.abs(m.targetMax ?? 0));
  if (t > 0 && t < 0.01) return Math.min(12, Math.ceil(-Math.log10(t)) + 2);
  return t >= 1000 ? 0 : t >= 100 ? 1 : t >= 1 ? 2 : 3;
}
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * The value an instrument reads for an outcome: inside the target band, or (when `out`) just outside it. Values stay
 * at or above zero (a zero-knowledge proof takes non-negative values), so a lower bound of zero cannot be missed.
 */
export function pickValue(m: Metric, rng: Rng, out: boolean): number {
  const { lo, hi } = band(m);
  const count = isCount(m);
  const scale = Math.max(Math.abs(m.target), Math.abs(m.targetMax ?? 0));
  const margin = count ? 1 : Math.max(scale * 0.06, scale > 0 ? 0 : 0.5, 10 ** -decimals(m));
  let v: number;
  if (lo !== null && hi !== null && hi > lo) {
    const span = hi - lo;
    v = out ? (rng.chance(0.5) || lo - span * 0.4 < 0 ? hi + span * rng.range(0.1, 0.4) : lo - span * rng.range(0.1, 0.4)) : lo + span * rng.range(0.2, 0.8);
  } else if (lo !== null && hi !== null) {
    v = out ? lo + margin * rng.range(0.6, 1.6) : lo;
  } else if (lo !== null) {
    v = out ? lo - margin * rng.range(0.6, 2) : lo + margin * rng.range(0.25, 1.8);
  } else {
    const h = hi!;
    if (out) v = count ? h + 1 + rng.int(2) : h + margin * rng.range(0.6, 2);
    else v = h <= 0 ? 0 : count ? rng.int(Math.floor(h) + 1) : h - margin * rng.range(0.3, 2.5);
  }
  v = Math.max(0, count ? Math.round(v) : round(v, decimals(m)));
  // rounding can land a value on the wrong side of its bound: nudge it back
  if (!out && !inSpec(m, v)) v = lo !== null ? Math.max(0, lo + (count ? 1 : 10 ** -decimals(m))) : Math.max(0, (hi ?? 0) - (count ? 0 : 10 ** -decimals(m)));
  return v;
}

export function fmt(v: number, m: Metric): string {
  const unit = m.unit.trim().toLowerCase() === "count" ? "" : m.unit;
  return `${v.toFixed(decimals(m))}${unit ? ` ${unit}` : ""}`;
}
export function targetText(m: Metric): string {
  const u = m.unit ? ` ${m.unit}` : "";
  if (m.targetMax !== undefined) return `${m.target} to ${m.targetMax}${u}`;
  return `${m.op === ">=" ? ">=" : m.op === "<=" ? "<=" : "="} ${m.target}${u}`;
}
