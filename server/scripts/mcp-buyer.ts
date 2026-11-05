/**
 * An outside agent buying from Ordo's metered MCP server on Hedera testnet, with no one approving its payments:
 *   ORDO_URL=https://<deployment> BUYER_ID=0.0.x BUYER_KEY=<ecdsa hex> node --import tsx scripts/mcp-buyer.ts
 * Without BUYER_ID/BUYER_KEY, an operator (HEDERA_OPERATOR_ID/KEY) opens a fresh buyer account with BUYER_HBAR (default 1).
 * ORDO_LOT adds a verify_lot call for that lot. Prints each settled payment's transaction and HashScan link (and writes
 * them to the GitHub step summary when there is one). The buyer's key is never printed.
 */
import { appendFileSync } from "node:fs";
import { AccountCreateTransaction, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { parseHederaKey } from "../src/chain/hedera.js";
import { connectPaidMcp } from "../src/chain/mcp-client.js";

const base = (process.env.ORDO_URL ?? "").replace(/\/$/, "");
if (!base) throw new Error("Set ORDO_URL to the Ordo deployment");
const network = process.env.HEDERA_NETWORK === "mainnet" ? "hedera:mainnet" : "hedera:testnet";
const maxPerCall = BigInt(process.env.BUYER_MAX_TINYBARS ?? "50000000"); // 0.5 HBAR a call at most

let accountId = process.env.BUYER_ID ?? "";
let key = process.env.BUYER_KEY ?? "";
if (!accountId || !key) {
  const op = process.env.HEDERA_OPERATOR_ID;
  const opKey = process.env.HEDERA_OPERATOR_KEY;
  if (!op || !opKey) throw new Error("Set BUYER_ID and BUYER_KEY, or HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY to open a buyer account");
  const client = Client.forName(network.split(":")[1]!).setOperator(op, parseHederaKey(opKey));
  const k = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction().setECDSAKeyWithAlias(k).setInitialBalance(new Hbar(Number(process.env.BUYER_HBAR ?? "1"))).setAccountMemo("ordo:mcp-demo-buyer").execute(client);
  accountId = (await tx.getReceipt(client)).accountId!.toString();
  key = k.toStringRaw();
  client.close();
  console.log(`Opened buyer account ${accountId}: https://hashscan.io/${network.split(":")[1]}/account/${accountId}`);
  // the facilitator checks a payment's signature against the payer's key on the mirror node: wait until it has the account
  const mirror = process.env.HEDERA_MIRROR_URL ?? `https://${network.split(":")[1]}.mirrornode.hedera.com`;
  for (let i = 0; ; i++) {
    const r = await fetch(`${mirror}/api/v1/accounts/${accountId}`).catch(() => null);
    if (r?.ok && ((await r.json()) as { key?: unknown }).key) break;
    if (i >= 30) throw new Error(`The mirror node does not know ${accountId} yet`);
    await new Promise((res) => setTimeout(res, 2000));
  }
}

const mcp = await connectPaidMcp({ url: `${base}/v1/x402/mcp`, network, accountId, key, maxPerCall });
console.log("Tools:", (await mcp.tools()).map((t) => t.name).join(", "));
const prices = await mcp.call<{ payTo: string; tools: { name: string; hbar: number }[] }>("price_list");
console.log(`Paying ${prices.result.payTo}:`, prices.result.tools.map((t) => `${t.name} ${t.hbar} HBAR`).join(" · "));

// a pump bearing drifting over two hours: vibration in mm/s RMS and temperature in °C, every 10 minutes
const t0 = Date.now() - 2 * 3_600_000;
const vib = Array.from({ length: 13 }, (_, i) => ({ t: t0 + i * 600_000, v: Math.round((2.1 + i * 0.22 + (i % 3) * 0.05) * 100) / 100 }));
const temp = Array.from({ length: 13 }, (_, i) => ({ t: t0 + i * 600_000, v: 61 + i * 1.4 }));
const calls: [string, Record<string, unknown>][] = [
  ["assess_vibration", { machineClass: "medium", samples: vib }],
  ["forecast_failure", { signal: "bearing_temp", failureLimit: 95, samples: temp }],
];
if (process.env.ORDO_LOT) calls.push(["verify_lot", { lot: process.env.ORDO_LOT }]);

const rows: string[] = [];
for (const [tool, args] of calls) {
  const r = await mcp.call<Record<string, unknown>>(tool, args);
  const answer = r.isError ? `error: ${JSON.stringify(r.result)}` : JSON.stringify(r.result).slice(0, 200);
  console.log(`\n${tool}: ${answer}`);
  if (r.payment) {
    console.log(`  paid: ${r.payment.transaction}  ${r.payment.url}`);
    rows.push(`| \`${tool}\` | ${accountId} | [${r.payment.transaction}](${r.payment.url}) |`);
  } else console.log("  not charged");
}
await mcp.close();

if (process.env.GITHUB_STEP_SUMMARY && rows.length) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Paid MCP calls on ${network}\n\n| Tool | Payer | Settled transaction |\n|---|---|---|\n${rows.join("\n")}\n`);
}
process.exit(rows.length ? 0 : 1);
