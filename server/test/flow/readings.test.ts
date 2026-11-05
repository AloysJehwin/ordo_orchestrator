import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeMessage } from "../../src/core/readings.js";
import { holds, slotOf } from "../../src/core/stage-proofs.js";
import { Gateway } from "../../src/edge/gateway.js";
import { asTyped, atLevel, boot, enlist, wallet, type Client, type System } from "./helpers.js";

/**
 * Proof of work without a chain: a machine's gateway pushes its counters and signs each finished stage's counts, an
 * person (a manager) signs a manual stage's, and Ordo proves each stage's criteria from the signed commitment.
 */
describe("signed stage readings and stage proofs", () => {
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let admin: Client;
  /** a contributor: recording stages is a manager's */
  let operator: Client;
  /** a second manager, who records and signs the manual stage */
  let lead: Client;
  let site = "";
  let runId = "";
  let asset = "";
  let gw: Gateway;
  const S = () => `/v1/sites/${site}`;

  beforeAll(async () => {
    ({ sys, app } = await boot());
    admin = await wallet(app);
    operator = await wallet(app);
    lead = await wallet(app);
    site = (await admin.call("POST", "/v1/sites", { name: "Edge Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
    await atLevel(sys, site, "L3"); // machine stages complete on their own when in spec
    await enlist(admin, S(), operator);
    await enlist(admin, S(), lead, "manager");
    const key = generatePrivateKey();
    asset = (await admin.call("POST", `${S()}/assets`, { name: "CNC-07", kind: "cnc", owningAgent: "scheduler", source: { type: "gateway", device: privateKeyToAccount(key).address }, limits: {}, idealCycleS: 30 })).json.id;
    // the gateway talks to the app in-process; a simulated machine making a good part every 6 s
    // the gateway's clock starts a minute back, so its first sample predates the run
    let clock = Date.now() - 61_000;
    gw = new Gateway({ url: "http://localhost", key, assetId: asset, source: { kind: "simulate", cycleS: 6, scrapEvery: 0 }, fetch: ((u: string, init: RequestInit) => app.request(new URL(u).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } })) as never, now: () => clock });
    await gw.observe();
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "manager", timeoutMin: 120, criteria: [{ label: "Yield", op: ">=", target: 95, unit: "%" }, { label: "Cycle time", op: "<=", target: 7, unit: "s" }] },
        { code: "02", column: 2, name: "Inspect", agent: "vision_qa", resourceKind: "manual_station", mode: "manual", escalationRole: "manager", timeoutMin: 60, criteria: [{ label: "Scrap", op: "<=", target: 5, unit: "%" }] },
      ],
      rework: null,
    };
    const tpl = await admin.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "Edge test", spec });
    const versionId = tpl.json.versionId;
    runId = (await admin.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-9", quantity: 10 })).json.id;
    // ten cycles later the machine has made ten parts
    clock = Date.now();
    await gw.observe();
    await sys.advance(true);
  }, 120_000);
  afterAll(async () => sys?.close());

  it("refuses requests not signed by the asset's gateway", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const ts = Math.floor(Date.now() / 1000);
    const h = (nonce: string, t = ts) => ({ host: "localhost", "x-ordo-device": stranger.address, "x-ordo-ts": String(t), "x-ordo-nonce": nonce, "x-ordo-sig": "" });
    const sig = await stranger.signMessage({ message: edgeMessage(ts, "nonce-0001", "GET", "/v1/edge/stages", "") });
    // a valid signature from a key that is no asset's gateway
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0001"), "x-ordo-sig": sig } })).status).toBe(403);
    // replayed, stale, or signed for another nonce
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0001"), "x-ordo-sig": sig } })).status).toBe(401);
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0002", ts - 3600), "x-ordo-sig": sig } })).status).toBe(401);
    expect((await app.request("/v1/edge/stages", { headers: { ...h("nonce-0003"), "x-ordo-sig": sig } })).status).toBe(401);
  });

  it("the gateway signs the finished stage's counts from its own counters, and Ordo proves the criteria", async () => {
    const run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    expect(run.stages.find((s: any) => s.code === "01")).toMatchObject({ unitsGood: 10, workDoneAt: expect.any(String) });
    const signed = await gw.signFinished();
    expect(signed).toEqual([{ stage: "01", runId, matches: true }]);
    await sys.stageProofs.reconcile();
    const proofs = (await admin.call("GET", `${S()}/runs/${runId}/proofs`)).json.stages;
    expect(proofs).toEqual([expect.objectContaining({ stage: "01", status: "proven", verified: true, signerKind: "device", criteria: ["Yield", "Cycle time"] })]);
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    const d = decisions.find((x: any) => x.kind === "stage.reading_signed");
    expect(d.data).toMatchObject({ signerKind: "device", matches: true });
    expect(JSON.stringify(d.data)).not.toMatch(/"good"|salt/);
    // only once per stage
    expect(await gw.signFinished()).toEqual([]);
  }, 120_000);

  it("a manager signs a manual stage's counts; counts that miss a criterion are not proven", async () => {
    // a contributor neither records a stage nor signs its counts
    expect((await operator.call("POST", `${S()}/runs/${runId}/stages/02/record`, { good: 9, scrap: 1, complete: true })).status).toBe(403);
    expect((await operator.call("POST", `${S()}/runs/${runId}/stages/02/reading/sign-request`, { good: 9, scrap: 1 })).status).toBe(403);
    await lead.call("POST", `${S()}/runs/${runId}/stages/02/record`, { good: 9, scrap: 1, complete: true });
    // a gateway machine's stage is signed by its gateway, not a person
    expect((await lead.call("POST", `${S()}/runs/${runId}/stages/01/reading/sign-request`, { good: 10, scrap: 0 })).status).toBe(409);
    const req = (await lead.call("POST", `${S()}/runs/${runId}/stages/02/reading/sign-request`, { good: 9, scrap: 1 })).json;
    expect(req.typed.primaryType).toBe("OrdoReading");
    const m = req.typed.message;
    const signature = await lead.account.signTypedData(asTyped(req.typed));
    const r = await lead.call("POST", `${S()}/runs/${runId}/stages/02/reading`, { good: 9, scrap: 1, salt: req.salt, commitment: m.commitment, anchor: m.anchor, signedAt: Number(m.signedAt), signature });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ signer: lead.address, matches: true });
    await sys.stageProofs.reconcile();
    const proofs = (await admin.call("GET", `${S()}/runs/${runId}/proofs`)).json.stages;
    // 10 % scrap misses "scrap ≤ 5 %": nothing is proven, and the reason is shown
    expect(proofs.find((p: any) => p.stage === "02")).toMatchObject({ status: "not_met", signerKind: "operator", proof: null, detail: expect.stringMatching(/Scrap/) });
  }, 120_000);

  it("maps criteria to the circuit's comparisons exactly", () => {
    const y = slotOf({ label: "Yield", op: ">=", target: 98.5, unit: "%" } as never)!;
    expect(y).toMatchObject({ kind: 1n, op: 0n, target: 985_000n });
    expect(holds(y, { good: 197n, scrap: 3n, startedAt: 0n, endedAt: 1n })).toBe(true); // 98.5 %
    expect(holds(y, { good: 196n, scrap: 4n, startedAt: 0n, endedAt: 1n })).toBe(false);
    expect(slotOf({ label: "OEE", op: ">=", target: 85, unit: "%" } as never)).toBeNull();
    const ct = slotOf({ label: "Cycle time", op: "<=", target: 0.5, unit: "min" } as never)!;
    expect(holds(ct, { good: 10n, scrap: 0n, startedAt: 0n, endedAt: 300n })).toBe(true);
    expect(holds(ct, { good: 10n, scrap: 0n, startedAt: 0n, endedAt: 301n })).toBe(false);
  });
});

/**
 * An instrument on a gateway: its profile signals pass the ingest allow-list because a running stage reads them, the
 * stage is judged on them, closes when the batch is counted, and the gateway signs the counts as for any machine.
 */
describe("an instrument's gateway running a profile", () => {
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let admin: Client;
  let site = "";
  let runId = "";
  let asset = "";
  let gw: Gateway;
  const S = () => `/v1/sites/${site}`;

  beforeAll(async () => {
    ({ sys, app } = await boot());
    admin = await wallet(app);
    site = (await admin.call("POST", "/v1/sites", { name: "Protein Lab", timezone: "UTC", lineName: "Suite 1", zones: [] })).json.id;
    await atLevel(sys, site, "L3"); // machine stages complete on their own when in spec
    const key = generatePrivateKey();
    asset = (await admin.call("POST", `${S()}/assets`, { name: "BR-01 Bioreactor", kind: "process_vessel", owningAgent: "process", source: { type: "gateway", device: privateKeyToAccount(key).address }, limits: {}, idealCycleS: null })).json.id;
    // a 60 s "stage" that counts one batch; the clock starts a minute back so the first sample predates the run
    let clock = Date.now() - 61_000;
    const signals = [
      { name: "temperature", base: 37, swing: 0.4 },
      { name: "od600", base: 0.9, swing: 0.05 },
      { name: "ph", base: 7, swing: 0.1 },
    ];
    gw = new Gateway({ url: "http://localhost", key, assetId: asset, source: { kind: "profile", stageS: 60, batchUnits: 1, signals }, fetch: ((u: string, init: RequestInit) => app.request(new URL(u).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } })) as never, now: () => clock });
    await gw.observe();
    const spec = {
      stages: [
        {
          code: "01",
          column: 1,
          name: "Expression",
          agent: "process",
          resourceKind: "process_vessel",
          mode: "auto",
          escalationRole: "manager",
          timeoutMin: 600,
          criteria: [
            { label: "Culture temperature", kind: "signal", signal: "temperature", agg: "envelope", op: ">=", target: 35, targetMax: 39, unit: "°C" },
            { label: "Cell density OD600", kind: "signal", signal: "od600", agg: "last", op: ">=", target: 0.6, unit: "" },
            { label: "Yield", op: ">=", target: 95, unit: "%" },
          ],
        },
      ],
      rework: null,
    };
    const tpl = await admin.call("POST", `${S()}/templates`, { name: "Expression", category: "Regulated", description: "Edge test", spec });
    runId = (await admin.call("POST", `${S()}/runs`, { templateVersionId: tpl.json.versionId, orderRef: "PS-9", quantity: 1 })).json.id;
    // a minute later the profile has run its course: two samples inside the stage window (after the run started, before
    // the engine looks), and one batch counted
    await new Promise((r) => setTimeout(r, 700));
    clock = Date.now() - 500;
    await gw.observe();
    clock = Date.now();
    await gw.observe();
    await sys.advance(true);
  }, 120_000);
  afterAll(async () => sys?.close());

  it("keeps the signals the running stage reads and drops the rest", async () => {
    // temperature is a standard signal and is always kept, including the sample before the run; od600 is kept only once a
    // running stage reads it; nothing reads ph, so it is dropped
    expect(await sys.plant.series(asset, "temperature", 10)).toHaveLength(3);
    expect(await sys.plant.series(asset, "od600", 10)).toHaveLength(2);
    expect(await sys.plant.series(asset, "ph", 10)).toHaveLength(0);
  });

  it("judges the stage on the instrument's signals, closes it on the batch, and the gateway signs the counts", async () => {
    const run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    const st = run.stages.find((s: any) => s.code === "01");
    expect(st).toMatchObject({ state: "completed", unitsGood: 1, unitsScrap: 0, workDoneAt: expect.any(String) });
    expect(st.criteriaResults).toEqual([
      expect.objectContaining({ label: "Culture temperature", ok: true, n: 2, band: { lo: 35, hi: 39 } }),
      expect.objectContaining({ label: "Cell density OD600", ok: true, n: 2 }),
      expect.objectContaining({ label: "Yield", ok: true, actual: "100.0%" }),
    ]);
    // the gateway signs the counts, and one measurement per bound of the stage's measured parameters
    expect(await gw.signFinished()).toEqual([{ stage: "01", runId, matches: true, measurements: 3 }]);
    await sys.stageProofs.reconcile();
    const proofs = (await admin.call("GET", `${S()}/runs/${runId}/proofs`)).json.stages;
    // the count circuit proves the count criterion; the signal parameters are proven per value on the passport
    expect(proofs).toEqual([expect.objectContaining({ stage: "01", status: "proven", verified: true, signerKind: "device", criteria: ["Yield"] })]);
  }, 120_000);

  it("Ordo proves the signed measurements from the gateway's own commitments and folds them into the release root", async () => {
    const device = gw.account.address.toLowerCase();
    const rows = await sys.db.query<{ label: string; matches: boolean; signer: string }>("SELECT label, matches, signer FROM measurement_readings WHERE run_id = $1 ORDER BY label", [runId]);
    expect(rows.rows).toEqual([
      { label: "Cell density OD600", matches: true, signer: device },
      { label: "Culture temperature", matches: true, signer: device },
      { label: "Culture temperature#max", matches: true, signer: device },
    ]);
    // the ledger has the commitments and the signer, never a value or salt
    const d = (await admin.call("GET", `${S()}/decisions?limit=100`)).json.find((x: any) => x.kind === "stage.measurements_signed");
    expect(d.data).toMatchObject({ signerKind: "device", signer: device });
    expect(d.data.measurements).toHaveLength(3);
    expect(JSON.stringify(d.data)).not.toMatch(/"value"|salt/);
    // signing twice is refused
    expect(await gw.signFinished()).toEqual([]);

    await sys.passports.specs!.reconcile(50);
    const proofs = await sys.db.query<{ label: string; status: string; signer: string | null; signer_kind: string | null }>("SELECT label, status, signer, signer_kind FROM spec_proofs WHERE run_id = $1 ORDER BY label", [runId]);
    expect(proofs.rows).toEqual([
      { label: "Cell density OD600", status: "proven", signer: device, signer_kind: "device" },
      { label: "Culture temperature", status: "proven", signer: device, signer_kind: "device" },
      { label: "Culture temperature#max", status: "proven", signer: device, signer_kind: "device" },
      { label: "Yield", status: "proven", signer: null, signer_kind: null }, // from counts: Ordo commits
    ]);
    const pub = (await (await app.request(`/v1/public/passports/${runId}`, { headers: { host: "localhost" } })).json()) as any;
    const crit = pub.passport.stages[0].criteria;
    const temp = crit.find((c: any) => c.label === "Culture temperature");
    expect(temp.zk).toMatchObject({ status: "proven", verified: true, signerKind: "device", signer: device, measurement: { criterion: "Culture temperature", signature: expect.stringMatching(/^0x/) } });
    expect(temp.zkMax).toMatchObject({ status: "proven", verified: true, signerKind: "device", measurement: { criterion: "Culture temperature#max" } });
    expect(temp.zk.measurement.commitment).toBe(temp.zk.publicSignals[3]);
    expect(crit.find((c: any) => c.label === "Yield").zk).toMatchObject({ status: "proven", verified: true, signerKind: "ordo", signer: null, measurement: null });
    expect(JSON.stringify(pub)).not.toMatch(/salt/);
    // the release root folds the three source-signed parameters after the stages; Ordo's own commitments stay off-chain
    const zero = `0x${"00".repeat(32)}` as const;
    const b = await sys.passports.specs!.bundle(runId, zero);
    expect(b.params.map((p) => p.criterion)).toEqual(["Cell density OD600", "Culture temperature", "Culture temperature#max"]);
    expect(b.keys).toEqual(["01|Cell density OD600", "01|Culture temperature", "01|Culture temperature#max"]);
    expect(b.root).not.toBe(zero);
    expect(b.params[1]).toMatchObject({ stage: "01", asset, op: 0n, target: 350_000n, sig: expect.stringMatching(/^0x/) });
    expect(b.params[2]).toMatchObject({ op: 1n, target: 390_000n });
    expect((await sys.passports.specs!.bundle(runId, zero, ["01|Culture temperature"])).params).toHaveLength(1);
  }, 120_000);
});
