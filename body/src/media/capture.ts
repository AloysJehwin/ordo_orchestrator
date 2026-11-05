import type { AssetKind, Outcome } from "../../../server/src/domain/types.js";
import { fmt, type Metric } from "../metric.js";
import { Rng } from "../rng.js";
import { INK, Raster, WHITE, type RGB } from "./raster.js";

/**
 * Everything one capture is rendered from. It is all in the episode log, so `body replay` renders the same bytes:
 * the seed, the outcome, the attempt, the value the instrument read, when, and the process state at that moment.
 */
export interface CaptureSpec {
  seed: string;
  asset: string;
  kind: AssetKind;
  device: string;
  runId: string;
  stage: string;
  stageName: string;
  outcome: Pick<Outcome, "key" | "label" | "media" | "instrument" | "metric" | "required">;
  attempt: number;
  value: number;
  /** unix seconds */
  capturedAt: number;
  /** how far through the stage, 0–1 */
  progress: number;
  /** the process signals at the capture */
  signals: Record<string, number>;
}

export interface MediaFile {
  bytes: Uint8Array;
  mime: string;
  ext: string;
}
export interface Rendered {
  file: MediaFile;
  preview: MediaFile | null;
  /** the image the machine's agent reads: the file itself, or its spectrogram, keyframe, chart or page */
  perceive: Uint8Array;
}
export type RenderResult = Rendered | { skipped: string };

/** The random stream for one capture's pixels. */
export const renderRng = (c: CaptureSpec, part = "render") => new Rng(c.seed, c.asset, c.runId, c.stage, c.outcome.key, c.attempt, part);

export const words = (c: CaptureSpec) => `${c.outcome.label} ${c.outcome.instrument} ${c.outcome.metric.label}`.toLowerCase();
export const readout = (c: CaptureSpec, m: Metric = c.outcome.metric) => `${m.label}: ${fmt(c.value, m)}`;

const stamp = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace("T", " ");

/**
 * The strip every image a machine captures carries: the instrument and outcome above, and below, the machine, the lot
 * and stage, the capture time, and that the machine is simulated.
 */
export function chrome(r: Raster, c: CaptureSpec, top: RGB = INK, fg: RGB = WHITE) {
  r.rect(0, 0, r.w, 14, top);
  r.text(4, 4, `${c.outcome.instrument} · ${c.outcome.label}`.slice(0, Math.floor((r.w - 8) / 6)), fg);
  r.rect(0, r.h - 13, r.w, 13, top);
  r.text(4, r.h - 10, `${c.runId}/${c.stage} · ${stamp(c.capturedAt)}Z · SIMULATED MACHINE`.slice(0, Math.floor((r.w - 8) / 6)), fg);
}
