import { PrivateKey } from "@hiero-ledger/sdk";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeFacilitator } from "../fixtures/x402.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

/** The maintenance agent buys a vibration assessment over x402 for each work order it opens, from Ordo's own paid endpoint. */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let admin: Client;
let site = "";
const AGENT = "0.0.5005";
const { f, settled } = fakeFacilitator(AGENT);

beforeAll(async () => {
  let appRef: typeof app;
  const x402Fetch = ((input: RequestInfo | URL, init?: RequestInit) => appRef.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  ({ sys, app } = await boot(
    { HEDERA_OPERATOR_ID: "0.0.7001", HEDERA_AGENT_ID: AGENT, HEDERA_AGENT_KEY: PrivateKey.generateECDSA().toStringRaw(), PUBLIC_URL: "http://localhost" },
    { x402Facilitator: f, x402Fetch },
  ));
  appRef = app;
  admin = await wallet(app, generatePrivateKey());
  site = (await admin.call("POST", "/v1/sites", { name: "Paid Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
});
afterAll(async () => sys.close());

describe("x402 assessments", () => {
  it("lists the offer and charges strangers before answering", async () => {
    expect((await app.request("/v1/x402")).status).toBe(200);
    expect((await (await app.request("/v1/x402")).json()).offers[0]).toMatchObject({ path: "/v1/x402/vibration-assessment", payTo: "0.0.7001", price: "10000000", asset: "0.0.0" });
    const r = await app.request("/v1/x402/vibration-assessment", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(402);
    expect(r.headers.get("payment-required")).toBeTruthy();
    expect((await admin.call("GET", "/v1/status")).json.rails.find((x: any) => x.rail === "x402 assessments")).toMatchObject({ live: true });
  });

  it("buys an assessment for the work order with the agent's own account and records it", async () => {
    const S = `/v1/sites/${site}`;
    const cnc = (await admin.call("POST", `${S}/assets`, { name: "CNC-09", kind: "cnc", owningAgent: "scheduler", source: { type: "manual" }, limits: { vibration: { warn: 2.8, alarm: 4.5, unit: "mm/s" } }, idealCycleS: 30 })).json.id;
    for (const v of [2.2, 2.9, 3.6, 4.4, 5.1]) await admin.call("POST", `${S}/assets/${cnc}/readings`, { signal: "vibration", value: v });
    await sys.advance(true);
    const item = (await admin.call("GET", `${S}/inbox`)).json.find((i: any) => i.options[0]?.action.tool === "open_work_order");
    expect(item).toBeTruthy();
    const typed = (await admin.call("POST", `${S}/inbox/${item.id}/sign-request`, { option: 0, comment: "" })).json;
    expect((await admin.call("POST", `${S}/inbox/${item.id}/decide`, { option: 0, comment: "", nonce: typed.message.nonce, signature: await admin.sign(typed) })).status).toBe(200);

    let wo = (await admin.call("GET", `${S}/work-orders`)).json.items[0];
    expect(wo.assessment).toMatchObject({ status: "pending" });
    await sys.jobs.run();
    wo = (await admin.call("GET", `${S}/work-orders`)).json.items[0];
    expect(wo.assessment).toMatchObject({ status: "done", assessment: { zone: "C", samples: 5 }, payment: { payer: AGENT, transaction: settled[0] } });
    const decisions = (await admin.call("GET", `${S}/decisions?limit=50`)).json;
    expect(decisions.find((d: any) => d.kind === "work_order.assessed")?.summary).toMatch(/over x402: zone C at 4\.367 mm\/s, zone D within the hour at this trend/);
  });
});
