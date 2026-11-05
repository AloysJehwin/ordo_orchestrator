import { PrivateKey } from "@hiero-ledger/sdk";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MachineBank } from "../../src/chain/machine-bank.js";
import { fakeFacilitator } from "../fixtures/x402.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

/** A stand-in for Hedera: accounts with balances, a treasury and the HCS topic. */
class FakeBank implements MachineBank {
  accounts = new Map<string, bigint>();
  audits: Record<string, unknown>[] = [];
  topUps: [string, bigint][] = [];
  next = 6001;
  async open(initial: bigint) {
    const accountId = `0.0.${this.next++}`;
    this.accounts.set(accountId, initial);
    const key = PrivateKey.generateECDSA();
    return { accountId, evmAddress: `0x${key.publicKey.toEvmAddress()}`, key: key.toStringRaw(), tx: `0.0.2@1.${this.next}` };
  }
  async balance(id: string) {
    return this.accounts.get(id) ?? 0n;
  }
  async topUp(id: string, amount: bigint) {
    this.topUps.push([id, amount]);
    this.accounts.set(id, (this.accounts.get(id) ?? 0n) + amount);
    return "0.0.2@2.1";
  }
  async accountOf() {
    return "0.0.8001"; // the vendor's wallet has a Hedera account
  }
  async audit(m: Record<string, unknown>) {
    this.audits.push(m);
    return `0.0.2@3.${this.audits.length}`;
  }
  txUrl = (id: string) => `https://hashscan.io/testnet/transaction/${id}`;
  accountUrl = (id: string) => `https://hashscan.io/testnet/account/${id}`;
}

const HBAR = 100_000_000n;
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let admin: Client;
let operator: Client;
let site = "";
let cnc = "";
let skew = 0;
const bank = new FakeBank();
const { f, settled, transfers } = fakeFacilitator("0.0.6001");
const S = () => `/v1/sites/${site}`;

beforeAll(async () => {
  let appRef: typeof app;
  const x402Fetch = ((input: RequestInfo | URL, init?: RequestInit) => appRef.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  ({ sys, app } = await boot({ HEDERA_OPERATOR_ID: "0.0.7001", PUBLIC_URL: "http://localhost" }, { x402Facilitator: f, x402Fetch, machineBank: bank, now: () => Date.now() + skew }));
  appRef = app;
  admin = await wallet(app, generatePrivateKey());
  operator = await wallet(app, generatePrivateKey());
  site = (await admin.call("POST", "/v1/sites", { name: "Paying Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
  await admin.call("POST", `${S()}/team/invites`, { address: operator.address });
  cnc = (await admin.call("POST", `${S()}/assets`, { name: "CNC-11", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: { vibration: { warn: 2.8, alarm: 4.5, unit: "mm/s" } }, idealCycleS: 30 })).json.id;
  // an approved vendor for CNC machines, 2 HBAR an hour, on site within 90 minutes
  await sys.db.query("INSERT INTO vendors (id, site_id, address, company, categories, hourly_rate, response_minutes) VALUES ('ven_1',$1,$2,'Spindle Care','cnc','2',90)", [site, "0x00000000000000000000000000000000000000aa"]);
});
afterAll(async () => sys.close());

describe("machines that pay for themselves", () => {
  it("gives a machine its own Hedera account within a budget that people set", async () => {
    expect((await operator.call("PUT", `${S()}/assets/${cnc}/wallet`, { dailyBudget: String(2n * HBAR), perCall: String(HBAR / 2n) })).status).toBe(403);
    expect((await admin.call("PUT", `${S()}/assets/${cnc}/wallet`, { dailyBudget: String(HBAR), perCall: String(2n * HBAR) })).status).toBe(400);
    const r = await admin.call("PUT", `${S()}/assets/${cnc}/wallet`, { dailyBudget: String(2n * HBAR), perCall: String(HBAR / 2n) });
    expect(r.json).toMatchObject({ status: "opening", accountId: null });
    await sys.jobs.run();
    const w = (await admin.call("GET", `${S()}/assets/${cnc}/wallet`)).json;
    expect(w).toMatchObject({ live: true, wallet: { status: "active", accountId: "0.0.6001", balance: String(2n * HBAR), dailyBudget: String(2n * HBAR) } });
    expect((await admin.call("GET", "/v1/status")).json.rails.find((x: any) => x.rail === "machine wallets")).toMatchObject({ live: true });
  });

  it("drifts, then pays for its own assessment and reserves a vendor, with no one approving", async () => {
    for (const v of [2.4, 3.3, 4.1, 4.9, 5.6]) await admin.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "vibration", value: v });
    await sys.advance(true);
    await sys.jobs.run();

    // two x402 payments from the machine's own account: the assessment to Ordo, the deposit straight to the vendor
    expect(settled).toHaveLength(2);
    expect(transfers[0]).toEqual(expect.arrayContaining([["0.0.6001", String(-10_000_000n)], ["0.0.7001", "10000000"]]));
    expect(transfers[1]).toEqual(expect.arrayContaining([["0.0.6001", String(-20_000_000n)], ["0.0.8001", "20000000"]]));

    const w = (await admin.call("GET", `${S()}/assets/${cnc}/wallet`)).json.wallet;
    expect(w.purchases.map((p: any) => [p.kind, p.seller, p.amount])).toEqual([
      ["callout", "Spindle Care", "20000000"],
      ["assessment", "Ordo condition monitoring", "10000000"],
    ]);
    expect(w.purchases[0]).toMatchObject({ txId: settled[1], auditTx: expect.any(String), result: { vendor: "Spindle Care", deposit: "20000000" } });
    const callouts = (await sys.db.query<{ vendor_id: string; asset_id: string }>("SELECT vendor_id, asset_id FROM vendor_callouts")).rows;
    expect(callouts).toEqual([{ vendor_id: "ven_1", asset_id: cnc }]);
    expect(bank.audits.map((a) => a.kind)).toEqual(["machine.wallet_opened", "machine.assessment", "machine.callout"]);

    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.find((d: any) => d.kind === "machine.bought_assessment")).toMatchObject({ agent: "machine:CNC-11" });
    expect(decisions.find((d: any) => d.kind === "machine.reserved_callout")?.summary).toMatch(/CNC-11 paid Spindle Care a 0.2 HBAR deposit/);
  });

  it("cannot spend more than its cap, stops when told, and is topped back up once a day", async () => {
    // a cap below the vendor's deposit: the machine's x402 client refuses to sign it
    await admin.call("PUT", `${S()}/assets/${cnc}/wallet`, { dailyBudget: String(2n * HBAR), perCall: String(HBAR / 10n) });
    await sys.db.query("UPDATE incidents SET status = 'closed'");
    for (const v of [2.4, 3.3, 4.1, 4.9, 5.6]) await admin.call("POST", `${S()}/assets/${cnc}/readings`, { signal: "vibration", value: v });
    await sys.advance(true);
    await sys.jobs.run();
    expect(settled).toHaveLength(3); // the assessment (0.1 HBAR) only; the 0.2 HBAR deposit was refused
    const job = (await sys.db.query<{ error: string }>("SELECT error FROM chain_jobs WHERE kind = 'machine.buy' ORDER BY created_at DESC LIMIT 1")).rows[0]!;
    expect(job.error).toMatch(/exceed|max|cap|spend/i);

    expect((await operator.call("POST", `${S()}/assets/${cnc}/wallet/pause`, { stop: true })).status).toBe(403);
    expect((await admin.call("POST", `${S()}/assets/${cnc}/wallet/pause`, { stop: true })).json.status).toBe("paused");
    expect((await admin.call("POST", `${S()}/assets/${cnc}/wallet/pause`, { stop: false })).json.status).toBe("active");

    bank.accounts.set("0.0.6001", HBAR / 4n);
    skew += 25 * 3_600_000;
    await sys.machines.topUps();
    expect(bank.topUps).toEqual([["0.0.6001", 2n * HBAR - HBAR / 4n]]);
  });

  it("vendors take no call-outs without a Hedera account", async () => {
    const r = await app.request("/v1/x402/vendors/ven_missing/callout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(404);
  });
});
