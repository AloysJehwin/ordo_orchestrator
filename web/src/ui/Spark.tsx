import { isNum } from "../lib/criteria";

/**
 * A compact line chart. Dashed warn/alarm lines mark an asset's limits; `band` shades a criterion's acceptable region;
 * `window` fixes the time axis to a stage's window so a short stage does not stretch; `marker` is the point being judged.
 */
export function Spark({
  points,
  warn,
  alarm,
  unit,
  height = 64,
  band,
  marker,
  window,
}: {
  points: { ts: number; value: number | null }[];
  warn?: number;
  alarm?: number;
  unit?: string;
  height?: number;
  band?: { lo?: number | null; hi?: number | null };
  marker?: { ts: number; value: number; ok: boolean | null };
  window?: { from: number; to: number };
}) {
  const pts = points.filter((p): p is { ts: number; value: number } => p.value !== null);
  const w = 320;
  if (pts.length < 2) return <div className="spark-empty faint small">{pts.length ? `${pts[0]!.value}${unit ? ` ${unit}` : ""} · one reading` : "No numeric readings in this window"}</div>;
  const t0 = window?.from ?? pts[0]!.ts;
  const t1 = window?.to ?? pts.at(-1)!.ts;
  const vals = pts.map((p) => p.value);
  const lims = [warn, alarm, band?.lo, band?.hi].filter(isNum);
  const lo = Math.min(...vals, ...lims);
  const hi = Math.max(...vals, ...lims);
  const span = hi - lo || 1;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * (w - 4) + 2;
  const y = (v: number) => height - 4 - ((v - lo) / span) * (height - 8);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const bandTop = isNum(band?.hi) ? y(band.hi) : 0;
  const bandBottom = isNum(band?.lo) ? y(band.lo) : height;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label={`trend${band ? ", acceptable band shaded" : ""}`}>
      {band && (isNum(band.lo) || isNum(band.hi)) && <rect x={0} y={Math.min(bandTop, bandBottom)} width={w} height={Math.max(1, Math.abs(bandBottom - bandTop))} className="sp-band" />}
      {isNum(band?.lo) && <line x1={0} x2={w} y1={y(band.lo)} y2={y(band.lo)} className="sp-lim" />}
      {isNum(band?.hi) && <line x1={0} x2={w} y1={y(band.hi)} y2={y(band.hi)} className="sp-lim" />}
      {warn !== undefined && <line x1={0} x2={w} y1={y(warn)} y2={y(warn)} className="sp-warn" />}
      {alarm !== undefined && <line x1={0} x2={w} y1={y(alarm)} y2={y(alarm)} className="sp-alarm" />}
      <path d={d} className="sp-line" />
      {marker && (
        // a zero-length round-capped path: with a non-scaling stroke it stays a round dot however the chart is stretched
        <path d={`M${x(marker.ts).toFixed(1)},${y(marker.value).toFixed(1)} l0,0`} className={`sp-mark ${marker.ok === true ? "ok" : marker.ok === false ? "bad" : "na"}`}>
          <title>{`${marker.value}${unit ? ` ${unit}` : ""} · ${marker.ok === true ? "in spec" : marker.ok === false ? "out of spec" : "not judged"}`}</title>
        </path>
      )}
    </svg>
  );
}
