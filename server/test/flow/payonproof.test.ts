import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, parseEther, toHex, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PartyBank } from "../../src/chain/machine-bank.js";
import { ORDO_PAY_ON_PROOF_ABI, ORDO_PAY_ON_PROOF_BYTECODE } from "../../src/chain/ordo-payonproof-abi.js";
import { MOCK_RELEASES_ABI, MOCK_RELEASES_BYTECODE, MOCK_STABLECOIN_ABI, MOCK_STABLECOIN_BYTECODE } from "../fixtures/stablecoin.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

/**
 * Pay on proof end to end against a real EVM (in-process): Ordo USD cashed in to a customer, the customer's hold for a
 * lot, the plant selling its receivable to a financier at a discount, and the payment released only once the lot's
 * release is on-chain. The stablecoin is a stand-in with Stablecoin Studio's hold rules (contracts/test/MockStablecoin.sol).
 */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let admin: Client;
let operator: Client;
let pub: ReturnType<typeof createPublicClient>;
let provider: ReturnType<typeof ganache.provider>;
const funderKey = generatePrivateKey();
const relayerKey = generatePrivateKey();
const addr = { coin: "0x" as Address, releases: "0x" as Address, pay: "0x" as Address };
let site = "";
let pkg = "";
let skew = 0;
const S = () => `/v1/sites/${site}`;
const USD = 1_000_000n; // 6 decimals

/** Opens parties as fresh EVM accounts funded with gas, as Hedera accounts with an alias would be */
const bank: PartyBank & { opened: string[] } = {
  opened: [],
  async open(memo) {
    const key = generatePrivateKey();
    const a = privateKeyToAccount(key).address;
    const funder = createWalletClient({ chain: foundry, transport: custom(provider as never), account: privateKeyToAccount(funderKey) });
    await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: a, value: parseEther("10") }) });
    this.opened.push(memo);
    return { accountId: `0.0.${7000 + this.opened.length}`, evmAddress: a, key, tx: null };
  },
  accountUrl: (id) => `https://hashscan.io/testnet/account/${id}`,
};

beforeAll(async () => {
  provider = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: 31337 },
    wallet: { accounts: [funderKey, relayerKey].map((secretKey) => ({ secretKey, balance: toHex(parseEther("1000")) })) },
  });
  const transport = custom(provider as never);
  pub = createPublicClient({ chain: foundry, transport });
  const deployer = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(funderKey) });
  const deploy = async (abi: Abi, bytecode: Hex, args: unknown[]) => (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args } as never) })).contractAddress!;
  addr.coin = await deploy(MOCK_STABLECOIN_ABI as Abi, MOCK_STABLECOIN_BYTECODE, []);
  addr.releases = await deploy(MOCK_RELEASES_ABI as Abi, MOCK_RELEASES_BYTECODE, []);
  addr.pay = await deploy(ORDO_PAY_ON_PROOF_ABI as Abi, ORDO_PAY_ON_PROOF_BYTECODE, [addr.coin, addr.coin, addr.releases]);
  ({ sys, app } = await boot(
    { STABLECOIN_ADDRESS: addr.coin, STABLECOIN_TOKEN_ADDRESS: addr.coin, PAY_ON_PROOF_ADDRESS: addr.pay, TRUST_RELAYER_KEY: relayerKey, TRUST_CHAIN_ID: "31337" },
    { trustTransport: transport, partyBank: bank, now: () => Date.now() + skew },
  ));
  admin = await wallet(app, generatePrivateKey());
  operator = await wallet(app, generatePrivateKey());
  site = (await admin.call("POST", "/v1/sites", { name: "Proof Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
  await admin.call("POST", `${S()}/team/invites`, { address: operator.address });
  pkg = (await admin.call("POST", `${S()}/validation`, { type: "pilot_validation", title: "Lot 42 release", objective: "Release lot 42 for shipment" })).json.id;
}, 120_000);
afterAll(async () => sys?.close());

const finance = async () => (await admin.call("GET", `${S()}/finance`)).json;
const party = async (name: string) => (await finance()).parties.find((p: any) => p.name === name);
const order = async (id: string) => (await finance()).orders.find((o: any) => o.id === id);
const drain = async () => {
  for (let i = 0; i < 6; i++) await sys.jobs.run(10);
};
const releaseOnChain = async () => {
  const w = createWalletClient({ chain: foundry, transport: custom(provider as never), account: privateKeyToAccount(funderKey) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: addr.releases, abi: MOCK_RELEASES_ABI, functionName: "release", args: [site, pkg] }) });
};

describe("pay on proof", () => {
  let customer = "";
  let financier = "";
  let orderId = "";

  it("opens accounts for a customer and a financier and cashes in Ordo USD (managers only)", async () => {
    expect((await operator.call("POST", `${S()}/finance/parties`, { kind: "customer", name: "Tata Motors" })).status).toBe(403);
    customer = (await admin.call("POST", `${S()}/finance/parties`, { kind: "customer", name: "Tata Motors" })).json.id;
    financier = (await admin.call("POST", `${S()}/finance/parties`, { kind: "financier", name: "Lotus Capital" })).json.id;
    await drain();
    expect(await party("Tata Motors")).toMatchObject({ status: "active", kind: "customer", accountId: expect.stringMatching(/^0\.0\./), balance: "0" });
    expect((await admin.call("POST", `${S()}/finance/parties/${customer}/cash-in`, { amount: "1000.5" })).status).toBe(200);
    expect((await admin.call("POST", `${S()}/finance/parties/${financier}/cash-in`, { amount: "1000" })).status).toBe(200);
    expect((await admin.call("POST", `${S()}/finance/parties/${customer}/cash-in`, { amount: "-1" })).status).toBe(400);
    await drain();
    expect((await party("Tata Motors")).balance).toBe(String(1000_500_000n));
    const status = (await admin.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "pay on proof");
    expect(status).toMatchObject({ live: true });
  });

  it("holds the customer's payment for the lot, committed to the package and the plant", async () => {
    const r = await admin.call("POST", `${S()}/finance/orders`, { packageId: pkg, customerId: customer, amount: "500", days: 30 });
    expect(r.status).toBe(200);
    orderId = r.json.id;
    expect(r.json).toMatchObject({ status: "funding", amount: String(500n * USD), customer: { name: "Tata Motors" }, payee: { kind: "plant", name: "Proof Plant" } });
    expect((await admin.call("POST", `${S()}/finance/orders`, { packageId: pkg, customerId: financier, amount: "1" })).status).toBe(400);
    await drain();
    const o = await order(orderId);
    expect(o).toMatchObject({ status: "open", holdId: "1", key: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(o.txs.map((t: any) => t.kind)).toEqual(["hold", "open"]);
    expect((await party("Tata Motors")).balance).toBe(String(500_500_000n)); // 500 held, not spent
  });

  it("sells the receivable to a financier at a discount: the plant has the cash now", async () => {
    expect((await admin.call("POST", `${S()}/finance/orders/${orderId}/offer`, { ask: "500" })).status).toBe(400);
    expect((await admin.call("POST", `${S()}/finance/orders/${orderId}/take`, { financierId: financier })).status).toBe(409); // not offered yet
    await admin.call("POST", `${S()}/finance/orders/${orderId}/offer`, { ask: "485" });
    await drain();
    expect((await order(orderId)).ask).toBe(String(485n * USD));
    await admin.call("POST", `${S()}/finance/orders/${orderId}/take`, { financierId: financier });
    await drain();
    expect(await order(orderId)).toMatchObject({ payee: { name: "Lotus Capital", kind: "financier" }, ask: null });
    expect((await party("Proof Plant")).balance).toBe(String(485n * USD));
    expect((await party("Lotus Capital")).balance).toBe(String(515n * USD));
    expect((await admin.call("POST", `${S()}/finance/orders/${orderId}/waive`)).status).toBe(409); // the plant sold it
  });

  it("pays nothing until the release is on-chain, then pays the receivable's holder in full", async () => {
    await sys.db.query("UPDATE validation_packages SET status = 'released' WHERE id = $1", [pkg]);
    await sys.payOnProof.reconcile();
    expect(await order(orderId)).toMatchObject({ status: "open", note: expect.stringMatching(/on-chain/) });
    await releaseOnChain();
    expect(await sys.payOnProof.reconcile()).toBe(1);
    const o = await order(orderId);
    expect(o).toMatchObject({ status: "paid", note: null });
    expect(o.txs.map((t: any) => t.kind)).toEqual(["hold", "open", "offer", "sale", "paid"]);
    expect((await party("Lotus Capital")).balance).toBe(String(1015n * USD)); // 515 + 500: a 15 OUSD return
    const kinds = (await admin.call("GET", `${S()}/decisions?limit=50`)).json.map((d: any) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(["finance.cash_in", "finance.order_funded", "finance.receivable_sold", "finance.paid_on_proof"]));
    expect((await admin.call("POST", `${S()}/finance/orders`, { packageId: pkg, customerId: customer, amount: "1" })).status).toBe(409); // already released
  });

  it("gives an unproven payment back to the customer when it expires, and lets the plant waive one", async () => {
    const pkg2 = (await admin.call("POST", `${S()}/validation`, { type: "pilot_validation", title: "Lot 43 release" })).json.id;
    const a = (await admin.call("POST", `${S()}/finance/orders`, { packageId: pkg2, customerId: customer, amount: "100", days: 1 })).json.id;
    const b = (await admin.call("POST", `${S()}/finance/orders`, { packageId: pkg2, customerId: customer, amount: "50", days: 30 })).json.id;
    await drain();
    expect((await party("Tata Motors")).balance).toBe(String(350_500_000n));
    await admin.call("POST", `${S()}/finance/orders/${b}/waive`);
    await drain();
    expect((await order(b)).status).toBe("refunded");
    await provider.request({ method: "evm_increaseTime", params: [2 * 86_400] });
    await provider.request({ method: "evm_mine", params: [] });
    skew += 2 * 86_400_000;
    await sys.payOnProof.reconcile();
    expect((await order(a)).status).toBe("refunded");
    expect((await party("Tata Motors")).balance).toBe(String(500_500_000n));
  });
});
