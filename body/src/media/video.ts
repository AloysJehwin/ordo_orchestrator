import { fmt, isCount } from "../metric.js";
import { chrome, readout, renderRng, type CaptureSpec, type RenderResult } from "./capture.js";
import { encodeMp4 } from "./mp4.js";
import { AMBER, GREEN, INK, noise, Raster, RED, WHITE, type RGB } from "./raster.js";

const W = 320;
const H = 240;
const FPS = 8;
const FRAMES = 32;

type Scene = "events" | "timer" | "fill" | "angle" | "rate";

function sceneOf(c: CaptureSpec): Scene {
  const m = c.outcome.metric;
  const unit = m.unit.trim().toLowerCase();
  if (isCount(m) || /events|strikes|misses|violations|deviations|findings|dropouts|tears|streaks|nonconform/i.test(m.label)) return "events";
  if (unit === "s" || unit === "min" || unit === "h") return "timer";
  if (unit === "%") return "fill";
  if (unit === "°" || unit === "deg") return "angle";
  return "rate";
}

/**
 * A four-second recording (320×240, 8 fps) of the machine at work and its keyframe. The scene follows the metric:
 * a count shows each event as it happens and tallies it, a duration runs a clock to the value read, a percentage
 * fills the area covered, an angle tilts the surface, and a rate moves the part at that speed.
 */
export async function renderVideo(c: CaptureSpec): Promise<RenderResult> {
  const rng = renderRng(c);
  const m = c.outcome.metric;
  const scene = sceneOf(c);
  const bg = noise(W, H, rng, 32, 3);
  const tint: RGB = c.kind === "process_vessel" ? [70, 40, 30] : c.kind === "cnc" ? [44, 48, 56] : c.kind === "robot" ? [50, 52, 44] : [46, 46, 52];
  const base = new Raster(W, H, tint);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = bg[y * W + x]! * 40 - 20 - Math.max(0, Math.hypot(x - W / 2, y - H / 2) / 160 - 0.7) * 60;
      base.set(x, y, [tint[0] + v, tint[1] + v, tint[2] + v]);
    }
  const n = Math.max(0, Math.round(c.value));
  // events land at frames spread through the clip, each a flash for two frames
  const events = scene === "events" ? Array.from({ length: n }, () => ({ at: 2 + rng.int(FRAMES - 6), x: rng.range(40, W - 40), y: rng.range(40, H - 50) })).sort((a, b) => a.at - b.at) : [];
  const frames: Raster[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const r = new Raster(W, H);
    r.draw(base, 0, 0);
    const t = f / (FRAMES - 1);
    if (scene === "events") {
      // a carriage (recoater, head, camera pan) sweeping across, the events flashing where they happen
      const sx = 20 + ((f * 9) % (W - 40));
      r.rect(sx, 30, 10, H - 70, [150, 156, 168], 0.8);
      r.rect(20, H - 44, W - 40, 6, [110, 110, 120]);
      let seen = 0;
      for (const e of events) {
        if (e.at <= f) seen++;
        if (e.at === f || e.at === f - 1) {
          r.disc(e.x, e.y, e.at === f ? 14 : 9, [255, 236, 170], 0.85);
          r.ring(e.x, e.y, 20, RED, 2);
        } else if (e.at < f) r.ring(e.x, e.y, 10, RED, 1, 0.6);
      }
      r.label(8, 20, `${m.label}: ${seen}`, WHITE, seen ? RED : GREEN, 1, 3, 0.8);
    } else if (scene === "timer") {
      // a clock running to the time read, sped up to fit the clip
      const now = c.value * t;
      const ang = 2 * Math.PI * t - Math.PI / 2;
      r.ring(W / 2, H / 2 - 4, 60, WHITE, 2);
      r.line(W / 2, H / 2 - 4, W / 2 + Math.cos(ang) * 52, H / 2 - 4 + Math.sin(ang) * 52, AMBER, 3);
      r.rect(40, H - 46, (W - 80) * t, 8, AMBER);
      r.frame(40, H - 46, W - 80, 8, WHITE);
      r.label(8, 20, `T+ ${fmt(now, m)}`, WHITE, INK, 2, 3, 0.8);
    } else if (scene === "fill") {
      // a raster scan covering the area up to the percentage read
      const cover = (c.value / 100) * t;
      const rows = 12;
      const cells = Math.round(cover * rows * 16);
      for (let k = 0; k < Math.min(cells, rows * 16); k++) {
        const row = Math.floor(k / 16);
        const col = row % 2 ? 15 - (k % 16) : k % 16;
        r.rect(32 + col * 16, 30 + row * 14, 15, 13, [60, 170, 120], 0.55);
      }
      r.frame(32, 30, 256, rows * 14, WHITE);
      r.label(8, H - 40, `${m.label}: ${(cover * 100).toFixed(1)} %`, WHITE, INK, 1, 3, 0.8);
    } else if (scene === "angle") {
      // a rotating drum with the powder surface at the angle read
      const cx = W / 2;
      const cy = H / 2;
      const a = (c.value * Math.PI) / 180;
      r.disc(cx, cy, 82, [30, 30, 36]);
      r.ring(cx, cy, 82, [180, 180, 190], 3);
      for (let y = -80; y <= 80; y++)
        for (let x = -80; x <= 80; x++) if (x * x + y * y < 78 * 78 && y > -x * Math.tan(a) * t) r.blend(cx + x, cy + y, [196, 176, 140], 0.9);
      r.label(8, 20, `${m.label}: ${(c.value * t).toFixed(1)} °`, WHITE, INK, 1, 3, 0.8);
    } else {
      // the part moving at the rate read, with a ruler beside it
      const travel = (H - 80) * t;
      r.rect(W / 2 - 40, 30 + travel, 80, 40, [200, 120, 60]);
      for (let k = 0; k < 10; k++) r.line(W / 2 + 60, 30 + k * 16, W / 2 + 70, 30 + k * 16, WHITE);
      r.label(8, 20, `${m.label}: ${fmt(c.value, m)}`, WHITE, INK, 1, 3, 0.8);
    }
    r.text(W - 54, 20, `${String(Math.floor(f / FPS)).padStart(2, "0")}:${String(Math.floor(((f % FPS) / FPS) * 100)).padStart(2, "0")}`, WHITE);
    chrome(r, c);
    frames.push(r);
  }
  const mp4 = await encodeMp4(frames, FPS);
  if ("skipped" in mp4) return mp4;
  const key = frames.at(-1)!;
  key.label(8, H - 30, readout(c), WHITE, INK, 1, 3, 0.8);
  const png = key.png();
  return { file: { bytes: mp4.bytes, mime: "video/mp4", ext: "mp4" }, preview: { bytes: png, mime: "image/png", ext: "png" }, perceive: png };
}
