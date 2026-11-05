import { Raster, WHITE, type RGB } from "./raster.js";

export type Pt = [number, number];
export interface Series {
  name: string;
  pts: Pt[];
  color: RGB;
  dash?: number;
  width?: number;
  /** draw as bars from the bottom of the plot */
  bars?: boolean;
}
export interface Chart {
  xLabel: string;
  yLabel: string;
  x: [number, number];
  y: [number, number];
  xLog?: boolean;
  yLog?: boolean;
  /** draw x from high to low (infrared spectra) */
  xReversed?: boolean;
  series: Series[];
  /** horizontal lines: a limit, a tolerance */
  hlines?: { y: number; color: RGB; label?: string; dash?: number }[];
  marks?: { x: number; y: number; text: string; color: RGB }[];
}

export const PLOT = { x: 54, y: 30, w: 332, h: 206 };

const tickText = (v: number) => {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e6 || a < 1e-3) return v.toExponential(0).replace("e", "E");
  if (a >= 1000) return `${+(v / 1000).toFixed(1)}K`;
  return `${+v.toPrecision(3)}`;
};

function ticks(lo: number, hi: number, log: boolean): number[] {
  if (log) {
    const out: number[] = [];
    for (let e = Math.ceil(Math.log10(lo) - 1e-9); e <= Math.floor(Math.log10(hi) + 1e-9); e++) out.push(10 ** e);
    return out;
  }
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(10));
  return out;
}

/** A chart on a 400×300 raster: axes with ticks, the series, limit lines and marked points. */
export function drawChart(r: Raster, ch: Chart, fg: RGB = [210, 214, 224], grid: RGB = [44, 48, 60]) {
  const { x: px, y: py, w: pw, h: ph } = PLOT;
  const fx = (v: number) => {
    const t = ch.xLog ? (Math.log10(v) - Math.log10(ch.x[0])) / (Math.log10(ch.x[1]) - Math.log10(ch.x[0])) : (v - ch.x[0]) / (ch.x[1] - ch.x[0]);
    return px + (ch.xReversed ? 1 - t : t) * pw;
  };
  const fy = (v: number) => {
    const t = ch.yLog ? (Math.log10(Math.max(v, ch.y[0] * 1e-3)) - Math.log10(ch.y[0])) / (Math.log10(ch.y[1]) - Math.log10(ch.y[0])) : (v - ch.y[0]) / (ch.y[1] - ch.y[0]);
    return py + ph - Math.max(-0.02, Math.min(1.02, t)) * ph;
  };
  for (const t of ticks(ch.x[0], ch.x[1], Boolean(ch.xLog))) {
    const x = fx(t);
    r.line(x, py, x, py + ph, grid);
    r.line(x, py + ph, x, py + ph + 3, fg);
    const s = tickText(t);
    r.text(x - Raster.textWidth(s) / 2, py + ph + 6, s, fg);
  }
  for (const t of ticks(ch.y[0], ch.y[1], Boolean(ch.yLog))) {
    const y = fy(t);
    r.line(px, y, px + pw, y, grid);
    r.line(px - 3, y, px, y, fg);
    const s = tickText(t);
    r.text(px - 5 - Raster.textWidth(s), y - 3, s, fg);
  }
  r.frame(px, py, pw, ph, fg);
  r.text(px + pw - Raster.textWidth(ch.xLabel), py + ph + 16, ch.xLabel, fg);
  r.text(4, py - 10, ch.yLabel, fg);
  for (const s of ch.series) {
    if (s.bars) {
      for (const [x, y] of s.pts) r.rect(fx(x) - 2, fy(y), 4, py + ph - fy(y), s.color, 0.9);
      continue;
    }
    for (let i = 1; i < s.pts.length; i++) {
      const [a, b] = [s.pts[i - 1]!, s.pts[i]!];
      r.line(fx(a[0]), fy(a[1]), fx(b[0]), fy(b[1]), s.color, s.width ?? 1, s.dash ?? 0);
    }
  }
  for (const h of ch.hlines ?? []) {
    r.line(px, fy(h.y), px + pw, fy(h.y), h.color, 1, h.dash ?? 0);
    if (h.label) r.text(px + pw - Raster.textWidth(h.label) - 4, fy(h.y) - 10, h.label, h.color);
  }
  for (const m of ch.marks ?? []) {
    const [x, y] = [fx(m.x), fy(m.y)];
    r.ring(x, y, 4, m.color, 1.5);
    const w = Raster.textWidth(m.text);
    r.label(Math.min(px + pw - w - 8, Math.max(px + 2, x - w / 2)), Math.max(py + 2, y - 18), m.text, m.color, [0, 0, 0], 1, 2, 0.6);
  }
  // a legend for named series
  let lx = px + 6;
  for (const s of ch.series.filter((x) => x.name)) {
    r.line(lx, py + 8, lx + 12, py + 8, s.color, 2, s.dash ?? 0);
    r.text(lx + 16, py + 5, s.name, WHITE);
    lx += 24 + Raster.textWidth(s.name);
  }
}

/** The chart's data as CSV: x, the measured series, and the reference when there is one, at the measured series' points. */
export function chartCsv(ch: Chart, head: string): string {
  const [m, ref] = ch.series;
  const lines = [`# ${head.replace(/\n/g, " ")}`, `${ch.xLabel.toLowerCase()},${ch.yLabel.toLowerCase()}${ref ? `,${ref.name.toLowerCase() || "reference"}` : ""}`];
  const at = (s: Series, x: number) => s.pts.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best), s.pts[0]!)[1];
  for (const [x, y] of m?.pts ?? []) lines.push(`${+x.toPrecision(8)},${+y.toPrecision(8)}${ref ? `,${+at(ref, x).toPrecision(8)}` : ""}`);
  return `${lines.join("\n")}\n`;
}
