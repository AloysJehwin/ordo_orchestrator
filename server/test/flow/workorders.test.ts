import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, parseEther, toHex, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDO_POLICIES_ABI, ORDO_POLICIES_BYTECODE, ORDO_WORK_ORDERS_ABI, ORDO_WORK_ORDERS_BYTECODE } from "../../src/chain/ordo-contracts-abi.js";
import { ORDO_TRUST_ABI, ORDO_TRUST_BYTECODE } from "../../src/chain/ordo-trust-abi.js";
import { boot, enlist, wallet, type Client, type System } from "./helpers.js";

/**
 * Agent payments and autonomy policies end to end against a real EVM (in-process): the maintenance agent
 * escrows from its own key when its work order is approved, a manager's signature releases the money to the
 * vendor, an expired escrow is refunded, and a change of autonomy is published with a manager's signature.
 */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let pub: ReturnType<typeof createPublicClient>;
let transport: ReturnType<typeof custom>;
let provider: ReturnType<typeof ganache.provider>;
const addr = { trust: "0x" as Hex, orders: "0x" as Hex, policies: "0x" as Hex };
const keys = { admin: generatePrivateKey(), lead: generatePrivateKey(), vendor: generatePrivateKey(), pm2: generatePrivateKey(), operator: generatePrivateKey() };
const agentKey = generatePrivateKey();
const funderKey = generatePrivateKey();
const people: Record<keyof typeof keys, Client> = {} as never;
let site = "";
let cnc = "";
let skew = 0; // ms the test has moved time forward, on the chain and in Ordo
const S = () => `/v1/sites/${site}`;

beforeAll(async () => {
  const relayer = generatePrivateKey();
  provider = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: 31337 },
    wallet: { accounts: [funderKey, relayer, agentKey, ...Object.values(keys)].map((secretKey) => ({ secretKey, balance: toHex(parseEther("1000")) })) },
  });
  transport = custom(provider as never);
  pub = createPublicClient({ chain: foundry, transport });
  const deployer = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(funderKey) });
  const deploy = async (abi: Abi, bytecode: Hex, args: unknown[]) =>
    (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args } as never) })).contractAddress!;
  addr.trust = await deploy(ORDO_TRUST_ABI as Abi, ORDO_TRUST_BYTECODE, [parseEther("10"), 7n * 24n * 3600n, privateKeyToAccount(relayer).address]);
  addr.orders = await deploy(ORDO_WORK_ORDERS_ABI as Abi, ORDO_WORK_ORDERS_BYTECODE, [addr.trust]);
  addr.policies = await deploy(ORDO_POLICIES_ABI as Abi, ORDO_POLICIES_BYTECODE, [addr.trust]);
  ({ sys, app } = await boot(
    {
      TRUST_CONTRACT_ADDRESS: addr.trust,
      TRUST_WORKORDERS_ADDRESS: addr.orders,
      TRUST_POLICIES_ADDRESS: addr.policies,
      TRUST_RELAYER_KEY: relayer,
      TRUST_CHAIN_ID: "31337",
      TRUST_DECIMALS: "18",
      TRUST_SYMBOL: "ETH",
      HEDERA_AGENT_KEY: agentKey,
    },
    { trustTransport: transport, now: () => Date.now() + skew },
  ));
  for (const k of Object.keys(keys) as (keyof typeof keys)[]) people[k] = await wallet(app, keys[k]);
}, 120_000);
afterAll(async () => sys.close());

const signed = async (who: Client, request: string, submit: string, body: Record<string, unknown> = {}, method = "POST") => {
  const typed = (await who.call("POST", request, body)).json;
  return who.call(method, submit, { ...body, nonce: typed.message.nonce, signature: await who.sign(typed) });
};
const ordersRead = <T>(fn: string, args: unknown[]) => pub.readContract({ address: addr.orders, abi: ORDO_WORK_ORDERS_ABI, functionName: fn, args } as never) as Promise<T>;

describe("agent payments through OrdoWorkOrders", () => {
  it("sets up: site on-chain, a vendor and two more managers with credentials, caps a manager signed, a funded site", async () => {
    site = (await people.admin.call("POST", "/v1/sites", { name: "Pay Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
    expect((await signed(people.admin, `${S()}/chain/register/sign-request`, `${S()}/chain/register`)).json.registered).toBe(true);

    // a manager adds the vendor by wallet, with a signature relayed as their VENDOR credential
    const vendor = await signed(people.admin, `${S()}/vendors/sign-request`, `${S()}/vendors`, { address: people.vendor.address, company: "Spindle Care", categories: "cnc", hourlyRate: "2" });
    expect(vendor.json.chain.status, JSON.stringify(vendor.json)).toBe("done");
    for (const who of [people.lead, people.pm2]) expect((await enlist(people.admin, S(), who, "manager"))!.chain!.status).toBe("done");
    expect(await enlist(people.admin, S(), people.operator)).toBeNull();

    // only a manager sets caps; the caps are relayed with the manager's signature
    expect((await people.operator.call("POST", `${S()}/work-orders/caps/sign-request`, { perOrder: "1", perDay: "2" })).status).toBe(403);
    const caps = { perOrder: parseEther("5").toString(), perDay: parseEther("8").toString() };
    const r = await signed(people.admin, `${S()}/work-orders/caps/sign-request`, `${S()}/work-orders/caps`, caps, "PUT");
    expect(r.json.status).toBe("done");

    // anyone funds the site from their own wallet
    const funder = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(funderKey) });
    await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: addr.orders, abi: ORDO_WORK_ORDERS_ABI, functionName: "fund", args: [site], value: parseEther("10") } as never) });

    // the console funds and publishes through these addresses
    const status = (await people.admin.call("GET", "/v1/status")).json;
    expect(status.trust).toMatchObject({ workOrders: addr.orders, policies: addr.policies });
    const setup = (await people.admin.call("GET", `${S()}/work-orders`)).json.setup;
    expect(setup).toMatchObject({ configured: true, agent: { via: "evm" }, onchain: { funds: parseEther("10").toString(), paused: false, perOrder: caps.perOrder } });
    expect(setup.agent.address).toBe(privateKeyToAccount(agentKey).address);
  });

  it("an approved work order assigns the vendor and the agent escrows from its own key", async () => {
    cnc = (await people.admin.call("POST", `${S()}/assets`, { name: "CNC-07", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: { temperature: { warn: 60, alarm: 80, unit: "°C" } }, idealCycleS: 30 })).json.id;
    for (const v of [55, 62, 71, 84]) await people.admin.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "temperature", value: v });
    await sys.advance(true);
    const item = (await people.admin.call("GET", `${S()}/inbox`)).json.find((i: any) => i.options[0]?.action.tool === "open_work_order");
    const r = await signed(people.lead, `${S()}/inbox/${item.id}/sign-request`, `${S()}/inbox/${item.id}/decide`, { option: 0, comment: "" });
    expect(r.status).toBe(200);

    const wo = (await people.lead.call("GET", `${S()}/work-orders`)).json.items[0];
    expect(wo).toMatchObject({ status: "escrowed", vendor: { company: "Spindle Care", address: people.vendor.address }, payer: "evm" });
    expect(BigInt(wo.amount)).toBe(parseEther("4")); // 2 per hour × 2 hours for a high-priority order
    const onchain = await sys.trust.chain!.workOrder(site, wo.id);
    expect(onchain).toMatchObject({ status: "escrowed", vendor: privateKeyToAccount(keys.vendor).address, agent: privateKeyToAccount(agentKey).address });
    expect(await ordersRead<bigint>("funds", [await ordersRead<Hex>("siteKey", [site])])).toBe(parseEther("6"));
    const decisions = (await people.admin.call("GET", `${S()}/decisions?limit=50`)).json;
    expect(decisions.some((d: any) => d.kind === "work_order.escrowed")).toBe(true);
  });

  it("a manager's signature pays the vendor; the vendor and contributors cannot", async () => {
    const wo = (await people.lead.call("GET", `${S()}/work-orders`)).json.items[0];
    expect((await people.operator.call("POST", `${S()}/work-orders/${wo.id}/release/sign-request`)).status).toBe(403);
    expect((await people.vendor.call("POST", `${S()}/work-orders/${wo.id}/release/sign-request`)).status).toBe(403);
    const before = await pub.getBalance({ address: privateKeyToAccount(keys.vendor).address });
    const r = await signed(people.lead, `${S()}/work-orders/${wo.id}/release/sign-request`, `${S()}/work-orders/${wo.id}/release`);
    expect(r.json).toMatchObject({ status: "released", release: { status: "done" } });
    expect((await pub.getBalance({ address: privateKeyToAccount(keys.vendor).address })) - before).toBe(parseEther("4"));
    expect((await sys.trust.chain!.workOrder(site, wo.id)).status).toBe("released");
  });

  it("the Agent Kit policy check refuses anything Ordo did not open", async () => {
    const wo = (await people.lead.call("GET", `${S()}/work-orders`)).json.items[0];
    expect(await sys.workOrders.checkEscrow({ siteId: site, workOrderId: "wo_made_up", vendor: people.vendor.address, amount: "1" })).toMatch(/no work order/);
    expect(await sys.workOrders.checkEscrow({ siteId: site, workOrderId: wo.id, vendor: people.vendor.address, amount: wo.amount })).toMatch(/released/);
  });

  it("an unreleased escrow is refunded to the site's fund after it expires", async () => {
    const opened = await sys.workOrders.open(site, "agent:test", { assetId: cnc, assetName: "CNC-07", assetKind: "cnc", runId: "run_x", priority: "medium", incidentHash: null });
    expect(opened.status).toBe("escrowed");
    const k = await ordersRead<Hex>("siteKey", [site]);
    expect(await ordersRead<bigint>("funds", [k])).toBe(parseEther("4"));
    // 73 hours later, on the chain and in Ordo
    await provider.request({ method: "evm_increaseTime", params: [73 * 3600] });
    await provider.request({ method: "evm_mine", params: [] });
    skew += 73 * 3600 * 1000;
    await sys.advance(true);
    expect((await sys.workOrders.get(site, opened.id)).status).toBe("refunded");
    expect(await ordersRead<bigint>("funds", [k])).toBe(parseEther("6"));
  });

  it("a manager stops the agent at once", async () => {
    const r = await signed(people.pm2, `${S()}/work-orders/pause/sign-request`, `${S()}/work-orders/pause`, { stop: true }, "PUT");
    expect(r.json.status).toBe("done");
    const blocked = await sys.workOrders.open(site, "agent:test", { assetId: cnc, assetName: "CNC-07", assetKind: "cnc", runId: "run_y", priority: "low", incidentHash: null });
    expect(blocked.status).toBe("escrow_failed");
    expect(blocked.error).toBe("AgentPaused");
  });
});

describe("autonomy policies through OrdoPolicies", () => {
  it("publishes a raise and a lowering, each with one manager's signature", async () => {
    const lineId = (await people.admin.call("GET", S())).json.lines[0].id;
    const change = (who: Client, level: string) => signed(who, `${S()}/lines/${lineId}/autonomy/sign-request`, `${S()}/lines/${lineId}/autonomy`, { level }, "PUT");
    // OrdoPolicies checks the count too: it must ask for no more signatures than Ordo collects
    expect(Number(await pub.readContract({ address: addr.policies, abi: ORDO_POLICIES_ABI, functionName: "REQUIRED", args: [] } as never))).toBe(1);
    expect((await people.operator.call("POST", `${S()}/lines/${lineId}/autonomy/sign-request`, { level: "L3" })).status).toBe(403);
    let r = await change(people.admin, "L3");
    expect(r.json.proposal).toMatchObject({ status: "applied", required: 1, onchain: { status: "done" } });
    let p = await sys.trust.chain!.policyOf(site, lineId);
    expect(p).toMatchObject({ level: 3, version: 1, policyHash: `0x${sys.policy.hash.replace("sha256:", "")}` });
    r = await change(people.pm2, "L1");
    expect(r.json.proposal).toMatchObject({ status: "applied", required: 1, onchain: { status: "done" } });
    p = await sys.trust.chain!.policyOf(site, lineId);
    expect(p).toMatchObject({ level: 1, version: 2 });
  });
});
