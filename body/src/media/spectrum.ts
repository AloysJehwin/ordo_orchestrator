import { fmt, isCount } from "../metric.js";
import type { Rng } from "../rng.js";
import { chrome, readout, renderRng, words, type CaptureSpec, type Rendered } from "./capture.js";
import { chartCsv, drawChart, type Chart, type Pt } from "./chart.js";
import { AMBER, Raster, RED, WHITE, type RGB } from "./raster.js";

const BLUE: RGB = [96, 190, 255];
const GREY: RGB = [150, 150, 160];

const gauss = (x: number, at: number, w: number) => Math.exp(-((x - at) ** 2) / (2 * w * w));
const lorentz = (x: number, at: number, w: number) => 1 / (1 + ((x - at) / w) ** 2);
const sweep = (lo: number, hi: number, n: number, log = false): number[] =>
  Array.from({ length: n }, (_, i) => (log ? lo * (hi / lo) ** (i / (n - 1)) : lo + ((hi - lo) * i) / (n - 1)));
const top = (pts: Pt[]) => Math.max(...pts.map((p) => p[1]));

/** X-ray lines (keV) and optical emission lines (nm) of the elements alloy checks name. */
const ELEMENTS: Record<string, { sym: string; kev: number; nm: number }> = {
  vanadium: { sym: "V", kev: 4.95, nm: 311.07 },
  rhenium: { sym: "Re", kev: 8.65, nm: 346.05 },
  aluminium: { sym: "Al", kev: 1.49, nm: 396.15 },
  aluminum: { sym: "Al", kev: 1.49, nm: 396.15 },
  titanium: { sym: "Ti", kev: 4.51, nm: 334.94 },
  nickel: { sym: "Ni", kev: 7.48, nm: 341.48 },
  chromium: { sym: "Cr", kev: 5.41, nm: 267.72 },
  cobalt: { sym: "Co", kev: 6.93, nm: 228.62 },
  tungsten: { sym: "W", kev: 8.4, nm: 400.88 },
  tantalum: { sym: "Ta", kev: 8.15, nm: 240.06 },
  molybdenum: { sym: "Mo", kev: 17.48, nm: 202.03 },
  iron: { sym: "Fe", kev: 6.4, nm: 259.94 },
  zro2: { sym: "Zr", kev: 15.77, nm: 343.82 },
  zirconium: { sym: "Zr", kev: 15.77, nm: 343.82 },
};

function elemental(c: CaptureSpec, rng: Rng, optical: boolean): Chart {
  const label = c.outcome.metric.label.toLowerCase();
  const key = Object.keys(ELEMENTS).find((k) => label.includes(k)) ?? "nickel";
  const el = ELEMENTS[key]!;
  const matrix = [ELEMENTS.nickel!, ELEMENTS.titanium!, ELEMENTS.chromium!, ELEMENTS.cobalt!, ELEMENTS.aluminium!, ELEMENTS.iron!].filter((e) => e.sym !== el.sym);
  const [lo, hi] = optical ? [200, 420] : [0, 20];
  const w = optical ? 0.35 : 0.09;
  const at = (e: { kev: number; nm: number }) => (optical ? e.nm : e.kev);
  const others = matrix.map((e) => ({ at: at(e), h: rng.range(800, 4000) }));
  const peak = 400 * c.value; // counts per wt%
  const pts: Pt[] = sweep(lo, hi, 440).map((x) => {
    let y = 60 + 40 * Math.exp(-(optical ? (x - lo) / 120 : x / 6)) + rng.normal(0, 6);
    for (const o of others) y += o.h * gauss(x, o.at, w * (optical ? 1 : 1 + o.at / 20));
    y += peak * gauss(x, at(el), w * (optical ? 1 : 1 + at(el) / 20));
    return [x, Math.max(0, y)];
  });
  return {
    xLabel: optical ? "WAVELENGTH NM" : "ENERGY KEV",
    yLabel: "COUNTS",
    x: [lo, hi],
    y: [0, top(pts) * 1.15],
    series: [{ name: "", pts, color: BLUE }],
    marks: [{ x: at(el), y: 60 + peak, text: `${el.sym} ${optical ? `${el.nm} NM` : `${el.kev} KEV`}: ${fmt(c.value, c.outcome.metric)}`, color: AMBER }],
  };
}

/** A gas chromatogram: the carrier, nitrogen and oxygen peaks; the oxygen peak's area is the ppm read. */
function chromatogram(c: CaptureSpec, rng: Rng): Chart {
  const o2 = 0.8 * c.value; // mV per ppm at the peak
  const peaks = [
    { at: 0.42, h: 900, w: 0.03, n: "AR" },
    { at: 0.78, h: o2, w: 0.025, n: "O2" },
    { at: 1.05, h: rng.range(6, 30), w: 0.03, n: "N2" },
  ];
  const pts: Pt[] = sweep(0, 2, 500).map((x) => [x, 2 + rng.normal(0, 0.4) + peaks.reduce((s, p) => s + p.h * gauss(x, p.at, p.w), 0)]);
  const yMax = Math.max(40, o2 * 2.2);
  return { xLabel: "RETENTION MIN", yLabel: "MV", x: [0, 2], y: [0, yMax], series: [{ name: "", pts: pts.map(([x, y]) => [x, Math.min(y, yMax)]), color: BLUE }], marks: [{ x: 0.78, y: 2 + o2, text: `O2: ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** A combustion infrared cell trace: the carbon peak's area is the ppm read. */
function combustion(c: CaptureSpec, rng: Rng): Chart {
  const h = c.value / 6;
  const pts: Pt[] = sweep(0, 60, 400).map((x) => [x, 1 + rng.normal(0, 0.2) + h * (x > 8 ? Math.exp(-(x - 8) / 9) * (1 - Math.exp(-(x - 8) / 1.5)) : 0)]);
  return { xLabel: "TIME S", yLabel: "IR SIGNAL", x: [0, 60], y: [0, Math.max(10, top(pts) * 1.2)], series: [{ name: "", pts, color: BLUE }], marks: [{ x: 13, y: top(pts), text: `C: ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** A residual gas mass spectrum on a log scale: the m/z the outcome names stands at the partial pressure read. */
function rga(c: CaptureSpec, rng: Rng): Chart {
  const mz = Number(/m\/z\s*(\d+)/i.exec(c.outcome.metric.label)?.[1] ?? 43);
  const base: Record<number, number> = { 2: 3e-7, 18: 2e-7, 28: 8e-8, 32: 1e-8, 40: 5e-9, 44: 2e-9 };
  const pts: Pt[] = [];
  for (let m = 1; m <= 60; m++) pts.push([m, m === mz ? Math.max(1e-13, c.value) : (base[m] ?? 10 ** rng.range(-12.5, -11)) * rng.range(0.7, 1.3)]);
  return { xLabel: "M/Z", yLabel: "MBAR", x: [0, 61], y: [1e-13, 1e-5], yLog: true, series: [{ name: "", pts, color: BLUE, bars: true }], marks: [{ x: mz, y: Math.max(1e-13, c.value), text: `M/Z ${mz}: ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** An X-ray diffractogram: tetragonal peaks, and monoclinic peaks whose share of the intensity is the percentage read. */
function xrd(c: CaptureSpec, rng: Rng): Chart {
  const mono = c.value / 100;
  const tet = [30.2, 35.2, 50.4, 60.2, 62.9, 74.5].map((at, i) => ({ at, h: [1000, 220, 480, 300, 110, 90][i]! * (1 - mono) }));
  const mon = [28.2, 31.5, 34.2, 40.7].map((at, i) => ({ at, h: [1000, 700, 220, 140][i]! * mono * 1.4 }));
  const pts: Pt[] = sweep(20, 80, 600).map((x) => [x, 40 + rng.normal(0, 4) + [...tet, ...mon].reduce((s, p) => s + p.h * lorentz(x, p.at, 0.18), 0)]);
  return { xLabel: "2-THETA DEG", yLabel: "COUNTS", x: [20, 80], y: [0, top(pts) * 1.15], series: [{ name: "", pts, color: BLUE }], marks: [{ x: 28.2, y: 40 + mon[0]!.h, text: `M(-111): ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** An infrared spectrum against its reference: a match, a conversion or a residue band, as the metric reads. */
function infrared(c: CaptureSpec, rng: Rng): Chart {
  const m = c.outcome.metric;
  const label = m.label.toLowerCase();
  const bands = [
    { at: 2920, h: 0.35, w: 30 },
    { at: 2850, h: 0.22, w: 22 },
    { at: 1730, h: 0.55, w: 18 },
    { at: 1610, h: 0.3, w: 12 },
    { at: 1510, h: 0.62, w: 10 },
    { at: 1240, h: 0.7, w: 22 },
    { at: 1035, h: 0.45, w: 20 },
    { at: 915, h: 0.4, w: 9 },
    { at: 830, h: 0.38, w: 10 },
  ];
  const xs = sweep(600, 4000, 520);
  const spec = (scale: (at: number) => number, jitter: number) => xs.map((x): Pt => [x, Math.max(0, 0.02 + rng.normal(0, 0.004) + bands.reduce((s, b) => s + b.h * scale(b.at) * (1 + rng.normal(0, jitter)) * lorentz(x, b.at, b.w), 0))]);
  const ref = spec(() => 1, 0);
  let meas: Pt[];
  let mark: { x: number; y: number; text: string };
  if (/conversion|cure/.test(label)) {
    meas = spec((at) => (at === 915 ? 1 - c.value / 100 : 1), 0.01);
    mark = { x: 915, y: 0.4 * (1 - c.value / 100) + 0.05, text: `EPOXIDE 915: ${fmt(c.value, m)}` };
  } else if (/residue|nvr|release|contamin/.test(label)) {
    // the surface is clean apart from the C-H stretch of what is left on it
    meas = xs.map((x): Pt => [x, 0.02 + rng.normal(0, 0.003) + (c.value / 20) * (0.35 * lorentz(x, 2920, 30) + 0.22 * lorentz(x, 2850, 22))]);
    mark = { x: 2920, y: 0.02 + (c.value / 20) * 0.35, text: `C-H 2920: ${fmt(c.value, m)}` };
  } else {
    const dev = Math.max(0, (100 - c.value) / 100);
    meas = spec((at) => 1 + (at % 3 ? dev * 2.2 : -dev * 1.8), dev);
    mark = { x: 1240, y: 0.75, text: `MATCH: ${fmt(c.value, m)}` };
  }
  return {
    xLabel: "WAVENUMBER CM-1",
    yLabel: "ABSORBANCE",
    x: [600, 4000],
    xReversed: true,
    y: [0, Math.max(top(ref), top(meas)) * 1.2],
    series: [
      { name: "SAMPLE", pts: meas, color: BLUE },
      { name: "REFERENCE", pts: ref, color: GREY, dash: 3 },
    ],
    marks: [{ ...mark, color: AMBER }],
  };
}

/** A conducted or radiated emissions scan under its limit line; the closest approach is the margin read. */
function emissions(c: CaptureSpec, rng: Rng): Chart {
  const radiated = /re102|radiated/i.test(words(c));
  const [lo, hi] = radiated ? [1e4, 1.8e10] : [1e4, 1e7];
  const xs = sweep(lo, hi, 420, true);
  const limit = (f: number) => (radiated ? (f < 2e6 ? 34 : 34 + 10 * Math.log10(f / 2e6)) : f < 5e5 ? 94 - 20 * Math.log10(f / 1e4) : 60);
  const worstAt = xs[60 + rng.int(300)]!;
  const pts: Pt[] = xs.map((f) => [f, limit(f) - 28 - rng.range(0, 10) + 6 * Math.sin(Math.log10(f) * 7)]);
  // the worst emission sits exactly the margin under the limit
  const i = xs.indexOf(worstAt);
  for (let k = -2; k <= 2; k++) if (pts[i + k]) pts[i + k]![1] = limit(xs[i + k]!) - c.value - Math.abs(k) * 4;
  const ys = pts.map((p) => p[1]).concat(xs.map(limit));
  return {
    xLabel: "FREQUENCY HZ",
    yLabel: radiated ? "DBUV/M" : "DBUV",
    x: [lo, hi],
    xLog: true,
    y: [Math.floor(Math.min(...ys) / 10) * 10 - 10, Math.ceil(Math.max(...ys) / 10) * 10 + 10],
    series: [
      { name: "SCAN", pts, color: BLUE },
      { name: "LIMIT", pts: xs.map((f) => [f, limit(f)]), color: RED, dash: 4 },
    ],
    marks: [{ x: worstAt, y: limit(worstAt) - c.value, text: `MARGIN ${fmt(c.value, c.outcome.metric)}`, color: AMBER }],
  };
}

/** A signal analyzer around the carrier: its peak is the output power read. */
function carrier(c: CaptureSpec, rng: Rng): Chart {
  const fc = 8.2e9;
  const pts: Pt[] = sweep(fc - 5e6, fc + 5e6, 500).map((f) => [f / 1e9, Math.max(-90 + rng.normal(0, 1.2), c.value - 40 * Math.abs(f - fc) / 1.2e6 - (Math.abs(f - fc) < 1e6 ? 0 : 20))]);
  return { xLabel: "FREQUENCY GHZ", yLabel: "DBM", x: [(fc - 5e6) / 1e9, (fc + 5e6) / 1e9], y: [-100, Math.max(40, c.value + 10)], series: [{ name: "", pts, color: BLUE }], marks: [{ x: fc / 1e9, y: c.value, text: `PEAK ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** A network analyzer sweep of a cable: the deepest insertion loss is the value read. */
function insertion(c: CaptureSpec, rng: Rng): Chart {
  const pts: Pt[] = sweep(0.1, 18, 400).map((f) => [f, -(c.value * Math.sqrt(f / 18)) + 0.05 * Math.sin(f * 9) - rng.range(0, 0.02)]);
  pts[pts.length - 1]![1] = -c.value;
  return { xLabel: "FREQUENCY GHZ", yLabel: "S21 DB", x: [0, 18], y: [-Math.max(2, c.value * 1.5), 0.5], series: [{ name: "", pts, color: BLUE }], marks: [{ x: 18, y: -c.value, text: `LOSS ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** An acceleration spectral density against its tolerance; its area gives the Grms read. */
function psd(c: CaptureSpec, rng: Rng): Chart {
  const xs = sweep(20, 2000, 300, true);
  const shape = (f: number) => (f < 80 ? (f / 80) ** 2 : f > 500 ? (500 / f) ** 2 : 1);
  // area of the shape (trapezoids), so the plateau gives the Grms read
  let area = 0;
  for (let i = 1; i < xs.length; i++) area += ((shape(xs[i]!) + shape(xs[i - 1]!)) / 2) * (xs[i]! - xs[i - 1]!);
  const plateau = (c.value * c.value) / area;
  const pts: Pt[] = xs.map((f) => [f, plateau * shape(f) * 10 ** (rng.normal(0, 0.03))]);
  const ref = xs.map((f): Pt => [f, plateau * shape(f)]);
  return {
    xLabel: "FREQUENCY HZ",
    yLabel: "G2/HZ",
    x: [20, 2000],
    y: [plateau / 100, plateau * 4],
    xLog: true,
    yLog: true,
    series: [
      { name: "CONTROL", pts, color: BLUE },
      { name: "+3 DB", pts: ref.map(([f, y]) => [f, y * 2]), color: GREY, dash: 3 },
      { name: "-3 DB", pts: ref.map(([f, y]) => [f, y / 2]), color: GREY, dash: 3 },
    ],
    marks: [{ x: 200, y: plateau, text: `${fmt(c.value, c.outcome.metric)}`, color: AMBER }],
  };
}

/** One-third octave bands against a ±3 dB tolerance: as many bands fall outside as the count read. */
function octave(c: CaptureSpec, rng: Rng): Chart {
  const centres = [31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000];
  const spec = (f: number) => 130 - 6 * Math.abs(Math.log2(f / 160)) * 0.6;
  const outside = new Set<number>();
  while (outside.size < Math.min(centres.length, Math.round(c.value))) outside.add(rng.int(centres.length));
  const pts: Pt[] = centres.map((f, i) => [f, spec(f) + (outside.has(i) ? (rng.chance(0.5) ? 1 : -1) * rng.range(3.5, 5) : rng.range(-2.2, 2.2))]);
  return {
    xLabel: "BAND HZ",
    yLabel: "DB",
    x: [25, 10000],
    xLog: true,
    y: [95, 145],
    series: [
      { name: "", pts, color: BLUE, bars: true },
      { name: "TOLERANCE", pts: centres.map((f) => [f, spec(f) + 3]), color: RED, dash: 3 },
      { name: "", pts: centres.map((f) => [f, spec(f) - 3]), color: RED, dash: 3 },
    ],
    marks: [{ x: 160, y: 140, text: `OUTSIDE: ${Math.round(c.value)}`, color: AMBER }],
  };
}

/** A vibration velocity spectrum: running speed and its harmonics; the overall RMS is the value read. */
function velocity(c: CaptureSpec, rng: Rng): Chart {
  const run = (c.signals.spindle_speed ?? 8000) / 60;
  const lines = [1, 2, 3, 4.6].map((k, i) => ({ at: run * k, a: [1, 0.5, 0.25, 0.3][i]! }));
  const xs = sweep(0, Math.max(1000, run * 5.5), 500);
  // amplitudes so the root sum square of the lines is the overall value
  const rss = Math.sqrt(lines.reduce((s, l) => s + l.a * l.a, 0));
  const pts: Pt[] = xs.map((f) => [f, Math.max(0, rng.range(0, 0.03) + lines.reduce((s, l) => s + ((l.a * c.value) / rss) * gauss(f, l.at, 3), 0))]);
  return { xLabel: "FREQUENCY HZ", yLabel: "MM/S RMS", x: [0, xs.at(-1)!], y: [0, Math.max(top(pts) * 1.3, 0.5)], series: [{ name: "", pts, color: BLUE }], marks: [{ x: run, y: c.value / rss, text: `1X  OVERALL ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** A quantity over time reaching the value read: degree of cure, a dielectric trace. */
function progress(c: CaptureSpec, rng: Rng): Chart {
  const k = 3 / 60;
  const pts: Pt[] = sweep(0, 120, 300).map((t) => [t, c.value * (1 - Math.exp(-k * t)) / (1 - Math.exp(-k * 120)) + rng.normal(0, 0.15)]);
  return { xLabel: "TIME MIN", yLabel: c.outcome.metric.unit.toUpperCase() || "VALUE", x: [0, 120], y: [0, Math.max(100, c.value * 1.1)], series: [{ name: "", pts, color: BLUE }], marks: [{ x: 120, y: c.value, text: `END ${fmt(c.value, c.outcome.metric)}`, color: AMBER }] };
}

/** Two curves compared: emission against the reference penetrant, or a mode before and after test. */
function overlay(c: CaptureSpec, rng: Rng): Chart {
  const m = c.outcome.metric;
  const fluor = /fluor|brightness/i.test(words(c));
  if (fluor) {
    const xs = sweep(450, 650, 300);
    const ref = xs.map((x): Pt => [x, 1000 * gauss(x, 520, 22)]);
    const meas = xs.map((x): Pt => [x, (1000 * c.value) / 100 * gauss(x, 521, 23) + rng.normal(0, 6)]);
    return { xLabel: "WAVELENGTH NM", yLabel: "CPS", x: [450, 650], y: [0, 1200], series: [{ name: "SAMPLE", pts: meas, color: BLUE }, { name: "REFERENCE", pts: ref, color: GREY, dash: 3 }], marks: [{ x: 520, y: (1000 * c.value) / 100, text: `${fmt(c.value, m)} OF REF`, color: AMBER }] };
  }
  const f0 = 120;
  const f1 = f0 * (1 - c.value / 100);
  const xs = sweep(20, 400, 400, true);
  const frf = (f: number, fn: number) => 1 / Math.sqrt((1 - (f / fn) ** 2) ** 2 + (0.06 * f / fn) ** 2);
  return {
    xLabel: "FREQUENCY HZ",
    yLabel: "G/G",
    x: [20, 400],
    xLog: true,
    y: [0.05, 30],
    yLog: true,
    series: [
      { name: "POST", pts: xs.map((f) => [f, frf(f, f1) * 10 ** rng.normal(0, 0.01)]), color: BLUE },
      { name: "PRE", pts: xs.map((f) => [f, frf(f, f0)]), color: GREY, dash: 3 },
    ],
    marks: [{ x: f1, y: frf(f1, f1), text: `SHIFT ${fmt(c.value, m)}`, color: AMBER }],
  };
}

/** A single peak whose height is the value read, for an instrument the body has no closer model of. */
function generic(c: CaptureSpec, rng: Rng): Chart {
  const at = rng.range(30, 70);
  const pts: Pt[] = sweep(0, 100, 400).map((x) => [x, c.value * gauss(x, at, 3) + Math.abs(c.value) * 0.03 * (1 + rng.normal(0, 0.3))]);
  return { xLabel: "CHANNEL", yLabel: c.outcome.metric.unit.toUpperCase() || "VALUE", x: [0, 100], y: [0, Math.max(1e-9, Math.abs(c.value)) * 1.4], series: [{ name: "", pts, color: BLUE }], marks: [{ x: at, y: c.value, text: fmt(c.value, c.outcome.metric), color: AMBER }] };
}

function chartFor(c: CaptureSpec, rng: Rng): Chart {
  const w = words(c);
  const unit = c.outcome.metric.unit.trim().toLowerCase();
  if (/\bxrf\b|vanta|niton|s2 puma/.test(w)) return elemental(c, rng, false);
  if (/\boes\b|icp|arc-spark|spectromaxx/.test(w)) return elemental(c, rng, true);
  if (/\bgc\b|chromatograph|purity/.test(w)) return chromatogram(c, rng);
  if (/carbon\/sulfur|cs844|residual carbon/.test(w)) return combustion(c, rng);
  if (/\brga\b|transpector|m\/z|residual gas/.test(w)) return rga(c, rng);
  if (/xrd|diffract|phase/.test(w)) return xrd(c, rng);
  if (/ftir|infrared|raman/.test(w)) return infrared(c, rng);
  if (/ce102|re102|emissions|emi /.test(w)) return emissions(c, rng);
  if (/signal analyzer|downlink|transmitter/.test(w) || unit === "dbm") return carrier(c, rng);
  if (/insertion loss|network analyzer/.test(w)) return insertion(c, rng);
  if (/octave/.test(w) && isCount(c.outcome.metric)) return octave(c, rng);
  if (/psd|grms|acceleration/.test(w) || unit === "grms") return psd(c, rng);
  if (unit === "mm/s" || /vibration velocity/.test(w)) return velocity(c, rng);
  if (/dielectric|degree of cure/.test(w)) return progress(c, rng);
  if (/fluor|brightness|sine survey|mode frequency/.test(w)) return overlay(c, rng);
  return generic(c, rng);
}

/**
 * A spectrum or trace from the instrument the outcome names (XRF and OES lines, a chromatogram, an infrared spectrum
 * against its reference, an emissions scan under its limit, a PSD, a mass spectrum…), drawn so the value read is on
 * the chart. The file is the data as CSV; the chart is its preview.
 */
export function renderSpectrum(c: CaptureSpec): Rendered {
  const rng = renderRng(c);
  const ch = chartFor(c, rng);
  const r = new Raster(400, 300, [14, 16, 22]);
  drawChart(r, ch);
  r.label(58, 214, readout(c), WHITE, [0, 0, 0], 1, 3, 0.6);
  chrome(r, c);
  const png = r.png();
  const csv = chartCsv(ch, `${c.outcome.instrument} · ${c.outcome.label} · ${readout(c)} · ${c.runId}/${c.stage} · virtual machine (simulated)`);
  return { file: { bytes: new TextEncoder().encode(csv), mime: "text/csv", ext: "csv" }, preview: { bytes: png, mime: "image/png", ext: "png" }, perceive: png };
}
