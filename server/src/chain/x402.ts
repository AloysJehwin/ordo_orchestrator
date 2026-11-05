/**
 * x402 pay-per-call on Hedera. Ordo sells a vibration assessment per request at POST /v1/x402/vibration-assessment,
 * and the maintenance agent buys one with its own Hedera account before a vendor is sent out. The payment is an
 * HBAR transfer the agent signs and an x402 facilitator co-signs as fee payer and submits; nobody holds the agent's key
 * but the agent.
 */
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter, type HTTPRequestContext } from "@x402/core/server";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme as ClientScheme } from "@x402/hedera/exact/client";
import { ExactHederaScheme as ServerScheme } from "@x402/hedera/exact/server";
import type { Context, Next } from "hono";
import { parseHederaKey } from "./hedera.js";

export const ASSESSMENT_PATH = "/v1/x402/vibration-assessment";
/** A vendor's urgent call-out, sold per reservation: the deposit goes straight to the vendor's Hedera account */
export const CALLOUT_PATH = "/v1/x402/vendors/:vendorId/callout";
export const calloutVendor = (path: string) => /^\/v1\/x402\/vendors\/([\w-]+)\/callout$/.exec(path)?.[1] ?? null;
const HBAR = "0.0.0";

type Network = "hedera:testnet" | "hedera:mainnet";
export const x402Network = (hederaNetwork: string): Network | null => (hederaNetwork === "testnet" ? "hedera:testnet" : hederaNetwork === "mainnet" ? "hedera:mainnet" : null);
export const hashscanTx = (network: Network, id: string) => `https://hashscan.io/${network.split(":")[1]}/transaction/${id.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;

// ---------------------------------------------------------------- what is sold

/** ISO 10816-3 velocity thresholds (mm/s RMS) between zones A|B, B|C and C|D, by machine group. */
const ZONES = { medium: [1.4, 2.8, 4.5], large: [2.3, 4.5, 7.1] } as const;
export type MachineClass = keyof typeof ZONES;
export interface AssessmentInput {
  machineClass: MachineClass;
  /** Vibration velocity readings in mm/s RMS, oldest first; t in ms since the epoch. */
  samples: { t: number; v: number }[];
}
export interface Assessment {
  standard: string;
  zone: "A" | "B" | "C" | "D";
  verdict: string;
  level: number;
  peak: number;
  slopePerHour: number;
  hoursToZoneD: number | null;
  samples: number;
}

const VERDICT = {
  A: "Newly commissioned condition",
  B: "Acceptable for unrestricted long-term operation",
  C: "Unsatisfactory for long-term operation: plan maintenance",
  D: "Severe enough to damage the machine: stop and repair",
};

/** The assessment itself: zone from the recent level, trend by least squares, time until zone D at that trend. */
export function assessVibration(i: AssessmentInput): Assessment {
  const s = i.samples.filter((x) => Number.isFinite(x.v) && Number.isFinite(x.t));
  if (s.length < 3) throw new Error("At least three readings are needed");
  const [ab, bc, cd] = ZONES[i.machineClass];
  const recent = s.slice(-Math.max(3, Math.ceil(s.length / 5)));
  const t0 = s[0]!.t;
  const level = recent.reduce((a, x) => a + x.v, 0) / recent.length;
  const zone = level < ab ? "A" : level < bc ? "B" : level < cd ? "C" : "D";
  const h = s.map((x) => (x.t - t0) / 3_600_000);
  const mh = h.reduce((a, x) => a + x, 0) / h.length;
  const mv = s.reduce((a, x) => a + x.v, 0) / s.length;
  const den = h.reduce((a, x) => a + (x - mh) ** 2, 0);
  const slope = den ? h.reduce((a, x, k) => a + (x - mh) * (s[k]!.v - mv), 0) / den : 0;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    standard: `ISO 10816-3, ${i.machineClass === "large" ? "group 1 (large machines)" : "group 2 (medium machines)"}, rigid foundation`,
    zone,
    verdict: VERDICT[zone],
    level: round(level),
    peak: round(Math.max(...s.map((x) => x.v))),
    slopePerHour: round(slope),
    hoursToZoneD: zone === "D" ? 0 : slope > 0 ? round((cd - level) / slope) : null,
    samples: s.length,
  };
}

// ---------------------------------------------------------------- the seller

export interface SellerConfig {
  network: Network;
  /** Hedera account the fee is paid to */
  payTo: string;
  /** Price per assessment in tinybars */
  price: bigint;
  facilitatorUrl: string;
  /** Tests pass an in-process facilitator */
  facilitator?: FacilitatorClient;
  /** Vendors' call-outs: each vendor is paid at its own account, at its own deposit */
  vendors?: { payTo: (vendorId: string) => Promise<string | null>; deposit: (vendorId: string) => Promise<bigint> };
}

class HonoAdapter implements HTTPAdapter {
  constructor(private c: Context) {}
  getHeader(name: string) {
    return this.c.req.header(name);
  }
  getMethod() {
    return this.c.req.method;
  }
  getPath() {
    return this.c.req.path;
  }
  getUrl() {
    return this.c.req.url;
  }
  getAcceptHeader() {
    return this.c.req.header("accept") ?? "";
  }
  getUserAgent() {
    return this.c.req.header("user-agent") ?? "";
  }
  getQueryParams() {
    return Object.fromEntries(Object.entries(this.c.req.queries()).map(([k, v]) => [k, v.length === 1 ? v[0]! : v])) as Record<string, string | string[]>;
  }
  getQueryParam(name: string) {
    const v = this.c.req.queries(name);
    return !v?.length ? undefined : v.length === 1 ? v[0] : v;
  }
  async getBody() {
    return this.c.req.json().catch(() => undefined);
  }
}

/**
 * Hono middleware that charges for the assessment route: answers 402 with the payment terms, verifies the signed
 * transfer with the facilitator, runs the handler, then settles; a failed handler is never charged.
 */
export function x402Seller(cfg: SellerConfig) {
  const server = new x402ResourceServer(cfg.facilitator ?? new HTTPFacilitatorClient({ url: cfg.facilitatorUrl })).register(cfg.network, new ServerScheme());
  const http = new x402HTTPResourceServer(server, {
    [`POST ${ASSESSMENT_PATH}`]: {
      accepts: { scheme: "exact", network: cfg.network, payTo: cfg.payTo, price: { amount: cfg.price.toString(), asset: HBAR }, maxTimeoutSeconds: 120 },
      description: "Vibration assessment against ISO 10816-3: zone, trend and time to zone D",
      mimeType: "application/json",
      serviceName: "Ordo condition monitoring",
    },
    ...(cfg.vendors
      ? {
          [`POST ${CALLOUT_PATH}`]: {
            accepts: {
              scheme: "exact",
              network: cfg.network,
              payTo: async (ctx: HTTPRequestContext) => {
                const account = await cfg.vendors!.payTo(calloutVendor(ctx.path) ?? "");
                if (!account) throw new Error("This vendor has no Hedera account");
                return account;
              },
              price: async (ctx: HTTPRequestContext) => ({ amount: (await cfg.vendors!.deposit(calloutVendor(ctx.path) ?? "")).toString(), asset: HBAR }),
              maxTimeoutSeconds: 120,
            },
            description: "Reserve an urgent maintenance call-out; the deposit is paid to the vendor",
            mimeType: "application/json",
            serviceName: "Ordo vendor call-outs",
          },
        }
      : {}),
  });
  let ready: Promise<void> | null = null;

  const middleware = async (c: Context, next: Next) => {
    const adapter = new HonoAdapter(c);
    const ctx: HTTPRequestContext = { adapter, path: c.req.path, method: c.req.method, paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment") };
    if (!http.requiresPayment(ctx)) return next();
    try {
      await (ready ??= http.initialize());
    } catch (e) {
      ready = null;
      return c.json({ error: `x402 facilitator unavailable: ${e instanceof Error ? e.message : e}` }, 502);
    }
    const r = await http.processHTTPRequest(ctx);
    if (r.type === "no-payment-required") return next();
    if (r.type === "payment-error") {
      for (const [k, v] of Object.entries(r.response.headers)) c.header(k, v);
      return c.json((r.response.body ?? {}) as object, r.response.status as 402);
    }
    await next();
    const res = c.res;
    if (res.status >= 400) {
      await r.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: res.status });
      return;
    }
    const body = new Uint8Array(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const settled = await http.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, { request: ctx, responseBody: Buffer.from(body), responseHeaders: headers }, undefined, r.beforeHandlerSettlement);
    if (!settled.success) {
      c.res = new Response(JSON.stringify(settled.response.body ?? {}), { status: settled.response.status, headers: settled.response.headers });
      return;
    }
    const out = new Response(body, { status: res.status, headers: res.headers });
    for (const [k, v] of Object.entries(settled.headers)) out.headers.set(k, v);
    out.headers.set("cache-control", "private, no-store");
    c.res = undefined;
    c.res = out;
  };
  return { middleware, terms: { network: cfg.network, payTo: cfg.payTo, price: cfg.price.toString(), asset: HBAR } };
}

// ---------------------------------------------------------------- the buyer

export interface Purchase<T> {
  body: T;
  payment: { transaction: string; url: string; payer: string | null; network: string } | null;
}

/** The agent's x402 client: pays in HBAR from its own account, never more than maxPerCall tinybars a call. */
export class X402Buyer {
  readonly kind = "x402";
  private pay: typeof fetch;
  constructor(
    private o: { network: Network; agentId: string; agentKey: string; maxPerCall: bigint },
    fetchImpl: typeof fetch = fetch,
  ) {
    const signer = createClientHederaSigner(o.agentId, parseHederaKey(o.agentKey), { network: o.network });
    const client = x402Client.fromConfig({
      schemes: [{ network: o.network, client: new ClientScheme(signer) }],
      spendControls: { allowedAssets: [{ network: o.network, asset: HBAR, maxAmountPerPayment: o.maxPerCall.toString() }] },
    });
    this.pay = wrapFetchWithPayment(fetchImpl, client) as typeof fetch;
  }

  async post<T>(url: string, body: unknown): Promise<Purchase<T>> {
    const res = await this.pay(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${text.slice(0, 200)}`);
    const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    let payment: Purchase<T>["payment"] = null;
    if (header) {
      const s = decodePaymentResponseHeader(header) as { transaction?: string; transactionId?: string; payer?: string; network?: string };
      const tx = s.transaction ?? s.transactionId ?? "";
      payment = { transaction: tx, url: hashscanTx(this.o.network, tx), payer: s.payer ?? null, network: s.network ?? this.o.network };
    }
    return { body: JSON.parse(text) as T, payment };
  }
}
