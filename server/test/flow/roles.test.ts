import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensRoles } from "../../src/core/names.js";
import { boot, demote, enlist, join, promote, uid, wallet, type Client, type System } from "./helpers.js";

/**
 * The four roles: anyone joins an open org as a contributor, a manager promotes and demotes with a signature, and
 * what each member sees is their level (1 stages and status, 2 outcomes, 3 proofs and measurements, 4 everything)
 * within their scope of lines and stages, enforced by the API.
 */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];

beforeAll(async () => {
  ({ sys, app } = await boot());
}, 60_000);
afterAll(async () => sys.close());

const newOrg = async (manager: Client, name: string) => (await manager.call("POST", "/v1/sites", { name, timezone: "UTC", lineName: "Line A", zones: [] })).json.id as string;
const rolesIn = async (c: Client, site: string) => ((await c.call("GET", "/v1/me")).json.memberships.find((m: any) => m.siteId === site)?.roles ?? null) as string[] | null;
const sorted = (x: string[] | null) => (x ? [...x].sort() : x);

describe("open joining", () => {
  let manager: Client;
  let site = "";
  const S = () => `/v1/sites/${site}`;

  beforeAll(async () => {
    manager = await wallet(app);
    site = await newOrg(manager, "Open Works");
  });

  it("lists open orgs to anyone, and marks the ones a wallet belongs to", async () => {
    const anon = await app.request("/v1/orgs", { headers: { host: "localhost" } });
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as any[]).find((o) => o.id === site)).toMatchObject({ name: "Open Works", open: true, member: false, members: 1, lines: 1 });
    expect((await manager.call("GET", "/v1/orgs")).json.find((o: any) => o.id === site)).toMatchObject({ open: true, member: true });
    expect((await manager.call("GET", S())).json).toMatchObject({ openJoin: true, myRoles: ["manager"], myAccess: { level: 4, source: "manager" } });
  });

  it("any signed-in wallet joins an open org as a contributor, once", async () => {
    const w = await wallet(app);
    const r = await join(w, site);
    expect(r.joined).toBe(true);
    expect(r.me.memberships).toEqual([expect.objectContaining({ siteId: site, roles: ["contributor"] })]);
    expect((await join(w, site)).joined).toBe(false);
    expect(await rolesIn(w, site)).toEqual(["contributor"]);
    expect((await w.call("GET", S())).json).toMatchObject({ myRoles: ["contributor"], myAccess: { level: 2, source: "role" } });
    expect((await w.call("GET", "/v1/orgs")).json.find((o: any) => o.id === site)).toMatchObject({ member: true, members: 2 });
    const decisions = (await manager.call("GET", `${S()}/decisions?limit=50`)).json;
    expect(decisions.some((d: any) => d.kind === "team.joined")).toBe(true);
  });

  it("needs a signed-in wallet and an org that exists", async () => {
    const anon = await app.request(`/v1/orgs/${site}/join`, { method: "POST", headers: { host: "localhost" } });
    expect(anon.status).toBe(401);
    const w = await wallet(app);
    expect((await w.call("POST", "/v1/orgs/site_nope/join")).status).toBe(404);
    expect((await w.call("POST", "/v1/orgs/bad%20id/join")).status).toBe(404);
  });

  it("a manager closes the org: nobody joins on their own, the explore list hides it, a manager still adds people", async () => {
    const member = await wallet(app);
    await join(member, site);
    expect((await member.call("PATCH", S(), { openJoin: false })).status).toBe(403);
    const closed = await manager.call("PATCH", S(), { openJoin: false });
    expect(closed.status).toBe(200);
    expect(closed.json.openJoin).toBe(false);

    const outsider = await wallet(app);
    const refused = await outsider.call("POST", `/v1/orgs/${site}/join`);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/closed/);
    expect((await outsider.call("GET", "/v1/orgs")).json.some((o: any) => o.id === site)).toBe(false);
    // members still see it, marked closed; joining again changes nothing
    expect((await member.call("GET", "/v1/orgs")).json.find((o: any) => o.id === site)).toMatchObject({ open: false, member: true });
    expect((await member.call("POST", `/v1/orgs/${site}/join`)).json.joined).toBe(false);

    // invited by a manager: always as a contributor, whatever role the request names
    const added = await manager.call("POST", `${S()}/team/invites`, { address: outsider.address, role: "manager" });
    expect(added.json.added).toBe(true);
    expect(await rolesIn(outsider, site)).toEqual(["contributor"]);
    // a wallet that never signed in is invited, and becomes a contributor on its first sign-in
    const later = await manager.call("POST", `${S()}/team/invites`, { address: "0x00000000000000000000000000000000000000c1" });
    expect(later.json.added).toBe(false);
    expect((await manager.call("GET", `${S()}/team`)).json.invites).toEqual([expect.objectContaining({ address: "0x00000000000000000000000000000000000000c1", role: "contributor" })]);

    await manager.call("PATCH", S(), { openJoin: true });
    expect((await outsider.call("GET", "/v1/orgs")).json.find((o: any) => o.id === site)).toMatchObject({ open: true });
  });
});

describe("promotions and demotions, signed by a manager", () => {
  let manager: Client;
  let second: Client;
  let alice: Client;
  let bob: Client;
  let site = "";
  const S = () => `/v1/sites/${site}`;

  beforeAll(async () => {
    [manager, second, alice, bob] = await Promise.all([wallet(app), wallet(app), wallet(app), wallet(app)]);
    site = await newOrg(manager, "Signed Roles");
    for (const c of [second, alice, bob]) await join(c, site);
  });

  it("a manager signs role.grant for <address>#<ROLE>, and the promotion is on the ledger", async () => {
    const t = await manager.call("POST", `${S()}/team/members/${await uid(alice)}/roles/sign-request`, { role: "validator", grant: true, comment: "Six years in QA" });
    expect(t.status).toBe(200);
    expect(t.json.primaryType).toBe("OrdoSignature");
    expect(t.json.message).toMatchObject({ action: "role.grant", entity: `${alice.address}#VALIDATOR`, site });
    const r = await manager.call("POST", `${S()}/team/members/${await uid(alice)}/roles`, { role: "validator", grant: true, comment: "Six years in QA", nonce: t.json.message.nonce, signature: await manager.sign(t.json) });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ chain: null }); // no trust contract on this deployment
    expect(sorted(await rolesIn(alice, site))).toEqual(["contributor", "validator"]);
    expect((await alice.call("GET", S())).json.myAccess).toMatchObject({ level: 3, source: "role" });
    const d = (await manager.call("GET", `${S()}/decisions?limit=50`)).json.find((x: any) => x.kind === "team.role_granted");
    expect(d).toMatchObject({ agent: `user:${manager.address}`, reason: "Six years in QA", data: { address: alice.address, role: "validator", signature: expect.stringMatching(/^0x/) } });
    // the other roles name their OrdoTrust credential
    for (const [role, cred] of [["tester", "TESTER"], ["manager", "MANAGER"]] as const) {
      const typed = (await manager.call("POST", `${S()}/team/members/${await uid(alice)}/roles/sign-request`, { role, grant: true })).json;
      expect(typed.message.entity).toBe(`${alice.address}#${cred}`);
    }
    expect((await promote(manager, S(), alice, "validator")).status).toBe(409); // already one
    expect((await promote(manager, S(), second, "manager")).status).toBe(200);
    expect(sorted(await rolesIn(second, site))).toEqual(["contributor", "manager"]);
  });

  it("refuses a signature from another wallet, a nonce of another manager, and a signature for another role or person", async () => {
    const bobId = await uid(bob);
    const ask = (by: Client, role: string) => by.call("POST", `${S()}/team/members/${bobId}/roles/sign-request`, { role, grant: true, comment: "" });
    const submit = (by: Client, typed: any, role: string, signature: string, userId = bobId, grant = true) =>
      by.call("POST", `${S()}/team/members/${userId}/roles`, { role, grant, comment: "", nonce: typed.message.nonce, signature });

    const t = (await ask(manager, "tester")).json;
    // signed by the other manager's wallet, submitted as the first: not the requester's signature
    expect((await submit(manager, t, "tester", await second.sign(t))).status).toBe(401);
    // the other manager cannot use a nonce issued to the first
    expect((await submit(second, t, "tester", await second.sign(t))).status).toBe(401);
    // the statement names bob#TESTER: it does not make him a validator, nor make alice a tester, nor take a role away
    expect((await submit(manager, t, "validator", await manager.sign(t))).status).toBe(400);
    expect((await submit(manager, t, "tester", await manager.sign(t), await uid(alice))).status).toBe(400);
    expect((await submit(manager, t, "tester", await manager.sign(t), bobId, false)).status).toBe(400);
    expect(await rolesIn(bob, site)).toEqual(["contributor"]);
    // the refusals rolled back, so the request is still good for exactly what it says, once
    const sig = await manager.sign(t);
    expect((await submit(manager, t, "tester", sig)).status).toBe(200);
    expect(sorted(await rolesIn(bob, site))).toEqual(["contributor", "tester"]);
    expect((await submit(manager, t, "tester", sig)).status).toBe(401);
    expect((await bob.call("GET", S())).json.myAccess).toMatchObject({ level: 3, source: "role" });
  });

  it("only a manager promotes, and only members; a role is granted once and revoked only when held", async () => {
    const outsider = await wallet(app);
    expect((await promote(manager, S(), outsider, "validator")).status).toBe(404); // join or invite first
    expect((await promote(alice, S(), bob, "validator")).status).toBe(403); // a validator is not a manager
    expect((await promote(bob, S(), bob, "manager")).status).toBe(403);
    expect((await demote(manager, S(), bob, "validator")).status).toBe(409); // not one
    expect((await demote(manager, S(), bob, "contributor")).status).toBe(400); // taking someone out is a removal
    expect((await manager.call("POST", `${S()}/team/members/${await uid(bob)}/roles/sign-request`, { role: "admin", grant: true })).status).toBe(400); // old role names are not roles
  });

  it("demoting takes the role and its access away; someone who loses their last role is a contributor again", async () => {
    const r = await demote(manager, S(), bob, "tester", "Moved teams");
    expect(r.status).toBe(200);
    expect(await rolesIn(bob, site)).toEqual(["contributor"]);
    expect((await bob.call("GET", S())).json.myAccess.level).toBe(2);
    const d = (await manager.call("GET", `${S()}/decisions?limit=50`)).json.find((x: any) => x.kind === "team.role_revoked");
    expect(d).toMatchObject({ reason: "Moved teams", data: { role: "tester", address: bob.address } });

    // the creator holds only the manager role: the second manager removing it leaves them a contributor
    expect(await rolesIn(manager, site)).toEqual(["manager"]);
    expect((await demote(second, S(), manager, "manager")).status).toBe(200);
    expect(await rolesIn(manager, site)).toEqual(["contributor"]);
    expect((await manager.call("GET", `${S()}/access`)).status).toBe(403);
    expect((await manager.call("GET", S())).json.myAccess).toMatchObject({ level: 2, source: "role" });
    // and now the second manager is the last one
    const own = await demote(second, S(), second, "manager");
    expect(own.status).toBe(409);
    expect(own.json.error).toMatch(/another manager/);
  });

  it("protects the last manager: nobody removes their own manager role, and the last one cannot leave", async () => {
    const lone = await wallet(app);
    const solo = await newOrg(lone, "One Manager");
    const SS = `/v1/sites/${solo}`;
    expect((await demote(lone, SS, lone, "manager")).status).toBe(409);
    const leave = await lone.call("DELETE", `${SS}/team/members/${await uid(lone)}`);
    expect(leave.status).toBe(409);
    expect(leave.json.error).toMatch(/at least one manager/);
    expect(await rolesIn(lone, solo)).toEqual(["manager"]);
  });

  it("leaving and removing: anyone leaves, a manager removes a contributor, a promoted person is demoted first", async () => {
    // a contributor cannot remove someone else
    expect((await bob.call("DELETE", `${S()}/team/members/${await uid(alice)}`)).status).toBe(403);
    // a validator is demoted (a signed change OrdoTrust sees) before a manager removes them
    const blocked = await second.call("DELETE", `${S()}/team/members/${await uid(alice)}`);
    expect(blocked.status).toBe(409);
    expect((await demote(second, S(), alice, "validator")).status).toBe(200);
    expect((await second.call("DELETE", `${S()}/team/members/${await uid(alice)}`)).status).toBe(200);
    expect(await rolesIn(alice, site)).toBeNull();
    expect((await alice.call("GET", S())).status).toBe(403);
    // bob leaves on his own
    expect((await bob.call("DELETE", `${S()}/team/members/${await uid(bob)}`)).status).toBe(200);
    expect(await rolesIn(bob, site)).toBeNull();
    const kinds = (await second.call("GET", `${S()}/decisions?limit=100`)).json.map((d: any) => d.kind);
    expect(kinds.filter((k: string) => k === "team.removed")).toHaveLength(2);
    // someone who left can join again, as a contributor
    expect((await join(bob, site)).joined).toBe(true);
    expect(await rolesIn(bob, site)).toEqual(["contributor"]);
  });
});

describe("what a contributor cannot do", () => {
  it("is refused every manager route", async () => {
    const manager = await wallet(app);
    const c = await wallet(app);
    const site = await newOrg(manager, "Manager Only");
    const S = `/v1/sites/${site}`;
    await join(c, site);
    const tpl = (await manager.call("GET", `${S}/templates`)).json[0];
    const runId = (await manager.call("POST", `${S}/runs`, { templateVersionId: tpl.versionId, orderRef: "SO-1", quantity: 2 })).json.id;
    const asset = (await manager.call("POST", `${S}/assets`, { name: "CNC-1", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: {}, idealCycleS: 30 })).json.id;
    const lineId = (await manager.call("GET", S)).json.lines[0].id;
    const managerId = await uid(manager);
    const calls: [string, string, unknown?][] = [
      ["PATCH", S, { name: "Mine now" }],
      ["POST", `${S}/zones`, { name: "Z" }],
      ["POST", `${S}/team/invites`, { address: "0x00000000000000000000000000000000000000d1" }],
      ["POST", `${S}/team/members/${managerId}/roles/sign-request`, { role: "contributor", grant: true }],
      ["DELETE", `${S}/team/members/${managerId}`],
      ["GET", `${S}/access`],
      ["PUT", `${S}/access/roles/contributor`, { level: 4, scope: { lines: null, stages: null } }],
      ["PUT", `${S}/access/members/${await uid(c)}`, { level: 4, scope: { lines: null, stages: null } }],
      ["POST", `${S}/assets`, { name: "X", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: {}, idealCycleS: 30 }],
      ["PUT", `${S}/assets/${asset}`, { name: "X", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: {}, idealCycleS: 30 }],
      ["POST", `${S}/assets/${asset}/readings`, { signal: "part_count", value: 1 }],
      ["PUT", `${S}/assets/${asset}/wallet`, { dailyBudget: "100", perCall: "10" }],
      ["POST", `${S}/templates`, { name: "T", category: "Discrete", spec: { stages: [], rework: null } }],
      ["POST", `${S}/runs`, { templateVersionId: tpl.versionId, orderRef: "SO-2", quantity: 1 }],
      ["POST", `${S}/runs/${runId}/step`],
      ["POST", `${S}/runs/${runId}/abort`, { reason: "Not mine" }],
      ["POST", `${S}/runs/${runId}/stages/01/record`, { good: 1, scrap: 0 }],
      ["POST", `${S}/runs/${runId}/stages/01/hold`, { reason: "Looks wrong" }],
      ["POST", `${S}/runs/${runId}/ship/sign-request`, { to: "0.0.4242" }],
      ["POST", `${S}/lines/${lineId}/autonomy/sign-request`, { level: "L3" }],
      ["POST", `${S}/validation`, { type: "process_change", title: "Mine" }],
      ["POST", `${S}/vendors/sign-request`, { address: "0x00000000000000000000000000000000000000aa", company: "Spindle Care" }],
      ["POST", `${S}/chain/register/sign-request`],
      ["POST", `${S}/work-orders/caps/sign-request`, { perOrder: "1", perDay: "2" }],
      ["POST", `${S}/work-orders/pause/sign-request`, { stop: true }],
      ["POST", `${S}/finance/parties`, { kind: "customer", name: "Tata Motors" }],
      ["POST", `${S}/anchors`],
      ["GET", `${S}/agents`],
      ["GET", `${S}/ledger`],
      ["GET", `${S}/finance`],
      ["GET", `${S}/work-orders`],
      ["GET", `${S}/vendors`],
      ["GET", `${S}/assets/${asset}/wallet`],
    ];
    for (const [method, path, body] of calls) {
      const r = await c.call(method, path, body);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBe(403);
    }
    // the manager is untouched by all of it
    expect(await rolesIn(manager, site)).toEqual(["manager"]);
  });
});

describe("vendors are added by a manager", () => {
  it("signs role.grant for <address>#VENDOR; the vendor is listed for work orders", async () => {
    const manager = await wallet(app);
    const site = await newOrg(manager, "Vendor Plant");
    const S = `/v1/sites/${site}`;
    const v = { address: "0x00000000000000000000000000000000000000aB", company: "Spindle Care", categories: "cnc", hourlyRate: "2", responseMinutes: 90 };
    const typed = (await manager.call("POST", `${S}/vendors/sign-request`, v)).json;
    expect(typed.message).toMatchObject({ action: "role.grant", entity: "0x00000000000000000000000000000000000000ab#VENDOR" });
    const r = await manager.call("POST", `${S}/vendors`, { ...v, nonce: typed.message.nonce, signature: await manager.sign(typed) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: expect.stringMatching(/^vnd_/), chain: null });
    expect((await manager.call("GET", `${S}/vendors`)).json).toEqual([expect.objectContaining({ address: "0x00000000000000000000000000000000000000ab", company: "Spindle Care", categories: "cnc", hourlyRate: "2", responseMinutes: 90, status: "approved" })]);
    expect((await manager.call("POST", `${S}/vendors/sign-request`, v)).status).toBe(409); // already a vendor
    expect((await manager.call("POST", `${S}/vendors/sign-request`, { ...v, address: "not-a-wallet" })).status).toBe(400);
  });
});

describe("stakers", () => {
  it("lists the org's validators, testers and managers, and tells each person whether they may sign", async () => {
    const manager = await wallet(app);
    const v = await wallet(app);
    const t = await wallet(app);
    const c = await wallet(app);
    const site = await newOrg(manager, "Stake Plant");
    const S = `/v1/sites/${site}`;
    await enlist(manager, S, v, "validator");
    await enlist(manager, S, t, "tester");
    await enlist(manager, S, c);
    const all = (await c.call("GET", `${S}/stakers`)).json;
    expect(all.chain).toEqual({ configured: false });
    expect(all.stakers.map((s: any) => [s.address, s.roles.sort()]).sort()).toEqual(
      [
        [manager.address, ["manager"]],
        [v.address, ["validator"]],
        [t.address, ["tester"]],
      ].sort(),
    );
    expect(all.stakers.every((s: any) => s.onchain === null)).toBe(true);
    expect(all.me).toEqual({ validator: { ok: false, reason: expect.stringMatching(/validator or a manager/) }, tester: { ok: false, reason: expect.stringMatching(/tester/) } });
    expect((await v.call("GET", `${S}/stakers`)).json.me).toMatchObject({ validator: { ok: true }, tester: { ok: false } });
    expect((await t.call("GET", `${S}/stakers`)).json.me).toMatchObject({ validator: { ok: false }, tester: { ok: true } });
    expect((await manager.call("GET", `${S}/stakers`)).json.me).toMatchObject({ validator: { ok: true }, tester: { ok: false } });
    // the removed routes are gone
    for (const path of [`${S}/validators`, `${S}/slash`, `${S}/onboarding`]) expect((await manager.call("GET", path)).status).toBe(404);
    expect((await c.call("POST", "/v1/onboarding", { siteId: site, kind: "validator" })).status).toBe(404);
    expect((await c.call("POST", `${S}/stakers/me/payout-schedule`)).json).toEqual({ payout: null });
  });
});

describe("visibility: level and scope", () => {
  let manager: Client;
  /** contributors at level 1 to 4 (per-person overrides), and one at the role's default */
  const at: Record<1 | 2 | 3 | 4, Client> = {} as never;
  let plain: Client;
  let site = "";
  let lineA = "";
  let lineB = "";
  let runA = "";
  let runB = "";
  let cnc = "";
  const S = () => `/v1/sites/${site}`;
  const setAccess = (userId: string, level: number, scope: { lines?: string[] | null; stages?: string[] | null } = {}) =>
    manager.call("PUT", `${S()}/access/members/${userId}`, { level, scope: { lines: scope.lines ?? null, stages: scope.stages ?? null } });
  const stage = (run: any, code: string) => run.stages.find((s: any) => s.code === code);

  beforeAll(async () => {
    manager = await wallet(app);
    site = await newOrg(manager, "Glass Plant");
    lineA = (await manager.call("GET", S())).json.lines[0].id;
    lineB = await sys.plant.addLine(site, "Line B");
    for (const l of [1, 2, 3, 4] as const) {
      at[l] = await wallet(app);
      await join(at[l], site);
      if (l !== 2) expect((await setAccess(await uid(at[l]), l)).status).toBe(200);
    }
    plain = at[2];
    cnc = (await manager.call("POST", `${S()}/assets`, { name: "CNC-01", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: {}, idealCycleS: 30 })).json.id;
    await manager.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "execution", text: "ACTIVE" });
    await manager.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "part_count", value: 100 });
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Release order", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "manager", timeoutMin: 10, criteria: [] },
        { code: "02", column: 2, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "manager", timeoutMin: 60, criteria: [{ label: "Yield", op: ">=", target: 95, unit: "%" }] },
        { code: "03", column: 3, name: "Final inspection", agent: "vision_qa", resourceKind: "manual_station", mode: "manual", escalationRole: "validator", timeoutMin: 60, criteria: [{ label: "Yield", op: ">=", target: 99, unit: "%" }] },
      ],
      rework: null,
    };
    const versionId = (await manager.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "", spec })).json.versionId;
    runA = (await manager.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-A", quantity: 10, lineId: lineA })).json.id;
    await manager.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "part_count", value: 110 });
    await sys.advance(true);
    runB = (await manager.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-B", quantity: 5, lineId: lineB })).json.id;
    const full = (await manager.call("GET", `${S()}/runs/${runA}`)).json.run;
    expect(stage(full, "02")).toMatchObject({ state: "completed", unitsGood: 10 });
    expect(stage(full, "02").criteriaResults[0]).toMatchObject({ ok: true, actual: expect.any(String) });
    expect(full.lineId).toBe(lineA);
  }, 60_000);

  it("the manager sees everything, always: no override or role default lowers a manager", async () => {
    const managerId = await uid(manager);
    expect((await setAccess(managerId, 1)).status).toBe(200); // stored, but a manager's own access does not read it
    expect((await manager.call("GET", S())).json.myAccess).toEqual({ level: 4, scope: { lines: null, stages: null }, source: "manager" });
    const bad = await manager.call("PUT", `${S()}/access/roles/manager`, { level: 1, scope: { lines: null, stages: null } });
    expect(bad.status).toBe(400);
    expect((await manager.call("GET", `${S()}/ledger`)).status).toBe(200);
    expect(stage((await manager.call("GET", `${S()}/runs/${runA}`)).json.run, "02").criteriaResults[0].actual).toEqual(expect.any(String));
    expect((await manager.call("PUT", `${S()}/access/members/${managerId}`, null)).status).toBe(200);
    const cfg = (await manager.call("GET", `${S()}/access`)).json;
    expect(cfg.roles).toEqual([
      { role: "manager", level: 4, scope: { lines: null, stages: null }, fixed: true },
      { role: "validator", level: 3, scope: { lines: null, stages: null }, fixed: false },
      { role: "tester", level: 3, scope: { lines: null, stages: null }, fixed: false },
      { role: "contributor", level: 2, scope: { lines: null, stages: null }, fixed: false },
    ]);
    expect(cfg.members.map((m: any) => m.level).sort()).toEqual([1, 3, 4]);
  });

  it("level 1: stages and their state only", async () => {
    const c = at[1];
    expect((await c.call("GET", S())).json.myAccess).toMatchObject({ level: 1, source: "member" });
    const live = (await c.call("GET", `${S()}/live`)).json;
    expect(live).toMatchObject({ access: { level: 1 }, assets: [], inbox: [], decisions: [] });
    const run = live.runs.find((r: any) => r.id === runA);
    expect(stage(run, "02")).toMatchObject({ state: "completed", unitsGood: 0, unitsScrap: 0, yieldPct: null, outcome: null, decisions: 0 });
    expect(stage(run, "02").criteriaResults[0]).toMatchObject({ label: "Yield", target: "≥ 95 %", ok: null, actual: null });
    expect(run.metrics).toMatchObject({ rolledYield: null, throughputPerHour: null, decisions: 0 });
    const one = (await c.call("GET", `${S()}/runs/${runA}`)).json;
    expect(one).toMatchObject({ decisions: [], inbox: [] });
    expect(stage(one.run, "02")).toMatchObject({ state: "completed", unitsGood: 0 });
    for (const path of [`/runs/${runA}/stages/02/series`, `/runs/${runA}/proofs`, `/runs/${runA}/passport`, "/assets", `/assets/${cnc}`, "/inbox", "/decisions", "/incidents", "/ledger", "/agents", "/names", "/verify"])
      expect((await c.call("GET", `${S()}${path}`)).status, path).toBe(403);
    expect((await c.call("GET", `${S()}/templates`)).status).toBe(200);
    expect((await c.call("GET", `${S()}/team`)).status).toBe(200);
  });

  it("level 2: plus outcomes (counts, pass or fail), never the measured values", async () => {
    const c = plain;
    expect((await c.call("GET", S())).json.myAccess).toMatchObject({ level: 2, source: "role" });
    const live = (await c.call("GET", `${S()}/live`)).json;
    expect(live.assets.map((a: any) => a.id)).toEqual([cnc]);
    const run = live.runs.find((r: any) => r.id === runA);
    expect(stage(run, "02")).toMatchObject({ state: "completed", unitsGood: 10 });
    expect(stage(run, "02").criteriaResults[0]).toMatchObject({ ok: true, actual: null });
    const one = (await c.call("GET", `${S()}/runs/${runA}`)).json;
    expect(one.decisions.length).toBeGreaterThan(0);
    expect(stage(one.run, "02").criteriaResults[0]).toMatchObject({ ok: true, actual: null });
    expect((await c.call("GET", `${S()}/assets`)).status).toBe(200);
    expect((await c.call("GET", `${S()}/decisions`)).status).toBe(200);
    for (const path of [`/runs/${runA}/stages/02/series`, `/runs/${runA}/proofs`, `/assets/${cnc}`, "/ledger", "/agents", "/validation"]) expect((await c.call("GET", `${S()}${path}`)).status, path).toBe(403);
  });

  it("level 3: plus proofs and measurements; still no agents, ledger or finance", async () => {
    const c = at[3];
    const one = (await c.call("GET", `${S()}/runs/${runA}`)).json;
    expect(stage(one.run, "02").criteriaResults[0]).toMatchObject({ ok: true, actual: expect.any(String) });
    const series = await c.call("GET", `${S()}/runs/${runA}/stages/02/series`);
    expect(series.status).toBe(200);
    expect(series.json).toHaveProperty("signals");
    const proofs = await c.call("GET", `${S()}/runs/${runA}/proofs`);
    expect(proofs.status).toBe(200);
    expect(proofs.json).toMatchObject({ runId: runA, stages: expect.any(Array) });
    expect((await c.call("GET", `${S()}/assets/${cnc}`)).status).toBe(200);
    expect((await c.call("GET", `${S()}/runs/${runA}/passport`)).status).toBe(200);
    expect((await c.call("GET", `${S()}/validation`)).status).toBe(200);
    for (const path of ["/ledger", "/agents", "/agents/market", "/finance", "/work-orders", "/vendors", `/assets/${cnc}/wallet`]) expect((await c.call("GET", `${S()}${path}`)).status, path).toBe(403);
  });

  it("level 4: everything, as the manager sees it", async () => {
    const c = at[4];
    expect((await c.call("GET", `${S()}/ledger`)).status).toBe(200);
    const agents = await c.call("GET", `${S()}/agents`);
    expect(agents.status).toBe(200);
    expect(agents.json).toHaveLength(8);
    const mine = (await c.call("GET", `${S()}/runs/${runA}`)).json.run;
    const managers = (await manager.call("GET", `${S()}/runs/${runA}`)).json.run;
    expect(mine.stages).toEqual(managers.stages);
    expect({ ...mine.metrics, eta: null }).toEqual({ ...managers.metrics, eta: null });
    // seeing everything is not being a manager
    expect((await c.call("GET", `${S()}/access`)).status).toBe(403);
    expect((await c.call("POST", `${S()}/anchors`)).status).toBe(403);
  });

  it("a line out of scope: its runs are not listed, and opening one is a 404", async () => {
    const c = at[3];
    expect((await setAccess(await uid(c), 3, { lines: [lineA] })).status).toBe(200);
    expect((await c.call("GET", S())).json.lines.map((l: any) => l.id)).toEqual([lineA]);
    expect((await manager.call("GET", S())).json.lines.map((l: any) => l.id).sort()).toEqual([lineA, lineB].sort());
    expect((await c.call("GET", `${S()}/runs/${runB}`)).status).toBe(404);
    expect((await c.call("GET", `${S()}/runs/${runB}/proofs`)).status).toBe(404);
    expect((await c.call("GET", `${S()}/runs/${runB}/stages/01/series`)).status).toBe(404);
    expect((await c.call("GET", `${S()}/runs/${runA}`)).status).toBe(200);
    const listed = (await c.call("GET", `${S()}/runs`)).json.map((r: any) => r.id);
    expect(listed).toContain(runA);
    expect(listed).not.toContain(runB);
    expect((await c.call("GET", `${S()}/live`)).json.runs.map((r: any) => r.id)).not.toContain(runB);
    expect((await manager.call("GET", `${S()}/runs`)).json.map((r: any) => r.id)).toEqual(expect.arrayContaining([runA, runB]));
    // a scope can only name the org's own lines
    expect((await setAccess(await uid(c), 3, { lines: ["line_elsewhere"] })).status).toBe(400);
  });

  it("a stage out of scope keeps its state only, and its measurements are a 404", async () => {
    const c = at[3];
    expect((await setAccess(await uid(c), 3, { stages: ["01"] })).status).toBe(200);
    const run = (await c.call("GET", `${S()}/runs/${runA}`)).json.run;
    expect(stage(run, "02")).toMatchObject({ state: "completed", unitsGood: 0, yieldPct: null });
    expect(stage(run, "02").criteriaResults[0]).toMatchObject({ ok: null, actual: null });
    expect(stage(run, "01")).toMatchObject({ state: "completed" });
    expect((await c.call("GET", `${S()}/runs/${runA}/stages/02/series`)).status).toBe(404);
    expect((await c.call("GET", `${S()}/runs/${runA}/stages/01/series`)).status).toBe(200);
    expect((await c.call("GET", `${S()}/runs/${runB}`)).status).toBe(200); // every line again
    expect((await setAccess(await uid(c), 3, { stages: ["2"] })).status).toBe(400); // a stage code, like 02 or 03a
  });

  it("a person's override beats their roles' default; clearing it returns them to the default", async () => {
    const c = at[3];
    const id = await uid(c);
    expect((await setAccess(id, 3)).status).toBe(200);
    // the manager lowers contributors to level 1: the plain contributor drops, the one with an override does not
    const set = await manager.call("PUT", `${S()}/access/roles/contributor`, { level: 1, scope: { lines: null, stages: null } });
    expect(set.status).toBe(200);
    expect(set.json.roles.find((r: any) => r.role === "contributor")).toMatchObject({ level: 1 });
    expect((await plain.call("GET", S())).json.myAccess).toMatchObject({ level: 1, source: "role" });
    expect((await plain.call("GET", `${S()}/assets`)).status).toBe(403);
    expect((await c.call("GET", S())).json.myAccess).toMatchObject({ level: 3, source: "member" });
    expect((await c.call("GET", `${S()}/runs/${runA}/stages/02/series`)).status).toBe(200);
    // the override goes: back to the role's level
    expect((await manager.call("PUT", `${S()}/access/members/${id}`, null)).status).toBe(200);
    expect((await c.call("GET", S())).json.myAccess).toMatchObject({ level: 1, source: "role" });
    // a role default can carry a scope too
    expect((await manager.call("PUT", `${S()}/access/roles/contributor`, { level: 2, scope: { lines: [lineB], stages: null } })).status).toBe(200);
    expect((await plain.call("GET", `${S()}/runs/${runA}`)).status).toBe(404);
    expect((await plain.call("GET", `${S()}/runs/${runB}`)).status).toBe(200);
    // several roles: the highest level, and every line either role allows
    expect((await promote(manager, S(), plain, "validator")).status).toBe(200);
    expect((await plain.call("GET", S())).json.myAccess).toMatchObject({ level: 3, scope: { lines: null, stages: null }, source: "role" });
    expect((await plain.call("GET", `${S()}/runs/${runA}`)).status).toBe(200);
    await manager.call("PUT", `${S()}/access/roles/contributor`, { level: 2, scope: { lines: null, stages: null } });
  });

  it("validates what the manager sets", async () => {
    const id = await uid(at[1]);
    expect((await manager.call("PUT", `${S()}/access/members/${id}`, { level: 5, scope: { lines: null, stages: null } })).status).toBe(400);
    expect((await manager.call("PUT", `${S()}/access/members/${id}`, { level: 0, scope: { lines: null, stages: null } })).status).toBe(400);
    expect((await manager.call("PUT", `${S()}/access/roles/admin`, { level: 2, scope: { lines: null, stages: null } })).status).toBe(400);
    const stranger = await wallet(app);
    expect((await setAccess(await uid(stranger), 2)).status).toBe(404); // not a member
    const decisions = (await manager.call("GET", `${S()}/decisions?limit=100`)).json.map((d: any) => d.kind);
    expect(decisions).toEqual(expect.arrayContaining(["access.role_set", "access.member_set"]));
  });
});

describe("ENS role records", () => {
  it("are written with the role names OrdoEnsRoles already knows", () => {
    expect(ensRoles(["manager"])).toBe("admin,operator,plant_manager,supervisor,validator");
    expect(ensRoles(["contributor"])).toBe("operator");
    expect(ensRoles(["validator"])).toBe("validator");
    expect(ensRoles(["tester"])).toBe("");
    expect(ensRoles(["contributor", "validator"])).toBe("operator,validator");
    expect(ensRoles(["contributor", "manager", "validator"])).toBe("admin,operator,plant_manager,supervisor,validator");
  });
});
