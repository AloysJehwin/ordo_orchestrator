import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  POLICY_FILE: z.string().default("../policies/default.yaml"),
  WEB_DIST: z.string().default("../web/dist"),
  CORS_ORIGINS: z.string().default(""),
  /** Run a background timer that advances ingestion and runs. Off on serverless (requests drive it). */
  ENGINE_TIMER: z.enum(["auto", "on", "off"]).default("auto"),
  /** required: a run starts only when every stage has a machine to run on. optional: a stage with none waits for a person to record it (the earlier manual mode). */
  STAGE_MACHINES: z.enum(["required", "optional"]).default("required"),
  /** where machine bodies run: local (a process per machine on this host), sandbox (a Vercel Sandbox microVM per machine), off */
  BODY_RUNTIME: z.enum(["local", "sandbox", "off"]).default("off"),
  /** Vercel Sandbox: a token with access to the team, and the project the sandboxes belong to */
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_SANDBOX_PROJECT: z.string().optional(),
  TICK_MS: z.coerce.number().int().min(1000).default(5000),
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.string().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  /** Vercel sets this to the production domain; public links (lot passports, QR codes) use it when PUBLIC_URL is unset */
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
  /** On a Vercel preview, links point at the preview itself: its branch URL, else its deployment URL */
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),
  /** Render sets this to the service's public URL */
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  /** Render sets this to the deployed commit (shown on Settings and /health) */
  RENDER_GIT_COMMIT: z.string().optional(),
  /** Base URL people and wallets reach this deployment at, e.g. https://aiwarriors.vercel.app */
  PUBLIC_URL: z.string().url().optional(),

  // ---- Accounts ----
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(72),
  /** When set, only this wallet may create sites. Otherwise any signed-in wallet can create its own site. */
  BOOTSTRAP_ADMIN_ADDRESS: z.string().optional(),
  /** RPC used to verify smart-contract wallets (ERC-1271 / ERC-6492). Optional. */
  AUTH_RPC_URL: z.string().optional(),
  /** Chain id put in EIP-712 signatures when the client does not send its own. */
  SIGNATURE_CHAIN_ID: z.coerce.number().int().default(296),

  // ---- On-chain trust (OrdoTrust: role credentials, validator stakes, releases, slashing) ----
  /** JSON-RPC of the chain OrdoTrust is deployed on, e.g. https://testnet.hashio.io/api for Hedera testnet */
  TRUST_RPC_URL: z.string().optional(),
  TRUST_CHAIN_ID: z.coerce.number().int().optional(),
  TRUST_CHAIN_NAME: z.string().default("Hedera Testnet"),
  TRUST_EXPLORER_URL: z.string().optional(),
  TRUST_CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Pays gas to relay signed grants, releases, selections, cases and claims. Holds no authority: the contract checks the signers. */
  TRUST_RELAYER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  TRUST_SYMBOL: z.string().default("HBAR"),
  /** decimals of native value inside the contract: 8 on Hedera (tinybars), 18 on other EVM chains */
  TRUST_DECIMALS: z.coerce.number().int().min(0).max(18).default(8),
  /** OrdoWorkOrders: the maintenance agent escrows vendor payments within caps an admin signed */
  TRUST_WORKORDERS_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** OrdoPolicies: a manager publishes each line's autonomy policy */
  TRUST_POLICIES_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),

  // ---- Agents ----
  /** Unset: Claude when ANTHROPIC_API_KEY is set, else the deterministic offline reasoning */
  LLM_PROVIDER: z.enum(["offline", "gemini", "openai_compat", "0g", "claude"]).optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(15000),
  /** Claude (LLM_PROVIDER=claude): Anthropic's API, Claude Opus 5.5 unless CLAUDE_MODEL names another */
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  /** Or, with no API key: Workload Identity Federation from the Claude Console. On Vercel the identity token is the
   *  deployment's OIDC token; elsewhere ANTHROPIC_IDENTITY_TOKEN_FILE (or ANTHROPIC_IDENTITY_TOKEN) supplies it. */
  ANTHROPIC_FEDERATION_RULE_ID: z.string().regex(/^fdrl_\w+$/).optional(),
  ANTHROPIC_ORGANIZATION_ID: z.string().uuid().optional(),
  ANTHROPIC_SERVICE_ACCOUNT_ID: z.string().regex(/^svac_\w+$/).optional(),
  ANTHROPIC_WORKSPACE_ID: z.string().regex(/^wrkspc_\w+$/).optional(),
  ANTHROPIC_IDENTITY_TOKEN_FILE: z.string().optional(),
  ANTHROPIC_IDENTITY_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  OPENAI_COMPAT_BASE_URL: z.string().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  OPENAI_COMPAT_MODEL: z.string().optional(),

  // ---- Proof ----
  ANCHOR: z.enum(["local", "hedera"]).default("local"),
  LEDGER_SIGNING_KEY: z.string().optional(),
  /** Anchor the ledger head after this many new entries (and at least every 30 minutes when there are any). */
  ANCHOR_EVERY: z.coerce.number().int().min(1).default(50),
  IDENTITY: z.enum(["plain", "ens"]).default("plain"),
  EVIDENCE_STORE: z.enum(["local", "0g"]).default("local"),
  DEMO_TAMPER: bool,

  HEDERA_NETWORK: z.enum(["testnet", "mainnet", "previewnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_TOPIC_ID: z.string().optional(),
  /** The maintenance agent's own account: it signs the escrow for a work order (with HEDERA_AGENT_ID, through Hedera Agent Kit) */
  HEDERA_AGENT_ID: z.string().optional(),
  HEDERA_AGENT_KEY: z.string().optional(),
  HEDERA_MIRROR_URL: z.string().optional(),
  /** HTS NFT collection for lot passports (the operator is treasury, supply and metadata key) */
  HEDERA_PASSPORT_TOKEN_ID: z.string().optional(),
  /** Work-order refunds, validator payouts and stage timeouts run on Hedera's Schedule Service when the operator is set */
  HEDERA_SCHEDULES: z.enum(["on", "off"]).default("on"),

  /** x402: Ordo sells vibration assessments per call; fees go to this Hedera account (default: the operator) */
  X402_PAY_TO: z.string().optional(),
  X402_PRICE_TINYBARS: z.coerce.bigint().default(10_000_000n),
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  /** Where the agent buys assessments (default: this deployment's own endpoint) and the most it pays per call */
  X402_ASSESSMENT_URL: z.string().url().optional(),
  X402_MAX_TINYBARS: z.coerce.bigint().default(50_000_000n),

  /** Pay on proof: Ordo USD, a Stablecoin Studio stablecoin (its proxy and its HTS token's EVM address), and OrdoPayOnProof,
   *  on the same chain as OrdoTrust (TRUST_RPC_URL, TRUST_RELAYER_KEY: the stablecoin's cash-in role). From Hedera setup. */
  STABLECOIN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  STABLECOIN_TOKEN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  STABLECOIN_SYMBOL: z.string().default("OUSD"),
  STABLECOIN_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  PAY_ON_PROOF_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** HBAR each pay-on-proof party's account is opened with, for its own gas */
  PAY_ON_PROOF_PARTY_TINYBARS: z.coerce.bigint().default(500_000_000n),

  /** Primary-name lookups for signed-in wallets (Ethereum mainnet) when IDENTITY=ens */
  ENS_RPC_URL: z.string().optional(),
  /** ENSv2 names on Sepolia under Ordo's root (ordo.eth): the root's registry and resolver come from setup:ens */
  ENS_PARENT_NAME: z.string().optional(),
  ENS_REGISTRY_ADDRESS: z.string().optional(),
  ENS_RESOLVER_ADDRESS: z.string().optional(),
  ENS_OWNER_KEY: z.string().optional(),
  /** one or more Sepolia RPCs, comma-separated, tried in order */
  ENS_SEPOLIA_RPC_URL: z.string().default("https://gateway.tenderly.co/public/sepolia,https://sepolia.rpc.thirdweb.com,https://0xrpc.io/sep,https://1rpc.io/sepolia"),
  /** Tests point these at a local chain */
  ENS_CHAIN_ID: z.coerce.number().int().optional(),
  ENS_FACTORY_ADDRESS: z.string().optional(),
  ENS_USER_REGISTRY_IMPL: z.string().optional(),
  /** OrdoNames (issues every name in batches, roles from the names people hold) and OrdoRunResolver (releases on run names), from setup:ens-contracts */
  ENS_NAMES_ADDRESS: z.string().optional(),
  ENS_RUN_RESOLVER_ADDRESS: z.string().optional(),
  /** sending pauses while Sepolia's base fee is above this (gwei) or once this much ETH went on names today */
  ENS_MAX_FEE_GWEI: z.coerce.number().positive().default(2),
  ENS_DAILY_ETH: z.coerce.number().positive().default(0.02),
  /** estimated gas a batch of names may use (Sepolia caps a transaction at 16.7M) */
  ENS_BATCH_GAS: z.coerce.number().int().min(500_000).max(15_000_000).default(9_000_000),
  /** how long names are registered for, renewed as they near expiry */
  ENS_NAME_YEARS: z.coerce.number().int().min(1).max(5).default(1),
  /** retired: OrdoEnsRoles and OrdoLotResolver under ordo-mfg.eth (their names stay on-chain) */
  ENS_ROLES_ADDRESS: z.string().optional(),
  ENS_LOT_RESOLVER_ADDRESS: z.string().optional(),

  ZG_RPC_URL: z.string().default("https://evmrpc-testnet.0g.ai"),
  ZG_INDEXER_URL: z.string().default("https://indexer-storage-testnet-turbo.0g.ai"),
  ZG_PRIVATE_KEY: z.string().optional(),
  ZG_PROVIDER_ADDRESS: z.string().optional(),
  /** OrdoAgentNFT (ERC-7857) on 0G Galileo, from the 0G setup workflow: each agent of each site is a token */
  ZG_INFT_ADDRESS: z.string().optional(),
  ZG_CHAIN_ID: z.coerce.number().int().default(16602),

  /** 0G Private Computer: the Router that serves the proof-of-work agent's model in TEEs. Mainnet by default (where the
   *  account's credits are); everything else on 0G stays on Galileo testnet. */
  ZG_ROUTER_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  /** A management key (mk-…) from pc.0g.ai with account:read, keys:read, keys:create and keys:manage. Unset: sessions use the CLI's scripted interviewer. */
  ZG_ROUTER_MGMT_KEY: z.string().regex(/^mk-/).optional(),
  /** Which providers may serve: private (TEE isolation, TeeML), verified (verifiable providers) or standard (any; no TEE,
   *  and everything Ordo shows says so). Private unless the Router has no private provider for the model. */
  ZG_ROUTER_TRUST_MODE: z.enum(["private", "verified", "standard"]).default("private"),
  /** The chat model (in private mode, one TeeML providers serve); it must read images (multimedia outcomes) */
  ZG_ROUTER_MODEL: z.string().default("0gm-1.0-35b-a3b"),
  /** Speech to text for voice notes: whisper-large-v3 (its transcription endpoint) or an omni chat model that hears audio,
   *  such as qwen3-omni-flash. Unset: whisper-large-v3 in private mode on mainnet, none otherwise. Empty: none. */
  ZG_ROUTER_AUDIO_MODEL: z.string().optional(),
  /** Most one proof-of-work session may spend, in the account's units (0G wei or micro-USD) */
  ZG_ROUTER_CREDIT_LIMIT: z.string().regex(/^\d+$/).optional(),
  /** The npm package contributors run: npx <package>@latest <token> */
  POW_PACKAGE: z.string().default("ordo-pow"),
  /** How long a proof-of-work session stays open */
  POW_SESSION_MINUTES: z.coerce.number().int().min(10).max(24 * 60).default(120),

  // ---- Org treasuries (OrdoTreasury): run budgets and machine top-ups as Hedera schedules a manager approves ----
  /** OrdoTreasury on the trust chain (Hedera), from `setup:hedera treasury`. Unset: no treasuries, no budgets. */
  TREASURY_CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Added to a run's budget on top of Σ qty × maxPrice of its stages' resources */
  TREASURY_BUDGET_MARGIN_PCT: z.coerce.number().min(0).max(100).default(10),
  /** How long a budget or top-up schedule waits for the manager before it lapses on the ledger (HIP-423) */
  TREASURY_BUDGET_HOURS: z.coerce.number().int().min(1).max(24 * 62).default(24),
  /** HBAR (in tinybars) the operator puts in an org's treasury when a manager opens one in the console */
  TREASURY_SEED_TINYBARS: z.coerce.bigint().default(0n),
  /** The largest over-budget top-up a machine may ask for */
  TREASURY_TOPUP_MAX_TINYBARS: z.coerce.bigint().default(10_000_000_000n),
  // ---- Machine bodies (BODY_RUNTIME above) ----
  /** Where bodies reach Ordo. Unset: this host on PORT for local bodies, the public URL for sandboxes */
  BODY_ORDO_URL: z.string().url().optional(),
  /** The body bundle a local body runs (pnpm --filter @ordo/body build). Unset: body/dist/body.mjs in this checkout */
  BODY_BUNDLE: z.string().optional(),
  /** How long a body's simulated process takes over one stage, in seconds */
  BODY_STAGE_S: z.coerce.number().int().min(10).max(24 * 3600).default(10),
  // seconds between a body's ticks, its agent's decisions while a stage runs (each one a 0G Router call), and its
  // buying-ahead cycles: a demo pace
  BODY_TICK_S: z.coerce.number().int().min(1).max(60).default(3),
  BODY_DECIDE_S: z.coerce.number().int().min(5).max(3600).default(10),
  BODY_BUY_S: z.coerce.number().int().min(5).max(3600).default(5),
});

export type Config = z.infer<typeof Env>;
/** Where the public can reach this deployment, for links that leave the app (NFT metadata, QR codes). */
export const publicBase = (c: Config): string | null => {
  const vercel = c.VERCEL_ENV === "preview" ? (c.VERCEL_BRANCH_URL ?? c.VERCEL_URL) : c.VERCEL_PROJECT_PRODUCTION_URL;
  return (c.PUBLIC_URL ?? c.RENDER_EXTERNAL_URL ?? (vercel ? `https://${vercel}` : null))?.replace(/\/$/, "") ?? null;
};

/** A public URL someone set on purpose (PUBLIC_URL, or Render's), not one a platform derived. */
export const chosenBase = (c: Config): string | null => (c.PUBLIC_URL ?? c.RENDER_EXTERNAL_URL)?.replace(/\/$/, "") ?? null;

export const timerEnabled = (c: Config) => (c.ENGINE_TIMER === "auto" ? !c.VERCEL : c.ENGINE_TIMER === "on");
/** An empty variable (`KEY=` in an env file) counts as unset, except where empty has its own meaning. */
const EMPTY_MEANS_NONE = new Set(["ZG_ROUTER_AUDIO_MODEL"]);
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  Env.parse(Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== "" || EMPTY_MEANS_NONE.has(k))));
