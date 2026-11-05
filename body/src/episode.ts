import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetKind } from "../../server/src/domain/types.js";
import type { CaptureSpec } from "./media/capture.js";

/**
 * One line of a body's episode log. Every perception and decision carries the 0G request it came from; every capture
 * carries what it was rendered from, so `body replay` renders the same files again.
 */
export type Entry = { t: string; runId?: string; stage?: string } & (
  | { kind: "start"; seed: string; asset: string; machine: AssetKind; device: string; brain: "0g" | "none"; model: string | null; ffmpeg: string | null; hedera: string | null }
  | { kind: "stage"; event: "started" | "resumed" | "units_done" | "finished" | "held" | "released"; name: string; quantity?: number }
  | ({ kind: "capture"; sha256: string | null; previewSha256: string | null; mime: string | null; uploaded: boolean; version?: number; skipped?: string; error?: string } & Omit<CaptureSpec, "seed" | "asset" | "kind" | "device">)
  | { kind: "perception"; outcome: string; attempt: number; value: number | null; summary: string; anomaly: string | null; requestId: string | null; provider: string | null; teeVerified: boolean | null; model: string | null; ms: number }
  | { kind: "decision"; action: "continue" | "adjust" | "hold"; reason: string; signal: string | null; recapture: string | null; applied: string; requestId: string | null; provider: string | null; teeVerified: boolean | null; model: string | null; ms: number }
  | { kind: "hold"; reason: string; hold: "safe_stop" | "agent"; accepted: boolean; error?: string }
  | { kind: "brain_error"; error: string; consecutive: number }
  | { kind: "brain_back"; requestId: string | null }
  | { kind: "note"; text: string }
);
type Body<E> = E extends unknown ? Omit<E, "t"> : never;
export type NewEntry = Body<Entry>;

/** The body's header: what every capture in the log is rendered from besides the entry itself. */
export interface Header {
  seed: string;
  asset: string;
  machine: AssetKind;
  device: string;
}

/** An episode as Ordo keeps it: one run's stage on this machine, with the header replay needs. */
export interface EpisodeDoc extends Header {
  version: 1;
  runId: string | null;
  stage: string | null;
  entries: Entry[];
}

const MAX_KEEP = 20_000;

/**
 * The log: kept in memory and appended to `episode.jsonl` in the body's data directory (its own disk), from which
 * `body replay` reproduces the outputs. Ordo gets each stage's episode (`/v1/edge/episodes`) and copies it to 0G Storage.
 */
export class EpisodeLog {
  readonly entries: Entry[] = [];
  private file: string | null;

  constructor(
    readonly header: Header,
    dir: string | null,
    private now: () => number = Date.now,
  ) {
    this.file = null;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.file = join(dir, "episode.jsonl");
    }
  }

  add(e: NewEntry): Entry {
    const entry = { t: new Date(this.now()).toISOString(), ...e } as Entry;
    this.entries.push(entry);
    if (this.entries.length > MAX_KEEP) this.entries.splice(0, this.entries.length - MAX_KEEP);
    if (this.file) {
      try {
        appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
      } catch (err) {
        console.error(`[body] could not write the episode log: ${(err as Error).message}`);
        this.file = null;
      }
    }
    return entry;
  }

  /** One stage's episode: its entries, and the body's start and brain entries while it ran. */
  episode(runId: string, stage: string): EpisodeDoc {
    const entries = this.entries.filter((e) => (e.runId === runId && e.stage === stage) || e.kind === "start").slice(-4999);
    return { version: 1, ...this.header, runId, stage, entries };
  }

  /** The newest entries as JSON lines, at most `max` characters, for the agent to answer from. */
  tail(max = 24_000): string {
    const out: string[] = [];
    let n = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      // the capture's process signals are long and rarely asked about
      const line = JSON.stringify(e.kind === "capture" ? { ...e, signals: undefined } : e);
      if (n + line.length > max) break;
      out.push(line);
      n += line.length + 1;
    }
    return out.reverse().join("\n");
  }
}

/**
 * A log read back for replay: an episode as Ordo serves it (`{version, seed, …, entries}`) or the body's own
 * `episode.jsonl`, whose start entries carry the header.
 */
export function readLog(path: string): { header: Header | null; entries: Entry[] } {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("{") && !text.includes("\n{")) {
    const doc = JSON.parse(text) as Partial<EpisodeDoc> & { log?: EpisodeDoc };
    const d = (doc.entries ? doc : doc.log) as EpisodeDoc | undefined;
    if (!d?.entries) throw new Error("Not an episode log: no entries");
    return { header: d.seed ? { seed: d.seed, asset: d.asset, machine: d.machine, device: d.device } : null, entries: d.entries };
  }
  const entries = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Entry);
  const start = entries.find((e) => e.kind === "start") as Extract<Entry, { kind: "start" }> | undefined;
  return { header: start ? { seed: start.seed, asset: start.asset, machine: start.machine, device: start.device } : null, entries };
}
