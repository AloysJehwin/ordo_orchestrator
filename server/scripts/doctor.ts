/**
 * Env doctor: validates configuration and checks every configured rail against the real service.
 *   pnpm env:doctor                       (reads server/.env)
 *   vercel env pull .env.preview && node --env-file=.env.preview --import tsx scripts/doctor.ts
 * Exit code 1 if any configured rail fails, so it can gate a deploy.
 */
import { readFileSync } from "node:fs";
import { ZodError } from "zod";
import { loadConfig, type Config } from "../src/config.js";
import { migrate, openDb } from "../src/db/db.js";
import { loadPolicy } from "../src/domain/policy.js";
import { checkRouter, routerFromConfig } from "../src/chain/zg-router.js";

type Result = { rail: string; status: "pass" | "warn" | "fail" | "off"; detail: string };
const results: Result[] = [];
const check = async (rail: string, enabled: boolean, f: () => Promise<string>, offDetail = "not configured (local stand-in)") => {
  if (!enabled) return void results.push({ rail, status: "off", detail: offDetail });
  try {
    results.push({ rail, status: "pass", detail: await f() });
  } catch (e) {
    results.push({ rail, status: "fail", detail: e instanceof Error ? e.message : String(e) });
  }
};
const warn = (rail: string, detail: string) => results.push({ rail, status: "warn", detail });

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e) {
  console.error("✘ configuration is invalid:");
  if (e instanceof ZodError) for (const i of e.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}
const json = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${url.split("?")[0]} → HTTP ${r.status}`);
  return r.json() as Promise<any>;
};
const rpc = (url: string, method: string, params: unknown[] = []) => json(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.result);

// ---- Core ----
const policy = loadPolicy(readFileSync(cfg.POLICY_FILE, "utf8"));
results.push({ rail: "policy", status: "pass", detail: `${policy.policy.id} v${policy.policy.version} ${policy.hash.slice(0, 19)}…` });
await check("database", true, async () => {
  const db = await openDb({ url: cfg.DATABASE_URL, dataDir: cfg.DATA_DIR });
  await migrate(db);
  const r = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM ledger");
  await db.close();
  return `${db.kind} reachable, schema ok, ${r.rows[0]?.n ?? 0} ledger entries`;
});
if (cfg.VERCEL && !cfg.DATABASE_URL) warn("database", "DATABASE_URL is required on Vercel");
if (!cfg.LEDGER_SIGNING_KEY && cfg.ANCHOR === "local") warn("ledger key", "LEDGER_SIGNING_KEY not set: anchors are signed with a throwaway key");
if (!cfg.BOOTSTRAP_ADMIN_ADDRESS) warn("accounts", "BOOTSTRAP_ADMIN_ADDRESS not set: any wallet can sign in and create its own site");

// ---- AI ----
await check("ai: gemini", cfg.LLM_PROVIDER === "gemini", async () => {
  if (!cfg.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const m = await json(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_MODEL}?key=${cfg.GEMINI_API_KEY}`);
  return `model ${m.name} available`;
});
await check("ai: openai-compatible", cfg.LLM_PROVIDER === "openai_compat", async () => {
  const r = await json(`${cfg.OPENAI_COMPAT_BASE_URL}/models`, { headers: cfg.OPENAI_COMPAT_API_KEY ? { authorization: `Bearer ${cfg.OPENAI_COMPAT_API_KEY}` } : {} });
  return `${(r.data ?? []).length} models listed`;
});
await check("ai: 0g compute", cfg.LLM_PROVIDER === "0g", async () => `RPC chain ${parseInt(await rpc(cfg.ZG_RPC_URL, "eth_chainId"), 16)}`);

// ---- Hedera ----
const mirror = (cfg.HEDERA_MIRROR_URL ?? `https://${cfg.HEDERA_NETWORK}.mirrornode.hedera.com`).replace(/\/$/, "");
const hbarOf = (a: any) => Number(a.balance?.balance ?? 0) / 1e8;
await check("hedera: operator", cfg.ANCHOR === "hedera", async () => {
  const a = await json(`${mirror}/api/v1/accounts/${cfg.HEDERA_OPERATOR_ID}`);
  if (hbarOf(a) < 5) throw new Error(`operator balance ${hbarOf(a)} HBAR (top up from the faucet)`);
  return `${cfg.HEDERA_OPERATOR_ID} · ${hbarOf(a).toFixed(1)} HBAR`;
});
await check("hedera: ledger topic", cfg.ANCHOR === "hedera", async () => {
  const t = await json(`${mirror}/api/v1/topics/${cfg.HEDERA_TOPIC_ID}`);
  return `${cfg.HEDERA_TOPIC_ID} · memo "${t.memo}"`;
});
await check("hedera: agent account", Boolean(cfg.HEDERA_AGENT_ID), async () => {
  if (!cfg.HEDERA_AGENT_KEY) throw new Error("HEDERA_AGENT_KEY missing");
  const a = await json(`${mirror}/api/v1/accounts/${cfg.HEDERA_AGENT_ID}`);
  if (hbarOf(a) < 1) throw new Error(`agent balance ${hbarOf(a)} HBAR: it pays gas for escrows`);
  return `${cfg.HEDERA_AGENT_ID} · ${a.evm_address} · ${hbarOf(a).toFixed(1)} HBAR`;
});

// ---- Contracts (OrdoTrust, OrdoWorkOrders, OrdoPolicies on the trust chain) ----
for (const [name, address] of [
  ["OrdoTrust", cfg.TRUST_CONTRACT_ADDRESS],
  ["OrdoWorkOrders", cfg.TRUST_WORKORDERS_ADDRESS],
  ["OrdoPolicies", cfg.TRUST_POLICIES_ADDRESS],
] as const)
  await check(`chain: ${name}`, Boolean(address && cfg.TRUST_RPC_URL), async () => {
    const id = parseInt(await rpc(cfg.TRUST_RPC_URL!, "eth_chainId"), 16);
    if (cfg.TRUST_CHAIN_ID && id !== cfg.TRUST_CHAIN_ID) throw new Error(`RPC is chain ${id}, TRUST_CHAIN_ID is ${cfg.TRUST_CHAIN_ID}`);
    const code = await rpc(cfg.TRUST_RPC_URL!, "eth_getCode", [address, "latest"]);
    if (!code || code === "0x") throw new Error(`no contract at ${address}`);
    return `${address} · chain ${id}`;
  });
await check("chain: relayer", Boolean(cfg.TRUST_RELAYER_KEY && cfg.TRUST_RPC_URL), async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const address = privateKeyToAccount(cfg.TRUST_RELAYER_KEY as `0x${string}`).address;
  const balance = Number(BigInt(await rpc(cfg.TRUST_RPC_URL!, "eth_getBalance", [address, "latest"]))) / 1e18;
  if (balance < 1) throw new Error(`relayer ${address} has ${balance.toFixed(3)} ${cfg.TRUST_SYMBOL}: it pays gas for every relay`);
  return `${address} · ${balance.toFixed(2)} ${cfg.TRUST_SYMBOL}`;
});
if (cfg.TRUST_CONTRACT_ADDRESS && !cfg.TRUST_RELAYER_KEY) warn("chain: relayer", "TRUST_RELAYER_KEY not set: the contracts are configured but nothing can relay to them");
// testers, cases and rewards need the v3 OrdoTrust: on an older one selections stay in Ordo's ledger and cases are refused
if (cfg.TRUST_CONTRACT_ADDRESS && cfg.TRUST_RPC_URL) {
  const { toFunctionSelector } = await import("viem");
  const code = await rpc(cfg.TRUST_RPC_URL, "eth_getCode", [cfg.TRUST_CONTRACT_ADDRESS, "latest"]).catch(() => "");
  if (code && code !== "0x" && !code.includes(toFunctionSelector("isActiveTester(string,address)").slice(2)))
    warn("chain: OrdoTrust v3", "the deployed OrdoTrust predates testers, cases and rewards: selections stay in Ordo's ledger, cases are refused and nothing is paid until the v3 contracts are deployed (contracts/README.md#redeploying)");
}

// ---- ENS ----
await check("ens", cfg.IDENTITY === "ens", async () => {
  const { EnsNames } = await import("../src/chain/ens.js");
  const names = await new EnsNames(cfg.ENS_RPC_URL).lookup(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]);
  const found = Object.values(names).filter(Boolean);
  if (!found.length) throw new Error("reverse resolution returned nothing (check ENS_RPC_URL)");
  return `reverse resolution works (${found.join(", ")})`;
});

// ---- 0G storage ----
await check("evidence: 0g storage", cfg.EVIDENCE_STORE === "0g", async () => {
  if (!cfg.ZG_PRIVATE_KEY) throw new Error("ZG_PRIVATE_KEY missing");
  await fetch(cfg.ZG_INDEXER_URL, { signal: AbortSignal.timeout(10_000) });
  return `indexer ${cfg.ZG_INDEXER_URL} reachable`;
});

// ---- 0G Private Computer (proof of work) ----
await check(
  "0g private computer",
  Boolean(cfg.ZG_ROUTER_MGMT_KEY),
  async () => {
    const r = await checkRouter(routerFromConfig(cfg));
    if (!r.ok) throw new Error(r.detail);
    return r.detail;
  },
  "no ZG_ROUTER_MGMT_KEY: proof-of-work sessions use the terminal agent's scripted interviewer",
);

const icon = { pass: "✔", warn: "!", fail: "✘", off: "·" } as const;
const w = Math.max(...results.map((r) => r.rail.length));
console.log(`\nOrdo env doctor · ${cfg.VERCEL_ENV ?? "local"}\n`);
for (const r of results) console.log(`${icon[r.status]} ${r.rail.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => r.status === "fail").length;
console.log(`\n${failed ? `${failed} check(s) failed` : "all configured rails are healthy"}`);
process.exit(failed ? 1 : 0);
