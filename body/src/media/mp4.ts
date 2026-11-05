import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Raster } from "./raster.js";

let found: Promise<string | null> | null = null;
/**
 * The ffmpeg the body encodes video with: BODY_FFMPEG, else the ffmpeg-static package (when its binary was
 * downloaded), else ffmpeg on PATH. None: video outcomes are skipped, never faked.
 */
export function ffmpegPath(): Promise<string | null> {
  found ??= (async () => {
    if (process.env.BODY_FFMPEG) return existsSync(process.env.BODY_FFMPEG) ? process.env.BODY_FFMPEG : null;
    try {
      const mod = (await import("ffmpeg-static" as string)) as { default?: string | null };
      if (mod.default && existsSync(mod.default)) return mod.default;
    } catch {
      // optional dependency, not installed
    }
    const probe = spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return probe.status === 0 ? "ffmpeg" : null;
  })();
  return found;
}

function run(bin: string, args: string[], input: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()).length > 4000 && (err = err.slice(-4000)));
    p.on("error", (e) => resolve(e.message));
    p.on("close", (code) => resolve(code === 0 ? null : err.trim().split("\n").at(-1) ?? `exit ${code}`));
    p.stdin.on("error", () => undefined);
    p.stdin.end(input);
  });
}

/**
 * Frames to an H.264 MP4 (MPEG-4 Part 2 when the ffmpeg has no libx264), single-threaded and bit-exact so the same
 * frames give the same file on the same ffmpeg. Returns why it could not, instead of a file, when there is no ffmpeg.
 */
export async function encodeMp4(frames: Raster[], fps: number): Promise<{ bytes: Uint8Array } | { skipped: string }> {
  const bin = await ffmpegPath();
  if (!bin) return { skipped: "no ffmpeg on this machine (install ffmpeg-static or set BODY_FFMPEG)" };
  const { w, h } = frames[0]!;
  if (w % 2 || h % 2) throw new Error("Video frames need an even width and height");
  const dir = await mkdtemp(join(tmpdir(), "ordo-body-"));
  const out = join(dir, "out.mp4");
  try {
    const input = Buffer.concat(frames.map((f) => Buffer.from(f.data)));
    const head = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-r", String(fps), "-i", "pipe:0"];
    const tail = ["-pix_fmt", "yuv420p", "-movflags", "+faststart", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1", "-threads", "1", "-an", out];
    let err = await run(bin, [...head, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", ...tail], input);
    if (err) err = await run(bin, [...head, "-c:v", "mpeg4", "-q:v", "5", ...tail], input);
    if (err) return { skipped: `ffmpeg could not encode the video: ${err}` };
    return { bytes: new Uint8Array(await readFile(out)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
