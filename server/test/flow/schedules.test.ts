import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, parseEther, toHex, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDO_POLICIES_ABI, ORDO_POLICIES_BYTECODE, ORDO_WORK_ORDERS_ABI, ORDO_WORK_ORDERS_BYTECODE } from "../../src/chain/ordo-contracts-abi.js";
import { ORDO_TRUST_ABI, ORDO_TRUST_BYTECODE } from "../../src/chain/ordo-trust-abi.js";
import type { ScheduleRail } from "../../src/core/schedules.js";
import { atLevel, boot, enlist, wallet, type Client, type System } from "./helpers.js";

/**
 * Deadlines on Hedera's Schedule Service, against a real EVM (in-process). The scheduler here stands in for
 * Hedera: it keeps what Ordo schedules and, once its time comes, sends exactly the scheduled call from an
 * account that is not Ordo's, so the test shows the scheduled transaction alone refunds an escrow and returns a
 * stake. Stage timeouts are scheduled ledger messages that the engine waits for.
 */
interface Scheduled {
  id: string;
  at: number;
  contract?: Hex;
  data?: Hex;
  message?: string;
  cancelled: boolean;
  executedAt: string | null;
}
const book: Scheduled[] = [];
let skew = 0; // ms the test has moved time forward, on the chain and in Ordo
const now = () => Date.now() + skew;
const rail: ScheduleRail = {
  kind: "test-scheduler",
  async contractCall(i) {
    const id = `0.0.${9000 + book.length}`;
    book.push({ id, at: i.at.getTime(), contract: i.contract, data: i.data, cancelled: false, executedAt: null });
    return { scheduleId: id, txId: `0.0.2@${book.length}` };
  },
  async topicMessage(i) {
    const id = `0.0.${9000 + book.length}`;
    book.push({ id, at: i.at.getTime(), message: i.message, cancelled: false, executedAt: null });
    return { scheduleId: id, txId: `0.0.2@${book.length}` };
  },
  async cancel(id) {
    book.find((s) => s.id === id)!.cancelled = true;
  },
  async state(id) {
    const s = book.find((x) => x.id === id)!;
    return { state: s.executedAt ? "executed" : s.cancelled ? "deleted" : "pending", executedAt: s.executedAt };
  },
  url: (id) => `https://hashscan.io/testnet/schedule/${id}`,
};

let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let pub: ReturnType<typeof createPublicClient>;
let provider: ReturnType<typeof ganache.provider>;
let transport: ReturnType<typeof custom>;
const addr = { trust: "0x" as Hex, orders: "0x" as Hex };
const keys = { admin: generatePrivateKey(), lead: generatePrivateKey(), vendor: generatePrivateKey(), qe: generatePrivateKey(), operator: generatePrivateKey() };
const agentKey = generatePrivateKey();
const funderKey = generatePrivateKey();
const hederaKey = generatePrivateKey(); // the network executing schedules: not Ordo's relayer
const people: Record<keyof typeof keys, Client> = {} as never;
let site = "";
const cnc: string[] = [];
const S = () => `/v1/sites/${site}`;

/** Hedera's side: run every schedule whose time has come. */
async function hedera() {
  const net = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(hederaKey) });
  for (const s of book.filter((x) => !x.cancelled && !x.executedAt && x.at <= now())) {
    if (s.contract) await pub.waitForTransactionReceipt({ hash: await net.sendTransaction({ to: s.contract, data: s.data, gas: 300_000n } as never) });
    s.executedAt = new Date(now()).toISOString();
  }
}
async function later(seconds: number) {
  await provider.request({ method: "evm_increaseTime", params: [seconds] });
  await provider.request({ method: "evm_mine", params: [] });
  skew += seconds * 1000;
}
const signed = async (who: Client, request: string, submit: string, body: Record<string, unknown> = {}, method = "POST") => {
  const typed = (await who.call("POST", request, body)).json;
  return who.call(method, submit, { ...body, nonce: typed.message.nonce, signature: await who.sign(typed) });
};
const trustWrite = async (key: Hex, functionName: string, value?: bigint) => {
  const w = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(key) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: addr.trust, abi: ORDO_TRUST_ABI, functionName, args: [site], value } as never) });
};

beforeAll(async () => {
  const relayer = generatePrivateKey();
  provider = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: 31337 },
    wallet: { accounts: [funderKey, relayer, agentKey, hederaKey, ...Object.values(keys)].map((secretKey) => ({ secretKey, balance: toHex(parseEther("1000")) })) },
  });
  transport = custom(provider as never);
  pub = createPublicClient({ chain: foundry, transport });
  const deployer = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(funderKey) });
  const deploy = async (abi: Abi, bytecode: Hex, args: unknown[]) => (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args } as never) })).contractAddress!;
  addr.trust = await deploy(ORDO_TRUST_ABI as Abi, ORDO_TRUST_BYTECODE, [parseEther("10"), 7n * 24n * 3600n, privateKeyToAccount(relayer).address]);
  addr.orders = await deploy(ORDO_WORK_ORDERS_ABI as Abi, ORDO_WORK_ORDERS_BYTECODE, [addr.trust]);
  const policies = await deploy(ORDO_POLICIES_ABI as Abi, ORDO_POLICIES_BYTECODE, [addr.trust]);
  ({ sys, app } = await boot(
    {
      TRUST_CONTRACT_ADDRESS: addr.trust,
      TRUST_WORKORDERS_ADDRESS: addr.orders,
      TRUST_POLICIES_ADDRESS: policies,
      TRUST_RELAYER_KEY: relayer,
      TRUST_CHAIN_ID: "31337",
      TRUST_DECIMALS: "18",
      TRUST_SYMBOL: "ETH",
      HEDERA_AGENT_KEY: agentKey,
    },
    { trustTransport: transport, now, scheduler: rail },
  ));
  for (const k of Object.keys(keys) as (keyof typeof keys)[]) people[k] = await wallet(app, keys[k]);

  site = (await people.admin.call("POST", "/v1/sites", { name: "Clock Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
  await atLevel(sys, site, "L3"); // machine stages complete on their own when in spec
  expect((await signed(people.admin, `${S()}/chain/register/sign-request`, `${S()}/chain/register`)).json.registered).toBe(true);
  expect((await signed(people.admin, `${S()}/vendors/sign-request`, `${S()}/vendors`, { address: people.vendor.address, company: "Spindle Care", categories: "cnc", hourlyRate: "2" })).json.chain.status).toBe("done");
  expect((await enlist(people.admin, S(), people.lead, "manager"))!.chain!.status).toBe("done");
  expect((await enlist(people.admin, S(), people.qe, "validator"))!.chain!.status).toBe("done");
  expect((await signed(people.admin, `${S()}/work-orders/caps/sign-request`, `${S()}/work-orders/caps`, { perOrder: parseEther("5").toString(), perDay: parseEther("50").toString() }, "PUT")).json.status).toBe("done");
  const funder = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(funderKey) });
  await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: addr.orders, abi: ORDO_WORK_ORDERS_ABI, functionName: "fund", args: [site], value: parseEther("20") } as never) });
  await enlist(people.admin, S(), people.operator);
  for (const name of ["CNC-01", "CNC-02"])
    cnc.push((await people.admin.call("POST", `${S()}/assets`, { name, kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: {}, idealCycleS: 30 })).json.id);
}, 180_000);
afterAll(async () => sys.close());

const fundsOf = async () => pub.readContract({ address: addr.orders, abi: ORDO_WORK_ORDERS_ABI, functionName: "funds", args: [await pub.readContract({ address: addr.orders, abi: ORDO_WORK_ORDERS_ABI, functionName: "siteKey", args: [site] } as never)] } as never) as Promise<bigint>;
const open = (runId: string) => sys.workOrders.open(site, "agent:test", { assetId: cnc[0]!, assetName: "CNC-01", assetKind: "cnc", runId, priority: "medium", incidentHash: null });

// first, while Ordo's clock still matches the database's (stage start times come from it)
describe("stage timeouts on Hedera's scheduler", () => {
  let versionId = "";
  const stages = (timeoutMin: number) => ({
    stages: [
      { code: "01", column: 1, name: "Release order", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "manager", timeoutMin: 10, criteria: [] },
      { code: "02", column: 2, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "manager", timeoutMin, criteria: [] },
    ],
    rework: null,
  });
  const stage = async (runId: string, code: string) => (await people.admin.call("GET", `${S()}/runs/${runId}`)).json.run.stages.find((s: any) => s.code === code);

  it("a running stage's timeout is a scheduled ledger message; the inbox item waits for Hedera to execute it", async () => {
    for (const id of cnc) for (const [signal, v] of [["execution", "ACTIVE"], ["part_count", 0]] as const) await people.admin.call("POST", `${S()}/assets/${id}/readings`, typeof v === "string" ? { signal, text: v } : { signal, value: v });
    versionId = (await people.admin.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "", spec: stages(10) })).json.versionId;
    const runId = (await people.admin.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-1", quantity: 10 })).json.id;
    expect((await stage(runId, "02")).state).toBe("running");
    await sys.advance(true);
    const msg = book.find((s) => s.message?.includes(runId));
    expect(JSON.parse(msg!.message!)).toMatchObject({ kind: "stage.timeout", runId, stage: "02", site });

    await later(11 * 60);
    await sys.advance(true);
    const timeoutItem = async () => (await people.admin.call("GET", `${S()}/inbox`)).json.find((i: any) => i.runId === runId && i.category === "Timeout");
    expect(await timeoutItem()).toBeUndefined(); // past the deadline by Ordo's clock, but Hedera has not said so
    await hedera();
    await later(20);
    await sys.advance(true);
    const item = await timeoutItem();
    expect(item.metrics).toContainEqual({ label: "Timed out on Hedera", value: `Schedule ${msg!.id} · ${msg!.executedAt}` });
  });

  it("a stage that finishes in time has its timeout schedule deleted", async () => {
    const long = (await people.admin.call("POST", `${S()}/templates`, { name: "Housing (long)", category: "Discrete", description: "", spec: stages(60) })).json.versionId;
    const runId = (await people.admin.call("POST", `${S()}/runs`, { templateVersionId: long, orderRef: "SO-2", quantity: 3 })).json.id;
    const s = await stage(runId, "02");
    expect(s.state).toBe("running");
    await sys.advance(true);
    const msg = book.find((x) => x.message?.includes(runId))!;
    expect(msg.cancelled).toBe(false);
    expect((await people.operator.call("POST", `${S()}/assets/${s.assetId}/readings`, { signal: "part_count", value: 3 })).status).toBe(403); // a manager records readings
    await people.admin.call("POST", `${S()}/assets/${s.assetId}/readings`, { signal: "part_count", value: 3 });
    await sys.advance(true);
    expect((await stage(runId, "02")).state).toBe("completed");
    await sys.advance(true);
    expect(msg.cancelled).toBe(true);
  });
});

describe("work-order refunds on Hedera's scheduler", () => {
  it("an escrow gets a refund schedule at its on-chain expiry, deleted once a manager releases it", async () => {
    const wo = await open("run_a");
    expect(wo.status).toBe("escrowed");
    await sys.advance(true);
    const onchain = await sys.trust.chain!.workOrder(site, wo.id);
    const view = (await sys.workOrders.get(site, wo.id)).refundSchedule!;
    expect(view).toMatchObject({ kind: "workorder.refund", status: "scheduled", executeAt: new Date((onchain.expiresAt + 5) * 1000).toISOString(), url: `https://hashscan.io/testnet/schedule/${view.scheduleId}` });
    expect(book.find((s) => s.id === view.scheduleId)).toMatchObject({ contract: addr.orders, cancelled: false });

    expect((await signed(people.lead, `${S()}/work-orders/${wo.id}/release/sign-request`, `${S()}/work-orders/${wo.id}/release`)).json.status).toBe("released");
    await sys.advance(true);
    expect((await sys.workOrders.get(site, wo.id)).refundSchedule!.status).toBe("cancelled");
    expect(book.find((s) => s.id === view.scheduleId)!.cancelled).toBe(true);
  });

  it("an unreleased escrow is refunded by the scheduled transaction itself; Ordo only records it", async () => {
    const wo = await open("run_b");
    await sys.advance(true);
    const before = await fundsOf();
    await later(72 * 3600 + 1);
    await sys.advance(true);
    // expired, but within the grace period Ordo leaves the refund to Hedera
    expect((await sys.workOrders.get(site, wo.id)).status).toBe("escrowed");
    await later(10);
    await hedera();
    expect(await sys.trust.chain!.workOrder(site, wo.id)).toMatchObject({ status: "refunded" });
    expect((await fundsOf()) - before).toBe(BigInt(wo.amount!));
    await sys.advance(true);
    const after = await sys.workOrders.get(site, wo.id);
    expect(after).toMatchObject({ status: "refunded", refundSchedule: { status: "executed" } });
    const decisions = (await people.admin.call("GET", `${S()}/decisions?limit=50`)).json;
    expect(decisions.some((d: any) => d.kind === "work_order.refunded" && d.agent === "system:scheduler")).toBe(true);
  });

  it("if a schedule never runs, Ordo's relayer refunds it after the grace period", async () => {
    const wo = await open("run_c");
    await sys.advance(true);
    const id = (await sys.workOrders.get(site, wo.id)).refundSchedule!.scheduleId!;
    book.find((s) => s.id === id)!.cancelled = true; // lost: Hedera will not run it
    await later(72 * 3600 + 6 * 60);
    await sys.advance(true);
    expect((await sys.workOrders.get(site, wo.id)).status).toBe("refunded");
    expect(await sys.trust.chain!.workOrder(site, wo.id)).toMatchObject({ status: "refunded" });
  });
});

describe("validator payouts on Hedera's scheduler", () => {
  it("an unstake request schedules the payout at the end of the cooldown; staking again deletes it", async () => {
    await trustWrite(keys.qe, "stake", parseEther("10"));
    expect((await people.qe.call("POST", `${S()}/stakers/me/payout-schedule`)).json.payout).toBeNull();
    await trustWrite(keys.qe, "requestUnstake");
    const first = (await people.qe.call("POST", `${S()}/stakers/me/payout-schedule`)).json.payout;
    const stake = await sys.trust.chain!.stakeOf(site, people.qe.address);
    expect(first).toMatchObject({ kind: "stake.withdraw", status: "scheduled", executeAt: new Date((stake.unlockAt + 5) * 1000).toISOString() });
    expect(book.find((s) => s.id === first.scheduleId)).toMatchObject({ contract: addr.trust });

    await trustWrite(keys.qe, "stake", parseEther("1"));
    expect((await people.qe.call("POST", `${S()}/stakers/me/payout-schedule`)).json.payout).toBeNull();
    expect(book.find((s) => s.id === first.scheduleId)!.cancelled).toBe(true);
  });

  it("the scheduled withdrawFor returns the stake to the validator without them doing anything", async () => {
    await trustWrite(keys.qe, "requestUnstake");
    const payout = (await people.qe.call("POST", `${S()}/stakers/me/payout-schedule`)).json.payout;
    const mine = (await people.qe.call("GET", `${S()}/stakers`)).json.stakers.find((v: any) => v.address === people.qe.address);
    expect(mine.onchain.payout).toMatchObject({ scheduleId: payout.scheduleId, status: "scheduled" });
    const qe = privateKeyToAccount(keys.qe).address;
    const before = await pub.getBalance({ address: qe });
    await later(7 * 24 * 3600 + 10);
    await hedera();
    expect((await pub.getBalance({ address: qe })) - before).toBe(parseEther("11"));
    await sys.advance(true);
    const decisions = (await people.admin.call("GET", `${S()}/decisions?limit=80`)).json;
    expect(decisions.some((d: any) => d.kind === "stake.returned")).toBe(true);
  });
});
