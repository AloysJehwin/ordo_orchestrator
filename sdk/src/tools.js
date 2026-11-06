// The tools the interviewer model can call, and the record they build.
/** @import { Stage, Session, Measurement, Note, Evidence, Confirmation, VoiceNote, Receipt } from "./types.js" */
/** @import { MediaQueue } from "./media.js" */
/** @import { OrdoClient } from "./ordo-api.js" */
/** @import { TranscriptionResult } from "./router.js" */
import { readFile } from "node:fs/promises";
import { sha256Hex } from "./canonical.js";
import { EvidenceError, hashEvidence, formatBytes, MAX_EVIDENCE_BYTES } from "./evidence.js";
import { isImage, isVoiceNote, MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, mediaTypeOf, readHead } from "./media.js";
import { askMachine, confirmOutcome, outcomeToolDefinitions, pendingOutcomes, reviewOutcome } from "./outcome-tools.js";
import { describeRouterError } from "./router.js";

/**
 * @typedef {object} ContributionRecord
 * @property {Measurement[]} measurements
 * @property {Note[]} notes
 * @property {Evidence[]} evidence
 * @property {Confirmation[]} confirmations  The contributor's verdicts on the machine's outcomes.
 * @property {VoiceNote[]} voiceNotes
 * @property {Record<string, { sha256: string, version: number }>} reviewed  Outcomes shown to the model, by key (kept here, not sent).
 * @property {string} summary
 */

/** @returns {ContributionRecord} */
export function createRecord() {
  return { measurements: [], notes: [], evidence: [], confirmations: [], voiceNotes: [], reviewed: {}, summary: "" };
}

/**
 * @typedef {object} Measurable
 * @property {string} key        Exact criterion label or parameter signal.
 * @property {"criterion" | "parameter"} kind
 * @property {string} [unit]
 */

/**
 * The names record_measurement accepts: every criterion label, then every parameter signal.
 * @param {Stage} stage
 * @returns {Measurable[]}
 */
export function measurables(stage) {
  /** @type {Measurable[]} */
  const list = [];
  const seen = new Set();
  for (const c of stage.criteria) {
    if (typeof c?.label !== "string" || !c.label.trim() || seen.has(c.label)) continue;
    seen.add(c.label);
    list.push({ key: c.label, kind: "criterion", unit: c.unit || undefined });
  }
  for (const p of stage.parameters) {
    if (typeof p?.signal !== "string" || !p.signal.trim() || seen.has(p.signal)) continue;
    seen.add(p.signal);
    list.push({ key: p.signal, kind: "parameter", unit: p.unit || undefined });
  }
  return list;
}

/** @param {string} s */
function normalizeName(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * OpenAI-format tool definitions.
 * @param {Stage} stage
 */
export function toolDefinitions(stage) {
  const names = measurables(stage).map((m) => m.key);
  /** @type {Record<string, unknown>} */
  const criterion = {
    type: "string",
    description: "Exact criterion label or parameter signal from the stage.",
  };
  if (names.length) criterion.enum = names;
  return [
    {
      type: "function",
      function: {
        name: "record_measurement",
        description:
          "Record one value the contributor measured, exactly as they stated it. Calling it again for the same criterion replaces the earlier value. Never invent, estimate or convert values.",
        parameters: {
          type: "object",
          properties: {
            criterion,
            value: { type: "number", description: "The number the contributor gave." },
            unit: { type: "string", description: "The unit the contributor gave, if any." },
            note: { type: "string", description: "Short context for this value, if the contributor gave any." },
          },
          required: ["criterion", "value"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "note",
        description:
          "Record one fact worth keeping: what was done, conditions, tools used, an anomaly or deviation, or why something was not measured.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "attach_evidence",
        description:
          "Attach an evidence file from the contributor's machine (path as they typed it, relative to their working directory or absolute). The file is hashed locally; Ordo gets only its name, size, type and SHA-256. For a photo, the terminal asks the contributor whether to show it to you (it then follows as an image); for a voice note, whether to transcribe it (the transcript comes back in the result). Other files stay hash-only.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    ...outcomeToolDefinitions(stage),
    {
      type: "function",
      function: {
        name: "finish",
        description:
          "Submit the record once the contributor has agreed to your summary. The terminal asks them to confirm before anything is sent. When the stage has outcomes, every required one the machine captured must first be reviewed and confirmed or disputed.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Two to four plain sentences describing the work and its results." },
          },
          required: ["summary"],
          additionalProperties: false,
        },
      },
    },
  ];
}

/**
 * @typedef {object} ToolContext
 * @property {Stage} stage
 * @property {ContributionRecord} record
 * @property {string} cwd
 * @property {string[]} [searchDirs]  More directories a relative evidence path may be in: the notes file's.
 * @property {(summary: string) => Promise<boolean>} confirmFinish
 * @property {(line: string) => void} [announce]  Shows the contributor what was recorded.
 * @property {number} [maxEvidenceBytes]
 * @property {(question: string) => Promise<boolean>} [consent]  Asks the contributor yes or no (default no) before a file goes to a model.
 * @property {MediaQueue} [media]  Images for the model, sent after this round's tool results.
 * @property {{ model: string, audioModel?: string | null, transcribe?: (input: { bytes: Uint8Array, filename: string }) => Promise<TranscriptionResult> }} [router]
 * @property {Pick<OrdoClient, "output" | "askMachine">} [client]
 * @property {(receipt: Receipt) => void} [addReceipt]  Keeps the receipt of a 0G call made by a tool (a transcription).
 * @property {(line: string) => void} [inform]  Shows the contributor something verbatim: a transcript, the machine's answer.
 * @property {() => Promise<void>} [refreshOutcomes]  Reloads what the machine captured, before finishing.
 * @property {string} [saveDir]  Where review_outcome saves the machine's media for the contributor to open.
 */

/**
 * @typedef {object} ToolOutcome
 * @property {Record<string, unknown>} result  Sent back to the model as the tool message.
 * @property {boolean} finished                True once the contributor confirmed submission.
 */

/**
 * Run one tool call.
 * @param {string} name
 * @param {string} argsJson
 * @param {ToolContext} ctx
 * @returns {Promise<ToolOutcome>}
 */
export async function runTool(name, argsJson, ctx) {
  /** @type {Record<string, unknown>} */
  let args;
  try {
    const parsed = argsJson ? JSON.parse(argsJson) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    args = parsed;
  } catch {
    return fail(`The arguments for ${name} were not a JSON object. Call it again with valid arguments.`);
  }
  const announce = ctx.announce ?? (() => {});
  switch (name) {
    case "record_measurement":
      return recordMeasurement(args, ctx, announce);
    case "note":
      return addNote(args, ctx, announce);
    case "attach_evidence":
      return attachEvidence(args, ctx, announce);
    case "review_outcome":
      return reviewOutcome(args, ctx, announce);
    case "confirm_outcome":
      return confirmOutcome(args, ctx, announce);
    case "ask_machine":
      return askMachine(args, ctx);
    case "finish":
      return finish(args, ctx);
    default:
      return fail(`Unknown tool "${name}". Available tools: ${/** @type {any[]} */ (toolDefinitions(ctx.stage)).map((t) => t.function.name).join(", ")}.`);
  }
}

/** @param {string} error @returns {ToolOutcome} */
function fail(error) {
  return { result: { ok: false, error }, finished: false };
}

/** @param {Record<string, unknown>} result @returns {ToolOutcome} */
function ok(result) {
  return { result: { ok: true, ...result }, finished: false };
}

/**
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @param {(line: string) => void} announce
 */
function recordMeasurement(args, ctx, announce) {
  const list = measurables(ctx.stage);
  if (!list.length) {
    return fail("This stage has no criteria or parameters to measure. Use note to record what the contributor reported.");
  }
  const valid = list.map((m) => m.key);
  if (typeof args.criterion !== "string" || !args.criterion.trim()) {
    return fail(`criterion is required. Use one of: ${valid.join(", ")}.`);
  }
  const wanted = normalizeName(args.criterion);
  const match = list.find((m) => normalizeName(m.key) === wanted);
  if (!match) {
    return fail(`"${args.criterion}" is not a criterion or parameter of this stage. Use one of: ${valid.join(", ")}.`);
  }
  const value = typeof args.value === "string" && args.value.trim() !== "" ? Number(args.value) : args.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(`value must be a number for "${match.key}". Ask the contributor for the number if it is unclear.`);
  }
  /** @type {Measurement} */
  const measurement = { criterion: match.key, value };
  if (typeof args.unit === "string" && args.unit.trim()) measurement.unit = args.unit.trim();
  if (typeof args.note === "string" && args.note.trim()) measurement.note = args.note.trim();

  const index = ctx.record.measurements.findIndex((m) => m.criterion === match.key);
  const replaced = index >= 0;
  if (replaced) ctx.record.measurements[index] = measurement;
  else ctx.record.measurements.push(measurement);

  announce(`${replaced ? "updated" : "recorded"} ${match.key} = ${value}${measurement.unit ? ` ${measurement.unit}` : ""}`);
  /** @type {Record<string, unknown>} */
  const result = { recorded: measurement, replacedEarlierValue: replaced };
  if (match.unit && measurement.unit && normalizeName(match.unit) !== normalizeName(measurement.unit)) {
    result.warning = `The stage specifies "${match.unit}" for ${match.key}; the contributor's unit was "${measurement.unit}". Confirm the unit with them if unsure.`;
  } else if (match.unit && !measurement.unit) {
    result.warning = `No unit recorded; the stage specifies "${match.unit}". If the contributor gave a unit, record the value again with it.`;
  }
  const remaining = list.filter((m) => !ctx.record.measurements.some((r) => r.criterion === m.key)).map((m) => m.key);
  result.notYetRecorded = remaining;
  return ok(result);
}

/**
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @param {(line: string) => void} announce
 */
function addNote(args, ctx, announce) {
  if (typeof args.text !== "string" || !args.text.trim()) return fail("text is required.");
  const text = args.text.trim().slice(0, 4000);
  ctx.record.notes.push({ text, at: new Date().toISOString() });
  announce(`noted: ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`);
  return ok({ noteCount: ctx.record.notes.length });
}

/**
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @param {(line: string) => void} announce
 */
async function attachEvidence(args, ctx, announce) {
  if (typeof args.path !== "string" || !args.path.trim()) return fail("path is required.");
  /** @type {import("./evidence.js").HashedEvidence} */
  let file;
  try {
    file = await hashEvidence(args.path, { cwd: ctx.cwd, maxBytes: ctx.maxEvidenceBytes ?? MAX_EVIDENCE_BYTES, alsoIn: ctx.searchDirs });
  } catch (err) {
    if (!(err instanceof EvidenceError)) throw err;
    // a file already attached by name (the notes file, given as --notes): nothing to do
    const name = args.path.trim().replace(/^(['"])(.*)\1$/s, "$2").split(/[/\\]/).pop();
    const known = ctx.record.evidence.find((e) => e.name === name);
    if (known) return ok({ alreadyAttached: true, name: known.name, size: known.size, sha256: known.sha256 });
    return fail(err.message);
  }
  const type = mediaTypeOf(await readHead(file.path).catch(() => new Uint8Array()), file.name);
  let entry = ctx.record.evidence.find((e) => e.sha256 === file.sha256);
  if (entry) {
    // already hashed: a photo or voice note the model has not read yet may still be shown or transcribed
    const again = !entry.analyzedBy && (isImage(entry.mediaType) || isVoiceNote(entry.mediaType));
    if (!again) return ok({ alreadyAttached: true, name: entry.name, size: entry.size, sha256: entry.sha256, ...(entry.analyzedBy ? { analyzedBy: entry.analyzedBy.kind } : {}) });
  } else {
    entry = { name: file.name, sha256: file.sha256, size: file.size };
    if (type) entry.mediaType = type;
    ctx.record.evidence.push(entry);
    announce(`hashed ${file.name} (${formatBytes(file.size)}) sha256 ${file.sha256.slice(0, 16)}…  (the file stays on this machine)`);
  }
  /** @type {Record<string, unknown>} */
  const result = { name: entry.name, size: entry.size, sha256: entry.sha256, mediaType: type ?? null, uploaded: false };
  if (isImage(type)) Object.assign(result, await showImage(file, entry, /** @type {string} */ (type), ctx, announce));
  else if (isVoiceNote(type)) Object.assign(result, await transcribeNote(file, entry, /** @type {string} */ (type), ctx, announce));
  return ok(result);
}

/**
 * Read a file again and check it is still the one that was hashed.
 * @param {import("./evidence.js").HashedEvidence} file
 */
async function readHashed(file) {
  const bytes = new Uint8Array(await readFile(file.path));
  return sha256Hex(bytes) === file.sha256 ? bytes : null;
}

/**
 * A photo goes to the chat model only if the contributor says yes, for this file.
 * @param {import("./evidence.js").HashedEvidence} file
 * @param {Evidence} entry
 * @param {string} type
 * @param {ToolContext} ctx
 * @param {(line: string) => void} announce
 * @returns {Promise<Record<string, unknown>>}
 */
async function showImage(file, entry, type, ctx, announce) {
  const model = ctx.router?.model ?? "the interviewer model";
  if (!ctx.media || !ctx.consent) return { shownToModel: false };
  if (file.size > MAX_IMAGE_BYTES) {
    announce(`${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_IMAGE_BYTES)} the model is shown; only its hash is kept`);
    return { shownToModel: false, note: `Too large to show you (${formatBytes(file.size)}; the limit is ${formatBytes(MAX_IMAGE_BYTES)}). Its hash is recorded. If you need to see it, ask the contributor for a smaller copy.` };
  }
  if (!ctx.media.fits(file.size)) {
    return { shownToModel: false, note: "Too many images for one request. Attach it again after you have answered; it will not be hashed twice." };
  }
  const yes = await ctx.consent(`Show ${file.name} (${formatBytes(file.size)}) to the interviewer model ${model}? It goes only to the 0G TEE provider; Ordo gets its hash.`);
  if (!yes) return { shownToModel: false, note: "The contributor chose not to show it to you; only its hash is recorded." };
  const bytes = await readHashed(file);
  if (!bytes) return { shownToModel: false, note: "The file changed after it was hashed. Ask the contributor to attach it again." };
  ctx.media.add(
    `Evidence photo ${file.name} (sha256 ${file.sha256.slice(0, 12)}…), shown with the contributor's consent. Describe what you see; take no value from it unless the contributor states it.`,
    bytes,
    type,
  );
  entry.analyzedBy = { model, requestId: null, kind: "vision" };
  announce(`showing ${file.name} to ${model} (you agreed)`);
  return { shownToModel: true, note: "The image follows these tool results." };
}

/**
 * A voice note is transcribed through 0G only if the contributor says yes, for this file.
 * @param {import("./evidence.js").HashedEvidence} file
 * @param {Evidence} entry
 * @param {string} type
 * @param {ToolContext} ctx
 * @param {(line: string) => void} announce
 * @returns {Promise<Record<string, unknown>>}
 */
async function transcribeNote(file, entry, type, ctx, announce) {
  const model = ctx.router?.audioModel;
  const transcribe = ctx.router?.transcribe;
  if (!model || !transcribe || !ctx.consent) return { transcribed: false, note: "This session has no speech-to-text model, so the voice note was not transcribed. Its hash is recorded; ask the contributor to say what it contains." };
  if (file.size > MAX_AUDIO_BYTES) {
    announce(`${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_AUDIO_BYTES)} that can be transcribed; only its hash is kept`);
    return { transcribed: false, note: `Too long to transcribe (${formatBytes(file.size)}; the limit is ${formatBytes(MAX_AUDIO_BYTES)}). Its hash is recorded.` };
  }
  const yes = await ctx.consent(`Transcribe ${file.name} (${formatBytes(file.size)}) with ${model} on 0G Private Computer (TEE)? The transcript goes into your record; the audio never reaches Ordo.`);
  if (!yes) return { transcribed: false, note: "The contributor chose not to transcribe it; only its hash is recorded." };
  const bytes = await readHashed(file);
  if (!bytes) return { transcribed: false, note: "The file changed after it was hashed. Ask the contributor to attach it again." };
  /** @type {TranscriptionResult} */
  let t;
  try {
    t = await transcribe({ bytes, filename: file.name });
  } catch (err) {
    return { transcribed: false, error: describeRouterError(err, model) };
  }
  ctx.addReceipt?.(t.receipt);
  entry.analyzedBy = { model, requestId: t.receipt.requestId, kind: "transcription" };
  ctx.record.voiceNotes.push({ name: file.name, sha256: file.sha256, size: file.size, mediaType: type, transcript: t.text.slice(0, 20_000), model, requestId: t.receipt.requestId, at: new Date().toISOString() });
  announce(`transcribed ${file.name} with ${model}${t.receipt.requestId ? ` (0G request ${t.receipt.requestId})` : ""}`);
  ctx.inform?.(`“${t.text}”`);
  return {
    transcribed: true,
    transcript: t.text,
    requestId: t.receipt.requestId,
    note: "This is the contributor's voice note. Read back any value you take from it, and record it only once they confirm.",
  };
}

/**
 * Once the model has answered a request that carried images, the photos it was shown have a request id.
 * @param {ContributionRecord} record
 * @param {string | null} requestId
 */
export function settleVision(record, requestId) {
  for (const e of record.evidence) {
    if (e.analyzedBy?.kind === "vision" && e.analyzedBy.requestId === null) e.analyzedBy.requestId = requestId;
  }
}

/**
 * Photos queued for the model but never sent (the interview ended first) were not read by it.
 * @param {ContributionRecord} record
 */
export function unsentVision(record) {
  for (const e of record.evidence) {
    if (e.analyzedBy?.kind === "vision" && e.analyzedBy.requestId === null) delete e.analyzedBy;
  }
}

/**
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @returns {Promise<ToolOutcome>}
 */
async function finish(args, ctx) {
  if (typeof args.summary !== "string" || !args.summary.trim()) {
    return fail("summary is required: two to four sentences the contributor agreed to.");
  }
  const summary = args.summary.trim().slice(0, 4000);
  // the machine may have captured more since the interview started: reload, then check every required outcome has a verdict
  if (ctx.refreshOutcomes) await ctx.refreshOutcomes().catch(() => {});
  const missing = pendingOutcomes(ctx.stage, ctx.record);
  if (missing.length) {
    return {
      result: {
        ok: false,
        error: `Not finished: the contributor has not confirmed or disputed ${missing.map((o) => `"${o.label}"`).join(", ")}. Show each with review_outcome, ask them, and record their verdict with confirm_outcome (confirm or dispute; "unsure" is not enough for a required outcome).`,
        missing: missing.map((o) => o.key),
      },
      finished: false,
    };
  }
  const confirmed = await ctx.confirmFinish(summary);
  if (!confirmed) {
    return {
      result: {
        ok: false,
        submitted: false,
        error: "The contributor did not confirm. Nothing was sent. Ask what they want to change.",
      },
      finished: false,
    };
  }
  ctx.record.summary = summary;
  return { result: { ok: true, submitted: true }, finished: true };
}
