import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { buildSystemPrompt } from "../src/prompt.js";
import { createRecord, measurables, runTool, toolDefinitions } from "../src/tools.js";

/** @type {import("../src/types.js").Stage} */
const stage = {
  runId: "r",
  name: "Press fit",
  criteria: [
    { label: "Bore diameter", kind: "range", target: { min: 11.98, max: 12.02 }, unit: "mm", signal: "bore_d" },
    { label: "Visual check", kind: "boolean", target: true },
  ],
  parameters: [{ signal: "press_force", unit: "kN" }],
};

/** @type {string} */
let dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ordo-pow-tools-"));
  await writeFile(path.join(dir, "a.txt"), "a");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(confirm = true) {
  const record = createRecord();
  /** @type {string[]} */
  const announced = [];
  return {
    record,
    announced,
    context: { stage, record, cwd: dir, confirmFinish: async () => confirm, announce: (/** @type {string} */ l) => void announced.push(l) },
  };
}

describe("record_measurement", () => {
  test("accepts criterion labels and parameter signals, case-insensitively, storing the exact name", async () => {
    const { record, context } = ctx();
    const a = await runTool("record_measurement", JSON.stringify({ criterion: "  bore   DIAMETER ", value: 12.01, unit: "mm" }), context);
    assert.equal(a.result.ok, true);
    const b = await runTool("record_measurement", JSON.stringify({ criterion: "press_force", value: "41.5", unit: "kN", note: "gauge 7" }), context);
    assert.equal(b.result.ok, true);
    assert.deepEqual(b.result.notYetRecorded, ["Visual check"]);
    assert.deepEqual(record.measurements, [
      { criterion: "Bore diameter", value: 12.01, unit: "mm" },
      { criterion: "press_force", value: 41.5, unit: "kN", note: "gauge 7" },
    ]);
  });

  test("a second value for the same criterion replaces the first", async () => {
    const { record, context } = ctx();
    await runTool("record_measurement", JSON.stringify({ criterion: "Bore diameter", value: 12.5, unit: "mm" }), context);
    const r = await runTool("record_measurement", JSON.stringify({ criterion: "Bore diameter", value: 12.01, unit: "mm" }), context);
    assert.equal(r.result.replacedEarlierValue, true);
    assert.deepEqual(record.measurements, [{ criterion: "Bore diameter", value: 12.01, unit: "mm" }]);
  });

  test("rejects unknown criteria, a criterion's signal, and non-numbers", async () => {
    const { record, context } = ctx();
    for (const args of [{ criterion: "Torque", value: 5 }, { criterion: "bore_d", value: 12 }, { criterion: "Bore diameter", value: "twelve" }, { criterion: "Bore diameter" }, { value: 1 }]) {
      const r = await runTool("record_measurement", JSON.stringify(args), context);
      assert.equal(r.result.ok, false, JSON.stringify(args));
      assert.equal(typeof r.result.error, "string");
    }
    assert.equal(record.measurements.length, 0);
  });

  test("flags a unit that differs from the stage's", async () => {
    const { context } = ctx();
    const r = await runTool("record_measurement", JSON.stringify({ criterion: "Bore diameter", value: 0.47, unit: "in" }), context);
    assert.equal(r.result.ok, true);
    assert.match(String(r.result.warning), /specifies "mm"/);
  });
});

describe("other tools", () => {
  test("note, attach_evidence (deduplicated) and bad JSON", async () => {
    const { record, context, announced } = ctx();
    assert.equal((await runTool("note", JSON.stringify({ text: " ran 20 parts " }), context)).result.ok, true);
    assert.equal((await runTool("note", JSON.stringify({ text: "" }), context)).result.ok, false);
    const first = await runTool("attach_evidence", JSON.stringify({ path: "a.txt" }), context);
    assert.equal(first.result.ok, true);
    assert.equal(first.result.uploaded, false);
    const again = await runTool("attach_evidence", JSON.stringify({ path: path.join(dir, "a.txt") }), context);
    assert.equal(again.result.alreadyAttached, true);
    assert.equal(record.evidence.length, 1);
    assert.equal(record.notes[0]?.text, "ran 20 parts");
    assert.equal((await runTool("note", "{not json", context)).result.ok, false);
    assert.equal((await runTool("delete_everything", "{}", context)).result.ok, false);
    assert.ok(announced.some((l) => l.includes("a.txt")));
  });

  test("finish needs a summary and the contributor's confirmation", async () => {
    const declined = ctx(false);
    const no = await runTool("finish", JSON.stringify({ summary: "Done." }), declined.context);
    assert.equal(no.finished, false);
    assert.equal(no.result.submitted, false);
    assert.equal(declined.record.summary, "");

    const confirmed = ctx(true);
    assert.equal((await runTool("finish", JSON.stringify({}), confirmed.context)).finished, false);
    const yes = await runTool("finish", JSON.stringify({ summary: " Done. " }), confirmed.context);
    assert.equal(yes.finished, true);
    assert.equal(confirmed.record.summary, "Done.");
  });
});

test("tool definitions list the measurable names", () => {
  assert.deepEqual(measurables(stage).map((m) => m.key), ["Bore diameter", "Visual check", "press_force"]);
  const defs = /** @type {any[]} */ (toolDefinitions(stage));
  assert.deepEqual(defs.map((d) => d.function.name), ["record_measurement", "note", "attach_evidence", "finish"]);
  assert.deepEqual(defs[0].function.parameters.properties.criterion.enum, ["Bore diameter", "Visual check", "press_force"]);
  const none = /** @type {any[]} */ (toolDefinitions({ ...stage, criteria: [], parameters: [] }));
  assert.equal(none[0].function.parameters.properties.criterion.enum, undefined);
});

test("the system prompt carries the preamble, the stage and the guide", () => {
  const prompt = buildSystemPrompt(
    /** @type {any} */ ({
      org: { id: "o", name: "Acme" },
      contributor: { address: "0x1", name: null },
      stage: { ...stage, code: "PF-20", state: "running", orderRef: "WO-1" },
      guide: "Ask about the calibration date.",
    }),
  );
  assert.match(prompt, /^You are the Ordo proof-of-work interviewer/);
  assert.match(prompt, /Never invent/);
  assert.match(prompt, /- "Bore diameter": kind range, target \{"min":11\.98,"max":12\.02\}, unit mm, signal bore_d/);
  assert.match(prompt, /- "press_force": unit kN/);
  assert.match(prompt, /Stage: Press fit \(code PF-20, state running, order WO-1\)/);
  assert.match(prompt, /Ask about the calibration date\.$/);
});
