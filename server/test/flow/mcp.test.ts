import { PrivateKey } from "@hiero-ledger/sdk";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lotVerdict, type LotPassport } from "../../src/chain/mcp.js";
import { connectPaidMcp } from "../../src/chain/mcp-client.js";
import { fakeFacilitator } from "../fixtures/x402.js";
import { boot, wallet, type System } from "./helpers.js";

const PRICE = 10_000_000n; // the default X402_PRICE_TINYBARS: 0.1 HBAR
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let runId = "";
const { f, settled, transfers } = fakeFacilitator("0.0.5005");
const buyerKey = PrivateKey.generateECDSA().toStringRaw();
const toApp = ((input: RequestInfo | URL, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
const connect = (maxPerCall = PRICE) => connectPaidMcp({ url: "http://localhost/v1/x402/mcp", network: "hedera:testnet", accountId: "0.0.5005", key: buyerKey, maxPerCall, fetch: toApp });

beforeAll(async () => {
  ({ sys, app } = await boot({ HEDERA_OPERATOR_ID: "0.0.7001", PUBLIC_URL: "http://localhost" }, { x402Facilitator: f }));
  const admin = await wallet(app, generatePrivateKey());
  const site = (await admin.call("POST", "/v1/sites", { name: "Tool Shop", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
  const spec = {
    stages: [
      { code: "01", column: 1, name: "Release order", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "manager", timeoutMin: 10, criteria: [] },
      { code: "02", column: 2, name: "Final inspection", agent: "vision_qa", resourceKind: "inspection", mode: "approve", escalationRole: "validator", timeoutMin: 30, criteria: [{ label: "Yield", op: ">=", target: 99, unit: "%" }] },
    ],
    rework: null,
  };
  const tpl = (await admin.call("POST", `/v1/sites/${site}/templates`, { name: "Bracket", category: "Discrete", description: "MCP test", spec })).json;
  runId = (await admin.call("POST", `/v1/sites/${site}/runs`, { templateVersionId: tpl.versionId, orderRef: "SO-42", quantity: 12 })).json.id;
  await sys.passports.reconcile(); // passports are opened by the engine cycle
});
afterAll(async () => sys?.close());

const ramp = (from: number, step: number, n = 12) => Array.from({ length: n }, (_, i) => ({ t: Date.UTC(2026, 9, 1) + i * 600_000, v: from + i * step }));

describe("metered MCP server", () => {
  it("lists its tools and prices for free, and is listed with the x402 offers", async () => {
    const mcp = await connect();
    expect((await mcp.tools()).map((t) => t.name)).toEqual(["price_list", "assess_vibration", "forecast_failure", "verify_lot"]);
    const prices = await mcp.call<any>("price_list");
    expect(prices.payment).toBeNull();
    expect(prices.result).toMatchObject({ network: "hedera:testnet", payTo: "0.0.7001", tools: expect.arrayContaining([{ name: "assess_vibration", title: expect.any(String), price: String(PRICE), hbar: 0.1 }]) });
    const offers = (await (await app.request("/v1/x402")).json()) as any;
    expect(offers.mcp).toMatchObject({ path: "/v1/x402/mcp", transport: "streamable-http", payTo: "0.0.7001" });
    expect((await app.request("/v1/status")).status).toBe(200);
    await mcp.close();
  });

  it("charges each paid tool call in HBAR, settled before the answer comes back, and keeps a record of the sale", async () => {
    const mcp = await connect();
    const a = await mcp.call<any>("assess_vibration", { machineClass: "medium", samples: ramp(2.5, 0.25) });
    expect(a.isError).toBe(false);
    expect(a.result).toMatchObject({ zone: "D", standard: expect.stringContaining("ISO 10816-3") });
    expect(a.payment).toMatchObject({ transaction: settled[0], payer: "0.0.5005", url: expect.stringContaining("hashscan.io/testnet/transaction/") });
    // the buyer paid exactly the price to Ordo's account
    expect(transfers[0]).toEqual(expect.arrayContaining([["0.0.5005", String(-PRICE)], ["0.0.7001", String(PRICE)]]));

    const fc = await mcp.call<any>("forecast_failure", { signal: "bearing_temp", failureLimit: 90, samples: ramp(60, 1.5) });
    expect(fc.result).toMatchObject({ signal: "bearing_temp", hoursToFailure: expect.any(Number), model: "trend-logit-v1" });
    expect(fc.payment?.transaction).toBe(settled[1]);

    const lot = await mcp.call<any>("verify_lot", { lot: runId });
    expect(lot.result).toMatchObject({ runId, verdict: "in production", accept: false, quantity: 12, ledger: { intact: true } });
    expect(settled).toHaveLength(3);

    const sales = ((await (await app.request("/v1/x402")).json()) as any).mcp.recentSales;
    expect(sales.map((s: any) => s.tool).sort()).toEqual(["assess_vibration", "forecast_failure", "verify_lot"]);
    expect(sales[0]).toMatchObject({ amount: String(PRICE), payer: "0.0.5005", url: expect.stringContaining("hashscan.io") });
    await mcp.close();
  });

  it("does not charge a call it cannot answer", async () => {
    const mcp = await connect();
    const before = settled.length;
    const r = await mcp.call("verify_lot", { lot: "run_nope" });
    expect(r.isError).toBe(true);
    expect(r.payment).toBeNull();
    expect(settled.length).toBe(before);
    await mcp.close();
  });

  it("an agent whose cap is below the price pays nothing", async () => {
    const mcp = await connect(PRICE - 1n);
    const before = settled.length;
    await expect(mcp.call("assess_vibration", { samples: ramp(1, 0.1) })).rejects.toThrow();
    expect(settled.length).toBe(before);
    await mcp.close();
  });

  it("answers only POSTed JSON-RPC", async () => {
    expect((await app.request("/v1/x402/mcp")).status).toBe(405);
  });
});

describe("lot verdicts", () => {
  const base = (over: Partial<LotPassport["passport"]> = {}): LotPassport => ({
    name: "Lot SO-1",
    passport: {
      runId: "run_1",
      status: "completed",
      site: "Plant",
      orderRef: "SO-1",
      quantity: 10,
      product: { name: "Housing", version: 2 },
      stages: [{ code: "01", name: "Inspect", state: "completed", criteria: [{ label: "Yield", ok: true, zk: { status: "proven" } }] }],
      releases: [{ number: 1, type: "lot_release", signers: [{ meaning: "approved", address: "0xabc", ens: "meera.plant.eth" }], onchain: { txUrl: "https://hashscan.io/testnet/transaction/0x1" } }],
      proof: { chainIntact: true, anchor: { kind: "hcs", url: null, matchesChain: true } },
      nft: null,
      pageUrl: "/#/passport/run_1",
      ...over,
    },
  });
  it("accepts a released lot whose record checks out", () => {
    expect(lotVerdict(base())).toMatchObject({ accept: true, stages: { zkProven: 1 }, releases: [{ signers: [{ signer: "meera.plant.eth" }], onchain: expect.stringContaining("hashscan") }] });
  });
  it("refuses a held, failed, unreleased or unverifiable lot", () => {
    expect(lotVerdict(base({ stages: [{ code: "01", name: "Inspect", state: "held", criteria: [] }] })).verdict).toMatch(/^on hold/);
    expect(lotVerdict(base({ stages: [{ code: "01", name: "Inspect", state: "completed", criteria: [{ label: "Yield", ok: false, zk: null }] }] }))).toMatchObject({ accept: false, stages: { failedCriteria: ["01: Yield"] } });
    expect(lotVerdict(base({ releases: [] })).verdict).toMatch(/^not released/);
    expect(lotVerdict(base({ proof: { chainIntact: false, anchor: null } })).verdict).toMatch(/^unverified/);
  });
});
