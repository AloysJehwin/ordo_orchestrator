import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./edge.js";
import { readLog, type Entry } from "./episode.js";
import type { CaptureSpec } from "./media/capture.js";
import { render } from "./media/render.js";

/**
 * `body replay <episode> [out-dir]`: renders every capture in an episode log again from the seed and what the log
 * recorded, writes the files to the out directory, and checks each against the SHA-256 the machine signed and uploaded.
 * Images, audio, spectra and documents come out byte for byte; video matches on the same ffmpeg build.
 */
export async function replay(path: string, outDir?: string): Promise<number> {
  const { header, entries } = readLog(path);
  if (!header) throw new Error("The log has no start entry or header: it does not say the seed, asset and machine to render from");
  const out = resolve(outDir ?? `replay-${header.asset}`);
  mkdirSync(out, { recursive: true });
  const captures = entries.filter((e): e is Extract<Entry, { kind: "capture" }> => e.kind === "capture");
  let same = 0;
  let differ = 0;
  let skipped = 0;
  for (const e of captures) {
    const spec: CaptureSpec = {
      seed: header.seed,
      asset: header.asset,
      kind: header.machine,
      device: header.device,
      runId: e.runId,
      stage: e.stage,
      stageName: e.stageName,
      outcome: e.outcome,
      attempt: e.attempt,
      value: e.value,
      capturedAt: e.capturedAt,
      progress: e.progress,
      signals: e.signals,
    };
    const res = await render(spec);
    const name = `${e.runId}-${e.stage}-${e.outcome.key}-a${e.attempt}`;
    if ("skipped" in res) {
      skipped++;
      console.log(`${name}: not rendered (${res.skipped})`);
      continue;
    }
    writeFileSync(join(out, `${name}.${res.file.ext}`), res.file.bytes);
    if (res.preview) writeFileSync(join(out, `${name}-preview.${res.preview.ext}`), res.preview.bytes);
    const hex = `sha256:${sha256(res.file.bytes)}`;
    if (!e.sha256) console.log(`${name}: rendered ${hex} (the machine did not upload it${e.skipped ? `: ${e.skipped}` : e.error ? `: ${e.error}` : ""})`);
    else if (hex === e.sha256) {
      same++;
      console.log(`${name}: same bytes as signed (${hex})`);
    } else {
      differ++;
      console.log(`${name}: differs: the log says ${e.sha256}, replay gives ${hex}${res.file.mime === "video/mp4" ? " (video depends on the ffmpeg build)" : ""}`);
    }
  }
  const perceptions = entries.filter((e) => e.kind === "perception").length;
  const decisions = entries.filter((e) => e.kind === "decision").length;
  console.log(`\n${captures.length} capture(s): ${same} reproduced exactly, ${differ} differ, ${skipped} not rendered. ${perceptions} perception(s) and ${decisions} decision(s) in the log, each with its 0G request ID. Files in ${out}`);
  return differ ? 1 : 0;
}
