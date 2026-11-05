import type { Rng } from "../rng.js";
import { GLYPH_H, GLYPH_W, glyph, plain } from "./font.js";
import { encodePng } from "./png.js";

export type RGB = readonly [number, number, number];
export type Colormap = (t: number) => RGB;

/** A colormap through evenly spaced stops. */
export function colormap(stops: RGB[]): Colormap {
  return (t: number) => {
    const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const a = stops[i]!;
    const b = stops[i + 1]!;
    return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
  };
}
/** The thermal camera palette: black through purple, red and yellow to white. */
export const IRONBOW = colormap([
  [0, 0, 10],
  [32, 0, 96],
  [110, 0, 150],
  [190, 30, 110],
  [232, 92, 30],
  [250, 170, 0],
  [255, 234, 90],
  [255, 255, 255],
]);
export const INFERNO = colormap([
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
]);
export const VIRIDIS = colormap([
  [68, 1, 84],
  [65, 68, 135],
  [42, 120, 142],
  [34, 168, 132],
  [122, 209, 81],
  [253, 231, 37],
]);
export const GRAY: Colormap = (t) => {
  const v = Math.round(255 * Math.min(1, Math.max(0, t)));
  return [v, v, v];
};

export const WHITE: RGB = [255, 255, 255];
export const BLACK: RGB = [0, 0, 0];
export const INK: RGB = [24, 26, 34];
export const RED: RGB = [220, 38, 38];
export const AMBER: RGB = [245, 158, 11];
export const GREEN: RGB = [22, 163, 74];

/** An RGB image the body draws its media in: rectangles, lines, discs, text in the bitmap font, and heat fields. */
export class Raster {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: RGB = BLACK,
  ) {
    this.data = new Uint8Array(w * h * 3);
    this.fill(bg);
  }
  fill(c: RGB) {
    for (let i = 0; i < this.w * this.h; i++) this.data.set(c, i * 3);
  }
  set(x: number, y: number, c: RGB) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data.set(c, (y * this.w + x) * 3);
  }
  blend(x: number, y: number, c: RGB, a: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 3;
    const k = Math.min(1, a);
    for (let j = 0; j < 3; j++) this.data[i + j] = Math.round(this.data[i + j]! * (1 - k) + c[j]! * k);
  }
  get(x: number, y: number): RGB {
    const i = (Math.min(this.h - 1, Math.max(0, y)) * this.w + Math.min(this.w - 1, Math.max(0, x))) * 3;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1) {
    for (let j = Math.max(0, Math.round(y)); j < Math.min(this.h, Math.round(y + h)); j++)
      for (let i = Math.max(0, Math.round(x)); i < Math.min(this.w, Math.round(x + w)); i++) (a >= 1 ? this.set(i, j, c) : this.blend(i, j, c, a));
  }
  frame(x: number, y: number, w: number, h: number, c: RGB, t = 1) {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, t = 1, dash = 0) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const r = (t - 1) / 2;
    for (let s = 0; s <= n; s++) {
      if (dash && Math.floor(s / dash) % 2 === 1) continue;
      const x = x0 + ((x1 - x0) * s) / n;
      const y = y0 + ((y1 - y0) * s) / n;
      if (t <= 1) this.set(x, y, c);
      else for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.set(x + dx, y + dy, c);
    }
  }
  disc(cx: number, cy: number, r: number, c: RGB, a = 1) {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        // soft edge: a pixel half inside the circle is half covered
        const cover = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x - cx, y - cy)));
        if (cover > 0) this.blend(x, y, c, cover * a);
      }
  }
  ring(cx: number, cy: number, r: number, c: RGB, t = 1, a = 1) {
    for (let y = Math.floor(cy - r - t); y <= Math.ceil(cy + r + t); y++)
      for (let x = Math.floor(cx - r - t); x <= Math.ceil(cx + r + t); x++) {
        const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
        const cover = Math.min(1, Math.max(0, t / 2 + 0.5 - d));
        if (cover > 0) this.blend(x, y, c, cover * a);
      }
  }
  /** Text in the bitmap font; returns its width. */
  text(x: number, y: number, s: string, c: RGB, scale = 1): number {
    const str = plain(s);
    let cx = x;
    for (const ch of str) {
      const g = glyph(ch);
      for (let gy = 0; gy < GLYPH_H; gy++) for (let gx = 0; gx < GLYPH_W; gx++) if (g[gy]![gx]) this.rect(cx + gx * scale, y + gy * scale, scale, scale, c);
      cx += (GLYPH_W + 1) * scale;
    }
    return cx - x;
  }
  static textWidth(s: string, scale = 1) {
    return [...plain(s)].length * (GLYPH_W + 1) * scale;
  }
  /** Text on a filled box, for readouts over an image. */
  label(x: number, y: number, s: string, fg: RGB, bg: RGB, scale = 1, pad = 3, alpha = 0.8) {
    const w = Raster.textWidth(s, scale) + pad * 2 - scale;
    const h = GLYPH_H * scale + pad * 2;
    this.rect(x, y, w, h, bg, alpha);
    this.text(x + pad, y + pad, s, fg, scale);
    return { w, h };
  }
  /** Paint a field of values through a colormap, one pixel per value. */
  field(x0: number, y0: number, f: Float32Array, fw: number, fh: number, lo: number, hi: number, cmap: Colormap) {
    const span = hi - lo || 1;
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) this.set(x0 + x, y0 + y, cmap((f[y * fw + x]! - lo) / span));
  }
  /** Copy another raster into this one. */
  draw(src: Raster, x0: number, y0: number) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) this.set(x0 + x, y0 + y, src.get(x, y));
  }
  png(): Uint8Array {
    return encodePng(this.w, this.h, this.data);
  }
}

/** Smooth value noise in [0, 1]: a few octaves of a random lattice, interpolated. */
export function noise(w: number, h: number, rng: Rng, cell = 32, octaves = 3): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const c = Math.max(2, cell / 2 ** o);
    const gw = Math.ceil(w / c) + 2;
    const gh = Math.ceil(h / c) + 2;
    const grid = new Float32Array(gw * gh).map(() => rng.next());
    for (let y = 0; y < h; y++) {
      const gy = y / c;
      const iy = Math.floor(gy);
      const fy = gy - iy;
      const sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < w; x++) {
        const gx = x / c;
        const ix = Math.floor(gx);
        const fx = gx - ix;
        const sx = fx * fx * (3 - 2 * fx);
        const a = grid[iy * gw + ix]!;
        const b = grid[iy * gw + ix + 1]!;
        const cc = grid[(iy + 1) * gw + ix]!;
        const d = grid[(iy + 1) * gw + ix + 1]!;
        out[y * w + x]! += amp * (a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy);
      }
    }
    total += amp;
    amp /= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

/** A separable box blur, `passes` times (three passes are close to a Gaussian). */
export function blur(f: Float32Array, w: number, h: number, r: number, passes = 2): Float32Array {
  let a = Float32Array.from(f);
  const b = new Float32Array(f.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          s += a[y * w + xx]!;
          n++;
        }
        b[y * w + x] = s / n;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= h) continue;
          s += b[yy * w + x]!;
          n++;
        }
        a[y * w + x] = s / n;
      }
  }
  return a;
}
