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

// ---- ENS names (ENSv2 on Sepolia under ENS_PARENT_NAME, issued by OrdoNames) ----
const ensSet = Boolean(cfg.ENS_PARENT_NAME && cfg.ENS_REGISTRY_ADDRESS && cfg.ENS_RESOLVER_ADDRESS && cfg.ENS_OWNER_KEY);
await check(
  "ens names",
  ensSet,
  async () => {
    const { EnsV2, ENSV2_SEPOLIA, NAMES_ROOT_ROLES, NAMES_RESOLVER_ROLES } = await import("../src/chain/ensv2.js");
    const ens = new EnsV2({
      rpcUrl: cfg.ENS_SEPOLIA_RPC_URL,
      ownerKey: cfg.ENS_OWNER_KEY!.replace(/^(0x)?/, "0x") as `0x${string}`,
      parentName: cfg.ENS_PARENT_NAME!,
      parentRegistry: cfg.ENS_REGISTRY_ADDRESS as `0x${string}`,
      resolver: cfg.ENS_RESOLVER_ADDRESS as `0x${string}`,
      chainId: cfg.ENS_CHAIN_ID,
      names: cfg.ENS_NAMES_ADDRESS as `0x${string}` | undefined,
      runResolver: cfg.ENS_RUN_RESOLVER_ADDRESS as `0x${string}` | undefined,
    });
    const balance = await ens.balanceEth();
    if (balance < 0.002) throw new Error(`the ENS owner holds ${balance.toFixed(4)} Sepolia ETH: names cannot be sent (top it up)`);
    const [label] = cfg.ENS_PARENT_NAME!.split(".");
    if (cfg.ENS_PARENT_NAME!.split(".").length === 2) {
      const holder = (await ens.ownerOf(ENSV2_SEPOLIA.ethRegistry as `0x${string}`, label!)).toLowerCase();
      if (holder !== ens.owner.toLowerCase()) throw new Error(`${cfg.ENS_PARENT_NAME} is held by ${holder}, not the ENS owner key's account`);
    }
    if (!cfg.ENS_NAMES_ADDRESS) throw new Error("ENS_NAMES_ADDRESS is not set: names are off (pnpm --filter @ordo/contracts setup:ens-contracts)");
    const names = cfg.ENS_NAMES_ADDRESS as `0x${string}`;
    if (!(await ens.hasCode(names))) throw new Error(`no OrdoNames at ${names} on Sepolia`);
    if (!(await ens.hasRootRoles(cfg.ENS_REGISTRY_ADDRESS as `0x${string}`, NAMES_ROOT_ROLES, names))) throw new Error("OrdoNames lacks its roles on the root registry (setup:ens-contracts grants them)");
    if (!(await ens.hasRootRoles(cfg.ENS_RESOLVER_ADDRESS as `0x${string}`, NAMES_RESOLVER_ROLES, names))) throw new Error("OrdoNames lacks its roles on the resolver (setup:ens-contracts grants them)");
    const releases = cfg.ENS_RUN_RESOLVER_ADDRESS && (await ens.hasCode(cfg.ENS_RUN_RESOLVER_ADDRESS as `0x${string}`));
    const fee = await ens.baseFeeGwei();
    if (fee > cfg.ENS_MAX_FEE_GWEI) warn("ens names", `Sepolia's base fee is ${fee.toFixed(2)} gwei, over ENS_MAX_FEE_GWEI (${cfg.ENS_MAX_FEE_GWEI}): sending waits until it drops`);
    if (!releases) warn("ens names", "no OrdoRunResolver (ENS_RUN_RESOLVER_ADDRESS): runs are named, but releases are not recorded on them");
    return `under ${cfg.ENS_PARENT_NAME} · OrdoNames ${names.slice(0, 10)}… holds its roles · owner ${balance.toFixed(4)} ETH · base fee ${fee.toFixed(2)} gwei${releases ? " · releases recorded on run names" : ""}`;
  },
  "ENS_PARENT_NAME, ENS_REGISTRY_ADDRESS, ENS_RESOLVER_ADDRESS and ENS_OWNER_KEY not set: nothing gets an ENS name",
);
for (const k of ["ENS_ROLES_ADDRESS", "ENS_LOT_RESOLVER_ADDRESS"] as const)
  if (process.env[k]) warn("ens names", `${k} is retired (OrdoNames and OrdoRunResolver replace it): remove it`);

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

// ---- Vercel Sandbox (machine bodies, BODY_RUNTIME=sandbox) ----
await check(
  "vercel sandbox",
  cfg.BODY_RUNTIME === "sandbox" || Boolean(cfg.VERCEL_SANDBOX_PROJECT),
  async () => {
    const { listBodySandboxes, sandboxCredentials } = await import("../src/core/bodies-sandbox.js");
    const creds = sandboxCredentials(cfg);
    if ("missing" in creds) throw new Error(`${creds.missing.join(", ")} missing`);
    const auth = { headers: { authorization: `Bearer ${creds.token}` } };
    const team = await json(`https://api.vercel.com/v2/teams/${encodeURIComponent(creds.teamId)}`, auth).catch((e) => {
      throw new Error(`team ${creds.teamId} not reachable with VERCEL_TOKEN (${e.message}); the token must be scoped to the team`);
    });
    const project = await json(`https://api.vercel.com/v9/projects/${encodeURIComponent(creds.projectId)}?teamId=${encodeURIComponent(creds.teamId)}`, auth).catch((e) => {
      throw new Error(`project ${creds.projectId} not found in ${team.slug} (${e.message}); create it, e.g. ordo-machines`);
    });
    const boxes = await listBodySandboxes(creds);
    const running = boxes.filter((b) => b.status === "running");
    return `${team.slug}/${project.name} · ${boxes.length} machine sandbox(es), ${running.length} running${running.length ? `: ${running.map((b) => b.name).join(", ")}` : ""}`;
  },
  "BODY_RUNTIME is not sandbox: machine bodies don't run on Vercel Sandbox",
);
if (cfg.BODY_RUNTIME === "sandbox") {
  const { publicBase } = await import("../src/config.js");
  const base = publicBase(cfg);
  if (!base || /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(base))
    warn("vercel sandbox", "no public address: bodies in a sandbox reach Ordo at PUBLIC_URL (or RENDER_EXTERNAL_URL on Render), not localhost");
}
// ---- Org treasury (OrdoTreasury): run budgets and top-ups as Hedera schedules a manager approves ----
await check(
  "org treasury",
  Boolean(cfg.TREASURY_CONTRACT_ADDRESS),
  async () => {
    if (!cfg.TRUST_RPC_URL || !cfg.TRUST_CONTRACT_ADDRESS || !cfg.TRUST_RELAYER_KEY) throw new Error("OrdoTreasury needs the OrdoTrust settings (TRUST_RPC_URL, TRUST_CONTRACT_ADDRESS, TRUST_RELAYER_KEY)");
    if (!cfg.HEDERA_OPERATOR_ID || !cfg.HEDERA_OPERATOR_KEY) throw new Error("The operator (HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY) creates the budget schedules");
    const { createPublicClient, http } = await import("viem");
    const { ORDO_TREASURY_ABI } = await import("../src/chain/ordo-treasury-abi.js");
    const pub = createPublicClient({ transport: http(cfg.TRUST_RPC_URL) });
    const read = <T>(functionName: string) => pub.readContract({ address: cfg.TREASURY_CONTRACT_ADDRESS as `0x${string}`, abi: ORDO_TREASURY_ABI, functionName } as never) as Promise<T>;
    const trust = await read<string>("trust").catch(() => {
      throw new Error(`no OrdoTreasury at ${cfg.TREASURY_CONTRACT_ADDRESS}`);
    });
    if (trust.toLowerCase() !== cfg.TRUST_CONTRACT_ADDRESS.toLowerCase()) throw new Error(`OrdoTreasury checks admins in OrdoTrust ${trust}, not TRUST_CONTRACT_ADDRESS ${cfg.TRUST_CONTRACT_ADDRESS}: deploy it again (setup:hedera treasury)`);
    // every org's treasury account must be keyed to its own key contract; any other key would be a custodial fallback
    const { keyContractId } = await import("../src/chain/schedule-body.js");
    const db = await openDb({ url: cfg.DATABASE_URL, dataDir: cfg.DATA_DIR });
    const rows = (await db.query<{ site_id: string; account_id: string; key_contract_id: string }>("SELECT site_id, account_id, key_contract_id FROM treasuries").catch(() => ({ rows: [] }))).rows;
    await db.close();
    let total = 0;
    for (const t of rows) {
      const a = await json(`${mirror}/api/v1/accounts/${t.account_id}`);
      const key = a.key?._type === "ProtobufEncoded" ? keyContractId(a.key.key) : null;
      if (key !== t.key_contract_id) warn("org treasury", `custodial fallback: ${t.site_id}'s treasury ${t.account_id} is not keyed to its OrdoTreasuryKey ${t.key_contract_id} (key ${a.key?._type ?? "none"})`);
      total += hbarOf(a);
    }
    if (!cfg.HEDERA_TOPIC_ID) warn("org treasury", "no HEDERA_TOPIC_ID: machines' over-budget reasoning has nowhere to go first, so top-ups are refused");
    return `OrdoTreasury ${cfg.TREASURY_CONTRACT_ADDRESS} · admins from OrdoTrust · each treasury keyed to its org's contract, signed through HIP-755 · ${rows.length} org treasur${rows.length === 1 ? "y" : "ies"}${rows.length ? `, ${total.toFixed(1)} HBAR` : ""}`;
  },
  "no TREASURY_CONTRACT_ADDRESS: machines spend only what their wallets hold, with no run budgets",
);

// ---- Machine bodies (local runtime) ----
await check(
  "machine bodies",
  cfg.BODY_RUNTIME === "local",
  async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const bundle = cfg.BODY_BUNDLE ?? fileURLToPath(new URL("../../body/dist/body.mjs", import.meta.url));
    if (!existsSync(bundle)) throw new Error(`no body at ${bundle}: run pnpm --filter @ordo/body build`);
    return `local runtime, body at ${bundle}${cfg.ZG_ROUTER_MGMT_KEY ? "" : " (no 0G Router: bodies run without an agent)"}`;
  },
  cfg.BODY_RUNTIME === "sandbox" ? "sandbox runtime" : "BODY_RUNTIME=off: virtual machines do not run",
);
// ---- Resource purchasing: bodies buy what their next stages consume over x402, from their machine's own account ----
if (cfg.BODY_RUNTIME === "off") results.push({ rail: "resource purchasing", status: "off", detail: "BODY_RUNTIME=off: no machine bodies buy ahead" });
else if (!["testnet", "mainnet"].includes(cfg.HEDERA_NETWORK) || !(cfg.X402_PAY_TO ?? cfg.HEDERA_OPERATOR_ID))
  warn("resource purchasing", "no x402 storefront (HEDERA_NETWORK testnet or mainnet, and X402_PAY_TO or HEDERA_OPERATOR_ID): bodies do not buy ahead, and stages wait for their resources until a manager waives them");
else if (!cfg.HEDERA_OPERATOR_ID || !cfg.HEDERA_OPERATOR_KEY)
  warn("resource purchasing", "no machine accounts (the operator, HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY, opens them): bodies have nothing to pay with and do not buy ahead");
else
  results.push({
    rail: "resource purchasing",
    status: "pass",
    detail: `bodies buy ahead over x402 (${cfg.X402_FACILITATOR_URL}) from their machine's own account, never more than Ordo quoted; ${cfg.TREASURY_CONTRACT_ADDRESS ? "over budget, they ask the org treasury for a top-up" : "no treasury: they buy only what their accounts hold"}`,
  });

const icon = { pass: "✔", warn: "!", fail: "✘", off: "·" } as const;
const w = Math.max(...results.map((r) => r.rail.length));
console.log(`\nOrdo env doctor · ${cfg.VERCEL_ENV ?? "local"}\n`);
for (const r of results) console.log(`${icon[r.status]} ${r.rail.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => r.status === "fail").length;
console.log(`\n${failed ? `${failed} check(s) failed` : "all configured rails are healthy"}`);
process.exit(failed ? 1 : 0);
