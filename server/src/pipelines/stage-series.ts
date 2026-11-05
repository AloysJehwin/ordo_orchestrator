import type { Db } from "../db/db.js";
import type { StageRunView } from "../domain/types.js";
import type { PlantService } from "../plant/plant.js";
import { signalsOf } from "./criteria.js";

const MAX_POINTS = 120;

export interface SeriesPoint {
  ts: number;
  value: number;
}
export interface StageSeriesView {
  window: { from: string; to: string } | null;
  /** read live from the asset's telemetry (the stage is still running) rather than from the snapshot taken when it closed */
  live: boolean;
  signals: Record<string, SeriesPoint[]>;
}

/** Keep at most n points: the first of each bucket plus the series' minimum, maximum and last point, so the shape and its extremes survive. */
export function downsample(pts: SeriesPoint[], n = MAX_POINTS): SeriesPoint[] {
  if (pts.length <= n) return pts;
  const keep = new Set<number>();
  const step = pts.length / n;
  for (let i = 0; i < n; i++) keep.add(Math.floor(i * step));
  let lo = 0;
  let hi = 0;
  pts.forEach((p, i) => {
    if (p.value < pts[lo]!.value) lo = i;
    if (p.value > pts[hi]!.value) hi = i;
  });
  keep.add(lo);
  keep.add(hi);
  keep.add(pts.length - 1);
  return [...keep].sort((a, b) => a - b).map((i) => pts[i]!);
}

/**
 * What a stage's measured signals did over its window, kept with the run. Telemetry is retained for days; a lot's record
 * is kept for good, so when a stage's work finishes the series its criteria read are snapshotted here, downsampled.
 * The values are for signed-in users; the public passport never reads this table.
 */
export class StageSeries {
  constructor(
    private db: Db,
    private plant: PlantService,
    private now: () => number = Date.now,
  ) {}

  async capture(runId: string, code: string, assetId: string, signals: string[], fromMs: number, toMs: number): Promise<number> {
    let stored = 0;
    for (const signal of signals) {
      const pts = downsample(await this.plant.seriesBetween(assetId, signal, fromMs, toMs));
      for (let i = 0; i < pts.length; i += 200) {
        const chunk = pts.slice(i, i + 200);
        const params: unknown[] = [];
        const values = chunk.map((p, j) => {
          params.push(runId, code, signal, p.ts, p.value);
          const b = j * 5;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
        });
        const r = await this.db.query(`INSERT INTO stage_series (run_id, stage_code, signal, t_ms, value) VALUES ${values.join(",")} ON CONFLICT DO NOTHING RETURNING run_id`, params);
        stored += r.rows.length;
      }
    }
    return stored;
  }

  /** The series behind a stage's parameters: the snapshot once the stage's work is done, live telemetry before that. */
  async read(runId: string, stage: StageRunView): Promise<StageSeriesView> {
    const signals = signalsOf(stage.criteria);
    const out: StageSeriesView = { window: null, live: false, signals: {} };
    if (!signals.length || !stage.startedAt) return out;
    if (stage.workDoneAt) {
      out.window = { from: stage.startedAt, to: stage.workDoneAt };
      const r = await this.db.query<{ signal: string; t_ms: string; value: number }>("SELECT signal, t_ms::text, value FROM stage_series WHERE run_id = $1 AND stage_code = $2 ORDER BY signal, t_ms", [runId, stage.code]);
      for (const row of r.rows) (out.signals[row.signal] ??= []).push({ ts: Number(row.t_ms), value: Number(row.value) });
      return out;
    }
    if (!stage.assetId) return out;
    const from = Date.parse(stage.startedAt);
    const to = this.now();
    out.live = true;
    out.window = { from: stage.startedAt, to: new Date(to).toISOString() };
    for (const s of signals) out.signals[s] = downsample(await this.plant.seriesBetween(stage.assetId, s, from, to));
    return out;
  }
}
