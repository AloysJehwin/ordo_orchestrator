// The interview: a chat loop between the contributor (stdin) and the interviewer model
// (the Router, or the scripted mock), with tool calls that build the record.
/** @import { Session, Stage, ChatMessage, Receipt, TranscriptEntry } from "./types.js" */
/** @import { RouterClient } from "./router.js" */
/** @import { Terminal } from "./io.js" */
/** @import { ContributionRecord } from "./tools.js" */
/** @import { OrdoClient } from "./ordo-api.js" */
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { EvidenceError, formatBytes, hashEvidence } from "./evidence.js";
import { contentText, createMediaQueue, stripImages } from "./media.js";
import { targetText } from "./outcome-tools.js";
import { buildSystemPrompt, KICKOFF, notesMessage } from "./prompt.js";
import { describeRouterError } from "./router.js";
import { createRecord, measurables, runTool, settleVision, toolDefinitions, unsentVision } from "./tools.js";

/** Tool rounds in a row without hearing from the contributor before we stop and ask them. */
const MAX_TOOL_ROUNDS = 8;
/** the largest observations file the interviewer reads */
const MAX_NOTES_BYTES = 64 * 1024;

/**
 * @typedef {object} InterviewResult
 * @property {"finished" | "quit"} outcome
 * @property {ContributionRecord} record
 * @property {TranscriptEntry[]} transcript
 * @property {Receipt[]} receipts
 */

/**
 * @param {{
 *   session: Session,
 *   router: Pick<RouterClient, "chat" | "model"> & Partial<Pick<RouterClient, "audioModel" | "transcribe">>,
 *   terminal: Terminal,
 *   client?: Pick<OrdoClient, "output" | "askMachine" | "getSession">,
 *   cwd?: string,
 *   maxEvidenceBytes?: number,
 *   notes?: string | null,
 * }} options
 * @returns {Promise<InterviewResult>}
 */
export async function runInterview({ session, router, terminal, client, cwd = process.cwd(), maxEvidenceBytes, notes = null }) {
  const { style } = terminal;
  const stage = session.stage;
  const record = createRecord();
  /** @type {TranscriptEntry[]} */
  const transcript = [];
  /** @type {Receipt[]} */
  const receipts = [];
  const tools = toolDefinitions(stage);
  // images for the model (the machine's media, photos the contributor agreed to show) ride after the tool results
  const media = createMediaQueue();
  const saveDir = path.join(tmpdir(), `ordo-pow-${String(session.sessionId ?? "session").replace(/[^\w-]/g, "_")}`);
  /** @type {ChatMessage[]} */
  const messages = [
    { role: "system", content: buildSystemPrompt(session) },
    { role: "user", content: KICKOFF },
  ];
  let inputEnded = false;
  let quitRequested = false;

  /** Where the notes files were: evidence they name by a bare file name is looked for there too. @type {string[]} */
  const searchDirs = [];
  /**
   * The contributor's observations file: hashed as evidence, and its text sent to the interviewer as their answers.
   * @param {string} input
   * @returns {Promise<string | null>} the message, or null when the file cannot be used (the reason is printed)
   */
  async function loadNotes(input) {
    let file;
    try {
      file = await hashEvidence(input, { cwd, maxBytes: MAX_NOTES_BYTES });
    } catch (err) {
      if (err instanceof EvidenceError) {
        terminal.error(`  Notes: ${err.message}`);
        return null;
      }
      throw err;
    }
    const text = (await readFile(file.path, "utf8")).replace(/\r\n/g, "\n").trim();
    if (!text) {
      terminal.error(`  Notes: ${file.name} is empty.`);
      return null;
    }
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 4096))) {
      terminal.error(`  Notes: ${file.name} is not a text file. Use a .txt or .md file of your observations.`);
      return null;
    }
    // evidence the notes name by a bare file name is looked for beside them
    const dir = path.dirname(file.path);
    if (!searchDirs.includes(dir)) searchDirs.push(dir);
    if (!record.evidence.some((e) => e.sha256 === file.sha256)) record.evidence.push({ name: file.name, sha256: file.sha256, size: file.size, mediaType: "text/plain" });
    terminal.print(style.green(`  ✓ read your notes ${file.name} (${formatBytes(file.size)}), sha256 ${file.sha256.slice(0, 16)}…: its text goes to the interviewer as your answers, and its hash is your evidence`));
    return notesMessage({ name: file.name, sha256: file.sha256, text });
  }
  let warnedTee = false;
  let toolRounds = 0;

  /** @returns {InterviewResult} */
  const done = (/** @type {"finished" | "quit"} */ outcome) => ({ outcome, record, transcript, receipts });

  /**
   * Read one answer, handling /show, /help and /quit locally. Returns null to quit.
   * @param {string} prompt
   * @returns {Promise<string | null>}
   */
  async function readAnswer(prompt) {
    for (;;) {
      const line = await terminal.ask(prompt);
      if (line === null) {
        inputEnded = true;
        return null;
      }
      const text = line.trim();
      if (!text) continue;
      const command = text.toLowerCase();
      if (command === "/quit" || command === "/exit") return null;
      if (command === "/show") {
        terminal.print(formatRecord(record, stage, style));
        continue;
      }
      if (command === "/help" || command === "/?") {
        terminal.print(style.dim("  /show          what is recorded so far\n  /notes <file>  answer from a text file of your observations\n  /quit          stop without sending anything"));
        continue;
      }
      if (command === "/notes" || command.startsWith("/notes ")) {
        const file = text.slice("/notes".length).trim();
        if (!file) {
          terminal.print(style.dim("  /notes <file>: a .txt or .md file of your observations, for example /notes ~/stage-01.txt"));
          continue;
        }
        const message = await loadNotes(file);
        if (message) return message;
        continue;
      }
      // Anything else, including absolute paths that start with "/", is an answer.
      return text;
    }
  }

  /**
   * Ask the contributor yes or no before a file of theirs goes to a model. Anything but y or yes is no.
   * @param {string} question
   */
  async function consent(question) {
    for (;;) {
      const answer = await terminal.ask(`${style.yellow("?")} ${question} [y/N] `);
      if (answer === null) {
        inputEnded = true;
        return false;
      }
      const text = answer.trim().toLowerCase();
      if (text === "/show") {
        terminal.print(formatRecord(record, stage, style));
        continue;
      }
      return text === "y" || text === "yes";
    }
  }

  /** The machine may capture more while we talk: reload its outcomes before finishing. */
  async function refreshOutcomes() {
    if (!client || !stage.outcomes?.length) return;
    const fresh = await client.getSession();
    if (Array.isArray(fresh.stage.outcomes)) stage.outcomes = fresh.stage.outcomes;
  }

  /** @param {string} summary */
  async function confirmFinish(summary) {
    terminal.print("");
    terminal.print(style.bold("Review before sending"));
    terminal.print(`  ${style.bold("Summary")}  ${summary}`);
    terminal.print(formatRecord(record, stage, style));
    terminal.print(
      style.dim(
        "  Your answers, this summary, your verdicts and the evidence hashes go to Ordo. Your files stay on this machine; a photo or voice note you agreed to share went only to the 0G model.",
      ),
    );
    for (;;) {
      const answer = await terminal.ask(`Submit this record to Ordo? [y/N] `);
      if (answer === null) {
        inputEnded = true;
        return false;
      }
      const text = answer.trim().toLowerCase();
      if (text === "/quit" || text === "/exit") {
        quitRequested = true;
        return false;
      }
      if (text === "/show") {
        terminal.print(formatRecord(record, stage, style));
        continue;
      }
      const yes = text === "y" || text === "yes";
      if (!yes) terminal.print(style.dim("  Not sent. Tell the interviewer what to change."));
      return yes;
    }
  }

  // an observations file given on the command line (--notes) is the contributor's first answer
  if (notes) {
    const message = await loadNotes(notes);
    if (message) {
      transcript.push({ role: "user", content: message, at: new Date().toISOString() });
      messages.push({ role: "user", content: message });
    }
  }

  /** @param {string} line */
  const announce = (line) => terminal.print(style.green(`  ✓ ${line}`));
  /** @param {string} line */
  const inform = (line) => terminal.print(style.dim(`  ↳ ${line}`));

  for (;;) {
    terminal.thinking();
    let result;
    try {
      result = await router.chat({ messages, tools });
    } catch (err) {
      terminal.error(describeRouterError(err, router.model));
      const again = await terminal.ask("Press Enter to try again, or type /quit: ");
      if (again === null) {
        inputEnded = true;
        return done("quit");
      }
      if (/^\/(quit|exit)$/i.test(again.trim())) return done("quit");
      continue;
    }
    receipts.push(result.receipt);
    // the model has seen the images in this request: they become placeholders, so later requests stay small
    settleVision(record, result.receipt.requestId);
    stripImages(messages);
    if (result.receipt.teeVerified === false && !warnedTee) {
      warnedTee = true;
      terminal.warn("Warning: the 0G Router reports that the provider's TEE signature on an answer did not verify. The receipt records this; Ordo will flag it.");
    }
    const message = result.message;
    messages.push(message);

    const content = contentText(message.content).trim();
    if (content) {
      terminal.print("");
      terminal.print(style.cyan(content));
      transcript.push({ role: "assistant", content, at: new Date().toISOString() });
    }

    const calls = message.tool_calls ?? [];
    if (calls.length) {
      toolRounds += 1;
      /** @type {Map<string, Record<string, unknown>>} */
      const results = new Map();
      let finished = false;
      // Record everything else first, so finish always sees the complete record.
      const ordered = [...calls.filter((c) => c.function.name !== "finish"), ...calls.filter((c) => c.function.name === "finish")];
      for (const call of ordered) {
        if (call.function.name === "finish" && (finished || inputEnded || quitRequested || [...results.values()].some((r) => r.submitted === false))) {
          results.set(call.id, { ok: false, error: "finish was already handled in this turn." });
          continue;
        }
        const outcome = await runTool(call.function.name, call.function.arguments, {
          stage,
          record,
          cwd,
          searchDirs,
          confirmFinish,
          announce,
          maxEvidenceBytes,
          consent,
          media,
          router,
          client,
          addReceipt: (receipt) => void receipts.push(receipt),
          inform,
          refreshOutcomes,
          saveDir,
        });
        results.set(call.id, outcome.result);
        if (outcome.finished) finished = true;
        if (!outcome.result.ok && call.function.name !== "finish") {
          terminal.print(style.yellow(`  ! ${call.function.name}: ${String(outcome.result.error)}`));
        }
      }
      for (const call of calls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(results.get(call.id) ?? { ok: false }) });
      }
      const images = media.take();
      if (finished) {
        if (images) unsentVision(record);
        return done("finished");
      }
      if (inputEnded || quitRequested) return done("quit");
      if (images) messages.push(images);
      if (toolRounds < MAX_TOOL_ROUNDS) continue;
      terminal.print(style.dim("  (The interviewer is taking many steps; please answer or type /show.)"));
    }
    toolRounds = 0;

    const answer = await readAnswer(`${style.bold("you ›")} `);
    if (answer === null) return done("quit");
    transcript.push({ role: "user", content: answer, at: new Date().toISOString() });
    messages.push({ role: "user", content: answer });
  }
}

/**
 * Human-readable view of the record (for /show and the final review).
 * @param {ContributionRecord} record
 * @param {Stage} stage
 * @param {Terminal["style"]} style
 */
export function formatRecord(record, stage, style) {
  const lines = [];
  lines.push(style.bold("  Measurements"));
  if (record.measurements.length) {
    const width = Math.min(32, Math.max(...record.measurements.map((m) => m.criterion.length)));
    for (const m of record.measurements) {
      lines.push(
        `    ${m.criterion.padEnd(width)}  ${m.value}${m.unit ? ` ${m.unit}` : ""}${m.note ? style.dim(`  (${m.note})`) : ""}`,
      );
    }
  } else {
    lines.push(style.dim("    none yet"));
  }
  const missing = measurables(stage)
    .filter((x) => !record.measurements.some((m) => m.criterion === x.key))
    .map((x) => x.key);
  if (missing.length) lines.push(style.dim(`    not recorded: ${missing.join(", ")}`));

  const outcomes = stage.outcomes ?? [];
  if (outcomes.length) {
    lines.push(style.bold("  Outcomes") + style.dim("  (captured by the machine; your verdicts)"));
    const width = Math.min(32, Math.max(...outcomes.map((o) => o.label.length)));
    for (const o of outcomes) {
      const c = record.confirmations.find((x) => x.outcome === o.key);
      const read = o.output ? `read ${o.output.value}${o.metric.unit ? ` ${o.metric.unit}` : ""}, target ${targetText(o.metric)}` : "not captured yet";
      const verdict = !c
        ? o.output && o.required
          ? style.yellow("not reviewed")
          : style.dim("no verdict")
        : c.verdict === "confirm"
          ? style.green("confirmed")
          : c.verdict === "dispute"
            ? style.yellow(`disputed${c.observed !== undefined ? `: observed ${c.observed}${o.metric.unit ? ` ${o.metric.unit}` : ""}` : ""}`)
            : "unsure";
      lines.push(`    ${o.label.padEnd(width)}  ${style.dim(read)}  ${verdict}${c?.note ? style.dim(`  (${c.note})`) : ""}`);
    }
  }

  lines.push(style.bold("  Notes"));
  if (record.notes.length) for (const n of record.notes) lines.push(`    - ${n.text}`);
  else lines.push(style.dim("    none yet"));

  lines.push(style.bold("  Evidence") + style.dim("  (hashed here; Ordo gets only the hashes)"));
  if (record.evidence.length) {
    for (const e of record.evidence) {
      const read = e.analyzedBy ? style.dim(e.analyzedBy.kind === "vision" ? `  shown to ${e.analyzedBy.model}` : `  transcribed by ${e.analyzedBy.model}`) : "";
      lines.push(`    ${e.name}  ${formatBytes(e.size)}  sha256 ${e.sha256}${read}`);
    }
  } else {
    lines.push(style.dim("    none"));
  }
  if (record.voiceNotes.length) {
    lines.push(style.bold("  Voice notes"));
    for (const v of record.voiceNotes) lines.push(`    ${v.name}: ${style.dim(`“${v.transcript.length > 160 ? `${v.transcript.slice(0, 159)}…` : v.transcript}”`)}`);
  }
  return lines.join("\n");
}
