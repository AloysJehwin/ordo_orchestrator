import type { Anomaly, SignalLimit, TelemetrySample } from "./types.js";

const MIN_DRIFT_SAMPLES = 30;
const DRIFT_Z = 6;
const DRIFT_FLOOR = 0.8;

export function slopePerMinute(xs: number[], ys: number[]): { slope: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, r2: 0 };
  return { slope: sxy / sxx, r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy) };
}

/**
 * Threshold and drift detection for one signal of one asset, against that asset's configured
 * limits. Only good-quality samples count: a sensor reporting "bad" never triggers an action.
 */
export function detect(samples: TelemetrySample[], signal: string, limit: SignalLimit): Anomaly | null {
  if (limit.warn === undefined && limit.alarm === undefined) return null;
  const good = samples.filter((s) => s.signal === signal && s.quality === "good");
  const last = good.at(-1);
  if (!last) return null;
  const window = good.slice(-20);
  const { slope } = slopePerMinute(window.map((s) => s.minute), window.map((s) => s.value));
  const trendPerHour = Math.round(slope * 60 * 1000) / 1000;
  const base = { assetId: last.assetId, signal, value: last.value, trendPerHour, minute: last.minute };

  if (limit.alarm !== undefined && last.value >= limit.alarm) return { ...base, limit: limit.alarm, level: "alarm", kind: "threshold" };
  if (limit.warn !== undefined && last.value >= limit.warn) return { ...base, limit: limit.warn, level: "warn", kind: "threshold" };

  const warn = limit.warn ?? limit.alarm!;
  if (good.length >= MIN_DRIFT_SAMPLES && last.value >= DRIFT_FLOOR * warn) {
    const base15 = good.slice(0, 15).map((s) => s.value);
    const recent = good.slice(-10).map((s) => s.value);
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const mb = mean(base15);
    const sd = Math.sqrt(base15.reduce((a, b) => a + (b - mb) ** 2, 0) / base15.length) || 1e-6;
    if ((mean(recent) - mb) / sd >= DRIFT_Z && slope > 0) return { ...base, limit: warn, level: "warn", kind: "drift" };
  }
  return null;
}

export function detectAll(samples: TelemetrySample[], limits: Record<string, SignalLimit>): Anomaly | null {
  const found = Object.entries(limits)
    .map(([signal, limit]) => detect(samples, signal, limit))
    .filter((a): a is Anomaly => a !== null);
  found.sort((a, b) => (a.level === b.level ? (a.kind === "threshold" ? -1 : 1) : a.level === "alarm" ? -1 : 1));
  return found[0] ?? null;
}
