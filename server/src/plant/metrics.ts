import type { AssetKind, AssetStatus, DataSource, Quality } from "../domain/types.js";

export interface Point {
  ts: number; // epoch ms
  value: number | null;
  text: string | null;
  quality: Quality;
}

const RUNNING = new Set(["ACTIVE"]);
const STOPPED = new Set(["INTERRUPTED", "STOPPED", "FEED_HOLD", "PROGRAM_STOPPED", "OPTIONAL_STOP", "PROGRAM_COMPLETED"]);

/** Fraction of [from, to] the execution state was ACTIVE. Needs the last event before `from` to know the starting state. */
export function utilization(execution: Point[], from: number, to: number): number | null {
  const pts = execution.filter((p) => p.quality === "good" && p.text).sort((a, b) => a.ts - b.ts);
  if (!pts.length) return null;
  const before = pts.filter((p) => p.ts <= from).at(-1);
  const inside = pts.filter((p) => p.ts > from && p.ts <= to);
  if (!before && !inside.length) return null;
  let state = before?.text ?? null;
  let cursor = before ? from : inside[0]!.ts;
  let active = 0;
  for (const p of inside) {
    if (state && RUNNING.has(state)) active += p.ts - cursor;
    state = p.text;
    cursor = p.ts;
  }
  if (state && RUNNING.has(state)) active += to - cursor;
  const span = to - (before ? from : inside[0]!.ts);
  return span > 0 ? Math.round((active / span) * 1000) / 1000 : null;
}

/** Parts produced in the window: sum of positive part-count increments (counter resets are ignored). */
export function partsProduced(partCount: Point[], from: number, to: number): number | null {
  const pts = partCount.filter((p) => p.quality === "good" && p.value !== null).sort((a, b) => a.ts - b.ts);
  const before = pts.filter((p) => p.ts <= from).at(-1);
  const inside = pts.filter((p) => p.ts > from && p.ts <= to);
  if (!before && inside.length < 2) return inside.length ? 0 : null;
  let prev = before?.value ?? inside[0]!.value!;
  let total = 0;
  for (const p of inside) {
    const d = p.value! - prev;
    if (d > 0) total += d;
    prev = p.value!;
  }
  return total;
}

/** OEE = availability × performance × quality. Any unknown factor makes OEE unknown, never guessed. */
export function oee(input: { availability: number | null; parts: number | null; idealCycleS: number | null; activeSeconds: number | null; good: number | null; scrap: number | null }): number | null {
  const { availability, parts, idealCycleS, activeSeconds, good, scrap } = input;
  if (availability === null || parts === null || !idealCycleS || !activeSeconds || good === null || scrap === null || good + scrap === 0) return null;
  const performance = Math.min(1, (parts * idealCycleS) / activeSeconds);
  const quality = good / (good + scrap);
  return Math.round(availability * performance * quality * 1000) / 1000;
}

export function deriveStatus(input: {
  kind: AssetKind;
  source: DataSource;
  latest: Record<string, { value: number | null; text: string | null; ts: string; quality: Quality }>;
  lastDataAt: number | null;
  now: number;
  openIncidentSeverity: "warn" | "alarm" | null;
  sourceError: string | null;
}): { status: AssetStatus; detail: string } {
  const { latest, lastDataAt, now, source } = input;
  if (input.kind === "system") return { status: "running", detail: "Business system" };
  if (lastDataAt === null) return { status: "no_data", detail: source.type === "manual" ? "No readings recorded yet" : "Waiting for first data" };
  const staleMs = source.type === "mtconnect" ? Math.max(120_000, source.pollSeconds * 6_000) : 30 * 60_000;
  if (input.sourceError && now - lastDataAt > staleMs) return { status: "offline", detail: input.sourceError };
  if (now - lastDataAt > staleMs) return { status: "offline", detail: `No data for ${Math.round((now - lastDataAt) / 60_000)} min` };
  if (latest.availability?.text === "UNAVAILABLE") return { status: "offline", detail: "Controller unavailable" };
  const faults = Object.entries(latest).filter(([k, v]) => k.startsWith("condition.") && v.text === "FAULT");
  if (faults.length) return { status: "alarm", detail: `Fault: ${faults.map(([k]) => k.slice(10)).join(", ")}` };
  if (input.openIncidentSeverity === "alarm") return { status: "alarm", detail: "Limit exceeded" };
  if (input.openIncidentSeverity === "warn") return { status: "degraded", detail: "Trending toward a limit" };
  const exec = latest.execution?.text ?? latest.state?.text ?? null;
  if (exec && RUNNING.has(exec)) return { status: "running", detail: "Executing" };
  if (exec && STOPPED.has(exec)) return { status: "stopped", detail: exec.replaceAll("_", " ").toLowerCase() };
  if (exec) return { status: "idle", detail: exec.toLowerCase() };
  return { status: "running", detail: "Reporting" };
}
