import type { BodyProfile, BodySignal } from "../../server/src/edge/profiles.js";
import { Rng } from "./rng.js";

export type Execution = "READY" | "ACTIVE" | "FEED_HOLD";

/** A signal drifting away from nominal over a stage, until the machine's agent adjusts it back. */
interface Drift {
  signal: string;
  /** how far it goes over the whole stage, as a share of the way to its warn limit */
  share: number;
}

/**
 * The simulated process of a virtual machine: its counters, its execution state and its profile's signals. Signals
 * follow the profile (base, swing over a period, drift over a stage) with seeded noise; once in a while a stage brings a
 * drift toward a signal's warn limit, which the machine's agent can notice and adjust. Values are plausible, not measured.
 */
export class Process {
  parts: number;
  scrap: number;
  execution: Execution = "READY";
  /** 0–1 through the current stage, for drift */
  progress = 0;
  private drift: Drift | null = null;
  private adjusted = new Set<string>();
  private phase = new Map<string, number>();
  private noise: Rng;
  /** extra signals the body reports beside the profile: outcome values, a batch phase */
  extra = new Map<string, { value: number | null; text: string | null }>();

  constructor(
    readonly profile: BodyProfile,
    seed: string,
    counters: { parts: number; scrap: number } | null,
    private now: () => number = Date.now,
  ) {
    const rng = new Rng(seed, "process");
    for (const s of profile.signals) this.phase.set(s.name, rng.range(0, 2 * Math.PI));
    this.parts = counters?.parts ?? 1000 + rng.int(9000);
    this.scrap = counters?.scrap ?? 0;
    this.noise = new Rng(seed, "noise", this.now());
  }

  /** A new stage: maybe a drift, picked from the stage's own seed. */
  beginStage(rng: Rng) {
    this.adjusted.clear();
    this.progress = 0;
    const candidates = this.profile.signals.filter((s) => s.warn !== undefined);
    this.drift = candidates.length && rng.chance(0.2) ? { signal: rng.pick(candidates).name, share: rng.range(0.55, 0.9) } : null;
  }
  endStage() {
    this.drift = null;
    this.adjusted.clear();
  }
  /** The agent brings a signal back to nominal: its drift stops for the rest of the stage. */
  adjust(signal: string): boolean {
    if (!this.profile.signals.some((s) => s.name === signal)) return false;
    this.adjusted.add(signal);
    return true;
  }
  get drifting(): string | null {
    return this.drift && !this.adjusted.has(this.drift.signal) ? this.drift.signal : null;
  }

  value(s: BodySignal): number {
    const t = this.now() / 1000;
    const active = this.execution === "ACTIVE";
    let v = s.base + s.swing * Math.sin((2 * Math.PI * t) / (s.periodS ?? 300) + (this.phase.get(s.name) ?? 0)) + this.noise.normal(0, s.swing * 0.08);
    if (active) v += (s.drift ?? 0) * this.progress;
    else v = s.base - (s.base - (s.min ?? 0)) * 0.15 + (v - s.base) * 0.3;
    if (active && this.drift?.signal === s.name && !this.adjusted.has(s.name) && s.warn !== undefined) v += (s.warn - s.base) * this.drift.share * this.progress;
    if (s.min !== undefined) v = Math.max(s.min, v);
    if (s.alarm !== undefined) v = Math.min(v, s.alarm * 1.05);
    return Math.round(v * 1000) / 1000;
  }

  signals(): Record<string, number> {
    return Object.fromEntries(this.profile.signals.map((s) => [s.name, this.value(s)]));
  }

  /** Everything the machine reports now, as the gateway pushes it. */
  read(): { signal: string; value: number | null; text: string | null }[] {
    return [
      { signal: "execution", value: null, text: this.execution },
      { signal: "availability", value: null, text: "AVAILABLE" },
      { signal: "part_count", value: this.parts, text: null },
      { signal: "scrap", value: this.scrap, text: null },
      ...this.profile.signals.map((s) => ({ signal: s.name, value: this.value(s), text: null })),
      ...[...this.extra].map(([signal, x]) => ({ signal, ...x })),
    ];
  }
}
