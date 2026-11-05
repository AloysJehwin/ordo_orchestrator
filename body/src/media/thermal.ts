import { decimals } from "../metric.js";
import { chrome, readout, renderRng, type CaptureSpec, type Rendered } from "./capture.js";
import { blur, IRONBOW, noise, Raster, WHITE, type RGB } from "./raster.js";

const FW = 336;
const FH = 272;

/** Where the machine's body is in the frame, by kind: 1 on it, 0 around it. */
function shape(kind: string): Float32Array {
  const m = new Float32Array(FW * FH);
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * FW + x] = 1;
  };
  const disc = (cx: number, cy: number, r: number) => {
    for (let y = Math.max(0, cy - r); y < Math.min(FH, cy + r); y++) for (let x = Math.max(0, cx - r); x < Math.min(FW, cx + r); x++) if (Math.hypot(x - cx, y - cy) <= r) m[y * FW + x] = 1;
  };
  const bar = (x0: number, y0: number, x1: number, y1: number, r: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= n; i += 2) disc(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), r);
  };
  switch (kind) {
    case "process_vessel":
      rect(112, 52, 224, 228);
      disc(168, 56, 56);
      disc(168, 224, 56);
      rect(150, 8, 186, 30); // nozzle
      break;
    case "cnc":
      rect(40, 96, 250, 176);
      disc(56, 136, 46);
      rect(250, 120, 300, 152);
      rect(300, 128, 326, 144);
      break;
    case "robot":
      disc(70, 230, 34);
      bar(70, 230, 150, 140, 18);
      disc(150, 140, 22);
      bar(150, 140, 250, 96, 14);
      disc(250, 96, 16);
      bar(250, 96, 300, 130, 8);
      break;
    case "pack_line":
      rect(16, 100, 320, 140);
      for (let i = 0; i < 5; i++) rect(30 + i * 60, 160, 70 + i * 60, 210);
      break;
    case "agv":
      rect(40, 96, 296, 196);
      rect(190, 150, 270, 192);
      disc(80, 206, 22);
      disc(256, 206, 22);
      break;
    default:
      rect(56, 48, 280, 224);
      disc(168, 136, 44);
  }
  return m;
}

/**
 * A thermal image in the ironbow palette with a scale bar. The field is shaped so the outcome's metric reads exactly
 * the instrument's value: the spread over the machine (max − min) for a ΔT, contrast or uniformity metric, otherwise
 * its hottest point.
 */
export function renderThermal(c: CaptureSpec): Rendered {
  const rng = renderRng(c);
  const m = c.outcome.metric;
  const spread = /δ|delta|\bdt\b|difference|contrast|uniform|gradient|spread/i.test(`${m.label} ${c.outcome.label}`) || /Δ/.test(m.label);
  const mask = shape(c.kind);
  const tex = noise(FW, FH, rng, 48, 3);
  const f = new Float32Array(FW * FH);
  const spots = 1 + rng.int(3);
  const inside: number[] = [];
  for (let i = 0; i < mask.length; i += 7) if (mask[i]) inside.push(i);
  const hot = Array.from({ length: spots }, () => ({ at: rng.pick(inside), sigma: rng.range(10, 36), amp: rng.range(0.5, 1) }));
  for (let i = 0; i < f.length; i++) {
    if (!mask[i]) continue;
    const x = i % FW;
    const y = Math.floor(i / FW);
    let v = tex[i]! * 0.45;
    for (const h of hot) {
      const d2 = (x - (h.at % FW)) ** 2 + (y - Math.floor(h.at / FW)) ** 2;
      v += h.amp * Math.exp(-d2 / (2 * h.sigma * h.sigma));
    }
    f[i] = v;
  }
  // normalise over the machine to [0, 1]
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < f.length; i++) if (mask[i]) (lo = Math.min(lo, f[i]!)), (hi = Math.max(hi, f[i]!));
  const ambient = 21 + rng.range(0, 3);
  const nominal = c.kind === "process_vessel" ? 37 : c.kind === "pack_line" ? 60 : 30 + rng.range(0, 8);
  const base = spread ? nominal : c.value > ambient + 2 ? Math.max(ambient + 1, c.value - Math.max(2, (c.value - ambient) * 0.35)) : c.value - 2;
  const top = spread ? base + c.value : c.value;
  const halo = blur(mask, FW, FH, 10, 2);
  const bg = noise(FW, FH, rng, 64, 2);
  const T = new Float32Array(FW * FH);
  let objMean = 0;
  let n = 0;
  for (let i = 0; i < f.length; i++) if (mask[i]) (objMean += base + (top - base) * ((f[i]! - lo) / (hi - lo || 1))), n++;
  objMean /= n || 1;
  let hotAt = 0;
  let coldAt = 0;
  for (let i = 0; i < T.length; i++) {
    if (mask[i]) {
      T[i] = base + (top - base) * ((f[i]! - lo) / (hi - lo || 1));
      if (!mask[hotAt] || T[i]! > T[hotAt]!) hotAt = i;
      if (!mask[coldAt] || T[i]! < T[coldAt]!) coldAt = i;
    } else T[i] = ambient + bg[i]! * 0.6 + halo[i]! * Math.max(0, objMean - ambient) * 0.3;
  }
  let tmin = Infinity;
  let tmax = -Infinity;
  for (const t of T) (tmin = Math.min(tmin, t)), (tmax = Math.max(tmax, t));
  const dlo = Math.floor(tmin);
  const dhi = Math.ceil(tmax + 0.01);

  const r = new Raster(400, 300, [10, 10, 16]);
  r.field(0, 14, T, FW, FH, dlo, dhi, IRONBOW);
  const d = Math.max(1, decimals(m));
  const cross = (i: number, col: RGB, text: string) => {
    const x = i % FW;
    const y = 14 + Math.floor(i / FW);
    r.line(x - 7, y, x - 2, y, col, 1);
    r.line(x + 2, y, x + 7, y, col, 1);
    r.line(x, y - 7, x, y - 2, col, 1);
    r.line(x, y + 2, x, y + 7, col, 1);
    r.label(Math.min(FW - 80, x + 9), Math.max(16, y - 14), text, col, [0, 0, 0], 1, 2, 0.55);
  };
  cross(hotAt, WHITE, `MAX ${T[hotAt]!.toFixed(d)} °C`);
  if (spread) cross(coldAt, [120, 220, 255], `MIN ${T[coldAt]!.toFixed(d)} °C`);
  r.label(6, 14 + FH - 24, readout(c), WHITE, [0, 0, 0], 1, 4, 0.6);
  // scale bar
  for (let y = 0; y < 240; y++) r.rect(344, 28 + y, 12, 1, IRONBOW(1 - y / 239));
  r.frame(343, 27, 14, 242, [90, 90, 100]);
  r.text(360, 26, `${dhi}`, WHITE);
  r.text(360, 144, `${((dlo + dhi) / 2).toFixed(0)}`, WHITE);
  r.text(360, 262, `${dlo}`, WHITE);
  r.text(362, 278, "°C", WHITE);
  chrome(r, c);
  const png = r.png();
  return { file: { bytes: png, mime: "image/png", ext: "png" }, preview: null, perceive: png };
}
