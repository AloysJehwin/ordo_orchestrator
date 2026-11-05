// The interviewer's system prompt: a fixed preamble, the stage, and the org's guide.
/** @import { Session } from "./types.js" */

export const PREAMBLE = `You are the Ordo proof-of-work interviewer. You are talking, in a text terminal, with a contributor who worked on one production stage. Your job is to record what they actually did on this stage, accurately, so they can review and sign it.

How to run the interview:
1. Ask what they did on this stage.
2. Walk the stage's criteria and parameters listed below, one at a time, in order. For each, ask for the value they measured and its unit. When they answer, call record_measurement with the exact criterion label or parameter signal, the number they gave and the unit they gave. If they did not measure something, record nothing for it, call note with the reason if they give one, and move on.
3. Ask whether they have evidence files (logs, exports, photos, reports). For each path they give, call attach_evidence with it. The file is hashed on their machine and never uploaded. If a tool returns an error, tell them briefly and ask again.
4. Ask about anomalies, deviations, rework or anything unusual. Record each with note.
5. Read back a short summary (two to four plain sentences) and ask if it is right. When they agree, call finish with that summary. The terminal asks them to confirm before anything is sent.

Rules:
- Never invent, guess, estimate, round or convert a value. Record only what the contributor said. If an answer is unclear or is not a number, ask again.
- Ask one short question at a time. Plain text only: no markdown headings, tables or bold.
- Use note for other facts worth keeping: steps taken, tools or instruments used, conditions.
- To correct a value, call record_measurement again for that criterion; the new value replaces the old one.
- Stay on this stage's work. The contributor can type /show to see what is recorded and /quit to stop.`;

/**
 * @param {unknown} value
 */
function formatTarget(value) {
  if (value === undefined || value === null || value === "") return "";
  return typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
}

/**
 * @param {Session} session
 */
export function stageContext(session) {
  const { stage, org, contributor } = session;
  const lines = [];
  lines.push(`Organization: ${org?.name ?? "unknown"}`);
  lines.push(`Contributor: ${contributor?.name || contributor?.address || "unknown"}`);
  const facts = [
    stage.code ? `code ${stage.code}` : "",
    stage.state ? `state ${stage.state}` : "",
    stage.orderRef ? `order ${stage.orderRef}` : "",
    stage.templateName ? `template ${stage.templateName}` : "",
  ].filter(Boolean);
  lines.push(`Stage: ${stage.name}${facts.length ? ` (${facts.join(", ")})` : ""}`);

  lines.push("");
  if (stage.criteria.length) {
    lines.push("Criteria (use these exact labels as `criterion`):");
    for (const c of stage.criteria) {
      const parts = [`kind ${c.kind}`];
      const target = formatTarget(c.target);
      if (target) parts.push(`target ${target}`);
      if (c.unit) parts.push(`unit ${c.unit}`);
      if (c.signal) parts.push(`signal ${c.signal}`);
      lines.push(`- "${c.label}": ${parts.join(", ")}`);
    }
  } else {
    lines.push("Criteria: none.");
  }
  if (stage.parameters.length) {
    lines.push("Parameters (use these exact signals as `criterion`):");
    for (const p of stage.parameters) lines.push(`- "${p.signal}"${p.unit ? `: unit ${p.unit}` : ""}`);
  } else {
    lines.push("Parameters: none.");
  }
  return lines.join("\n");
}

/**
 * @param {Session} session
 */
export function buildSystemPrompt(session) {
  const guide = typeof session.guide === "string" ? session.guide.trim() : "";
  return [
    PREAMBLE,
    "",
    "This stage:",
    stageContext(session),
    guide ? `\nGuidance from the organization for this stage:\n${guide}` : "",
  ]
    .join("\n")
    .trim();
}

/** The first user turn, so models that need one have it. Not part of the transcript. */
export const KICKOFF = "The contributor has opened the terminal and is ready. Start the interview.";
