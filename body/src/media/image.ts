import { fmt, isCount } from "../metric.js";
import type { Rng } from "../rng.js";
import { chrome, readout, renderRng, words, type CaptureSpec, type Rendered } from "./capture.js";
import { AMBER, GRAY, INK, noise, Raster, RED, VIRIDIS, WHITE } from "./raster.js";

const W = 400;
const H = 300;
const TOP = 14;
const BOTTOM = H - 13;

/** A cell culture under the microscope: viable cells bright and round, dead ones stained blue. */
function cells(c: CaptureSpec, rng: Rng, r: Raster) {
  const m = c.outcome.metric;
  const pct = m.unit.trim() === "%";
  const deadShare = pct && /viab/i.test(m.label) ? (100 - c.value) / 100 : pct && /dead|death/i.test(m.label) ? c.value / 100 : 0.06;
  const n = 110 + rng.int(40);
  const dead = Math.round(n * Math.min(1, Math.max(0, deadShare)));
  const tex = noise(W, BOTTOM - TOP, rng, 40, 2);
  for (let y = TOP; y < BOTTOM; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - W / 2, y - (TOP + BOTTOM) / 2) / 150;
      const v = 228 + tex[(y - TOP) * W + x]! * 14 - Math.max(0, d - 0.8) * 160;
      r.set(x, y, [Math.max(0, v - 4), Math.max(0, v), Math.max(0, v - 10)]);
    }
  const order = Array.from({ length: n }, (_, i) => i < dead).sort(() => rng.next() - 0.5);
  for (const isDead of order) {
    const a = rng.range(0, 2 * Math.PI);
    const rr = 135 * Math.sqrt(rng.next());
    const x = W / 2 + Math.cos(a) * rr;
    const y = (TOP + BOTTOM) / 2 + Math.sin(a) * rr * 0.92;
    if (isDead) {
      const s = rng.range(4, 6.5);
      r.disc(x, y, s, [44, 66, 150], 0.9);
      r.ring(x, y, s, [24, 36, 96], 1.2);
    } else {
      const s = rng.range(5.5, 8.5);
      r.disc(x, y, s, [196, 210, 192], 0.85);
      r.ring(x, y, s, [96, 118, 98], 1.4);
      r.disc(x - s * 0.25, y - s * 0.25, s * 0.3, [250, 252, 246], 0.9);
    }
  }
  for (let i = 0; i < 50; i++) r.disc(rng.range(40, W - 40), rng.range(TOP + 20, BOTTOM - 20), rng.range(0.6, 1.6), [120, 120, 110], 0.7);
  r.label(8, BOTTOM - 40, `CELLS ${n} · STAINED ${dead}`, INK, WHITE, 1, 3, 0.75);
  r.label(8, BOTTOM - 24, readout(c), INK, WHITE, 1, 3, 0.75);
  // scale bar: 50 µm
  r.rect(W - 70, BOTTOM - 16, 50, 3, INK);
  r.text(W - 70, BOTTOM - 26, "50 µM", INK);
}

/** A CT slice through the part: grey material, darker voids whose area is the porosity read. */
function ct(c: CaptureSpec, rng: Rng, r: Raster) {
  const m = c.outcome.metric;
  const cx = W / 2;
  const cy = (TOP + BOTTOM) / 2;
  const R = 116;
  const bore = 30;
  const tex = noise(W, H, rng, 18, 3);
  for (let y = TOP; y < BOTTOM; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const inPart = d <= R && d >= bore;
      const g = inPart ? 0.55 + tex[y * W + x]! * 0.16 + (d > R - 4 ? 0.12 : 0) : 0.04 + tex[y * W + x]! * 0.04;
      r.set(x, y, GRAY(g));
    }
  const area = Math.PI * (R * R - bore * bore);
  const pct = m.unit.trim() === "%";
  const pxPerMm = 10;
  const pores: { x: number; y: number; s: number }[] = [];
  const place = (s: number) => {
    for (let t = 0; t < 40; t++) {
      const a = rng.range(0, 2 * Math.PI);
      const d = rng.range(bore + s + 3, R - s - 3);
      const p = { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, s };
      if (pores.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > q.s + p.s + 2)) return pores.push(p);
    }
    return 0;
  };
  if (pct) {
    const k = 8 + rng.int(22);
    const wts = Array.from({ length: k }, () => rng.range(0.3, 1.6) ** 2);
    const sum = wts.reduce((a, b) => a + b, 0);
    for (const w of wts) place(Math.max(0.8, Math.sqrt(((c.value / 100) * area * w) / sum / Math.PI)));
  } else {
    const biggest = /diam|size|void|pore/i.test(m.label) && /mm|µm|um/i.test(m.unit) ? (c.value * (m.unit.includes("µ") || m.unit === "um" ? 0.001 : 1) * pxPerMm) / 2 : 3;
    place(Math.max(1, biggest));
    for (let i = 0; i < 10 + rng.int(10); i++) place(rng.range(0.8, Math.max(1, biggest * 0.6)));
  }
  for (const p of pores) r.disc(p.x, p.y, p.s, [22, 22, 24]);
  r.label(8, BOTTOM - 24, readout(c), WHITE, [0, 0, 0], 1, 3, 0.6);
  r.label(8, BOTTOM - 40, `VOIDS ${pores.length}`, WHITE, [0, 0, 0], 1, 3, 0.6);
  r.rect(W - 70, BOTTOM - 16, 5 * pxPerMm, 3, WHITE);
  r.text(W - 70, BOTTOM - 26, "5 MM", WHITE);
}

/** An ultrasonic C-scan of a panel: amplitude in colour, defects as low-amplitude patches. */
function cscan(c: CaptureSpec, rng: Rng, r: Raster) {
  const m = c.outcome.metric;
  const [x0, y0, x1, y1] = [20, TOP + 16, W - 20, BOTTOM - 40];
  const pw = x1 - x0;
  const ph = y1 - y0;
  const tex = noise(pw, ph, rng, 24, 3);
  const amp = new Float32Array(pw * ph).map((_, i) => 0.78 + tex[i]! * 0.18);
  const blobs: { x: number; y: number; s: number }[] = [];
  if (m.unit.trim() === "%") {
    const k = 1 + rng.int(4);
    for (let i = 0; i < k; i++) blobs.push({ x: rng.range(30, pw - 30), y: rng.range(20, ph - 20), s: Math.sqrt(((c.value / 100) * pw * ph) / k / Math.PI) });
  } else if (isCount(m)) {
    for (let i = 0; i < Math.round(c.value); i++) blobs.push({ x: rng.range(30, pw - 30), y: rng.range(20, ph - 20), s: rng.range(5, 12) });
  } else blobs.push({ x: rng.range(60, pw - 60), y: rng.range(30, ph - 30), s: Math.min(40, 4 + c.value * 2) });
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++)
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y);
        if (d < b.s * 1.4) amp[y * pw + x] = Math.min(amp[y * pw + x]!, 0.18 + 0.6 * Math.max(0, d / (b.s * 1.4)) ** 2);
      }
  r.field(x0, y0, amp, pw, ph, 0, 1, VIRIDIS);
  r.frame(x0 - 1, y0 - 1, pw + 2, ph + 2, [200, 200, 210]);
  for (let x = 0; x < 160; x++) r.rect(W - 180 + x, BOTTOM - 22, 1, 8, VIRIDIS(x / 159));
  r.text(W - 180, BOTTOM - 32, "AMPLITUDE 0 - 100%", WHITE);
  r.label(20, BOTTOM - 28, readout(c), WHITE, [0, 0, 0], 1, 3, 0.6);
}

/** A machine-vision photo of the surface or the part: defects circled and numbered, or the measurement drawn on it. */
function surface(c: CaptureSpec, rng: Rng, r: Raster) {
  const m = c.outcome.metric;
  const rough = /rough|\bra\b/i.test(m.label);
  const roughness = rough ? Math.min(3, Math.max(0.3, c.value / Math.max(0.1, m.target || 1))) : 1;
  const fine = noise(W, H, rng, 3, 2);
  const broad = noise(W, H, rng, 60, 2);
  const label = c.kind === "pack_line";
  for (let y = TOP; y < BOTTOM; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      // brushed metal: noise smeared along x
      run = run * 0.85 + fine[y * W + x]! * 0.15;
      const v = label ? 236 + broad[y * W + x]! * 10 : 120 + broad[y * W + x]! * 60 + (run - 0.5) * 90 * roughness;
      r.set(x, y, label ? [v, v, v - 6] : [v * 0.95, v, v * 1.04]);
    }
  }
  if (label) {
    r.rect(60, 70, 280, 12, INK);
    r.rect(60, 92, 200, 8, [90, 90, 96]);
    for (let i = 0; i < 40; i++) r.rect(60 + i * 7, 120, i % 3 ? 3 : 5, 60, INK);
  }
  if (isCount(m) || /defect|scratch|misprint|crack|dent/i.test(m.label)) {
    const n = Math.max(0, Math.round(c.value));
    for (let i = 0; i < n; i++) {
      const x = rng.range(50, W - 50);
      const y = rng.range(TOP + 30, BOTTOM - 50);
      const a = rng.range(0, Math.PI);
      const len = rng.range(6, 18);
      r.line(x - Math.cos(a) * len, y - Math.sin(a) * len, x + Math.cos(a) * len, y + Math.sin(a) * len, [40, 34, 30], 2);
      r.ring(x, y, len + 6, RED, 2);
      r.label(x + len + 6, y - len - 10, `${i + 1}`, WHITE, RED, 1, 2, 0.9);
    }
    r.label(8, BOTTOM - 24, n ? readout(c) : `${m.label}: none found`, WHITE, INK, 1, 3, 0.75);
  } else {
    // a feature and the dimension the instrument measured on it
    const y = (TOP + BOTTOM) / 2 + 10;
    const x0 = 90;
    const off = Math.min(60, 8 + rng.range(4, 30));
    r.rect(x0, y - 50, 220, 40, [70, 74, 82], 0.85);
    r.rect(x0 + off, y + 6, 220, 40, [92, 96, 104], 0.85);
    r.line(x0, y - 4, x0, y + 52, AMBER, 1, 3);
    r.line(x0 + off, y - 4, x0 + off, y + 52, AMBER, 1, 3);
    r.line(x0, y + 56, x0 + off, y + 56, AMBER, 2);
    r.text(x0 + off + 6, y + 52, fmt(c.value, m), AMBER, 1);
    r.label(8, BOTTOM - 24, readout(c), WHITE, INK, 1, 3, 0.75);
  }
}

/** A photo, micrograph, CT slice or C-scan, chosen from what the outcome and its instrument are. */
export function renderImage(c: CaptureSpec): Rendered {
  const rng = renderRng(c);
  const w = words(c);
  const r = new Raster(W, H, [16, 16, 20]);
  if (/viab|cell|cultur|confluen|bacteri|colon|microb/.test(w)) cells(c, rng, r);
  else if (/\bct\b|x-?ray|radiograph|poros|void|tomograph/.test(w)) ct(c, rng, r);
  else if (/c-?scan|ultrason|delam|phased/.test(w)) cscan(c, rng, r);
  else surface(c, rng, r);
  chrome(r, c);
  const png = r.png();
  return { file: { bytes: png, mime: "image/png", ext: "png" }, preview: null, perceive: png };
}
