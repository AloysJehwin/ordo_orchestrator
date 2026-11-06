import { keccak256, toBytes, type Abi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnsV2, ENSV2_ABI, ROLE_REGISTRAR } from "../../src/chain/ensv2.js";
import { ORDO_NAMES_ABI } from "../../src/chain/ordo-ens-abi.js";
import { ANVIL_KEYS, anvilPath, startAnvil } from "../fixtures/anvil.js";
import { deployEnsV2, deployOrdoEns, ensEnv } from "../fixtures/ensv2.js";
import { boot, demote, promote, wallet, type Client, type System } from "./helpers.js";

/**
 * ENSv2 names end to end on the real contracts (anvil): an org gets its own registry under the root, with its
 * collections; each person a name from the handle they chose, minted to their wallet; each role they hold a name in
 * that role's collection, which is what contracts read their roles from; and names follow promotions, demotions and
 * people leaving.
 */
const run = anvilPath() || process.env.CI ? describe : describe.skip;
const SLOT = { org: 1, managers: 2, validators: 3, testers: 4, contributors: 5, machines: 6 } as const;
const ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, DEVICE: 64 };
const MANAGER = ROLE.OPERATOR | ROLE.SUPERVISOR | ROLE.VALIDATOR | ROLE.PLANT_MANAGER | ROLE.ADMIN;

run("ENS names for an org", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let stack: Awaited<ReturnType<typeof deployEnsV2>>;
  let ordoNames: Address;
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let admin: Client;
  let lead: Client;
  let ens: EnsV2;
  let site = "";
  const gateway = privateKeyToAccount(generatePrivateKey());
  const ORG = "chennai-plant-1.ordo-test.eth";
  const S = () => `/v1/sites/${site}`;
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await sys.names.reconcile();
      const open = (await sys.db.query<{ n: string }>("SELECT count(*)::text AS n FROM ens_names WHERE status IN ('pending','sent')")).rows[0]!.n;
      if (open === "0") return;
    }
  };
  const read = <T>(functionName: string, args: unknown[]) => stack.pub.readContract({ address: ordoNames, abi: ORDO_NAMES_ABI as Abi, functionName, args }) as Promise<T>;
  const sitekey = () => keccak256(toBytes(site));
  const rolesOf = async (c: { address: string }) => Number(await read<number>("roles", [sitekey(), c.address as Address]));
  const registry = (slot: number) => read<Address>("registryOf", [sitekey(), slot]);

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployEnsV2(anvil.url);
    ({ names: ordoNames } = await deployOrdoEns(anvil.url, stack));
    ({ sys, app } = await boot(ensEnv(anvil.url, stack, { names: ordoNames })));
    ens = new EnsV2({ rpcUrl: anvil.url, ownerKey: ANVIL_KEYS[0]!, parentName: "ordo-test.eth", parentRegistry: stack.parentRegistry, resolver: stack.resolver, chainId: 31337, names: ordoNames });
    admin = await wallet(app, generatePrivateKey());
    lead = await wallet(app, generatePrivateKey());
    await admin.call("PATCH", "/v1/me", { displayName: "Asha Iyer", handle: "asha" });
    await lead.call("PATCH", "/v1/me", { displayName: "Lena Fischer" });
    site = (await admin.call("POST", "/v1/sites", { name: "Chennai Plant 1", timezone: "Asia/Kolkata", lineName: "L1", zones: [] })).json.id;
  }, 120_000);
  afterAll(async () => {
    await sys?.close();
    anvil?.stop();
  });

  it("checks handles: format, reserved words, and taken ones with a suggestion", async () => {
    expect((await lead.call("GET", "/v1/handles/asha")).json).toMatchObject({ available: false, suggestion: "asha-2" });
    expect((await lead.call("GET", "/v1/handles/validators")).json).toMatchObject({ available: false, reason: "That word is reserved" });
    expect((await lead.call("GET", "/v1/handles/Bad_Handle")).json.available).toBe(false);
    expect((await lead.call("GET", "/v1/me")).json.user).toMatchObject({ handle: null, handleSuggestion: "lena-fischer" });
    expect((await lead.call("PATCH", "/v1/me", { handle: "asha" })).status).toBe(409);
    expect((await lead.call("PATCH", "/v1/me", { handle: "lena" })).json.user.handle).toBe("lena");
  });

  it("names the org, its collections, people and their roles, machines and agents", async () => {
    await admin.call("POST", `${S()}/team/invites`, { address: lead.address });
    await admin.call("POST", `${S()}/assets`, { name: "CNC-07", kind: "cnc", owningAgent: "scheduler", source: { type: "gateway", device: gateway.address }, limits: {}, idealCycleS: 30 });
    await settle();

    const names = (await admin.call("GET", `${S()}/names`)).json;
    expect(names).toMatchObject({ live: true, root: "ordo-test.eth", org: ORG, failed: 0, pending: 0, gas: { paused: false } });
    const by = (n: string) => names.items.find((x: any) => x.name === n);
    expect(by(ORG)).toMatchObject({ kind: "org", status: "issued" });
    for (const c of ["managers", "validators", "testers", "contributors", "machines", "agents", "runs", "vendors"]) expect(by(`${c}.${ORG}`), c).toMatchObject({ kind: "collection", status: "issued" });
    expect(by(`asha.${ORG}`)).toMatchObject({ kind: "person", status: "issued", owner: admin.address });
    expect(by(`asha.managers.${ORG}`)).toMatchObject({ kind: "role", status: "issued", records: { "com.ordo.person": `asha.${ORG}` } });
    expect(by(`lena.${ORG}`)).toMatchObject({ kind: "person", status: "issued" });
    expect(by(`lena.contributors.${ORG}`)).toMatchObject({ kind: "role", status: "issued", collection: "contributors" });
    expect(by(`cnc-07.machines.${ORG}`)).toMatchObject({ kind: "machine", status: "issued", owner: gateway.address.toLowerCase() });
    expect(by(`maintenance.agents.${ORG}`)).toMatchObject({ kind: "agent", status: "issued" });
    expect(by(`l1.lines.${ORG}`)).toMatchObject({ kind: "line", status: "issued" });
    expect(names.items.every((x: any) => x.status === "issued")).toBe(true);
    // display names never reach the chain
    expect(JSON.stringify(names.items)).not.toMatch(/Asha|Iyer|Lena|Fischer/);

    // on-chain: each registry knows its names, and a person holds theirs
    expect((await ens.ownerOf(await registry(SLOT.contributors), "lena")).toLowerCase()).toBe(lead.address);
    expect((await ens.ownerOf(await registry(SLOT.org), "asha")).toLowerCase()).toBe(admin.address);
    expect((await ens.ownerOf(stack.parentRegistry, "chennai-plant-1")).toLowerCase()).toBe(stack.owner.toLowerCase());
    expect(await ens.text(`lena.${ORG}`, "com.ordo.type")).toBe("person");
    expect((await ens.addr(`lena.${ORG}`)).toLowerCase()).toBe(lead.address);
    expect(await ens.text(ORG, "url")).toBe("https://ordo.example");
    // roles come from the names held: a manager holds every manager bit, a contributor is an operator, the gateway a device
    expect(await rolesOf(admin)).toBe(MANAGER);
    expect(await rolesOf(lead)).toBe(ROLE.OPERATOR);
    expect(await rolesOf(gateway)).toBe(ROLE.DEVICE);
    expect(await read<string>("nameOf", [sitekey(), lead.address])).toBe(`lena.${ORG}`);
    expect(await read<string>("nameOf", [sitekey(), gateway.address])).toBe(`cnc-07.machines.${ORG}`);
    // a manager may register names in the org's registry themselves
    expect(await stack.pub.readContract({ address: await registry(SLOT.org), abi: ENSV2_ABI, functionName: "hasRootRoles", args: [ROLE_REGISTRAR, admin.address as Address] })).toBe(true);

    const team = (await admin.call("GET", `${S()}/team`)).json.members;
    const lm = team.find((m: any) => m.address === lead.address);
    expect(lm.ens).toBe(`lena.${ORG}`);
    expect(lm.roleNames).toEqual([{ role: "contributor", name: `lena.contributors.${ORG}`, status: "issued" }]);
    expect((await lead.call("GET", "/v1/me")).json.user.names.map((n: any) => n.name)).toEqual([`lena.${ORG}`, `lena.contributors.${ORG}`]);
    const dir = (await admin.call("GET", `${S()}/directory`)).json;
    expect(dir.entries.find((e: any) => e.kind === "machine")).toMatchObject({ name: `cnc-07.machines.${ORG}`, address: gateway.address.toLowerCase() });
    expect((await admin.call("GET", `${S()}/names/resolve?q=lena.${ORG}`)).json).toMatchObject({ kind: "person", address: lead.address, source: "ordo" });
    expect((await admin.call("GET", `${S()}/names/resolve?q=${lead.address}`)).json).toMatchObject({ name: `lena.${ORG}` });
    expect((await app.request(`/v1/names/lookup?name=lena.${ORG}`)).status).toBe(200);
    expect((await admin.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "ens names")).toMatchObject({ live: true });
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=200`)).json;
    expect(decisions.some((d: any) => d.kind === "ens.batch" && /in one transaction/.test(d.summary))).toBe(true);
  }, 180_000);

  it("issues a role name on promotion, revokes it on demotion, and revokes everything of someone who leaves", async () => {
    const leadId = (await admin.call("GET", `${S()}/team`)).json.members.find((m: any) => m.address === lead.address).userId;
    expect((await promote(admin, S(), lead, "validator")).status).toBe(200);
    await settle();
    expect((await ens.ownerOf(await registry(SLOT.validators), "lena")).toLowerCase()).toBe(lead.address);
    expect(await rolesOf(lead)).toBe(ROLE.OPERATOR | ROLE.VALIDATOR);
    expect(await ens.text(`lena.${ORG}`, "description")).toBe("Contributor, Validator");
    expect((await demote(admin, S(), lead, "validator")).status).toBe(200);
    await settle();
    expect(await ens.ownerOf(await registry(SLOT.validators), "lena")).toBe("0x0000000000000000000000000000000000000000");
    expect(await rolesOf(lead)).toBe(ROLE.OPERATOR);

    expect((await admin.call("DELETE", `${S()}/team/members/${leadId}`)).status).toBe(200);
    await settle();
    const items = (await admin.call("GET", `${S()}/names`)).json.items;
    expect(items.find((x: any) => x.kind === "person" && x.ref === leadId).status).toBe("revoked");
    expect(items.find((x: any) => x.name === `lena.contributors.${ORG}`).status).toBe("revoked");
    expect(await ens.text(`lena.${ORG}`, "com.ordo.status")).toBe("revoked");
    expect(await rolesOf(lead)).toBe(0);
    expect(await rolesOf(admin)).toBe(MANAGER);
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=200`)).json;
    expect(decisions.some((d: any) => d.kind === "ens.revoked" && d.summary === `Revoked lena.${ORG}`)).toBe(true);
  }, 180_000);
});
