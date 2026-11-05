// Tools for the stage's outcomes: the media its machine captured (a thermal image, a micrograph, audio, video, a spectrum,
// a document), each with the value the machine read from it. The interviewer shows each to the contributor and records
// whether they confirm or dispute it; it can also ask the machine about its run.
/** @import { Stage, Outcome, Confirmation } from "./types.js" */
/** @import { ContributionRecord, ToolContext, ToolOutcome } from "./tools.js" */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./canonical.js";
import { formatBytes } from "./evidence.js";
import { excerpt, extensionFor, isImage, isText, MAX_IMAGE_BYTES } from "./media.js";
import { OrdoApiError } from "./ordo-api.js";

export const VERDICTS = /** @type {const} */ (["confirm", "dispute", "unsure"]);

/** @param {string} error @returns {ToolOutcome} */
function fail(error) {
  return { result: { ok: false, error }, finished: false };
}

/** @param {Record<string, unknown>} result @returns {ToolOutcome} */
function ok(result) {
  return { result: { ok: true, ...result }, finished: false };
}

/**
 * The outcome tools this stage offers: review and confirm when it has outcomes, ask_machine when Ordo can relay
 * questions to its machine (a running body).
 * @param {Stage} stage
 */
export function outcomeToolDefinitions(stage) {
  const outcomes = stage.outcomes ?? [];
  const defs = [];
  if (outcomes.length) {
    /** @type {Record<string, unknown>} */
    const key = { type: "string", description: "The outcome's key, from the stage's outcomes.", enum: outcomes.map((o) => o.key) };
    defs.push(
      {
        type: "function",
        function: {
          name: "review_outcome",
          description:
            "Load what the stage's machine captured for one outcome: its value, its target, the machine's own reading, and the media (an image, a video keyframe, an audio spectrogram or a chart follows as an image; a CSV or text file comes back as an excerpt). Describe it briefly to the contributor and ask whether it matches what they saw.",
          parameters: { type: "object", properties: { key }, required: ["key"], additionalProperties: false },
        },
      },
      {
        type: "function",
        function: {
          name: "confirm_outcome",
          description:
            "Record the contributor's verdict on an outcome they reviewed: confirm (it matches what they saw), dispute (it does not: say what differs, and the value they observed if they give one), or unsure. Use only their words; calling it again replaces the verdict.",
          parameters: {
            type: "object",
            properties: {
              key,
              verdict: { type: "string", enum: [...VERDICTS] },
              observed: { type: "number", description: "The value the contributor observed for the outcome's metric, if they gave one." },
              note: { type: "string", description: "What the contributor said about it, in a sentence." },
            },
            required: ["key", "verdict"],
            additionalProperties: false,
          },
        },
      },
    );
  }
  if (stage.machine?.answers) {
    defs.push({
      type: "function",
      function: {
        name: "ask_machine",
        description:
          "Ask the stage's machine a question about its run (what it did, a reading, an anomaly, a decision). Its on-board agent answers from its own log through 0G. Its answer is the machine's account, not the contributor's: use it to ask better questions, never as their statement.",
        parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
      },
    });
  }
  return defs;
}

/**
 * The outcome a model's key names (exact key, else its label).
 * @param {Stage} stage
 * @param {unknown} key
 */
function findOutcome(stage, key) {
  if (typeof key !== "string" || !key.trim()) return undefined;
  const k = key.trim().toLowerCase();
  const outcomes = stage.outcomes ?? [];
  return outcomes.find((o) => o.key === k) ?? outcomes.find((o) => o.label.toLowerCase() === k);
}

/**
 * The target of an outcome's metric, in words.
 * @param {Outcome["metric"]} m
 */
export function targetText(m) {
  const u = m.unit ? ` ${m.unit}` : "";
  if (m.targetMax !== undefined) return `${m.target} to ${m.targetMax}${u}`;
  return `${m.op === ">=" ? "at least" : m.op === "<=" ? "at most" : m.op === "==" || m.op === "=" ? "exactly" : m.op} ${m.target}${u}`;
}

/** @param {Outcome} o */
function facts(o) {
  return { key: o.key, label: o.label, media: o.media, instrument: o.instrument, required: o.required, metric: `${o.metric.label}, target ${targetText(o.metric)}` };
}

/**
 * Required outcomes the machine captured that still need the contributor's confirmation or dispute.
 * @param {Stage} stage
 * @param {ContributionRecord} record
 */
export function pendingOutcomes(stage, record) {
  return (stage.outcomes ?? []).filter(
    (o) => o.required && o.captured && o.output && !record.confirmations.some((c) => c.outcome === o.key && (c.verdict === "confirm" || c.verdict === "dispute")),
  );
}

const strip = (/** @type {string} */ sha) => sha.replace(/^sha256:/, "");

/**
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @param {(line: string) => void} announce
 * @returns {Promise<ToolOutcome>}
 */
export async function reviewOutcome(args, ctx, announce) {
  const o = findOutcome(ctx.stage, args.key);
  if (!o) return fail(`Unknown outcome. Use one of: ${(ctx.stage.outcomes ?? []).map((x) => x.key).join(", ") || "(this stage has none)"}.`);
  const out = o.output;
  if (!o.captured || !out) {
    return ok({
      ...facts(o),
      captured: false,
      note: "The machine has not captured this outcome yet, so there is nothing to review. The contributor may still dispute it or mark it unsure, with a note.",
    });
  }
  /** @type {Record<string, unknown>} */
  const result = {
    ...facts(o),
    captured: true,
    version: out.version,
    sha256: out.sha256,
    mime: out.mime,
    machineValue: out.value,
    unit: o.metric.unit,
    inSpec: o.ok,
    capturedAt: o.capturedAt,
    machineReading: out.analysis ? { summary: out.analysis.summary, anomaly: out.analysis.anomaly ?? null, requestId: out.analysis.requestId ?? null, model: out.analysis.model ?? null, teeVerified: out.analysis.teeVerified ?? null } : null,
  };

  // what the model can see: the file when it is an image, else its preview (keyframe, spectrogram, chart), else a text excerpt
  const which = isImage(out.mime) ? "file" : out.hasPreview ? "preview" : isText(out.mime) ? "file" : null;
  const kind = which === "file" ? (isImage(out.mime) ? (o.media === "thermal" ? "thermal image" : "image") : "excerpt") : which === "preview" ? (o.media === "video" ? "video keyframe" : o.media === "audio" ? "audio spectrogram" : "preview") : "none";
  let saved = null;
  if (which && ctx.client) {
    let got;
    try {
      got = await ctx.client.output(o.key, which, out.version);
    } catch (err) {
      if (err instanceof OrdoApiError) return fail(`Could not load ${o.label} from Ordo: ${err.message}`);
      throw err;
    }
    if (which === "file" && sha256Hex(got.bytes) !== strip(out.sha256)) {
      return fail(`The file Ordo sent for ${o.label} does not match the hash the machine signed. Tell the contributor; do not confirm it.`);
    }
    if (kind === "excerpt") {
      result.excerpt = excerpt(got.bytes);
    } else if (got.bytes.byteLength > MAX_IMAGE_BYTES) {
      result.note = `The ${kind} is ${formatBytes(got.bytes.byteLength)}, too large to show you; rely on the machine's reading and the contributor.`;
    } else if (ctx.media && !ctx.media.fits(got.bytes.byteLength)) {
      return fail(`Too many images for one request. Review ${o.label} again after you have answered.`);
    } else if (ctx.media) {
      const type = isImage(got.mime) ? got.mime : "image/png";
      ctx.media.add(
        `Outcome "${o.label}" (${o.mediaLabel ?? o.media}, ${o.instrument}), version ${out.version}, sha256 ${strip(out.sha256).slice(0, 12)}…: the machine's ${kind}. It read ${out.value}${o.metric.unit ? ` ${o.metric.unit}` : ""}; target ${targetText(o.metric)}.`,
        got.bytes,
        type,
      );
    }
    result.shown = kind === "excerpt" || (ctx.media && !result.note) ? kind : "none";
    // a copy for the contributor to open: they confirm what they saw, not what the model says
    if (ctx.saveDir) {
      try {
        await mkdir(ctx.saveDir, { recursive: true });
        saved = path.join(ctx.saveDir, `${o.key}-v${out.version}${which === "preview" ? "-preview" : ""}${extensionFor(got.mime)}`);
        await writeFile(saved, got.bytes);
      } catch {
        saved = null;
      }
    }
  } else {
    result.shown = "none";
    result.note = "There is no image or text to show for this file; rely on the machine's reading and the contributor.";
  }
  ctx.record.reviewed[o.key] = { sha256: out.sha256, version: out.version };
  announce(
    `showed the interviewer ${o.label}${kind !== "none" ? ` (${kind}, v${out.version})` : ""}: the machine read ${out.value}${o.metric.unit ? ` ${o.metric.unit}` : ""}, target ${targetText(o.metric)}${saved ? `\n      open it: ${saved}` : ""}`,
  );
  return ok(result);
}

/**
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @param {(line: string) => void} announce
 * @returns {ToolOutcome}
 */
export function confirmOutcome(args, ctx, announce) {
  const o = findOutcome(ctx.stage, args.key);
  if (!o) return fail(`Unknown outcome. Use one of: ${(ctx.stage.outcomes ?? []).map((x) => x.key).join(", ") || "(this stage has none)"}.`);
  const verdict = typeof args.verdict === "string" ? args.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.includes(/** @type {any} */ (verdict))) return fail(`verdict is one of: ${VERDICTS.join(", ")}.`);
  const reviewed = ctx.record.reviewed[o.key];
  if (o.captured && o.output && !reviewed) return fail(`Show ${o.label} to the contributor first: call review_outcome with key "${o.key}".`);
  if (verdict === "confirm" && !reviewed) return fail(`Nothing was captured for ${o.label}, so there is nothing to confirm. Record dispute or unsure, with what the contributor said.`);
  const raw = typeof args.observed === "string" && args.observed.trim() !== "" ? Number(args.observed) : args.observed;
  if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isFinite(raw))) return fail("observed must be a number: the value the contributor observed, or leave it out.");
  const note = typeof args.note === "string" ? args.note.trim().slice(0, 2000) : "";
  if (verdict === "dispute" && !note && raw === undefined) return fail("A dispute says what the contributor saw instead: give a note, the value they observed, or both.");

  /** @type {Confirmation} */
  const c = { outcome: o.key, sha256: reviewed?.sha256 ?? null, verdict: /** @type {Confirmation["verdict"]} */ (verdict), note };
  if (typeof raw === "number") c.observed = raw;
  const index = ctx.record.confirmations.findIndex((x) => x.outcome === o.key);
  if (index >= 0) ctx.record.confirmations[index] = c;
  else ctx.record.confirmations.push(c);
  const word = verdict === "confirm" ? "confirmed" : verdict === "dispute" ? "disputed" : "unsure";
  announce(`${o.label}: ${word}${c.observed !== undefined ? `, observed ${c.observed}${o.metric.unit ? ` ${o.metric.unit}` : ""}` : ""}${note ? ` (${note.length > 70 ? `${note.slice(0, 69)}…` : note})` : ""}`);
  return ok({ recorded: c, replacedEarlierVerdict: index >= 0, outcomesToReview: pendingOutcomes(ctx.stage, ctx.record).map((x) => x.key) });
}

/**
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @returns {Promise<ToolOutcome>}
 */
export async function askMachine(args, ctx) {
  const machine = ctx.stage.machine;
  if (!machine) return fail("This stage has no machine to ask.");
  if (typeof args.question !== "string" || args.question.trim().length < 3) return fail("question is required.");
  if (!ctx.client) return fail("The machine cannot be asked from this session.");
  try {
    const a = await ctx.client.askMachine(args.question.trim().slice(0, 1000));
    ctx.inform?.(`${machine.name ?? "the machine"}: ${a.answer}${a.requestId ? `  [0G request ${a.requestId}]` : "  [no 0G brain]"}`);
    return ok({
      answer: a.answer,
      requestId: a.requestId,
      model: a.model,
      note: "This is the machine's own account, from its log. It is not the contributor's statement; ask them whether it matches what they saw.",
    });
  } catch (err) {
    if (err instanceof OrdoApiError) return fail(err.message);
    throw err;
  }
}
