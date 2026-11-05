import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, join, promote, wallet, type Client, type System } from "./helpers.js";

/**
 * Proof of work end to end without a Router or a chain: a contributor starts a session on a running stage, the terminal
 * agent (here, plain requests with the session token) fetches the stage and posts the interview, the contributor signs
 * the record, a validator selects it and the stage closes from it, and a tester's case against the validator is answered
 * and decided by the manager.
 */
describe("proof of work, selection and cases", () => {
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let manager: Client;
  let alice: Client;
  let bob: Client;
  let val: Client;
  let tester: Client;
  let site = "";
  let runId = "";
  let first = "";
  let second = "";
  let caseId = "";
  const S = () => `/v1/sites/${site}`;

  /** What the terminal agent does with a session token. */
  const agent = (token: string) => {
    const secret = token.split(".")[2]!;
    const h = { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json" };
    return {
      secret,
      get: async (path: string) => {
        const r = await app.request(path, { headers: h });
        return { status: r.status, json: await r.json() };
      },
      post: async (path: string, body: unknown) => {
        const r = await app.request(path, { method: "POST", headers: h, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json() };
      },
    };
  };
  const interview = (good: number, scrap: number, scrapPct: number) => ({
    summary: `Inspected the lot: ${good} good, ${scrap} scrap.`,
    measurements: [
      { criterion: "Good units", value: good },
      { criterion: "Scrap units", value: scrap },
      { criterion: "Scrap", value: scrapPct, unit: "%" },
    ],
    notes: [{ text: "One housing had a burr on the flange.", at: new Date().toISOString() }],
    evidence: [{ name: "inspection.jpg", sha256: createHash("sha256").update("photo").digest("hex"), size: 5 }],
    transcript: [
      { role: "assistant", content: "How many good units?", at: new Date().toISOString() },
      { role: "user", content: String(good), at: new Date().toISOString() },
    ],
    receipts: [{ resKey: "chatcmpl-1", requestId: "req-1", provider: "0x1111111111111111111111111111111111111111", teeVerified: true, model: "glm-5.3", at: new Date().toISOString(), requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), headers: { "zg-res-key": "chatcmpl-1" } }],
  });
  /** A member contributes to stage 01: session, interview, signature. Returns the contribution id. */
  const contribute = async (who: Client, good: number, scrap: number, scrapPct: number) => {
    const s = await who.call("POST", `${S()}/pow/sessions`, { runId, stage: "01" });
    expect(s.status).toBe(200);
    const a = agent(s.json.token);
    const f = await a.post("/v1/pow/session/finish", interview(good, scrap, scrapPct));
    expect(f.status).toBe(200);
    const req = await who.call("POST", `${S()}/contributions/${f.json.contributionId}/sign-request`, { chainId: 296 });
    const signed = await who.call("POST", `${S()}/contributions/${f.json.contributionId}/sign`, { nonce: req.json.message.nonce, signature: await who.sign(req.json) });
    expect(signed.status).toBe(200);
    return f.json.contributionId as string;
  };

  beforeAll(async () => {
    ({ sys, app } = await boot());
    manager = await wallet(app);
    alice = await wallet(app);
    bob = await wallet(app);
    val = await wallet(app);
    tester = await wallet(app);
    site = (await manager.call("POST", "/v1/sites", { name: "Works", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
    for (const c of [alice, bob, val, tester]) await join(c, site);
    expect((await promote(manager, S(), val, "validator")).status).toBe(200);
    expect((await promote(manager, S(), tester, "tester")).status).toBe(200);
    const spec = {
      stages: [{ code: "01", column: 1, name: "Inspect housings", agent: "vision_qa", resourceKind: "manual_station", mode: "manual", escalationRole: "manager", timeoutMin: 600, criteria: [{ label: "Scrap", op: "<=", target: 20, unit: "%" }] }],
      rework: null,
    };
    const tpl = await manager.call("POST", `${S()}/templates`, { name: "Inspection", category: "Discrete", description: "Proof of work test", spec });
    runId = (await manager.call("POST", `${S()}/runs`, { templateVersionId: tpl.json.versionId, orderRef: "SO-POW", quantity: 10 })).json.id;
    await sys.advance(true);
  }, 120_000);
  afterAll(async () => sys?.close());

  it("a session gives the terminal agent the stage and a private Router key, behind its token only", async () => {
    const s = await alice.call("POST", `${S()}/pow/sessions`, { runId, stage: "01" });
    expect(s.status).toBe(200);
    expect(s.json.command).toMatch(/^npx ordo-pow@latest opw1\.[\w-]+\.[\w-]{20,}$/);
    expect(Buffer.from(s.json.token.split(".")[1], "base64url").toString()).toBe("http://localhost");
    const a = agent(s.json.token);
    const info = await a.get("/v1/pow/session");
    expect(info.status).toBe(200);
    expect(info.json.stage).toMatchObject({ runId, code: "01", orderRef: "SO-POW" });
    expect(info.json.stage.criteria.map((c: any) => c.label)).toEqual(["Good units", "Scrap units", "Scrap"]);
    expect(info.json.router).toMatchObject({ trustMode: "private", apiKey: expect.stringMatching(/^sk-mock-/) });
    expect(info.json.guide).toMatch(/Inspect housings/);
    // nothing without the token, or with another one
    expect((await app.request("/v1/pow/session", { headers: { host: "localhost" } })).status).toBe(401);
    expect((await app.request("/v1/pow/session", { headers: { host: "localhost", authorization: "Bearer not-a-real-session-secret-000" } })).status).toBe(404);
    // a new session replaces this one
    await alice.call("POST", `${S()}/pow/sessions`, { runId, stage: "01" });
    expect((await a.get("/v1/pow/session")).status).toBe(410);
  });

  it("the agent's record is committed and sealed; the contributor signs it; the public proof shows no values", async () => {
    const s = await alice.call("POST", `${S()}/pow/sessions`, { runId, stage: "01" });
    const a = agent(s.json.token);
    // a criterion the stage does not have is refused
    expect((await a.post("/v1/pow/session/finish", { ...interview(9, 1, 10), measurements: [{ criterion: "Torque", value: 3 }] })).status).toBe(400);
    const f = await a.post("/v1/pow/session/finish", interview(9, 1, 10));
    expect(f.status).toBe(200);
    first = f.json.contributionId;
    expect(f.json.signUrl).toBe(`http://localhost/#/pow/${first}/sign?site=${encodeURIComponent(site)}`);
    // finishing again returns the same contribution
    expect((await a.post("/v1/pow/session/finish", interview(9, 1, 10))).json.contributionId).toBe(first);
    expect((await a.get("/v1/pow/session/status")).json).toMatchObject({ status: "submitted", contributionId: first, proofUrl: null });
    // the session's Router key is no longer handed out
    expect((await a.get("/v1/pow/session")).json.router.apiKey).toBe("");

    // until it is signed, only its author sees it
    expect((await val.call("GET", `${S()}/runs/${runId}/stages/01/contributions`)).json.contributions).toEqual([]);
    expect((await bob.call("POST", `${S()}/contributions/${first}/sign-request`, { chainId: 296 })).status).toBe(403);
    const req = await alice.call("POST", `${S()}/contributions/${first}/sign-request`, { chainId: 296 });
    expect(req.json.message).toMatchObject({ action: "contribution.sign", entity: expect.stringMatching(new RegExp(`^${first}#sha256:[0-9a-f]{64}$`)) });
    const signed = await alice.call("POST", `${S()}/contributions/${first}/sign`, { nonce: req.json.message.nonce, signature: await alice.sign(req.json) });
    expect(signed.status).toBe(200);
    expect(signed.json).toMatchObject({ status: "signed", ledgerSeq: expect.any(Number), tee: { turns: 1, verified: 1, allVerified: true } });
    expect((await a.get("/v1/pow/session/status")).json).toMatchObject({ status: "signed", proofUrl: `http://localhost/#/pow/${first}` });

    const pub = await app.request(`/v1/public/contributions/${first}`, { headers: { host: "localhost" } });
    const p = await pub.json();
    expect(pub.status).toBe(200);
    expect(p.measurements).toHaveLength(3);
    expect(p.measurements.every((m: any) => m.value === undefined && /^\d+$/.test(m.commitment))).toBe(true);
    expect(p.summary).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("burr");
    expect(p.receipts[0]).toMatchObject({ teeVerified: true, resKey: "chatcmpl-1" });
  });

  it("a stage takes many contributions; level 3 sees their values, a contributor only their own", async () => {
    second = await contribute(bob, 10, 0, 0);
    const v = await val.call("GET", `${S()}/runs/${runId}/stages/01/contributions`);
    expect(v.json.total).toBe(2);
    expect(v.json.contributions.find((c: any) => c.id === first).measurements.find((m: any) => m.criterion === "Good units").value).toBe(9);
    const mine = await bob.call("GET", `${S()}/runs/${runId}/stages/01/contributions`);
    expect(mine.json.contributions.map((c: any) => c.id)).toEqual([second]);
    // the sealed record is the manager's
    expect((await val.call("GET", `${S()}/contributions/${first}/record`)).status).toBe(403);
    expect((await manager.call("GET", `${S()}/contributions/${first}/record`)).json.notes[0].text).toMatch(/burr/);
  });

  it("a validator selects one; the others are not selected and the stage closes from the selected record", async () => {
    expect((await alice.call("POST", `${S()}/contributions/${second}/select/sign-request`, {})).status).toBe(403);
    const req = await val.call("POST", `${S()}/contributions/${first}/select/sign-request`, { comment: "Matches the photos" });
    expect(req.status).toBe(200);
    expect(req.json.message).toMatchObject({ action: "contribution.select", entity: `${first}#${alice.address}` });
    const r = await val.call("POST", `${S()}/contributions/${first}/select`, { comment: "Matches the photos", nonce: req.json.message.nonce, signature: await val.sign(req.json) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ contributionId: first, stageClosed: true, chain: null });
    const list = (await val.call("GET", `${S()}/runs/${runId}/stages/01/contributions`)).json.contributions;
    expect(list.find((c: any) => c.id === first)).toMatchObject({ status: "selected", selection: { by: val.address, comment: "Matches the photos" } });
    expect(list.find((c: any) => c.id === second).status).toBe("not_selected");
    const run = (await manager.call("GET", `${S()}/runs/${runId}`)).json.run;
    expect(run.stages[0]).toMatchObject({ unitsGood: 9, unitsScrap: 1 });
    expect(["completed", "done_deviation"]).toContain(run.stages[0].state);
    // a person's report is not a signed reading: Ordo commits the values itself (the machine's outputs are signed)
    const reading = await sys.db.query("SELECT 1 FROM stage_readings WHERE run_id = $1", [runId]);
    expect(reading.rows).toHaveLength(0);
    // the stage takes no more proof of work
    expect((await bob.call("POST", `${S()}/pow/sessions`, { runId, stage: "01" })).status).toBe(409);
  });

  it("a tester's case is answered by the validator and decided by the manager", async () => {
    const evidence = "The flange burr noted in the record is out of tolerance; the stage should not have passed.";
    expect((await bob.call("POST", `${S()}/cases/sign-request`, { contributionId: first, bps: 3000, evidence })).status).toBe(403);
    const req = await tester.call("POST", `${S()}/cases/sign-request`, { contributionId: first, bps: 3000, evidence });
    expect(req.status).toBe(200);
    caseId = req.json.caseId;
    const opened = await tester.call("POST", `${S()}/cases`, { caseId, contributionId: first, bps: 3000, evidence, nonce: req.json.typed.message.nonce, signature: await tester.sign(req.json.typed) });
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ status: "open", validator: { address: val.address }, can: { readRecord: true } });
    // one open case per proof of work, and the tester reads the sealed record while it is open
    expect((await tester.call("POST", `${S()}/cases/sign-request`, { contributionId: first, bps: 1000, evidence })).status).toBe(409);
    expect((await tester.call("GET", `${S()}/cases/${caseId}/record`)).json.summary).toMatch(/9 good/);
    expect((await tester.call("GET", `${S()}/cases/candidates`)).json[0]).toMatchObject({ contributionId: first, openCase: caseId });
    // the manager waits for the answer (or the window)
    expect((await manager.call("POST", `${S()}/cases/${caseId}/decide/sign-request`, { uphold: true })).status).toBe(409);
    const response = "The burr was within the drawing's 0.2 mm allowance; the photo shows the gauge.";
    expect((await tester.call("POST", `${S()}/cases/${caseId}/respond/sign-request`, { response })).status).toBe(403);
    const rr = await val.call("POST", `${S()}/cases/${caseId}/respond/sign-request`, { response });
    const answered = await val.call("POST", `${S()}/cases/${caseId}/respond`, { response, nonce: rr.json.message.nonce, signature: await val.sign(rr.json) });
    expect(answered.json).toMatchObject({ status: "responded", response });
    const dr = await manager.call("POST", `${S()}/cases/${caseId}/decide/sign-request`, { uphold: false, comment: "Within allowance" });
    expect(dr.json.message).toMatchObject({ action: "case.decide", entity: `${caseId}#reject` });
    const decided = await manager.call("POST", `${S()}/cases/${caseId}/decide`, { uphold: false, comment: "Within allowance", nonce: dr.json.message.nonce, signature: await manager.sign(dr.json) });
    expect(decided.json).toMatchObject({ status: "rejected", decidedBy: manager.address });
    // decided: the tester no longer reads the record
    expect((await tester.call("GET", `${S()}/cases/${caseId}/record`)).status).toBe(409);
    const kinds = (await manager.call("GET", `${S()}/decisions?limit=100`)).json.map((d: any) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(["contribution.signed", "contribution.selected", "case.opened", "case.responded", "case.rejected"]));
  });

  it("rewards report the selection, with nothing on-chain without OrdoTrust v3", async () => {
    const r = await alice.call("GET", `${S()}/rewards`);
    expect(r.json).toMatchObject({ configured: false, v3: false, settingsOnchain: false, pool: null, claimable: null });
    expect(r.json.acceptances).toEqual([expect.objectContaining({ contributionId: first, validator: expect.objectContaining({ address: val.address }), openCase: null })]);
    expect((await alice.call("POST", `${S()}/rewards/claim`)).status).toBe(409);
  });
});
