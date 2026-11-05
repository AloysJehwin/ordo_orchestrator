import { describe, expect, it } from "vitest";
import { GuardedLlm, toModelSchema } from "../../src/adapters/llm.js";
import { groundingCheck } from "../../src/agents/grounding.js";
import { Recommendation, ShiftSummary } from "../../src/domain/types.js";

const task = {
  name: "summarize" as const,
  system: "s",
  prompt: "p",
  input: { x: 1 },
  schema: ShiftSummary,
  offline: () => ({ summary: "offline summary text", citedSeqs: [1] }),
};

describe("guarded LLM", () => {
  it("uses the live answer when it is schema-valid", async () => {
    const llm = new GuardedLlm({ name: "fake", modelId: "m", call: async () => '```json\n{"summary":"live summary here","citedSeqs":[2]}\n```' }, 1000);
    const r = await llm.generate(task);
    expect(r.fallback).toBe(false);
    expect(r.value.citedSeqs).toEqual([2]);
    expect(r.promptHash).toMatch(/^sha256:/);
  });
  it("falls back to offline on invalid output, and says so", async () => {
    const llm = new GuardedLlm({ name: "fake", modelId: "m", call: async () => '{"summary":"x"}' }, 1000);
    const r = await llm.generate(task);
    expect(r.fallback).toBe(true);
    expect(r.value.summary).toBe("offline summary text");
  });
  it("keeps a provider's proof of the answer (0G Compute's TEE signature check)", async () => {
    const attestation = { kind: "0g-compute" as const, provider: "0xprov", chatId: "chat-1", verified: true };
    const llm = new GuardedLlm({ name: "0g-compute", modelId: "qwen", call: async () => ({ text: '{"summary":"live summary here","citedSeqs":[2]}', attestation }) }, 1000);
    expect(await llm.generate(task)).toMatchObject({ fallback: false, provider: "0g-compute", attestation });
    const bad = new GuardedLlm({ name: "0g-compute", modelId: "qwen", call: async () => ({ text: "{}", attestation }) }, 1000);
    expect((await bad.generate(task)).attestation).toBeUndefined(); // a fallback answer is Ordo's own, not the provider's
  });
  it("falls back on timeout", async () => {
    const llm = new GuardedLlm({ name: "fake", modelId: "m", call: (_t, signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) }, 20);
    expect((await llm.generate(task)).fallback).toBe(true);
  });
  it("model schema has no const or $schema", () => {
    const s = JSON.stringify(toModelSchema(Recommendation));
    expect(s).not.toContain('"const"');
    expect(s).not.toContain("$schema");
    expect(s).toContain("reassign_stage");
  });
});

describe("grounding check", () => {
  it("accepts numbers present in the input", () => {
    expect(groundingCheck("Vibration 4.62 mm/s, 94% risk, 80 units", { v: 4.6, p: 0.94, units: 80 }).ok).toBe(true);
  });
  it("flags invented numbers", () => {
    const r = groundingCheck("Temperature hit 131.5 °C", { t: 88 });
    expect(r.ok).toBe(false);
    expect(r.unknownNumbers).toEqual([131.5]);
  });
});
