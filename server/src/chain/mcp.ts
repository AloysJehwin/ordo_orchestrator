/**
 * Ordo's metered MCP server: tools other AI agents call over the Model Context Protocol and pay for per call, in HBAR
 * on Hedera, with x402. Stateless (a fresh server per request, JSON responses), so it runs on serverless as is. A
 * paid tool answers its first call with the payment terms; the agent's MCP client signs an HBAR transfer, the call is
 * retried with it in `_meta["x402/payment"]`, the tool runs, and only then is the payment settled: a call that fails
 * is never charged. The settled transaction comes back in `_meta["x402/payment-response"]`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { createPaymentWrapper, type MCPToolCallback } from "@x402/mcp";
import { z } from "zod";
import { forecast } from "../domain/forecast.js";
import { assessVibration } from "./x402.js";

export const MCP_PATH = "/v1/x402/mcp";
const HBAR = "0.0.0";
type Network = "hedera:testnet" | "hedera:mainnet";

/** One paid call, after it settled */
export interface McpSale {
  tool: string;
  amount: string;
  payer: string | null;
  transaction: string;
  network: string;
}

export interface MeteredMcpConfig {
  network: Network;
  /** Hedera account the fees are paid to */
  payTo: string;
  /** Price per paid call in tinybars */
  price: bigint;
  facilitatorUrl: string;
  /** Tests pass an in-process facilitator */
  facilitator?: FacilitatorClient;
  /** A lot's public passport, for verify_lot (null when there is no such lot) */
  passport: (runId: string) => Promise<LotPassport | null>;
  onSale?: (sale: McpSale) => void | Promise<void>;
}

/** The parts of a public passport verify_lot reads */
export interface LotPassport {
  name: string;
  passport: {
    runId: string;
    status: string;
    site: string | null;
    orderRef: string;
    quantity: number;
    product: { name: string; version: number };
    stages: { code: string; name: string; state: string; criteria: { label: string; ok: boolean | null; zk: unknown }[] }[];
    releases: { number: number; type: string; signers: { meaning: string; address: string; ens: string | null }[]; onchain: { txUrl: string | null } | null }[];
    proof: { chainIntact: boolean; anchor: { kind: string; url: string | null; matchesChain: boolean | null } | null };
    nft: { tokenId: string; serial: number | null; url: string | null } | null;
    pageUrl: string;
  };
}

/** What a buyer's agent needs to accept a lot: one verdict, and the evidence behind it. */
export function lotVerdict(p: LotPassport) {
  const v = p.passport;
  const held = v.stages.filter((s) => s.state === "held").map((s) => s.code);
  const failed = v.stages.flatMap((s) => s.criteria.filter((c) => c.ok === false).map((c) => `${s.code}: ${c.label}`));
  const criteria = v.stages.flatMap((s) => s.criteria);
  const finished = v.status === "completed" || v.status === "shipped";
  const verdict =
    v.status === "aborted" ? "rejected: production was aborted"
    : held.length ? "on hold: a stage is held for a deviation"
    : failed.length ? "nonconforming: a criterion failed"
    : !finished ? "in production"
    : !v.releases.length ? "not released: no validation package has released it yet"
    : !v.proof.chainIntact ? "unverified: the ledger does not re-walk"
    : "conforming: released by three signers and the record checks out";
  return {
    lot: p.name,
    runId: v.runId,
    verdict,
    accept: verdict.startsWith("conforming"),
    site: v.site,
    product: `${v.product.name} v${v.product.version}`,
    quantity: v.quantity,
    status: v.status,
    stages: { total: v.stages.length, held, failedCriteria: failed, criteria: criteria.length, zkProven: criteria.filter((c) => c.zk).length },
    releases: v.releases.map((r) => ({ number: r.number, type: r.type, signers: r.signers.map((s) => ({ meaning: s.meaning, signer: s.ens ?? s.address })), onchain: r.onchain?.txUrl ?? null })),
    ledger: { intact: v.proof.chainIntact, anchor: v.proof.anchor ? { kind: v.proof.anchor.kind, url: v.proof.anchor.url, matchesChain: v.proof.anchor.matchesChain } : null },
    nft: v.nft?.url ?? null,
    passport: v.pageUrl,
  };
}

const Samples = z.array(z.object({ t: z.number().describe("ms since the epoch"), v: z.number().min(0).max(1e6) })).min(3).max(5000);

interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run: (args: Record<string, unknown>) => Promise<object> | object;
}

/** The tools Ordo sells. Each throws on input it cannot answer, and a call that throws is not charged. */
function tools(cfg: MeteredMcpConfig): Tool[] {
  return [
    {
      name: "assess_vibration",
      title: "Vibration assessment (ISO 10816-3)",
      description: "Classify a machine's vibration against ISO 10816-3: zone A-D, verdict, trend per hour and hours until zone D. Give velocity readings in mm/s RMS, oldest first.",
      input: { machineClass: z.enum(["medium", "large"]).default("medium").describe("medium: 15-300 kW; large: over 300 kW"), samples: Samples },
      run: (a) => assessVibration(a as never),
    },
    {
      name: "forecast_failure",
      title: "Time-to-failure forecast",
      description: "Project a degrading signal (temperature, vibration, current...) to its failure limit: hours to failure, probability of failure within 24 h, and confidence, from the trend of the latest good readings.",
      input: { signal: z.string().min(1).max(60), failureLimit: z.number().describe("the value at which the machine fails or must stop"), samples: Samples },
      run: (a) => {
        const { signal, failureLimit, samples } = a as { signal: string; failureLimit: number; samples: { t: number; v: number }[] };
        const t0 = samples[0]!.t;
        const f = forecast(samples.map((s) => ({ assetId: "input", signal, value: s.v, unit: "", minute: (s.t - t0) / 60_000, quality: "good" as const })), "input", signal, failureLimit);
        return { signal, failureLimit, hoursToFailure: f.ttfHours, pFailure24h: f.pFailure24h, confidence: f.confidence, model: f.modelId, samples: samples.length };
      },
    },
    {
      name: "verify_lot",
      title: "Verify a production lot",
      description: "Should you accept this lot? Checks an Ordo lot passport (the id in its QR code): stage criteria and their zero-knowledge proofs, held stages, the three-signature validation releases and whether they are on-chain, and the hash-chained ledger and its Hedera anchor. Returns a verdict and the evidence.",
      input: { lot: z.string().regex(/^[\w-]{1,64}$/).describe("the lot's passport id (run id), as in /p/<id>") },
      run: async (a) => {
        const p = await cfg.passport(String(a.lot));
        if (!p) throw new Error("No lot passport with this id");
        return lotVerdict(p);
      },
    },
  ];
}

const json = (o: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }], structuredContent: o as Record<string, unknown> });

/** The MCP endpoint: `handle` answers one streamable-HTTP request (POST JSON-RPC). */
export function meteredMcp(cfg: MeteredMcpConfig) {
  const server = new x402ResourceServer(cfg.facilitator ?? new HTTPFacilitatorClient({ url: cfg.facilitatorUrl })).register(cfg.network, new ExactHederaScheme());
  const list = tools(cfg);
  let paid: Promise<Map<string, (h: (a: Record<string, unknown>) => Promise<ReturnType<typeof json>>) => MCPToolCallback>> | null = null;

  // the facilitator is asked for its fee payer once per instance, and the terms built once
  const wrappers = () =>
    (paid ??= (async () => {
      await server.initialize();
      const accepts = await server.buildPaymentRequirements({ scheme: "exact", network: cfg.network, payTo: cfg.payTo, price: { amount: cfg.price.toString(), asset: HBAR }, maxTimeoutSeconds: 120 });
      return new Map(
        list.map((t) => [
          t.name,
          createPaymentWrapper(server, {
            accepts,
            resource: { url: `mcp://tool/${t.name}`, description: t.description, mimeType: "application/json", serviceName: "Ordo" },
            hooks: {
              onAfterSettlement: async ({ settlement }) => {
                const s = settlement as { transaction?: string; payer?: string; network?: string };
                await cfg.onSale?.({ tool: t.name, amount: cfg.price.toString(), payer: s.payer ?? null, transaction: s.transaction ?? "", network: s.network ?? cfg.network });
              },
            },
          }),
        ]),
      );
    })().catch((e) => {
      paid = null;
      throw e;
    }));

  const priceList = () => ({
    network: cfg.network,
    payTo: cfg.payTo,
    asset: "HBAR",
    unit: "tinybar",
    facilitator: cfg.facilitatorUrl,
    tools: list.map((t) => ({ name: t.name, title: t.title, price: cfg.price.toString(), hbar: Number(cfg.price) / 1e8 })),
  });

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless, POST JSON-RPC to it" }, id: null }, { status: 405, headers: { allow: "POST" } });
    let w: Awaited<ReturnType<typeof wrappers>>;
    try {
      w = await wrappers();
    } catch (e) {
      return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: `x402 facilitator unavailable: ${e instanceof Error ? e.message : e}` }, id: null }, { status: 502 });
    }
    const mcp = new McpServer({ name: "ordo", title: "Ordo manufacturing tools", version: "1.0.0" }, { instructions: "Paid tools charge per call in HBAR on Hedera via x402 (the x402/payment _meta field). Call price_list (free) first." });
    mcp.registerTool("price_list", { title: "Price list", description: "Free. What each tool costs, in tinybars of HBAR, and the Hedera account it is paid to.", inputSchema: {} }, async () => json(priceList()));
    for (const t of list) {
      mcp.registerTool(t.name, { title: t.title, description: `${t.description} Costs ${Number(cfg.price) / 1e8} HBAR per call (x402).`, inputSchema: t.input }, w.get(t.name)!(async (a) => json(await t.run(a))) as never);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void mcp.close();
    }
  }

  return { handle, priceList, terms: { network: cfg.network, payTo: cfg.payTo, price: cfg.price.toString(), asset: HBAR }, tools: ["price_list", ...list.map((t) => t.name)] };
}
