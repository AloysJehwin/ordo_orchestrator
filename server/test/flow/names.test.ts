import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnsV2 } from "../../src/chain/ensv2.js";
import { personLabel } from "../../src/core/names.js";
import { ANVIL_KEYS, anvilPath, startAnvil } from "../fixtures/anvil.js";
import { deployEnsV2 } from "../fixtures/ensv2.js";
import { boot, demote, promote, wallet, type Client, type System } from "./helpers.js";

/**
 * ENSv2 names end to end on the real contracts (anvil): a site gets its own registry under the parent name, each
 * person a name in it minted to their wallet with their roles as records, and a person who leaves loses theirs.
 */
const run = anvilPath() || process.env.CI ? describe : describe.skip;

run("ENS names for a site", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let admin: Client;
  let lead: Client;
  let ens: EnsV2;
  let site = "";
  const S = () => `/v1/sites/${site}`;
  const settle = async () => {
    for (let i = 0; i < 12; i++) await sys.names.reconcile(10);
  };

  beforeAll(async () => {
    anvil = await startAnvil();
    const stack = await deployEnsV2(anvil.url);
    const env = {
      ENS_PARENT_NAME: "ordo-test.eth",
      ENS_REGISTRY_ADDRESS: stack.parentRegistry,
      ENS_RESOLVER_ADDRESS: stack.resolver,
      ENS_OWNER_KEY: ANVIL_KEYS[0]!,
      ENS_SEPOLIA_RPC_URL: anvil.url,
      ENS_CHAIN_ID: "31337",
      ENS_FACTORY_ADDRESS: stack.factory,
      ENS_USER_REGISTRY_IMPL: stack.userRegistryImpl,
      PUBLIC_URL: "https://ordo.example",
    };
    ({ sys, app } = await boot(env));
    ens = new EnsV2({ rpcUrl: anvil.url, ownerKey: ANVIL_KEYS[0]!, parentName: env.ENS_PARENT_NAME, parentRegistry: stack.parentRegistry, resolver: stack.resolver, chainId: 31337 });
    admin = await wallet(app, generatePrivateKey());
    lead = await wallet(app, generatePrivateKey());
    await admin.call("PATCH", "/v1/me", { displayName: "Asha Iyer" });
    await lead.call("PATCH", "/v1/me", { displayName: "Lena Fischer" });
    site = (await admin.call("POST", "/v1/sites", { name: "Chennai Plant 1", timezone: "Asia/Kolkata", lineName: "L1", zones: [] })).json.id;
  }, 60_000);
  afterAll(async () => {
    await sys?.close();
    anvil?.stop();
  });

  const leadName = () => `${personLabel(lead.address)}.chennai-plant-1.ordo-test.eth`;

  it("names the site, its people, assets and agents, with records", async () => {
    await admin.call("POST", `${S()}/team/invites`, { address: lead.address });
    await admin.call("POST", `${S()}/assets`, { name: "CNC-07", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: {}, idealCycleS: 30 });
    await settle();

    const names = (await admin.call("GET", `${S()}/names`)).json;
    expect(names).toMatchObject({ live: true, parent: "ordo-test.eth" });
    const by = (n: string) => names.items.find((x: any) => x.name === n);
    expect(by("chennai-plant-1.ordo-test.eth")).toMatchObject({ kind: "site", status: "issued" });
    expect(by(`${personLabel(admin.address)}.chennai-plant-1.ordo-test.eth`)).toMatchObject({ kind: "person", status: "issued", records: { "com.ordo.roles": "admin,operator,plant_manager,supervisor,validator" } });
    expect(by(leadName())).toMatchObject({ status: "issued" });
    expect(by("cnc-07.chennai-plant-1.ordo-test.eth")).toMatchObject({ kind: "asset", status: "issued" });
    expect(by("maintenance-agent.chennai-plant-1.ordo-test.eth")).toMatchObject({ kind: "agent", status: "issued" });
    expect(names.items.every((x: any) => x.status === "issued")).toBe(true);
    // account names never reach the chain
    expect(names.items.filter((x: any) => x.kind === "person").every((x: any) => !/asha|iyer|lena|fischer/.test(x.name))).toBe(true);

    // on-chain: the person owns the name, and its records say who they are at the site, in the role names
    // OrdoEnsRoles knows (a contributor is an operator)
    expect((await ens.text(leadName(), "com.ordo.roles"))).toBe("operator");
    expect((await ens.addr(leadName())).toLowerCase()).toBe(lead.address);
    expect(await ens.text("chennai-plant-1.ordo-test.eth", "url")).toBe("https://ordo.example");
    const team = (await admin.call("GET", `${S()}/team`)).json.members;
    expect(team.find((m: any) => m.address === lead.address).ens).toBe(leadName());
    expect((await admin.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "ens names")).toMatchObject({ live: true });
  }, 120_000);

  it("updates records when roles change, and revokes the name of someone who leaves", async () => {
    const leadId = (await admin.call("GET", `${S()}/team`)).json.members.find((m: any) => m.address === lead.address).userId;
    expect((await promote(admin, S(), lead, "validator")).status).toBe(200);
    await settle();
    expect(await ens.text(leadName(), "com.ordo.roles")).toBe("operator,validator");
    expect(await ens.text(leadName(), "description")).toBe("Contributor, Validator");
    expect((await demote(admin, S(), lead, "validator")).status).toBe(200);
    await settle();
    expect(await ens.text(leadName(), "com.ordo.roles")).toBe("operator");

    expect((await admin.call("DELETE", `${S()}/team/members/${leadId}`)).status).toBe(200);
    await settle();
    const item = (await admin.call("GET", `${S()}/names`)).json.items.find((x: any) => x.ref === leadId);
    expect(item.status).toBe("revoked");
    expect(await ens.text(leadName(), "com.ordo.status")).toBe("revoked");
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.some((d: any) => d.kind === "ens.revoked")).toBe(true);
  }, 120_000);
});
