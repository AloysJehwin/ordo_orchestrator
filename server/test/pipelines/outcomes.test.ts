import { describe, expect, it } from "vitest";
import { StageSpec, TemplateSpec } from "../../src/domain/types.js";
import { withOutcomeCriteria } from "../../src/pipelines/outcomes.js";

const stage = (outcomes: unknown[], criteria: unknown[] = []) =>
  StageSpec.parse({ code: "01", column: 1, name: "Bioreactor", agent: "scheduler", resourceKind: "process_vessel", mode: "auto", escalationRole: "manager", timeoutMin: 60, criteria, outcomes });
const thermal = { key: "jacket_dt", label: "Jacket", media: "thermal", instrument: "FLIR", metric: { label: "ΔT", unit: "°C", op: "<=", target: 5 } };

describe("outcomes", () => {
  it("each metric becomes a measured-signal criterion; the stage's own criteria stay", () => {
    const spec = withOutcomeCriteria(TemplateSpec.parse({ stages: [stage([thermal], [{ label: "Yield", op: ">=", target: 95, unit: "%" }])] }));
    expect(spec.stages[0]!.criteria).toEqual([
      expect.objectContaining({ label: "Yield", target: 95 }),
      expect.objectContaining({ label: "ΔT", kind: "signal", signal: "outcome.jacket_dt", op: "<=", target: 5, unit: "°C", agg: "last", outcome: "jacket_dt" }),
    ]);
  });

  it("is idempotent, follows edits to an outcome, and drops a removed outcome's criterion", () => {
    const once = withOutcomeCriteria(TemplateSpec.parse({ stages: [stage([thermal])] }));
    expect(withOutcomeCriteria(once)).toEqual(once);
    const edited = withOutcomeCriteria({ ...once, stages: [{ ...once.stages[0]!, outcomes: [{ ...once.stages[0]!.outcomes[0]!, metric: { ...thermal.metric, target: 3, unit: "°C" } }] }] } as never);
    expect(edited.stages[0]!.criteria).toHaveLength(1);
    expect(edited.stages[0]!.criteria[0]!.target).toBe(3);
    expect(withOutcomeCriteria({ ...once, stages: [{ ...once.stages[0]!, outcomes: [] }] }).stages[0]!.criteria).toEqual([]);
  });

  it("validates outcomes: unique keys, known media, a range with ≥", () => {
    expect(() => stage([thermal, thermal])).toThrow(/Two outcomes use the key jacket_dt/);
    expect(() => stage([{ ...thermal, media: "smell" }])).toThrow();
    expect(() => stage([{ ...thermal, metric: { label: "ΔT", op: "<=", target: 1, targetMax: 2 } }])).toThrow(/≥/);
    expect(() => stage([{ ...thermal, key: "Bad Key" }])).toThrow();
  });
});
