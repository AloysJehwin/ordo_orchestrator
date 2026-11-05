import { PrivateKey } from "@hiero-ledger/sdk";
import type { FacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fakeFacilitator, FEE_PAYER } from "../fixtures/x402.js";
import { ASSESSMENT_PATH, assessVibration, X402Buyer, x402Seller } from "../../src/chain/x402.js";

const PAY_TO = "0.0.7001";
const AGENT = "0.0.5005";
const t = (h: number) => Date.parse("2026-11-05T08:00:00Z") + h * 3_600_000;
const facilitator = () => fakeFacilitator(AGENT);

function service(f: FacilitatorClient) {
  const app = new Hono();
  const seller = x402Seller({ network: "hedera:testnet", payTo: PAY_TO, price: 10_000_000n, facilitatorUrl: "unused", facilitator: f });
  app.use(ASSESSMENT_PATH, seller.middleware);
  app.post(ASSESSMENT_PATH, async (c) => {
    const b = await c.req.json();
    if (!Array.isArray(b.samples)) return c.json({ error: "samples missing" }, 400);
    return c.json(assessVibration(b));
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  return { app, fetchImpl };
}

describe("x402 vibration assessment", () => {
  it("grades the level against ISO 10816-3 and projects the trend to zone D", () => {
    const a = assessVibration({ machineClass: "medium", samples: [0, 1, 2, 3, 4, 5].map((h) => ({ t: t(h), v: 2.5 + 0.2 * h })) });
    expect(a.zone).toBe("C");
    expect(a.slopePerHour).toBeCloseTo(0.2, 3);
    expect(a.hoursToZoneD).toBeGreaterThan(0);
    expect(assessVibration({ machineClass: "large", samples: [1, 1.1, 1.0].map((v, h) => ({ t: t(h), v })) }).zone).toBe("A");
    expect(() => assessVibration({ machineClass: "medium", samples: [{ t: 0, v: 1 }] })).toThrow(/three/);
  });

  it("answers 402 with the terms, and serves the assessment once the agent pays in HBAR", async () => {
    const { f, settled } = facilitator();
    const { app, fetchImpl } = service(f);
    const unpaid = await app.request(ASSESSMENT_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unpaid.status).toBe(402);
    const terms = JSON.parse(Buffer.from(unpaid.headers.get("payment-required")!, "base64").toString());
    expect(terms.accepts[0]).toMatchObject({ scheme: "exact", network: "hedera:testnet", payTo: PAY_TO, amount: "10000000", asset: "0.0.0", extra: { feePayer: FEE_PAYER } });

    const buyer = new X402Buyer({ network: "hedera:testnet", agentId: AGENT, agentKey: PrivateKey.generateECDSA().toStringRaw(), maxPerCall: 50_000_000n }, fetchImpl);
    const r = await buyer.post<{ zone: string }>(`http://ordo.test${ASSESSMENT_PATH}`, { machineClass: "medium", samples: [0, 1, 2, 3].map((h) => ({ t: t(h), v: 4 + h })) });
    expect(r.body.zone).toBe("D");
    expect(settled).toHaveLength(1);
    expect(r.payment).toMatchObject({ transaction: settled[0], payer: AGENT, network: "hedera:testnet" });
    expect(r.payment!.url).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\/0\.0\.9001-\d+-\d+$/);
  });

  it("does not charge for a failed request, and the agent refuses a price above its cap", async () => {
    const { f, settled } = facilitator();
    const { fetchImpl } = service(f);
    const key = PrivateKey.generateECDSA().toStringRaw();
    const buyer = new X402Buyer({ network: "hedera:testnet", agentId: AGENT, agentKey: key, maxPerCall: 50_000_000n }, fetchImpl);
    await expect(buyer.post(`http://ordo.test${ASSESSMENT_PATH}`, { machineClass: "medium" })).rejects.toThrow(/400/);
    expect(settled).toHaveLength(0);
    const frugal = new X402Buyer({ network: "hedera:testnet", agentId: AGENT, agentKey: key, maxPerCall: 1_000_000n }, fetchImpl);
    await expect(frugal.post(`http://ordo.test${ASSESSMENT_PATH}`, { machineClass: "medium", samples: [] })).rejects.toThrow(/exceeds|max|cap|spend/i);
    expect(settled).toHaveLength(0);
  });
});
