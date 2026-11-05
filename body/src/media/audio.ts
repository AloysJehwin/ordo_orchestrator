import { BODY_PROFILES } from "../../../server/src/edge/profiles.js";
import { isCount } from "../metric.js";
import { chrome, readout, renderRng, words, type CaptureSpec, type Rendered } from "./capture.js";
import { INFERNO, Raster, WHITE } from "./raster.js";
import { encodeWav, spectrum } from "./wav.js";

const SECONDS = 2;

/** The frequency the outcome is about: its metric when that is a frequency, a carrier for ultrasound and AE, else the machine's tone. */
function fundamental(c: CaptureSpec): number {
  const m = c.outcome.metric;
  const unit = m.unit.trim().toLowerCase();
  if (unit === "hz") return c.value;
  if (unit === "khz") return c.value * 1000;
  const w = words(c);
  if (/ultras|ultraprobe|sdt |dbµv|dbuv/.test(`${w} ${unit}`)) return 38_000;
  if (/\bae\b|acoustic emission|r15|micro-ii/.test(w)) return 26_000;
  const p = c.kind === "system" ? null : BODY_PROFILES[c.kind];
  return p?.toneHz ?? 220;
}

function rateFor(f: number): number {
  return [8000, 16000, 48000, 96000].find((r) => r > 3 * f) ?? 96000;
}

/**
 * A two-second mono recording of the machine and a spectrogram of it. What the outcome measures sets what is heard:
 * a level (dB) scales the band the instrument watches against its target, a count places that many transient hits
 * (acoustic emission, rattles, actuation anomalies), and a percentage shifts the resonance away from the reference by
 * that much. The spectrogram marks the frequency read.
 */
export function renderAudio(c: CaptureSpec): Rendered {
  const rng = renderRng(c);
  const m = c.outcome.metric;
  const unit = m.unit.trim().toLowerCase();
  const f0 = fundamental(c);
  const rate = rateFor(f0);
  const n = rate * SECONDS;
  const x = new Float32Array(n);
  const count = isCount(m) || /hits|events|anomal|rattle/i.test(m.label);
  const pct = unit === "%";
  // how far the band of interest sits above or below where it should (dB)
  const excess = unit.startsWith("db") ? c.value - m.target : 0;
  const level = Math.min(0.85, Math.max(0.02, 0.18 * 10 ** (excess / 20)));
  // a resonance shift: the tone moves by the percentage; a match or a deviation the other way
  const shift = pct ? (/match/i.test(m.label) ? (100 - c.value) / 100 : c.value / 100) : 0;
  const tone = f0 * (1 + (pct ? shift : 0));
  const harmonics = [1, 2, 3, 4.02].map((h, i) => ({ f: tone * h, a: [1, 0.45, 0.22, 0.12][i]!, ph: rng.range(0, 2 * Math.PI) })).filter((h) => h.f < rate / 2 - 100);
  const wobble = rng.range(0.2, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const h of harmonics) v += h.a * Math.sin(2 * Math.PI * h.f * t * (1 + 0.002 * Math.sin(2 * Math.PI * wobble * t)) + h.ph);
    x[i] = v * (count ? 0.1 : level) + rng.normal(0, 0.025);
  }
  // transient hits: a sharp onset and a ring-down at a high frequency
  const hits: number[] = [];
  if (count) {
    const k = Math.max(0, Math.round(c.value));
    for (let j = 0; j < k; j++) hits.push(rng.range(0.1, SECONDS - 0.15));
    hits.sort((a, b) => a - b);
    const hf = Math.min(rate / 2 - 500, Math.max(3000, f0 * (f0 > 5000 ? 1 : 12)));
    for (const at of hits) {
      const s0 = Math.floor(at * rate);
      const len = Math.floor(rate * 0.06);
      for (let i = 0; i < len && s0 + i < n; i++) {
        const t = i / rate;
        x[s0 + i] = x[s0 + i]! + 0.75 * Math.exp(-t * 90) * Math.sin(2 * Math.PI * hf * t) + rng.normal(0, 0.12) * Math.exp(-t * 200);
      }
    }
  }
  // fade in and out so the file starts and ends quietly
  const fade = Math.floor(rate * 0.02);
  for (let i = 0; i < fade; i++) {
    x[i] = x[i]! * (i / fade);
    x[n - 1 - i] = x[n - 1 - i]! * (i / fade);
  }
  const wav = encodeWav(x, rate);

  // spectrogram: frames across the width, bins up the height, dB in the inferno palette
  const W = 400;
  const H = 300;
  const [px0, py0, pw, ph] = [44, 22, 344, 236];
  const fft = rate >= 48000 ? 2048 : 1024;
  const cols = pw;
  const hop = Math.max(1, Math.floor((n - fft) / (cols - 1)));
  const bins = fft / 2;
  const spec = new Float32Array(pw * ph);
  let peak = -Infinity;
  const db: Float32Array[] = [];
  for (let col = 0; col < cols; col++) {
    const mag = spectrum(x.subarray(col * hop, col * hop + fft), fft);
    const out = new Float32Array(ph);
    for (let row = 0; row < ph; row++) {
      const b0 = Math.floor((row / ph) * bins);
      const b1 = Math.max(b0 + 1, Math.floor(((row + 1) / ph) * bins));
      let s = 0;
      for (let b = b0; b < b1; b++) s = Math.max(s, mag[b] ?? 0);
      const d = 20 * Math.log10(s + 1e-9);
      out[row] = d;
      peak = Math.max(peak, d);
    }
    db.push(out);
  }
  for (let col = 0; col < cols; col++) for (let row = 0; row < ph; row++) spec[(ph - 1 - row) * pw + col] = db[col]![row]!;
  const r = new Raster(W, H, [12, 10, 18]);
  r.field(px0, py0, spec, pw, ph, peak - 80, peak, INFERNO);
  r.frame(px0 - 1, py0 - 1, pw + 2, ph + 2, [90, 90, 100]);
  const nyq = rate / 2;
  const kHz = nyq >= 4000;
  for (let i = 0; i <= 4; i++) {
    const f = (nyq * i) / 4;
    const y = py0 + ph - Math.round((ph * i) / 4);
    r.line(px0 - 4, y, px0 - 1, y, WHITE);
    r.text(2, y - 3, kHz ? `${(f / 1000).toFixed(f % 1000 ? 1 : 0)}K` : `${f.toFixed(0)}`, WHITE);
  }
  r.text(2, py0 - 9, kHz ? "KHZ" : "HZ", WHITE);
  for (let s = 0; s <= SECONDS * 2; s++) {
    const xx = px0 + Math.round((pw * s) / (SECONDS * 2));
    r.line(xx, py0 + ph, xx, py0 + ph + 3, WHITE);
    r.text(xx - 6, py0 + ph + 5, `${(s / 2).toFixed(1)}`, WHITE);
  }
  r.text(px0 + pw - 30, py0 + ph + 5, "S", WHITE);
  // the frequency the instrument read, and the reference it is compared with
  const yOf = (f: number) => py0 + ph - Math.round((f / nyq) * ph);
  if (tone < nyq) {
    r.line(px0, yOf(tone), px0 + pw, yOf(tone), [120, 220, 255], 1, 4);
    r.text(px0 + 4, yOf(tone) - 10, `${tone >= 1000 ? `${(tone / 1000).toFixed(2)} KHZ` : `${tone.toFixed(1)} HZ`}`, [120, 220, 255]);
  }
  if (pct && f0 < nyq && Math.abs(tone - f0) > 0.5) {
    r.line(px0, yOf(f0), px0 + pw, yOf(f0), WHITE, 1, 2);
    r.text(px0 + 140, yOf(f0) + 3, "REFERENCE", WHITE);
  }
  for (const at of hits) r.text(px0 + Math.round((at / SECONDS) * pw) - 2, py0 + 2, "V", [120, 220, 255]);
  r.label(px0 + 4, py0 + ph - 18, readout(c), WHITE, [0, 0, 0], 1, 3, 0.65);
  chrome(r, c);
  const png = r.png();
  return { file: { bytes: wav, mime: "audio/wav", ext: "wav" }, preview: { bytes: png, mime: "image/png", ext: "png" }, perceive: png };
}
