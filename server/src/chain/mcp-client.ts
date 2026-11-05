/**
 * An agent's side of the metered MCP server: an MCP client that pays each tool call from the agent's own Hedera
 * account, never more than maxPerCall tinybars a call, with no one approving. Used by scripts/mcp-buyer.ts and tests.
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { parseHederaKey } from "./hedera.js";
import { hashscanTx } from "./x402.js";

type Network = "hedera:testnet" | "hedera:mainnet";
const HBAR = "0.0.0";

export interface PaidCall<T> {
  result: T;
  isError: boolean;
  payment: { transaction: string; url: string; payer: string | null } | null;
}

export async function connectPaidMcp(o: { url: string; network: Network; accountId: string; key: string; maxPerCall: bigint; fetch?: typeof fetch }) {
  const signer = createClientHederaSigner(o.accountId, parseHederaKey(o.key), { network: o.network });
  const client = createx402MCPClient({
    name: "ordo-mcp-buyer",
    version: "1.0.0",
    schemes: [{ network: o.network, client: new ExactHederaScheme(signer) }],
    spendControls: { allowedAssets: [{ network: o.network, asset: HBAR, maxAmountPerPayment: o.maxPerCall.toString() }] },
    autoPayment: true,
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(o.url), o.fetch ? { fetch: o.fetch } : undefined));

  return {
    tools: async () => (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
    async call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<PaidCall<T>> {
      const r = await client.callTool(name, args);
      const text = r.content.find((c) => c.type === "text") as { text?: string } | undefined;
      let result: T;
      try {
        result = JSON.parse(text?.text ?? "null") as T;
      } catch {
        result = (text?.text ?? null) as T;
      }
      const s = r.paymentResponse as { transaction?: string; payer?: string } | undefined;
      return { result, isError: Boolean(r.isError), payment: r.paymentMade && s?.transaction ? { transaction: s.transaction, url: hashscanTx(o.network, s.transaction), payer: s.payer ?? null } : null };
    },
    close: () => client.close(),
  };
}
