// The interview: a chat loop between the contributor (stdin) and the interviewer model
// (the Router, or the scripted mock), with tool calls that build the record.
/** @import { Session, Stage, ChatMessage, Receipt, TranscriptEntry } from "./types.js" */
/** @import { RouterClient } from "./router.js" */
/** @import { Terminal } from "./io.js" */
/** @import { ContributionRecord } from "./tools.js" */
import { formatBytes } from "./evidence.js";
import { buildSystemPrompt, KICKOFF } from "./prompt.js";
import { describeRouterError } from "./router.js";
import { createRecord, measurables, runTool, toolDefinitions } from "./tools.js";

/** Tool rounds in a row without hearing from the contributor before we stop and ask them. */
const MAX_TOOL_ROUNDS = 8;

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
 *   router: Pick<RouterClient, "chat" | "model">,
 *   terminal: Terminal,
 *   cwd?: string,
 *   maxEvidenceBytes?: number,
 * }} options
 * @returns {Promise<InterviewResult>}
 */
export async function runInterview({ session, router, terminal, cwd = process.cwd(), maxEvidenceBytes }) {
  const { style } = terminal;
  const stage = session.stage;
  const record = createRecord();
  /** @type {TranscriptEntry[]} */
  const transcript = [];
  /** @type {Receipt[]} */
  const receipts = [];
  const tools = toolDefinitions(stage);
  /** @type {ChatMessage[]} */
  const messages = [
    { role: "system", content: buildSystemPrompt(session) },
    { role: "user", content: KICKOFF },
  ];
  let inputEnded = false;
  let quitRequested = false;
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
        terminal.print(style.dim("  /show  what is recorded so far\n  /quit  stop without sending anything"));
        continue;
      }
      // Anything else, including absolute paths that start with "/", is an answer.
      return text;
    }
  }

  /** @param {string} summary */
  async function confirmFinish(summary) {
    terminal.print("");
    terminal.print(style.bold("Review before sending"));
    terminal.print(`  ${style.bold("Summary")}  ${summary}`);
    terminal.print(formatRecord(record, stage, style));
    terminal.print(style.dim("  Your answers, this summary and the evidence hashes go to Ordo. Evidence files stay on this machine."));
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

  /** @param {string} line */
  const announce = (line) => terminal.print(style.green(`  ✓ ${line}`));

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
    if (result.receipt.teeVerified === false && !warnedTee) {
      warnedTee = true;
      terminal.warn("Warning: the 0G Router reports that the provider's TEE signature on an answer did not verify. The receipt records this; Ordo will flag it.");
    }
    const message = result.message;
    messages.push(message);

    const content = message.content?.trim();
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
          confirmFinish,
          announce,
          maxEvidenceBytes,
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
      if (finished) return done("finished");
      if (inputEnded || quitRequested) return done("quit");
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

  lines.push(style.bold("  Notes"));
  if (record.notes.length) for (const n of record.notes) lines.push(`    - ${n.text}`);
  else lines.push(style.dim("    none yet"));

  lines.push(style.bold("  Evidence") + style.dim("  (hashed here; files are not uploaded)"));
  if (record.evidence.length) {
    for (const e of record.evidence) lines.push(`    ${e.name}  ${formatBytes(e.size)}  sha256 ${e.sha256}`);
  } else {
    lines.push(style.dim("    none"));
  }
  return lines.join("\n");
}
