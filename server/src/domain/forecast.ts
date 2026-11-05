import { slopePerMinute } from "./detector.js";
import type { Forecast, TelemetrySample } from "./types.js";

export const FORECAST_MODEL_ID = "trend-logit-v1";
export const LOGIT = { midpointHours: 6, scaleHours: 2 };

/** Linear trend on the last 30 good samples, projected to the signal's alarm limit. */
export function forecast(samples: TelemetrySample[], assetId: string, signal: string, failureLimit: number): Forecast {
  const good = samples.filter((s) => s.assetId === assetId && s.signal === signal && s.quality === "good").slice(-30);
  const last = good.at(-1);
  const { slope, r2 } = slopePerMinute(good.map((s) => s.minute), good.map((s) => s.value));
  let ttfHours: number | null;
  if (!last) ttfHours = null;
  else if (last.value >= failureLimit) ttfHours = 0;
  else if (slope > 1e-9) ttfHours = (failureLimit - last.value) / slope / 60;
  else ttfHours = null;
  const p = ttfHours === null ? 0.02 : 1 / (1 + Math.exp((ttfHours - LOGIT.midpointHours) / LOGIT.scaleHours));
  return {
    assetId,
    signal,
    failureLimit,
    ttfHours: ttfHours === null ? null : Math.round(ttfHours * 100) / 100,
    pFailure24h: Math.round(Math.min(0.98, Math.max(0.02, p)) * 100) / 100,
    confidence: Math.round((slope > 1e-9 ? Math.min(0.95, Math.max(0.3, r2)) : 0.5) * 100) / 100,
    modelId: FORECAST_MODEL_ID,
  };
}
