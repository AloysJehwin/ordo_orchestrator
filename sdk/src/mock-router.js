// ORDO_POW_MOCK_ROUTER=1: a deterministic, scripted interviewer that stands in for the Router,
// so the whole flow (interview, tools, receipts, submit, signing) runs without a key.
// It speaks the same wire format as the Router, so the real client code handles it.
// Its receipts are marked as mock (provider null, x_0g_trace.mock true): Ordo must not
// treat them as TEE-verified.
/** @import { Session, ChatMessage } from "./types.js" */
/** @import { Transport } from "./router.js" */
import { measurables } from "./tools.js";
import { KICKOFF } from "./prompt.js";

export const MOCK_MODEL = "ordo-mock-interviewer";

const NONE = /^(none|no|nothing|n\/a|na|nope|-)\.?$/i;
const SKIP = /^(skip|skipped|n\/a|na|not measured|none|-)\.?$/i;

/**
 * @typedef {{ kind: "intro" } | { kind: "measure", key: string, unit?: string, target?: string } | { kind: "evidence" } | { kind: "anomalies" } | { kind: "finish" }} Step
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
  steps.push({ kind: "evidence" }, { kind: "anomalies" }, { kind: "finish" });

  let index = 0;
  let calls = 0;
  /** @type {string | null} */
  let pendingTool = null;
  let afterDecline = false;
  let intro = "";
  let measured = 0;
  let attached = 0;
  let anomaly = false;

  const current = () => /** @type {Step} */ (steps[Math.min(index, steps.length - 1)]);

  /** @param {Step} step */
  function question(step) {
    switch (step.kind) {
      case "intro":
        return `What did you do on stage "${session.stage.name}"?`;
      case "measure":
        return `What did you measure for ${step.key}${step.unit ? ` (in ${step.unit})` : ""}${
          step.target ? `, target ${step.target}` : ""
        }? Type 'skip' if you did not measure it.`;
      case "evidence":
        return "Do you have evidence files (logs, exports, photos)? Type a path, or 'none'.";
      case "anomalies":
        return "Anything unusual: anomalies, deviations, rework? Describe it, or type 'none'.";
      case "finish":
        return "Type 'submit' to submit the record.";
    }
  }

  function summary() {
    const parts = [intro ? intro.replace(/[.\s]+$/, "") : "Work on this stage"];
    parts.push(`${measured} measurement${measured === 1 ? "" : "s"} recorded`);
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

  function goFinish() {
    index = steps.findIndex((s) => s.kind === "finish");
    return callTool("finish", { summary: summary() });
  }

  /**
   * @param {ChatMessage[]} messages
   */
  function next(messages) {
    const last = messages[messages.length - 1];
    if (!last) return say(question(current()));

    if (last.role === "tool") {
      /** @type {Record<string, any>} */
      let result = {};
      try {
        result = JSON.parse(typeof last.content === "string" ? last.content : "{}");
      } catch {
        result = {};
      }
      const step = current();
      switch (pendingTool) {
        case "record_measurement":
          if (result.ok) {
            measured += result.replacedEarlierValue ? 0 : 1;
            index += 1;
            return say(question(current()));
          }
          return say(`That was not recorded: ${result.error}. ${question(step)}`);
        case "attach_evidence":
          if (result.ok) {
            if (!result.alreadyAttached) attached += 1;
            return say(`Attached ${result.name} (only its hash is kept). Another file? Type a path, or 'none'.`);
          }
          return say(`That did not work: ${result.error} Type another path, or 'none'.`);
        case "finish":
          afterDecline = true;
          return say("Okay, nothing was sent. Type 'submit' to submit, or describe a correction.");
        case "note":
        default:
          if (step.kind === "anomalies") return goFinish();
          if (afterDecline) return say("Noted. Type 'submit' when you are ready.");
          index += 1;
          return say(question(current()));
      }
    }

    if (last.role !== "user") return say(question(current()));
    const answer = typeof last.content === "string" ? last.content.trim() : "";
    if (answer === KICKOFF) return say(question(current()));

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
        const match = answer.match(/[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?/i);
        if (!match) return say(`I need a number for ${step.key}, or type 'skip'.`);
        const value = Number(match[0].replace(",", "."));
        const rest = answer.slice((match.index ?? 0) + match[0].length).trim();
        const unit = rest.split(/\s+/)[0]?.replace(/[.,;]+$/, "") || step.unit;
        /** @type {Record<string, unknown>} */
        const args = { criterion: step.key, value };
        if (unit) args.unit = unit;
        return callTool("record_measurement", args);
      }
      case "evidence":
        if (NONE.test(answer)) {
          index += 1;
          return say(question(current()));
        }
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

  return async ({ body }) => {
    calls += 1;
    const request = JSON.parse(body);
    const message = next(Array.isArray(request.messages) ? request.messages : []);
    const response = {
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
    };
    return {
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json", "x-0g-mock": "true" }),
      body: new TextEncoder().encode(JSON.stringify(response)),
    };
  };
}
