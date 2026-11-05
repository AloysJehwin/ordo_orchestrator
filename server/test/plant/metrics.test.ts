import { describe, expect, it } from "vitest";
import { deriveStatus, oee, partsProduced, utilization, type Point } from "../../src/plant/metrics.js";

const ev = (ts: number, text: string): Point => ({ ts, value: null, text, quality: "good" });
const n = (ts: number, value: number): Point => ({ ts, value, text: null, quality: "good" });
const MIN = 60_000;

describe("asset metrics from real telemetry", () => {
  it("utilization is the ACTIVE share of the window", () => {
    const pts = [ev(-10 * MIN, "ACTIVE"), ev(30 * MIN, "READY"), ev(45 * MIN, "ACTIVE")];
    expect(utilization(pts, 0, 60 * MIN)).toBe(0.75);
    expect(utilization([], 0, 60 * MIN)).toBeNull();
  });
  it("parts produced ignores counter resets", () => {
    expect(partsProduced([n(-1, 100), n(10, 104), n(20, 110), n(30, 2), n(40, 5)], 0, 60)).toBe(13);
    expect(partsProduced([], 0, 60)).toBeNull();
  });
  it("OEE is unknown unless every factor is measured", () => {
    expect(oee({ availability: 0.8, parts: 100, idealCycleS: 30, activeSeconds: 3600, good: 98, scrap: 2 })).toBeCloseTo(0.8 * (3000 / 3600) * 0.98, 3);
    expect(oee({ availability: 0.8, parts: 100, idealCycleS: null, activeSeconds: 3600, good: 98, scrap: 2 })).toBeNull();
    expect(oee({ availability: 0.8, parts: 100, idealCycleS: 30, activeSeconds: 3600, good: null, scrap: null })).toBeNull();
  });
  it("status comes from execution, faults, freshness and open incidents", () => {
    const base = { kind: "cnc" as const, source: { type: "mtconnect" as const, agentUrl: "https://x.org", device: "M", pollSeconds: 10 }, now: 1_000_000, openIncidentSeverity: null, sourceError: null };
    const latest = (exec: string) => ({ execution: { value: null, text: exec, ts: "", quality: "good" as const } });
    expect(deriveStatus({ ...base, latest: latest("ACTIVE"), lastDataAt: 990_000 }).status).toBe("running");
    expect(deriveStatus({ ...base, latest: latest("READY"), lastDataAt: 990_000 }).status).toBe("idle");
    expect(deriveStatus({ ...base, latest: latest("FEED_HOLD"), lastDataAt: 990_000 }).status).toBe("stopped");
    expect(deriveStatus({ ...base, latest: latest("ACTIVE"), lastDataAt: 0 }).status).toBe("offline");
    expect(deriveStatus({ ...base, latest: {}, lastDataAt: null }).status).toBe("no_data");
    expect(deriveStatus({ ...base, latest: latest("ACTIVE"), lastDataAt: 990_000, openIncidentSeverity: "warn" }).status).toBe("degraded");
    expect(deriveStatus({ ...base, latest: { ...latest("ACTIVE"), "condition.spindle": { value: null, text: "FAULT", ts: "", quality: "good" } }, lastDataAt: 990_000 }).status).toBe("alarm");
  });
});
