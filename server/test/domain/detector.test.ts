import { describe, expect, it } from "vitest";
import { detect, detectAll } from "../../src/domain/detector.js";
import { forecast } from "../../src/domain/forecast.js";
import type { TelemetrySample } from "../../src/domain/types.js";

const series = (values: number[], quality: TelemetrySample["quality"] = "good", signal = "vibration"): TelemetrySample[] =>
  values.map((value, i) => ({ assetId: "A1", signal, value, unit: "mm/s", minute: 1_000_000 + i, quality }));
const ramp = (from: number, step: number, n: number) => Array.from({ length: n }, (_, i) => from + step * i);

describe("detector with per-asset limits", () => {
  it("raises warn and alarm on thresholds", () => {
    expect(detect(series([1, 2, 4.6]), "vibration", { warn: 4.5, alarm: 7.1, unit: "mm/s" })?.level).toBe("warn");
    expect(detect(series([1, 2, 7.2]), "vibration", { warn: 4.5, alarm: 7.1, unit: "mm/s" })?.level).toBe("alarm");
  });
  it("ignores signals without limits and samples of bad quality", () => {
    expect(detect(series([9, 9, 9]), "vibration", { unit: "" })).toBeNull();
    expect(detect(series([9, 9, 9], "bad"), "vibration", { warn: 4.5, unit: "" })).toBeNull();
  });
  it("detects drift approaching the limit", () => {
    const s = series([...Array(20).fill(3.7), ...ramp(3.72, 0.02, 15)]);
    expect(detectAll(s, { vibration: { warn: 4.5, unit: "mm/s" } })?.kind).toBe("drift");
  });
  it("forecasts time to the alarm limit from the trend", () => {
    const f = forecast(series(ramp(4, 0.05, 30)), "A1", "vibration", 7.1);
    expect(f.ttfHours).toBeGreaterThan(0.5);
    expect(f.ttfHours).toBeLessThan(1.5);
    expect(f.confidence).toBeGreaterThan(0.9);
  });
});
