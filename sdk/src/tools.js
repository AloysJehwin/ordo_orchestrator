// The tools the interviewer model can call, and the record they build.
/** @import { Stage, Measurement, Note, Evidence } from "./types.js" */
import { EvidenceError, hashEvidence, formatBytes, MAX_EVIDENCE_BYTES } from "./evidence.js";

/**
 * @typedef {object} ContributionRecord
 * @property {Measurement[]} measurements
 * @property {Note[]} notes
 * @property {Evidence[]} evidence
 * @property {string} summary
 */

/** @returns {ContributionRecord} */
export function createRecord() {
  return { measurements: [], notes: [], evidence: [], summary: "" };
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
          "Attach an evidence file from the contributor's machine (path as they typed it, relative to their working directory or absolute). The file is hashed locally and never uploaded; only its name, size and SHA-256 are recorded.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description:
          "Submit the record once the contributor has agreed to your summary. The terminal asks them to confirm before anything is sent.",
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
 * @property {(summary: string) => Promise<boolean>} confirmFinish
 * @property {(line: string) => void} [announce]  Shows the contributor what was recorded.
 * @property {number} [maxEvidenceBytes]
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
    case "finish":
      return finish(args, ctx);
    default:
      return fail(`Unknown tool "${name}". Available tools: record_measurement, note, attach_evidence, finish.`);
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
  try {
    const file = await hashEvidence(args.path, { cwd: ctx.cwd, maxBytes: ctx.maxEvidenceBytes ?? MAX_EVIDENCE_BYTES });
    const duplicate = ctx.record.evidence.find((e) => e.sha256 === file.sha256);
    if (duplicate) {
      return ok({ alreadyAttached: true, name: duplicate.name, size: duplicate.size, sha256: duplicate.sha256 });
    }
    ctx.record.evidence.push({ name: file.name, sha256: file.sha256, size: file.size });
    announce(`hashed ${file.name} (${formatBytes(file.size)}) sha256 ${file.sha256.slice(0, 16)}…  (the file stays on this machine)`);
    return ok({ name: file.name, size: file.size, sha256: file.sha256, uploaded: false });
  } catch (err) {
    if (err instanceof EvidenceError) return fail(err.message);
    throw err;
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
