import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asTyped, atLevel, boot, enlist, wallet, type Client, type System } from "./helpers.js";

/**
 * A stage judged on several measured parameters, protein expression as the example: an instrument's signals over the
 * stage window, a person's readings at a manual stage, the bands they are judged against, the series behind them, a
 * zero-knowledge proof per bound on the passport, and a parameter chart in the validation package.
 */
describe("multi-parameter stages", () => {
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  /** the manager: records the bioreactor's readings and the manual stage */
  let admin: Client;
  /** a contributor (level 2: outcomes, not measurements) */
  let operator: Client;
  /** a validator (level 3): sees the series and releases the quality gate */
  let qe: Client;
  let site = "";
  let runId = "";
  let reactor = "";
  const S = () => `/v1/sites/${site}`;
  const tick = () => sys.advance(true);
  const temperature = { label: "Culture temperature", kind: "signal", signal: "temperature", agg: "envelope", op: ">=", target: 35, targetMax: 39, unit: "°C" };
  const spec = {
    stages: [
      {
        code: "01",
        column: 1,
        name: "Expression (bioreactor)",
        agent: "process",
        resourceKind: "process_vessel",
        mode: "auto",
        escalationRole: "manager",
        timeoutMin: 600,
        criteria: [
          temperature,
          { label: "Cell density OD600", kind: "signal", signal: "od600", agg: "last", op: ">=", target: 0.6, unit: "" },
          { label: "Dissolved oxygen", kind: "signal", signal: "dissolved_oxygen", agg: "min", op: ">=", target: 30, unit: "%" },
        ],
      },
      {
        code: "02",
        column: 2,
        name: "QC release",
        agent: "vision_qa",
        resourceKind: "manual_station",
        mode: "approve",
        escalationRole: "validator",
        timeoutMin: 600,
        criteria: [{ label: "Endotoxin", kind: "signal", signal: "endotoxin_eu_mg", agg: "last", op: "<=", target: 0.5, unit: "EU/mg" }],
      },
    ],
    rework: null,
  };

  beforeAll(async () => {
    ({ sys, app } = await boot());
    admin = await wallet(app);
    operator = await wallet(app);
    qe = await wallet(app);
    site = (await admin.call("POST", "/v1/sites", { name: "Protein Lab", timezone: "UTC", lineName: "Suite 1", zones: [] })).json.id;
    await atLevel(sys, site, "L3"); // machine stages complete on their own when in spec
    await enlist(admin, S(), operator);
    // a quality gate is released by a validator: the manager promotes the QE with a signature
    await enlist(admin, S(), qe, "validator");
    // the bioreactor reports by hand in this test; the QC bench is not registered, so that stage runs without an asset
    reactor = (await admin.call("POST", `${S()}/assets`, { name: "BR-01 Bioreactor", kind: "process_vessel", owningAgent: "process", source: { type: "manual" }, limits: {}, idealCycleS: null })).json.id;
    await admin.call("POST", `${S()}/assets/${reactor}/readings`, { signal: "part_count", value: 1000 });
    const tpl = await admin.call("POST", `${S()}/templates`, { name: "Protein synthesis (test)", category: "Regulated", description: "Expression and release", spec });
    expect(tpl.status).toBe(200);
    // one batch is the order quantity: the stage's work is done when the batch is counted
    runId = (await admin.call("POST", `${S()}/runs`, { templateVersionId: tpl.json.versionId, orderRef: "PS-001", quantity: 1 })).json.id;
    await tick();
  }, 120_000);
  afterAll(async () => sys?.close());

  it("rejects a template whose parameters are not well formed", async () => {
    const bad = (c: Record<string, unknown>) => ({ ...spec, stages: [{ ...spec.stages[0], criteria: [c] }, spec.stages[1]] });
    expect((await admin.call("POST", `${S()}/templates`, { name: "Bad 1", category: "x", spec: bad({ label: "T", kind: "signal", op: ">=", target: 1, unit: "" }) })).status).toBe(400);
    expect((await admin.call("POST", `${S()}/templates`, { name: "Bad 2", category: "x", spec: bad({ ...temperature, targetMax: 30 }) })).status).toBe(400);
  });

  it("judges a running stage live on the instrument's signals over the stage window", async () => {
    const read = (signal: string, value: number) => admin.call("POST", `${S()}/assets/${reactor}/readings`, { signal, value });
    for (const v of [36.2, 37.1, 38.4]) await read("temperature", v);
    await read("od600", 0.2);
    await read("od600", 0.7);
    await read("dissolved_oxygen", 45);
    await read("dissolved_oxygen", 31);
    const run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    const st = run.stages.find((s: any) => s.code === "01");
    expect(st.state).toBe("running");
    expect(st.criteriaResults).toEqual([
      expect.objectContaining({ label: "Culture temperature", kind: "signal", agg: "envelope", ok: true, actual: "36.20–38.40 °C", n: 3, band: { lo: 35, hi: 39 }, unit: "°C" }),
      expect.objectContaining({ label: "Cell density OD600", ok: true, actual: "0.70", band: { lo: 0.6, hi: null } }),
      expect.objectContaining({ label: "Dissolved oxygen", agg: "min", ok: true, actual: "31 %", band: { lo: 30, hi: null } }),
    ]);
    // a contributor sees that it passes, not the measured values
    const theirs = (await operator.call("GET", `${S()}/runs/${runId}`)).json.run.stages.find((s: any) => s.code === "01");
    expect(theirs.criteriaResults.map((c: any) => [c.ok, c.actual])).toEqual([[true, null], [true, null], [true, null]]);
    expect((await operator.call("GET", `${S()}/runs/${runId}/stages/01/series`)).status).toBe(403);
    // the series behind it, live while the stage runs (level 3: a validator)
    const series = (await qe.call("GET", `${S()}/runs/${runId}/stages/01/series`)).json;
    expect(series.live).toBe(true);
    expect(series.signals.temperature.map((p: any) => p.value)).toEqual([36.2, 37.1, 38.4]);
    expect(Object.keys(series.signals).sort()).toEqual(["dissolved_oxygen", "od600", "temperature"]);
  });

  it("closes the stage on the batch count, keeps a snapshot of the window, and lets it pass without a gate when every parameter is in spec", async () => {
    await admin.call("POST", `${S()}/assets/${reactor}/readings`, { signal: "part_count", value: 1001 });
    await tick();
    const run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    const st = run.stages.find((s: any) => s.code === "01");
    expect(st).toMatchObject({ state: "completed", unitsGood: 1, workDoneAt: expect.any(String) });
    expect(st.criteriaResults.map((c: any) => c.ok)).toEqual([true, true, true]);
    const rows = await sys.db.query<{ signal: string; n: string }>("SELECT signal, COUNT(*)::text n FROM stage_series WHERE run_id = $1 AND stage_code = '01' GROUP BY signal ORDER BY signal", [runId]);
    expect(rows.rows).toEqual([
      { signal: "dissolved_oxygen", n: "2" },
      { signal: "od600", n: "2" },
      { signal: "temperature", n: "3" },
    ]);
    const series = (await qe.call("GET", `${S()}/runs/${runId}/stages/01/series`)).json;
    expect(series).toMatchObject({ live: false, window: { from: expect.any(String), to: expect.any(String) } });
    expect(series.signals.temperature).toHaveLength(3);
    // not for the public, nor for a stranger
    expect((await app.request(`${S()}/runs/${runId}/stages/01/series`, { headers: { host: "localhost" } })).status).toBe(401);
  });

  it("takes a person's readings at a manual stage and shows them against their bands at the gate", async () => {
    expect((await operator.call("POST", `${S()}/runs/${runId}/stages/02/record`, { good: 1, scrap: 0, complete: true, readings: [{ signal: "endotoxin_eu_mg", value: 0.3 }] })).status).toBe(403);
    const r = await admin.call("POST", `${S()}/runs/${runId}/stages/02/record`, { good: 1, scrap: 0, complete: true, readings: [{ signal: "endotoxin_eu_mg", value: 0.3 }] });
    expect(r.status).toBe(200);
    await tick();
    const run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    const st = run.stages.find((s: any) => s.code === "02");
    expect(st.state).toBe("awaiting_approval");
    expect(st.criteriaResults[0]).toMatchObject({ label: "Endotoxin", ok: true, actual: "0.30 EU/mg", band: { lo: null, hi: 0.5 }, measured: { value: 0.3, op: "<=", target: 0.5 } });
    const gate = (await admin.call("GET", `${S()}/inbox`)).json.find((i: any) => i.runId === runId && i.stageCode === "02");
    expect(gate.metrics).toEqual(expect.arrayContaining([{ label: "Endotoxin", value: "0.30 EU/mg · target ≤ 0.5 EU/mg", band: { lo: null, hi: 0.5, value: 0.3, valueMax: null, ok: true, unit: "EU/mg" } }]));
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    const d = decisions.find((x: any) => x.kind === "stage.parameters_recorded");
    expect(d.data).toEqual({ readings: [{ signal: "endotoxin_eu_mg", value: 0.3 }] });
    expect(d.summary).not.toContain("0.3");
    // the validator releases the lot
    const sr = await qe.call("POST", `${S()}/inbox/${gate.id}/sign-request`, { option: 0, comment: "Release" });
    expect(sr.status, JSON.stringify(sr.json)).toBe(200);
    const typed = sr.json;
    const sig = await qe.account.signTypedData(asTyped(typed));
    expect((await qe.call("POST", `${S()}/inbox/${gate.id}/decide`, { option: 0, comment: "Release", nonce: typed.message.nonce, signature: sig })).status).toBe(200);
    await tick();
    expect((await admin.call("GET", `${S()}/runs/${runId}`)).json.run.status).toBe("completed");
  }, 60_000);

  it("proves every bound of every parameter met in zero knowledge; the passport shows the bands and never a value", async () => {
    await sys.passports.specs!.reconcile(50);
    const rows = await sys.db.query<{ stage_code: string; label: string; status: string }>("SELECT stage_code, label, status FROM spec_proofs WHERE run_id = $1 ORDER BY stage_code, label", [runId]);
    expect(rows.rows).toEqual([
      { stage_code: "01", label: "Cell density OD600", status: "proven" },
      { stage_code: "01", label: "Culture temperature", status: "proven" },
      { stage_code: "01", label: "Culture temperature#max", status: "proven" },
      { stage_code: "01", label: "Dissolved oxygen", status: "proven" },
      { stage_code: "02", label: "Endotoxin", status: "proven" },
    ]);
    const pub = (await (await app.request(`/v1/public/passports/${runId}`, { headers: { host: "localhost" } })).json()) as any;
    const s1 = pub.passport.stages.find((s: any) => s.code === "01");
    const temp = s1.criteria.find((c: any) => c.label === "Culture temperature");
    expect(temp).toMatchObject({ target: "35–39 °C", ok: true, band: { lo: 35, hi: 39 }, unit: "°C", zk: { status: "proven", verified: true }, zkMax: { status: "proven", verified: true } });
    expect(s1.criteria.find((c: any) => c.label === "Cell density OD600")).toMatchObject({ band: { lo: 0.6, hi: null }, zk: { status: "proven", verified: true }, zkMax: null });
    for (const c of pub.passport.stages.flatMap((s: any) => s.criteria)) expect(c).not.toHaveProperty("actual");
    const text = JSON.stringify(pub);
    for (const v of ["36.2", "38.4", "0.70", "0.30"]) expect(text).not.toContain(v);
    // each bound verifies on its own against the published key, and is bound to its own ledger commitment
    const snarkjs = await import("snarkjs");
    const vk = (await (await app.request("/v1/public/zk/spec-check", { headers: { host: "localhost" } })).json()) as any;
    for (const [z, op] of [
      [temp.zk, "0"],
      [temp.zkMax, "1"],
    ] as const) {
      expect(await snarkjs.groth16.verify(vk.verificationKey, z.publicSignals, z.proof)).toBe(true);
      expect(z.publicSignals[2]).toBe(op);
    }
    expect(temp.zk.publicSignals[0]).toBe(temp.zkMax.publicSignals[0]); // the same subject: the lot, stage and criterion
    expect(temp.zk.publicSignals[3]).not.toBe(temp.zkMax.publicSignals[3]); // its own salt, so the two bounds cannot be combined into a value
    const entry = (await sys.rec.ledger.range(temp.zkMax.ledgerSeq, temp.zkMax.ledgerSeq))[0]!;
    expect(entry).toMatchObject({ type: "passport.spec_committed", payload: { criterion: "Culture temperature#max", commitment: temp.zkMax.publicSignals[3] } });
  }, 120_000);

  it("a batch stage can close on its phase signal instead of its counts", async () => {
    const tpl = await admin.call("POST", `${S()}/templates`, {
      name: "Phase-closed expression",
      category: "Regulated",
      description: "closes on execution = COMPLETE",
      spec: { stages: [{ code: "01", column: 1, name: "Expression", agent: "process", resourceKind: "process_vessel", mode: "auto", escalationRole: "manager", timeoutMin: 600, criteria: [], completeOn: { signal: "execution", equals: "COMPLETE" } }], rework: null },
    });
    expect(tpl.status).toBe(200);
    const run2 = (await admin.call("POST", `${S()}/runs`, { templateVersionId: tpl.json.versionId, orderRef: "PS-002", quantity: 2 })).json.id;
    await tick();
    // the batch is counted by nobody: the stage waits for the phase
    await admin.call("POST", `${S()}/assets/${reactor}/readings`, { signal: "execution", text: "ACTIVE" });
    await tick();
    expect((await admin.call("GET", `${S()}/runs/${run2}`)).json.run.stages[0]).toMatchObject({ state: "running", unitsGood: 0 });
    await admin.call("POST", `${S()}/assets/${reactor}/readings`, { signal: "execution", text: "COMPLETE" });
    await tick();
    const st = (await admin.call("GET", `${S()}/runs/${run2}`)).json.run.stages[0];
    expect(st).toMatchObject({ state: "completed", unitsGood: 2, workDoneAt: expect.any(String) });
    // a template cannot name a malformed completion signal
    expect((await admin.call("POST", `${S()}/templates`, { name: "Bad phase", category: "x", spec: { stages: [{ ...tpl.json.spec?.stages?.[0], code: "01", column: 1, name: "X", agent: "process", resourceKind: "process_vessel", mode: "auto", escalationRole: "manager", timeoutMin: 60, criteria: [], completeOn: { signal: "bad signal!", equals: "x" } }], rework: null } })).status).toBe(400);
  });

  it("the validation pre-check judges each parameter and attaches a parameter chart as evidence", async () => {
    const created = await admin.call("POST", `${S()}/validation`, { type: "stage_validation", title: "Expression stage", objective: "Prove 01", acceptance: "Culture temperature 35–39 °C", runId, stageCode: "01" });
    expect(created.status).toBe(200);
    expect(created.json.checks.map((c: any) => [c.criterion, c.target])).toEqual([
      ["Culture temperature", "35–39 °C"],
      ["Cell density OD600", "≥ 0.6"],
      ["Dissolved oxygen", "≥ 30 %"],
    ]);
    const id = created.json.id;
    const p = (await admin.call("POST", `${S()}/validation/${id}/precheck`)).json;
    expect(p.checks.map((c: any) => [c.status, c.actual])).toEqual([
      ["pass", "36.20–38.40 °C"],
      ["pass", "0.70"],
      ["pass", "31 %"],
    ]);
    expect(p.parameters.map((c: any) => [c.label, c.ok, c.band])).toEqual([
      ["Culture temperature", true, { lo: 35, hi: 39 }],
      ["Cell density OD600", true, { lo: 0.6, hi: null }],
      ["Dissolved oxygen", true, { lo: 30, hi: null }],
    ]);
    const chart = p.evidence.find((e: any) => e.mime === "image/svg+xml");
    expect(chart).toMatchObject({ name: `Parameter chart ${runId} · 01`, origin: "agent", sha256: expect.stringMatching(/^sha256:/) });
    const res = await admin.raw("GET", `${S()}/validation/${id}/evidence/${chart.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg).toContain("<svg");
    for (const t of ["Culture temperature", "Cell density OD600", "Dissolved oxygen", "35", "39", "Pass"]) expect(svg).toContain(t);
  });
});
