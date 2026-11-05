// ORDO_POW_MOCK_ROUTER=1: a deterministic, scripted interviewer that stands in for the Router,
// so the whole flow (interview, tools, receipts, submit, signing) runs without a key.
// It speaks the same wire format as the Router, so the real client code handles it.
// Its receipts are marked as mock (provider null, x_0g_trace.mock true): Ordo must not
// treat them as TEE-verified. It also stands in for speech to text: a voice note gets a
// placeholder transcript, marked the same way.
/** @import { Session, ChatMessage, Outcome } from "./types.js" */
/** @import { Transport } from "./router.js" */
import { measurables } from "./tools.js";
import { KICKOFF } from "./prompt.js";
import { contentText } from "./media.js";
import { targetText } from "./outcome-tools.js";

export const MOCK_MODEL = "ordo-mock-interviewer";
export const MOCK_AUDIO_MODEL = "ordo-mock-transcriber";

const NONE = /^(none|no|nothing|n\/a|na|nope|-)\.?$/i;
const SKIP = /^(skip|skipped|n\/a|na|not measured|none|-)\.?$/i;
const NUMBER = /[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?/i;

/**
 * @typedef {{ kind: "intro" }
 *   | { kind: "measure", key: string, unit?: string, target?: string }
 *   | { kind: "outcome", outcome: Outcome }
 *   | { kind: "evidence" }
 *   | { kind: "anomalies" }
 *   | { kind: "finish" }} Step
 */

/**
 * @param {Session} session
 * @returns {Transport}
 */
export function createMockTransport(session) {
  /** @type {Step[]} */
  const steps = [{ kind: "intro" }];
  for (const m of measurables(session.stage)) {
    const criterion = session.stage.criteria.find((c) => c.label === m.key);
    const target = criterion?.target;
    /** @type {Step} */
    const step = { kind: "measure", key: m.key };
    if (m.unit) step.unit = m.unit;
    if (target !== undefined && target !== null && target !== "") {
      step.target = typeof target === "object" ? JSON.stringify(target) : String(target);
    }
    steps.push(step);
  }
  for (const outcome of session.stage.outcomes ?? []) steps.push({ kind: "outcome", outcome });
  steps.push({ kind: "evidence" }, { kind: "anomalies" }, { kind: "finish" });

  let index = 0;
  let calls = 0;
  let transcriptions = 0;
  /** @type {string | null} */
  let pendingTool = null;
  let afterDecline = false;
  let intro = "";
  let measured = 0;
  let attached = 0;
  let anomaly = false;
  /** @type {Map<string, string>} */
  const verdicts = new Map();

  const current = () => /** @type {Step} */ (steps[Math.min(index, steps.length - 1)]);

  /** @param {Outcome} o */
  const verdictQuestion = (o) =>
    `Does ${o.label} match what you saw? Type 'confirm', 'dispute <what you saw>', 'unsure <why>'${session.stage.machine?.answers ? ", or 'ask <question>' to ask the machine" : ""}.`;

  /** @param {Step} step */
  function question(step) {
    switch (step.kind) {
      case "intro":
        return `What did you do on stage "${session.stage.name}"?`;
      case "measure":
        return `What did you measure for ${step.key}${step.unit ? ` (in ${step.unit})` : ""}${
          step.target ? `, target ${step.target}` : ""
        }? Type 'skip' if you did not measure it.`;
      case "outcome":
        return step.outcome.captured ? verdictQuestion(step.outcome) : `The machine has not captured ${step.outcome.label} yet. Type 'dispute <note>', 'unsure <note>', or 'skip'.`;
      case "evidence":
        return "Do you have evidence files (logs, exports, photos, voice notes)? Type a path, or 'none'.";
      case "anomalies":
        return "Anything unusual: anomalies, deviations, rework? Describe it, or type 'none'.";
      case "finish":
        return "Type 'submit' to submit the record.";
    }
  }

  function summary() {
    const parts = [intro ? intro.replace(/[.\s]+$/, "") : "Work on this stage"];
    parts.push(`${measured} measurement${measured === 1 ? "" : "s"} recorded`);
    if (session.stage.outcomes?.length) {
      const confirmed = [...verdicts.values()].filter((v) => v === "confirm").length;
      const disputed = [...verdicts.values()].filter((v) => v === "dispute").length;
      parts.push(`${confirmed} outcome${confirmed === 1 ? "" : "s"} confirmed, ${disputed} disputed`);
    }
    parts.push(`${attached} evidence file${attached === 1 ? "" : "s"} attached`);
    if (anomaly) parts.push("an anomaly was noted");
    return `${parts.join("; ")}.`;
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  function callTool(name, args) {
    pendingTool = name;
    return { role: "assistant", content: null, tool_calls: [{ id: `mock_call_${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
  }

  /** @param {string} text */
  function say(text) {
    pendingTool = null;
    return { role: "assistant", content: text };
  }

  /** Ask the next step's question; an outcome the machine captured is shown first. */
  function ask() {
    const step = current();
    if (step.kind === "outcome" && step.outcome.captured) return callTool("review_outcome", { key: step.outcome.key });
    return say(question(step));
  }

  function advance() {
    index += 1;
    return ask();
  }

  function goFinish() {
    index = steps.findIndex((s) => s.kind === "finish");
    return callTool("finish", { summary: summary() });
  }

  /**
   * @param {Record<string, any>} result
   * @param {Step} step
   */
  function afterTool(result, step) {
    switch (pendingTool) {
      case "record_measurement":
        if (result.ok) {
          measured += result.replacedEarlierValue ? 0 : 1;
          return advance();
        }
        return say(`That was not recorded: ${result.error}. ${question(step)}`);
      case "review_outcome": {
        if (step.kind !== "outcome") return say(question(step));
        if (!result.ok) return say(`I could not show ${step.outcome.label}: ${result.error} Type 'dispute <note>', 'unsure <note>', or 'skip'.`);
        if (!result.captured) return say(question({ kind: "outcome", outcome: { ...step.outcome, captured: false } }));
        const reading = result.machineReading?.summary ? ` Its agent noted: ${String(result.machineReading.summary).replace(/[.\s]+$/, "")}.` : "";
        const anomalyNote = result.machineReading?.anomaly ? ` Anomaly: ${result.machineReading.anomaly}.` : "";
        const shown = result.shown && result.shown !== "none" ? ` (shown: its ${result.shown})` : "";
        return say(
          `${step.outcome.label}: the machine read ${result.machineValue}${result.unit ? ` ${result.unit}` : ""}, target ${targetText(step.outcome.metric)}${shown}.${reading}${anomalyNote} ${verdictQuestion(step.outcome)}`,
        );
      }
      case "confirm_outcome":
        if (result.ok) {
          if (step.kind === "outcome") verdicts.set(step.outcome.key, String(result.recorded?.verdict ?? ""));
          return advance();
        }
        return say(`That was not recorded: ${result.error} ${question(step)}`);
      case "ask_machine":
        if (step.kind !== "outcome") return say(question(step));
        return say(`${result.ok ? `The machine says: ${result.answer}` : `The machine did not answer: ${result.error}`} ${verdictQuestion(step.outcome)}`);
      case "attach_evidence":
        if (result.ok) {
          if (!result.alreadyAttached) attached += 1;
          const how = result.shownToModel ? "shown to the interviewer" : result.transcribed ? `transcribed: "${String(result.transcript).slice(0, 80)}"` : "only its hash is kept";
          return say(`Attached ${result.name} (${how}). Another file? Type a path, or 'none'.`);
        }
        return say(`That did not work: ${result.error} Type another path, or 'none'.`);
      case "finish":
        if (Array.isArray(result.missing) && result.missing.length) {
          // a required outcome still needs a verdict: go back to it
          const back = steps.findIndex((s) => s.kind === "outcome" && result.missing.includes(s.outcome.key));
          if (back >= 0) {
            index = back;
            return ask();
          }
        }
        afterDecline = true;
        return say("Okay, nothing was sent. Type 'submit' to submit, or describe a correction.");
      case "note":
      default:
        if (step.kind === "anomalies") return goFinish();
        if (afterDecline) return say("Noted. Type 'submit' when you are ready.");
        return advance();
    }
  }

  /**
   * @param {Outcome} o
   * @param {string} answer
   */
  function verdictFrom(o, answer) {
    const ask = answer.match(/^ask\s+(.+)$/i);
    if (ask && session.stage.machine?.answers) return callTool("ask_machine", { question: ask[1] });
    if (SKIP.test(answer) && (!o.captured || !o.required)) return advance();
    const m = answer.match(/^(confirm|confirmed|yes|ok|dispute|disputed|no|unsure|not sure)\b[\s,:.-]*(.*)$/i);
    if (!m) return say(question({ kind: "outcome", outcome: o }));
    const word = (m[1] ?? "").toLowerCase();
    const verdict = /^(confirm|confirmed|yes|ok)$/.test(word) ? "confirm" : /^(dispute|disputed|no)$/.test(word) ? "dispute" : "unsure";
    const note = (m[2] ?? "").trim();
    /** @type {Record<string, unknown>} */
    const args = { key: o.key, verdict };
    const number = verdict === "dispute" ? note.match(NUMBER) : null;
    if (number) args.observed = Number(number[0].replace(",", "."));
    if (note) args.note = note;
    return callTool("confirm_outcome", args);
  }

  /**
   * @param {ChatMessage[]} messages
   */
  function next(messages) {
    let last = messages[messages.length - 1];
    // images follow the tool results as a user message of content parts: answer the tool results they belong to
    if (last?.role === "user" && Array.isArray(last.content)) {
      for (let i = messages.length - 2; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role === "tool") {
          last = m;
          break;
        }
        if (m?.role !== "user" || !Array.isArray(m.content)) break;
      }
    }
    if (!last) return ask();

    if (last.role === "tool") {
      /** @type {Record<string, any>} */
      let result = {};
      try {
        result = JSON.parse(contentText(last.content) || "{}");
      } catch {
        result = {};
      }
      return afterTool(result, current());
    }

    if (last.role !== "user") return ask();
    const answer = contentText(last.content).trim();
    if (answer === KICKOFF) return ask();

    if (afterDecline) {
      if (/^submit\.?$/i.test(answer)) return goFinish();
      return callTool("note", { text: `Correction: ${answer}` });
    }

    const step = current();
    switch (step.kind) {
      case "intro":
        intro = answer;
        return callTool("note", { text: `Work done: ${answer}` });
      case "measure": {
        if (SKIP.test(answer)) return callTool("note", { text: `Not measured: ${step.key}` });
        const match = answer.match(NUMBER);
        if (!match) return say(`I need a number for ${step.key}, or type 'skip'.`);
        const value = Number(match[0].replace(",", "."));
        const rest = answer.slice((match.index ?? 0) + match[0].length).trim();
        const unit = rest.split(/\s+/)[0]?.replace(/[.,;]+$/, "") || step.unit;
        /** @type {Record<string, unknown>} */
        const args = { criterion: step.key, value };
        if (unit) args.unit = unit;
        return callTool("record_measurement", args);
      }
      case "outcome":
        return verdictFrom(step.outcome, answer);
      case "evidence":
        if (NONE.test(answer)) return advance();
        return callTool("attach_evidence", { path: answer });
      case "anomalies":
        if (NONE.test(answer)) return goFinish();
        anomaly = true;
        return callTool("note", { text: `Anomaly: ${answer}` });
      case "finish":
      default:
        return goFinish();
    }
  }

  /** @param {unknown} data */
  const respond = (data) => ({
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json", "x-0g-mock": "true" }),
    body: new TextEncoder().encode(JSON.stringify(data)),
  });

  return async ({ url, body }) => {
    if (new URL(url).pathname.endsWith("/audio/transcriptions")) {
      // no speech model runs here: a placeholder transcript, marked as mock
      transcriptions += 1;
      const request = JSON.parse(body);
      const size = typeof request.file_base64 === "string" ? Buffer.from(request.file_base64, "base64").byteLength : 0;
      return respond({
        text: `(scripted interviewer: no speech model ran) voice note ${request.filename ?? "audio"}, ${size} bytes`,
        x_0g_trace: { request_id: `mock-audio-${transcriptions}`, provider: null, mock: true },
      });
    }
    calls += 1;
    const request = JSON.parse(body);
    const message = next(Array.isArray(request.messages) ? request.messages : []);
    return respond({
      id: `mockcmpl-${calls}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MOCK_MODEL,
      choices: [{ index: 0, message, finish_reason: message.content === null ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      x_0g_trace: {
        request_id: `mock-${calls}`,
        provider: null,
        mock: true,
        billing: { input_cost: "0", output_cost: "0", total_cost: "0" },
      },
    });
  };
}
