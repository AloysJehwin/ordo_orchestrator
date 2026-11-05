import { describe, expect, it } from "vitest";
import library from "../../src/library/templates.json" with { type: "json" };
import { bandOf, evaluateCriteria, kindOf, signalsOf, targetText } from "../../src/pipelines/criteria.js";
import { Criterion } from "../../src/domain/types.js";
import { edges, predecessors, renumber, validateSpec } from "../../src/pipelines/graph.js";
import type { StageSpec } from "../../src/domain/types.js";

const discrete = library.templates.find((t) => t.key === "discrete-assembly")!.stages as unknown as StageSpec[];

describe("pipeline graph (design rules)", () => {
  it("splits, keeps parallel lanes, and merges like the Discrete assembly flow", () => {
    const e = edges(discrete).map((x) => `${x.from}>${x.to}`);
    expect(e).toEqual(expect.arrayContaining(["01>02a", "01>02b", "02a>03a", "02b>03b", "03a>04", "03b>04", "04>05a", "04>05b", "05a>06", "05b>06", "06>07", "07>08"]));
    expect(e).not.toContain("02a>03b");
    expect(predecessors(discrete).get("04")).toEqual(["03a", "03b"]);
  });
  it("every library template is valid", () => {
    for (const t of library.templates) expect(validateSpec(t.stages as unknown as StageSpec[], t.rework), t.name).toEqual([]);
  });
  it("renumbers columns and lanes after editing", () => {
    const r = renumber([{ column: 1 }, { column: 3 }, { column: 3 }, { column: 7 }]);
    expect(r.map((s) => s.code)).toEqual(["01", "02a", "02b", "03"]);
  });
  it("rejects bad rework loops and duplicate codes", () => {
    expect(validateSpec(discrete, { from: "04", to: "06" })).toContain("A rework loop must send units back to an earlier stage");
    expect(validateSpec([...discrete, discrete[0]!], null)).toContain("Stage code 01 is used twice");
  });
});

describe("success criteria use measured values only", () => {
  const crit = [
    { label: "First-pass yield", op: ">=", target: 97, unit: "%" },
    { label: "Scrap", op: "<=", target: 1, unit: "%" },
    { label: "Cycle time", op: "<=", target: 62, unit: "s" },
    { label: "Cpk (critical dim.)", op: ">=", target: 1.33, unit: "" },
  ] as const;
  it("passes, fails and leaves unmeasured criteria to a person", () => {
    const r = evaluateCriteria([...crit], { good: 196, scrap: 4, durationMin: 200, activeOee: null });
    expect(r.map((x) => x.ok)).toEqual([true, false, true, null]);
    expect(r[0]!.actual).toBe("98.0%");
    expect(r[3]!.actual).toBeNull();
    // what each is, and the region where it passes, read without a kind on the criterion
    expect([...crit].map((c) => kindOf(c))).toEqual(["yield", "scrap_pct", "cycle_time", "manual"]);
    expect(r.map((x) => x.band)).toEqual([{ lo: 97, hi: null }, { lo: null, hi: 1 }, { lo: null, hi: 62 }, { lo: 1.33, hi: null }]);
  });

  const temp: Criterion = { label: "Culture temperature", kind: "signal", signal: "temperature", agg: "envelope", op: ">=", target: 35, targetMax: 39, unit: "°C" };
  const od: Criterion = { label: "Cell density", kind: "signal", signal: "od600", agg: "last", op: ">=", target: 0.6, unit: "" };
  const press: Criterion = { label: "Column pressure", kind: "signal", signal: "pressure_bar", agg: "max", op: "<=", target: 3, unit: "bar" };
  const purity: Criterion = { label: "Purity", kind: "signal", signal: "purity_pct", op: ">=", target: 95, targetMax: 100, unit: "%" };
  const counts = { good: 1, scrap: 0, durationMin: 240, activeOee: null };

  it("judges measured signals on the aggregate each asks for, over the stage window", () => {
    const signals = {
      temperature: { last: 37.1, min: 36.2, max: 38.4, mean: 37.2, n: 240 },
      od600: { last: 0.72, min: 0.1, max: 0.72, mean: 0.4, n: 240 },
      pressure_bar: { last: 1.2, min: 0.8, max: 3.4, mean: 1.9, n: 60 },
      purity_pct: { last: 97.5, min: 10, max: 97.5, mean: 60, n: 12 },
    };
    const r = evaluateCriteria([temp, od, press, purity], { ...counts, signals });
    expect(r.map((x) => x.ok)).toEqual([true, true, false, true]);
    // an envelope is judged on the window's minimum and maximum, and proves each bound separately
    expect(r[0]).toMatchObject({ kind: "signal", agg: "envelope", actual: "36.20–38.40 °C", n: 240, band: { lo: 35, hi: 39 }, measured: { value: 36.2, op: ">=", target: 35 }, measuredMax: { value: 38.4, op: "<=", target: 39 } });
    expect(r[1]).toMatchObject({ actual: "0.72", measured: { value: 0.72, op: ">=", target: 0.6 }, band: { lo: 0.6, hi: null } });
    expect(r[1]).not.toHaveProperty("measuredMax");
    expect(r[2]).toMatchObject({ actual: "3.40 bar", ok: false, measured: { value: 3.4, op: "<=", target: 3 } });
    // a range on a single aggregate is two statements over the same value
    expect(r[3]).toMatchObject({ actual: "97.50 %", ok: true, measured: { value: 97.5, op: ">=", target: 95 }, measuredMax: { value: 97.5, op: "<=", target: 100 } });
  });

  it("leaves a signal nobody measured to a person, and fails an envelope that left the band", () => {
    expect(evaluateCriteria([temp, od], counts).map((x) => x.ok)).toEqual([null, null]);
    expect(evaluateCriteria([od], { ...counts, signals: { od600: { last: null, min: null, max: null, mean: null, n: 0 } } })[0]!.ok).toBeNull();
    const r = evaluateCriteria([temp], { ...counts, signals: { temperature: { last: 37, min: 33.9, max: 38, mean: 36, n: 50 } } })[0]!;
    expect(r).toMatchObject({ ok: false, actual: "33.90–38.00 °C" });
  });

  it("reads targets as people do, and knows which signals a stage needs", () => {
    expect(targetText(temp)).toBe("35–39 °C");
    expect(targetText(od)).toBe("≥ 0.6");
    expect(targetText(press)).toBe("≤ 3 bar");
    expect(targetText({ label: "Temperature deviation", op: "<=", target: 2, unit: "°C", abs: true })).toBe("≤ ±2 °C");
    expect(bandOf({ label: "Deviation", op: "<=", target: 2, unit: "°C", abs: true })).toEqual({ lo: -2, hi: 2 });
    expect(signalsOf([temp, od, temp, { label: "Yield", op: ">=", target: 95, unit: "%" }])).toEqual(["temperature", "od600"]);
  });

  it("rejects a signal criterion with no signal, an envelope without a range, and an inverted range", () => {
    expect(Criterion.safeParse({ label: "x", kind: "signal", op: ">=", target: 1, unit: "" }).success).toBe(false);
    expect(Criterion.safeParse({ label: "x", kind: "signal", signal: "t", agg: "envelope", op: ">=", target: 1, unit: "" }).success).toBe(false);
    expect(Criterion.safeParse({ label: "x", kind: "signal", signal: "t", op: ">=", target: 5, targetMax: 4, unit: "" }).success).toBe(false);
    expect(Criterion.safeParse({ label: "x", kind: "signal", signal: "t", op: "<=", target: 1, targetMax: 4, unit: "" }).success).toBe(false);
    expect(Criterion.safeParse(temp).success).toBe(true);
  });
});
