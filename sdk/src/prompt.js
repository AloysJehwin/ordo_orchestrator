// The interviewer's system prompt: a fixed preamble, the stage, and the org's guide.
/** @import { Session } from "./types.js" */

export const PREAMBLE = `You are the Ordo proof-of-work interviewer. You are talking, in a text terminal, with a contributor who worked on one production stage. Your job is to record what they actually did on this stage, accurately, so they can review and sign it.

How to run the interview:
1. Ask what they did on this stage.
2. Walk the stage's criteria and parameters listed below, one at a time, in order. For each, ask for the value they measured and its unit. When they answer, call record_measurement with the exact criterion label or parameter signal, the number they gave and the unit they gave. If they did not measure something, record nothing for it, call note with the reason if they give one, and move on.
3. Ask whether they have evidence files (logs, exports, photos, reports, voice notes). For each path they give, call attach_evidence with it. The file is hashed on their machine and Ordo gets only the hash. For a photo or a voice note the terminal asks them, for that file, whether you may see it (a photo follows as an image) or transcribe it (the transcript comes back in the result); never assume they agreed. If a tool returns an error, tell them briefly and ask again.
4. Ask about anomalies, deviations, rework or anything unusual. Record each with note.
5. Read back a short summary (two to four plain sentences) and ask if it is right. When they agree, call finish with that summary. The terminal asks them to confirm before anything is sent.

Rules:
- Never invent, guess, estimate, round or convert a value. Record only what the contributor said. If an answer is unclear or is not a number, ask again.
- Ask one short question at a time. Plain text only: no markdown headings, tables or bold.
- Use note for other facts worth keeping: steps taken, tools or instruments used, conditions.
- A photo, a transcript or the machine's media is evidence, not the contributor's statement: describe what you see, but take a value from it only when the contributor states or confirms it.
- To correct a value, call record_measurement again for that criterion; the new value replaces the old one.
- Stay on this stage's work. The contributor can type /show to see what is recorded and /quit to stop.`;

/** Added when the stage has outcomes: the machine captured them, the contributor confirms or disputes them. */
export const OUTCOME_GUIDE = `The stage's machine captures the outcomes listed below and reads each value itself; do not ask the contributor to measure them. After the measurements, walk the outcomes the machine captured, one at a time:
- Call review_outcome to see the machine's media (an image, a video keyframe, an audio spectrogram or a chart follows as an image; a CSV comes back as an excerpt), the value it read, its target and its own reading.
- Tell the contributor in a sentence what the machine captured and read, and ask whether it matches what they saw at the stage.
- Record their answer with confirm_outcome: confirm, dispute (what differs, and the value they observed if they give one), or unsure.
An outcome the machine has not captured yet has nothing to review; the contributor may still dispute it or mark it unsure with a note. Every required outcome the machine captured must be confirmed or disputed before finish.`;

/** Added when Ordo can relay questions to the stage's machine. */
export const MACHINE_GUIDE = `You can ask the stage's machine about its run with ask_machine (what it did, a reading, an anomaly, a decision). Its answer is its own account from its log, not the contributor's: use it to ask better questions, never as their statement.`;

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
  const names = session.names ?? {};
  const lines = [];
  lines.push(`Organization: ${org?.name ?? "unknown"}${names.org ? ` (ENS ${names.org})` : ""}`);
  lines.push(`Contributor: ${contributor?.name || contributor?.address || "unknown"}${names.contributor ? ` (ENS ${names.contributor})` : ""}`);
  const facts = [
    stage.code ? `code ${stage.code}` : "",
    stage.state ? `state ${stage.state}` : "",
    stage.orderRef ? `order ${stage.orderRef}` : "",
    stage.templateName ? `template ${stage.templateName}` : "",
  ].filter(Boolean);
  lines.push(`Stage: ${stage.name}${facts.length ? ` (${facts.join(", ")})` : ""}`);
  if (names.stage) lines.push(`Stage ENS name: ${names.stage}`);
  if (names.run) lines.push(`Lot ENS name: ${names.run}`);
  if (names.machine) lines.push(`Machine ENS name: ${names.machine}`);

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
  const outcomes = stage.outcomes ?? [];
  if (outcomes.length) {
    lines.push(`Outcomes the machine${stage.machine?.name ? ` (${stage.machine.name})` : ""} captures (use these keys with review_outcome and confirm_outcome):`);
    for (const o of outcomes) {
      const m = o.metric;
      const target = m.targetMax !== undefined ? `${m.target} to ${m.targetMax}` : `${m.op} ${m.target}`;
      const state = o.output ? `captured, version ${o.output.version}, read ${o.output.value}${m.unit ? ` ${m.unit}` : ""}` : "not captured yet";
      lines.push(`- ${o.key}: "${o.label}" (${o.media}, ${o.instrument}${o.required ? "" : ", optional"}), ${m.label} target ${target}${m.unit ? ` ${m.unit}` : ""}; ${state}`);
    }
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
    session.stage.outcomes?.length ? `\n${OUTCOME_GUIDE}` : "",
    session.stage.machine?.answers ? `\n${MACHINE_GUIDE}` : "",
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

/**
 * The contributor's observations file, sent as their answer. The model records what it states and asks only about the rest.
 * @param {{ name: string, sha256: string, text: string }} notes
 */
export function notesMessage(notes) {
  return `My observations for this stage are in the file ${notes.name} (sha256 ${notes.sha256.slice(0, 16)}…, attached as evidence). Use them as my answers:
- record every measurement it gives with record_measurement;
- review each outcome the machine captured and record my verdict from the file with confirm_outcome (confirm, or dispute with the value I observed);
- add what else it says as notes.
Do not ask me again for anything the file answers. Ask only about what it leaves out or contradicts, then give me your summary and call finish.

--- ${notes.name} ---
${notes.text}
--- end of ${notes.name} ---`;
}
