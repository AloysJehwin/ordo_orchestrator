import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { atLevel, boot, demote, join, promote, uid, wallet, type Client, type System } from "./helpers.js";

let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
/** the org's creator, its manager */
let admin: Client;
/** a contributor */
let operator: Client;
/** a validator */
let qe: Client;
/** a second manager */
let pm: Client;
let site = "";
let cnc = "";
let runId = "";

const S = () => `/v1/sites/${site}`;
const tick = () => sys.advance(true);

beforeAll(async () => {
  ({ sys, app } = await boot());
  admin = await wallet(app);
}, 60_000);
afterAll(async () => sys.close());

describe("accounts", () => {
  it("rejects anonymous access and a replayed sign-in", async () => {
    const anon = await app.request("/v1/sites/x/assets", { headers: { host: "localhost" } });
    expect(anon.status).toBe(401);
  });

  it("the first wallet creates an org and becomes its manager", async () => {
    const r = await admin.call("POST", "/v1/sites", { name: "Pune Plant 1", timezone: "Asia/Kolkata", lineName: "Line 2", zones: ["Machining", "Inspection"] });
    expect(r.status).toBe(200);
    site = r.json.id;
    // machine stages here complete on their own when in spec, as at L3
    await atLevel(sys, site, "L3");
    const me = await admin.call("GET", "/v1/me");
    expect(me.json.memberships[0].roles).toEqual(["manager"]);
  });

  it("people join as contributors, by wallet or on their own; a contributor cannot add anyone", async () => {
    operator = await wallet(app);
    qe = await wallet(app);
    pm = await wallet(app);
    await qe.call("PATCH", "/v1/me", { displayName: "Meera Okafor" });
    await pm.call("PATCH", "/v1/me", { displayName: "Sven Lindqvist" });
    // operator already signed in once: added directly
    expect((await admin.call("POST", `${S()}/team/invites`, { address: operator.address })).json.added).toBe(true);
    expect((await join(qe, site)).joined).toBe(true);
    expect((await join(pm, site)).joined).toBe(true);
    const team = await admin.call("GET", `${S()}/team`);
    expect(team.json.members).toHaveLength(4);
    expect(team.json.members.filter((m: any) => m.address !== admin.address).every((m: any) => m.roles.join() === "contributor")).toBe(true);
    // a contributor cannot invite
    expect((await operator.call("POST", `${S()}/team/invites`, { address: qe.address })).status).toBe(403);
  });

  it("a manager promotes a validator and a second manager with signatures", async () => {
    const v = await promote(admin, S(), qe, "validator");
    expect(v.status).toBe(200);
    expect((await promote(admin, S(), pm, "manager")).status).toBe(200);
    // only a manager promotes
    expect((await promote(qe, S(), operator, "validator")).status).toBe(403);
    const stakers = (await admin.call("GET", `${S()}/stakers`)).json;
    expect(stakers.stakers.map((x: any) => x.address).sort()).toEqual([admin.address, qe.address, pm.address].sort());
    expect((await qe.call("GET", `${S()}/stakers`)).json.me.validator.ok).toBe(true);
    expect((await operator.call("GET", `${S()}/stakers`)).json.me.validator.ok).toBe(false);
  });

  it("blocks cross-site writes", async () => {
    const res = await app.request(`${S()}/zones`, { method: "POST", headers: { host: "localhost", origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("assets and real readings", () => {
  it("registers an asset with limits; no data means no status", async () => {
    const r = await admin.call("POST", `${S()}/assets`, {
      name: "CNC-01",
      kind: "cnc",
      owningAgent: "scheduler",
      source: { type: "manual" },
      limits: { temperature: { warn: 60, alarm: 80, unit: "°C" } },
      idealCycleS: 30,
    });
    expect(r.status).toBe(200);
    cnc = r.json.id;
    const assets = await admin.call("GET", `${S()}/assets`);
    expect(assets.json[0].status).toBe("no_data");
    expect(assets.json[0].utilization).toBeNull();
    expect(assets.json[0].oee).toBeNull();
  });

  it("records manual readings (a manager does; a contributor cannot)", async () => {
    expect((await operator.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "execution", text: "ACTIVE" })).status).toBe(403);
    await admin.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "execution", text: "ACTIVE" });
    await admin.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "part_count", value: 100 });
    const a = (await admin.call("GET", `${S()}/assets`)).json[0];
    expect(a.status).toBe("running");
    expect(a.latest.part_count.value).toBe(100);
  });
});

describe("pipelines", () => {
  let versionId = "";
  it("ships the 20 library templates", async () => {
    const t = await admin.call("GET", `${S()}/templates`);
    expect(t.json.filter((x: any) => x.origin === "library")).toHaveLength(20);
  });

  it("publishes a custom template from the builder", async () => {
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Release order", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "manager", timeoutMin: 10, criteria: [] },
        { code: "02", column: 2, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "manager", timeoutMin: 60, criteria: [{ label: "Yield", op: ">=", target: 95, unit: "%" }] },
        { code: "03", column: 3, name: "Final inspection", agent: "vision_qa", resourceKind: "inspection", mode: "approve", escalationRole: "validator", timeoutMin: 30, criteria: [{ label: "Yield", op: ">=", target: 99, unit: "%" }] },
      ],
      rework: null,
    };
    expect((await operator.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", spec })).status).toBe(403);
    const r = await admin.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "Test line", spec });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(1);
    versionId = r.json.versionId;
    const bad = await admin.call("POST", `${S()}/templates`, { name: "Bad", category: "x1", spec: { ...spec, rework: { from: "01", to: "03" } } });
    expect(bad.status).toBe(400);
  });

  it("runs on measured part counts and gates on a signed approval", async () => {
    const r = await admin.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-7781", quantity: 10 });
    expect(r.status).toBe(200);
    runId = r.json.id;
    const st = (code: string) => r.json.stages.find((s: any) => s.code === code);
    expect(st("01").state).toBe("completed");
    expect(st("02").state).toBe("running");
    expect(st("02").assetId).toBe(cnc);

    // the machine counts 10 parts
    await admin.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "part_count", value: 110 });
    await tick();
    let run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    const s2 = run.stages.find((s: any) => s.code === "02");
    expect(s2.state).toBe("completed");
    expect(s2.unitsGood).toBe(10);
    const s3 = run.stages.find((s: any) => s.code === "03");
    expect(s3.state).toBe("running");
    expect(s3.waitingReason).toMatch(/operator records/);

    // a manager records the inspection (a contributor cannot); approve mode raises a gate
    expect((await operator.call("POST", `${S()}/runs/${runId}/stages/03/record`, { good: 10, scrap: 0, complete: true })).status).toBe(403);
    await pm.call("POST", `${S()}/runs/${runId}/stages/03/record`, { good: 10, scrap: 0, complete: true });
    run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    expect(run.stages.find((s: any) => s.code === "03").state).toBe("awaiting_approval");
    const inbox = (await admin.call("GET", `${S()}/inbox`)).json;
    const gate = inbox.find((i: any) => i.runId === runId && i.stageCode === "03");
    expect(gate.requiredRole).toBe("validator");

    // a contributor cannot release a quality gate
    expect((await operator.call("POST", `${S()}/inbox/${gate.id}/sign-request`, { option: 0 })).status).toBe(403);

    // the validator signs with their wallet
    const typed = (await qe.call("POST", `${S()}/inbox/${gate.id}/sign-request`, { option: 0, comment: "Visual check OK" })).json;
    expect(typed.message.entity).toBe(`${gate.id}#0`);
    // a signature from another wallet is rejected
    const forged = await admin.sign(typed);
    expect((await qe.call("POST", `${S()}/inbox/${gate.id}/decide`, { option: 0, comment: "x", nonce: typed.message.nonce, signature: forged })).status).toBe(401);
    // the failed attempt rolled back, so the nonce is still usable by its owner
    const sig = await qe.sign(typed);
    const d = await qe.call("POST", `${S()}/inbox/${gate.id}/decide`, { option: 0, comment: "Visual check OK", nonce: typed.message.nonce, signature: sig });
    expect(d.status).toBe(200);
    expect(d.json.status).toBe("approved");
    // replaying the same signature fails
    expect((await qe.call("POST", `${S()}/inbox/${gate.id}/decide`, { option: 0, comment: "x", nonce: typed.message.nonce, signature: sig })).status).toBe(409);

    run = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    expect(run.status).toBe("completed");
    expect(run.metrics.rolledYield).toBe(1);
  });
});

describe("pending actions", () => {
  it("a waiting stage says what it waits on and offers a retry or a bypass; a manager's signed waiver starts it", async () => {
    const wax = { key: "pattern_wax", label: "Filled pattern wax", kind: "pattern_wax", unit: "kg", qty: 6, per: "batch", maxPrice: 0.9 };
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Wax pattern injection", agent: "scheduler", resourceKind: "cnc", mode: "manual", escalationRole: "manager", timeoutMin: 60, criteria: [], resources: [wax] },
        { code: "02", column: 2, name: "Final inspection", agent: "vision_qa", resourceKind: "inspection", mode: "manual", escalationRole: "manager", timeoutMin: 30, criteria: [] },
      ],
      rework: null,
    };
    const t = (await admin.call("POST", `${S()}/templates`, { name: "Wax patterns", category: "Discrete", description: "Resources", spec })).json;
    const id = (await admin.call("POST", `${S()}/runs`, { templateVersionId: t.versionId, orderRef: "SO-WAX", quantity: 4 })).json.id as string;
    await tick();
    const p = (await admin.call("GET", `${S()}/runs/${id}/pending`)).json;
    const s1 = p.stages.find((s: any) => s.code === "01");
    expect(s1).toMatchObject({ headline: "Waiting for Filled pattern wax", status: "blocked", upstream: [] });
    expect(s1.items[0].text).toBe("Filled pattern wax: 0 of 6 kg arrived");
    // the machine that would buy it may not, and nobody sells it: each is fixed where it lives; a manager may also start without the wax
    expect(s1.items.map((i: any) => i.text)).toEqual(expect.arrayContaining(["CNC-01 does not hold the Buyer role, so it may not buy", "No vendor sells pattern_wax"]));
    expect(s1.actions.map((a: any) => [a.id, a.kind, a.role])).toEqual(expect.arrayContaining([["open_machine", "open", "manager"], ["open_vendors", "open", "manager"], ["waive_resources", "bypass", "manager"]]));
    expect(p.stages.find((s: any) => s.code === "02")).toMatchObject({ headline: "Waits for 01 Wax pattern injection", status: "waiting", upstream: ["01"] });
    expect(p.blocking).toEqual(["01"]);
    // a contributor sees why too
    expect((await operator.call("GET", `${S()}/runs/${id}/pending`)).status).toBe(200);
    // bypass: the manager signs the waiver and the stage starts, waiting on an operator now
    const body = { reason: "Wax already on site" };
    const typed = (await admin.call("POST", `${S()}/runs/${id}/stages/01/resources/waive/sign-request`, body)).json;
    expect((await admin.call("POST", `${S()}/runs/${id}/stages/01/resources/waive`, { ...body, nonce: typed.message.nonce, signature: await admin.sign(typed) })).status).toBe(200);
    const after = (await admin.call("GET", `${S()}/runs/${id}/pending`)).json;
    expect(after.stages.find((s: any) => s.code === "01")).toMatchObject({ headline: "An operator records it", actions: [expect.objectContaining({ id: "record", role: "manager" })] });
    await admin.call("POST", `${S()}/runs/${id}/abort`, { reason: "Test run" });
    expect((await admin.call("GET", `${S()}/runs/${id}/pending`)).json.stages).toEqual([]);
  });
});

describe("agents on real telemetry", () => {
  it("opens an incident and escalates the out-of-policy action", async () => {
    for (const v of [55, 62, 71, 84]) await admin.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "temperature", value: v });
    await tick();
    const inc = (await admin.call("GET", `${S()}/incidents`)).json;
    expect(inc).toHaveLength(1);
    expect(inc[0].severity).toBe("alarm");
    const items = (await admin.call("GET", `${S()}/inbox`)).json.filter((i: any) => i.incidentId === inc[0].id);
    expect(items).toHaveLength(1);
    expect(items[0].options[0].action.tool).toBe("open_work_order");
    expect(items[0].requiredRole).toBe("manager");
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.some((d: any) => d.kind === "incident.diagnosed" && /temperature/.test(d.summary))).toBe(true);
  });

  it("a signed work order starts a predictive maintenance run", async () => {
    const item = (await admin.call("GET", `${S()}/inbox`)).json.find((i: any) => i.category === "Equipment");
    const typed = (await admin.call("POST", `${S()}/inbox/${item.id}/sign-request`, { option: 0 })).json;
    const r = await admin.call("POST", `${S()}/inbox/${item.id}/decide`, { option: 0, comment: "", nonce: typed.message.nonce, signature: await admin.sign(typed) });
    expect(r.status).toBe(200);
    const runs = (await admin.call("GET", `${S()}/runs`)).json;
    expect(runs.some((x: any) => x.templateName === "Predictive maintenance" && x.orderRef.includes("CNC-01"))).toBe(true);
    // the work order is recorded; with no vendor onboarded and no contract it is unassigned, nothing is paid
    const wo = (await admin.call("GET", `${S()}/work-orders`)).json;
    expect(wo.setup.configured).toBe(false);
    expect(wo.items[0]).toMatchObject({ status: "unassigned", vendor: null, escrow: null });
  });

  it("changing autonomy takes one manager's signature, raising or lowering", async () => {
    await atLevel(sys, site, "L2");
    const lineId = (await admin.call("GET", S())).json.lines[0].id;
    const change = async (who: Client, level: string) => {
      const typed = (await who.call("POST", `${S()}/lines/${lineId}/autonomy/sign-request`, { level })).json;
      return who.call("PUT", `${S()}/lines/${lineId}/autonomy`, { level, nonce: typed.message.nonce, signature: await who.sign(typed) });
    };
    expect((await operator.call("POST", `${S()}/lines/${lineId}/autonomy/sign-request`, { level: "L3" })).status).toBe(403);
    expect((await qe.call("POST", `${S()}/lines/${lineId}/autonomy/sign-request`, { level: "L3" })).status).toBe(403);
    // raise to L3: one manager's signature applies it, and the policy version moves on
    let r = await change(pm, "L3");
    expect(r.json.proposal).toMatchObject({ status: "applied", required: 1, from: "L2", to: "L3", version: 1 });
    expect(r.json.proposal.signers).toHaveLength(1);
    expect(r.json.site.lines[0].autonomy).toBe("L3");
    // lowering is one signature too, from any manager
    r = await change(admin, "L2");
    expect(r.json.proposal).toMatchObject({ status: "applied", required: 1, version: 2 });
    expect(r.json.site.lines[0].autonomy).toBe("L2");
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.filter((d: any) => d.kind === "autonomy.set")).toHaveLength(2);
  });
});

describe("validation package", () => {
  it("runs the full signature chain with separation of duties", async () => {
    const created = await admin.call("POST", `${S()}/validation`, { type: "stage_validation", title: "Housing machining stage", objective: "Prove stage 02", acceptance: "Yield ≥ 95%", runId, stageCode: "02" });
    expect(created.status).toBe(200);
    const id = created.json.id;
    expect(created.json.checks).toHaveLength(1);
    expect(created.json.readiness.ready).toBe(false);

    let p = (await admin.call("POST", `${S()}/validation/${id}/precheck`)).json;
    expect(p.checks[0].status).toBe("pass");
    expect(p.checks[0].actual).toBe("100.0%");
    expect(p.evidence.some((e: any) => e.origin === "agent" && e.sha256)).toBe(true);

    // attach the required inspection report
    const slot = p.evidence.find((e: any) => e.name === "Inspection report");
    const form = new FormData();
    form.set("file", new File(["CMM report: all dimensions in tolerance"], "cmm.txt", { type: "text/plain" }));
    form.set("slotId", slot.id);
    const up = await admin.upload(`${S()}/validation/${id}/evidence`, form);
    expect(up.status).toBe(200);
    expect(up.json.evidence.find((e: any) => e.name === "Inspection report" && !e.removedAt).sha256).toMatch(/^sha256:/);
    // QE can download the stored file
    const res = await app.request(`${S()}/validation/${id}/evidence/${slot.id}/file`, { headers: { host: "localhost" } });
    expect(res.status).toBe(401);
    p = (await admin.call("GET", `${S()}/validation/${id}`)).json;
    expect(p.readiness.ready).toBe(true);

    const act = async (c: Client, action: string, comment = "") => {
      const t = await c.call("POST", `${S()}/validation/${id}/sign-request`, { action, comment });
      if (t.status !== 200) return t;
      return c.call("POST", `${S()}/validation/${id}/act`, { action, comment, nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    // only the owner (a manager created it) signs Performed by
    expect((await act(pm, "sign")).status).toBe(403);
    expect((await act(admin, "sign")).json.status).toBe("in_review");
    // a contributor cannot review
    expect((await act(operator, "sign")).status).toBe(403);
    // the same person cannot also review
    expect((await act(admin, "sign")).status).toBe(403);
    // the validator returns it, the owner resubmits, the chain restarts
    expect((await act(qe, "return", "Add the CMM data file")).json.status).toBe("changes_requested");
    expect((await act(admin, "sign")).json.step).toBe("qe_review");
    // a validator cannot approve the release: that is a manager's, and a different person's
    expect((await act(qe, "sign")).json.step).toBe("approval");
    expect((await act(qe, "sign")).status).toBe(403);
    expect((await act(admin, "sign")).status).toBe(403);
    const done = await act(pm, "sign");
    expect(done.json.status).toBe("released");
    expect(done.json.chain.every((x: any) => x.state === "signed")).toBe(true);
    expect(done.json.audit.length).toBeGreaterThan(8);
  });

  it("an org's only manager may approve a package they performed; a validator still reviews it", async () => {
    expect((await demote(admin, S(), pm, "manager", "Moving to another site")).status).toBe(200);
    const id = (await admin.call("POST", `${S()}/validation`, { type: "stage_validation", title: "Housing machining, second lot", objective: "Prove stage 02 again", acceptance: "Yield ≥ 95%", runId, stageCode: "02" })).json.id;
    const p = (await admin.call("POST", `${S()}/validation/${id}/precheck`)).json;
    const form = new FormData();
    form.set("file", new File(["CMM report: second lot in tolerance"], "cmm2.txt", { type: "text/plain" }));
    form.set("slotId", p.evidence.find((e: any) => e.name === "Inspection report").id);
    expect((await admin.upload(`${S()}/validation/${id}/evidence`, form)).status).toBe(200);
    const act = async (c: Client, action: string, comment = "") => {
      const t = await c.call("POST", `${S()}/validation/${id}/sign-request`, { action, comment });
      if (t.status !== 200) return t;
      return c.call("POST", `${S()}/validation/${id}/act`, { action, comment, nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    expect((await act(admin, "sign")).json.step).toBe("qe_review");
    // the exception is only for approving: the owner still cannot review their own package
    expect((await act(admin, "sign")).status).toBe(403);
    expect((await act(qe, "sign")).json.step).toBe("approval");
    const done = await act(admin, "sign");
    expect(done.json.status).toBe("released");
    expect(done.json.audit.some((a: any) => a.type === "signed.approved" && a.payload?.soleManager === true)).toBe(true);
  });

  it("a manager assigns a package to a contributor, who performs it; other contributors do not see it", async () => {
    const opId = await uid(operator);
    // a contributor sees only the packages assigned to them (and those on stages they contributed to)
    expect((await operator.call("GET", `${S()}/validation`)).json).toEqual([]);
    expect((await admin.call("POST", `${S()}/validation`, { type: "process_change", title: "Nobody's", ownerId: "usr_nobody" })).status).toBe(404);
    const created = (await admin.call("POST", `${S()}/validation`, { type: "stage_validation", title: "Housing machining, third lot", objective: "Prove stage 02 once more", acceptance: "Yield ≥ 95%", runId, stageCode: "02", ownerId: opId })).json;
    expect(created.owner.id).toBe(opId);
    const id = created.id;
    expect((await operator.call("GET", `${S()}/validation`)).json).toEqual([expect.objectContaining({ id, needsMe: true, mine: true, view: "full" })]);
    expect((await operator.call("GET", `${S()}/live`)).json.counts.validation).toBe(1);
    expect((await pm.call("GET", `${S()}/validation`)).json.some((x: any) => x.id === id)).toBe(false);
    expect((await pm.call("GET", `${S()}/validation/${id}`)).status).toBe(403);
    // the contributor performs it: the agent pre-check, the required evidence, then Performed by
    const p = (await operator.call("POST", `${S()}/validation/${id}/precheck`)).json;
    expect(p.checks[0].status).toBe("pass");
    const form = new FormData();
    form.set("file", new File(["CMM report: third lot in tolerance"], "cmm3.txt", { type: "text/plain" }));
    form.set("slotId", p.evidence.find((e: any) => e.name === "Inspection report").id);
    expect((await operator.upload(`${S()}/validation/${id}/evidence`, form)).status).toBe(200);
    const act = async (c: Client, action: string, comment = "") => {
      const t = await c.call("POST", `${S()}/validation/${id}/sign-request`, { action, comment });
      if (t.status !== 200) return t;
      return c.call("POST", `${S()}/validation/${id}/act`, { action, comment, nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    expect((await act(admin, "sign")).status).toBe(403); // the manager who created it does not perform it now
    expect((await act(operator, "sign")).json.step).toBe("qe_review");
    // signed, it no longer changes hands
    expect((await admin.call("POST", `${S()}/validation/${id}/owner`, { userId: await uid(admin) })).status).toBe(409);
    expect((await act(qe, "sign")).json.step).toBe("approval");
    const done = await act(admin, "sign");
    expect(done.json.status).toBe("released");
    expect(done.json.chain.map((x: any) => x.signer.address)).toEqual([operator.address, qe.address, admin.address]);
    expect(done.json.audit.some((a: any) => a.payload?.soleManager)).toBe(false);
  });
});

describe("proof", () => {
  it("the ledger verifies and anchors", async () => {
    const a = await admin.call("POST", `${S()}/anchors`);
    expect(a.json.kind).toBe("local-signed");
    const v = await admin.call("GET", `${S()}/verify?subject=${runId}`);
    expect(v.json.ok).toBe(true);
    expect(v.json.entries).toBeGreaterThan(30);
    expect(v.json.subject.entries.length).toBeGreaterThan(5);
  });

  it("live returns counts for the signed-in user", async () => {
    const l = await qe.call("GET", `${S()}/live`);
    expect(l.status).toBe(200);
    expect(Array.isArray(l.json.assets)).toBe(true);
  });
});

describe("lot passports", () => {
  it("every run has a passport; the public page needs no sign-in and shows the signed gate and the ledger proof", async () => {
    await tick();
    const p = (await admin.call("GET", `${S()}/runs/${runId}/passport`)).json;
    expect(p).toMatchObject({ runId, status: "completed", nft: null, shipment: null });
    expect(p.pageUrl).toBe(`/#/passport/${runId}`);
    const res = await app.request(`/v1/public/passports/${runId}`, { headers: { host: "localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const pub = (await res.json()) as any;
    expect(pub.name).toBe("Lot SO-7781");
    expect(pub.properties).toMatchObject({ runId, status: "completed", quantity: 10 });
    expect(pub.passport.stages.map((s: any) => s.state)).toEqual(expect.arrayContaining(["completed"]));
    expect(pub.passport.signed.some((d: any) => d.stageCode === "03" && d.by === qe.address)).toBe(true);
    expect(pub.passport.proof).toMatchObject({ chainIntact: true });
    expect(JSON.stringify(pub)).not.toMatch(/Meera|Sven/); // people appear by address, never by name
    expect((await app.request("/v1/public/passports/run_unknown", { headers: { host: "localhost" } })).status).toBe(404);
  });

  it("the public passport proves each passed criterion in zero knowledge and never shows the measurements", async () => {
    await sys.passports.specs!.reconcile(50);
    const pub = (await (await app.request(`/v1/public/passports/${runId}`, { headers: { host: "localhost" } })).json()) as any;
    const criteria = pub.passport.stages.flatMap((s: any) => s.criteria.map((c: any) => ({ ...c, stage: s.code })));
    const passed = criteria.filter((c: any) => c.ok === true && c.zk);
    expect(passed.length).toBeGreaterThan(0);
    for (const c of passed) {
      expect(c).not.toHaveProperty("actual");
      expect(c.zk).toMatchObject({ status: "proven", system: "groth16-bn254", verified: true });
      expect(c.zk.publicSignals).toHaveLength(4);
    }
    for (const s of pub.passport.stages) expect(s).not.toHaveProperty("unitsGood");
    expect(pub.passport).not.toHaveProperty("rolledYield");
    // the measured values are not anywhere on the page
    const internal = (await admin.call("GET", `${S()}/runs/${runId}`)).json.run;
    const actuals = internal.stages.flatMap((s: any) => s.criteriaResults.map((c: any) => c.actual)).filter(Boolean);
    expect(actuals.length).toBeGreaterThan(0);
    for (const a of actuals) expect(JSON.stringify(pub)).not.toContain(a);

    // the proof checks out independently, with the published key, and is bound to its commitment in the ledger
    const snarkjs = await import("snarkjs");
    const vk = (await (await app.request("/v1/public/zk/spec-check", { headers: { host: "localhost" } })).json()) as any;
    const z = passed[0].zk;
    expect(await snarkjs.groth16.verify(vk.verificationKey, z.publicSignals, z.proof)).toBe(true);
    const entry = (await sys.rec.ledger.range(z.ledgerSeq, z.ledgerSeq))[0]!;
    expect(entry).toMatchObject({ type: "passport.spec_committed", payload: { commitment: z.publicSignals[3], target: z.publicSignals[1] } });
    // a proof replayed against another target does not verify
    expect(await snarkjs.groth16.verify(vk.verificationKey, [z.publicSignals[0], "0", z.publicSignals[2], z.publicSignals[3]], z.proof)).toBe(false);
  });

  it("a manager ships a completed lot with a signature", async () => {
    expect((await operator.call("POST", `${S()}/runs/${runId}/ship/sign-request`, { to: "0.0.4242" })).status).toBe(403);
    expect((await admin.call("POST", `${S()}/runs/${runId}/ship/sign-request`, { to: "not-an-account" })).status).toBe(400);
    const typed = (await admin.call("POST", `${S()}/runs/${runId}/ship/sign-request`, { to: "0.0.4242" })).json;
    expect(typed.message).toMatchObject({ action: "lot.ship", entity: `${runId}#0.0.4242` });
    const r = await admin.call("POST", `${S()}/runs/${runId}/ship`, { to: "0.0.4242", nonce: typed.message.nonce, signature: await admin.sign(typed) });
    expect(r.json).toMatchObject({ status: "shipped", shipment: { to: "0.0.4242", txUrl: null } });
    expect((await admin.call("POST", `${S()}/runs/${runId}/ship/sign-request`, { to: "0.0.4242" })).status).toBe(409);
    const pub = (await (await app.request(`/v1/public/passports/${runId}`, { headers: { host: "localhost" } })).json()) as any;
    expect(pub.properties.status).toBe("shipped");
  });

  it("with an HTS collection the passport NFT follows the lot: minted, updated on hold and completion, airdropped on ship", async () => {
    const { Passports } = await import("../../src/core/passports.js");
    const calls: string[] = [];
    let serial = 0;
    const rail = {
      kind: "hedera-hts" as const,
      tokenId: "0.0.9001",
      mint: async (m: string) => (calls.push(`mint ${m}`), { serial: ++serial, txId: `0.0.2@1.${serial}` }),
      update: async (s: number, m: string) => (calls.push(`update #${s} ${m}`), { txId: "0.0.2@2.0" }),
      ship: async (s: number, to: string) => (calls.push(`ship #${s} ${to}`), { txId: "0.0.2@3.0", pending: true }),
      nftUrl: (s: number) => `https://hashscan.io/testnet/token/0.0.9001/${s}`,
      txUrl: (id: string) => `https://hashscan.io/testnet/transaction/${id}`,
    };
    // a fresh run on its own system view of passports, so the in-app passports above are untouched
    await sys.db.query("DELETE FROM passports");
    const passports = new Passports(sys.db, sys.rec, sys.sigs, sys.engine, sys.trust, sys.proof, rail, "https://ordo.example", 296, () => Date.now());
    const tpl = (await admin.call("GET", `${S()}/templates`)).json.find((t: any) => t.key === "discrete-assembly") ?? (await admin.call("GET", `${S()}/templates`)).json[0];
    const run2 = (await admin.call("POST", `${S()}/runs`, { templateVersionId: tpl.versionId, orderRef: "SO-9000", quantity: 5 })).json.id as string;
    await passports.reconcile(50);
    expect(calls.filter((c) => c.startsWith("mint")).length).toBeGreaterThanOrEqual(1);
    expect(calls).toContain(`mint https://ordo.example/v1/public/passports/${run2}`);
    const minted = await passports.get(site, run2);
    expect(minted.nft).toMatchObject({ tokenId: "0.0.9001", onchainStatus: "in_production" });
    // a held stage moves the NFT's metadata on
    await sys.db.query("UPDATE stage_runs SET state = 'held' WHERE run_id = $1 AND code = (SELECT MIN(code) FROM stage_runs WHERE run_id = $1)", [run2]);
    await passports.reconcile(50);
    expect(calls).toContain(`update #${minted.nft!.serial} https://ordo.example/v1/public/passports/${run2}?s=held`);
    expect((await passports.get(site, run2)).nft!.onchainStatus).toBe("held");
    // shipping: only completed lots; the NFT is updated then airdropped to the customer
    await sys.db.query("UPDATE stage_runs SET state = 'completed' WHERE run_id = $1", [run2]);
    await sys.db.query("UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1", [run2]);
    await passports.reconcile(50);
    const u = (await sys.db.query<{ id: string }>("SELECT id FROM users WHERE address = $1", [admin.address])).rows[0]!;
    const me = { id: u.id, address: admin.address, displayName: null, handle: null };
    await expect(passports.shipRequest(site, me, ["contributor", "validator"], run2, "0.0.4242")).rejects.toThrow(/manager/);
    const typed = await passports.shipRequest(site, me, ["manager"], run2, "0.0.4242");
    const shipped = await passports.ship(site, me, ["manager"], run2, { to: "0.0.4242", nonce: typed.message.nonce, signature: await admin.sign(typed) });
    expect(calls.slice(-2)).toEqual([`update #${minted.nft!.serial} https://ordo.example/v1/public/passports/${run2}?s=shipped`, `ship #${minted.nft!.serial} 0.0.4242`]);
    expect(shipped.shipment).toMatchObject({ to: "0.0.4242", pending: true, txUrl: "https://hashscan.io/testnet/transaction/0.0.2@3.0" });
    expect(metadataFits(`https://aiwarriors.vercel.app/v1/public/passports/${run2}?s=in_production`)).toBe(true);
  });
});

const metadataFits = (m: string) => Buffer.byteLength(m) <= 100;
