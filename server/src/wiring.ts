import { readFileSync } from "node:fs";
import type { BodyRunner, BodyRuntime } from "./core/bodies.js";
import { Bodies } from "./core/body-service.js";
import { Fleet } from "./core/fleet.js";
import { resolve } from "node:path";
import { publicBase, type Config } from "./config.js";
import { geminiProvider, OfflineLlm, openAiCompatProvider, type LlmProvider } from "./adapters/llm.js";
import { LocalSignedAnchor, type AnchorAdapter } from "./adapters/rails.js";
import { Agents } from "./agents/agents.js";
import { Auth, Signatures } from "./auth/auth.js";
import { Assessments } from "./core/assessments.js";
import { Machines } from "./core/machines.js";
import { Resources } from "./core/resources.js";
import { AgentLicenses } from "./core/agent-licenses.js";
import { AgentMemory } from "./core/agent-memory.js";
import { AgentNfts } from "./core/agent-nfts.js";
import { Autonomy } from "./core/autonomy.js";
import { Inbox } from "./core/inbox.js";
import { Jobs } from "./core/jobs.js";
import { Monitor } from "./core/monitor.js";
import { LotNames } from "./core/lot-names.js";
import { Names } from "./core/names.js";
import { Openings } from "./core/openings.js";
import { Passports } from "./core/passports.js";
import { MachineOutputs } from "./core/outputs.js";
import { Readings } from "./core/readings.js";
import { StageProofs } from "./core/stage-proofs.js";
import { SpecProofs } from "./core/spec-proofs.js";
import { Proof } from "./core/proof.js";
import { Recorder } from "./core/recorder.js";
import { Replicas } from "./core/replicas.js";
import { Contributions } from "./core/contributions.js";
import { Selection } from "./core/selection.js";
import { Cases } from "./core/cases.js";
import { routerFromConfig, TRUST_LABEL } from "./chain/zg-router.js";
import { Templates } from "./core/templates.js";
import { Validation } from "./core/validation.js";
import { WorkOrders } from "./core/workorders.js";
import { Schedules, type ScheduleRail } from "./core/schedules.js";
import { Trust } from "./core/trust.js";
import { EvmAgentPayer, type AgentPayer } from "./chain/agent.js";
import { TrustChain } from "./chain/trust.js";
import type { Hex, Transport } from "viem";
import { migrate, openDb, type Db } from "./db/db.js";
import { LedgerStore } from "./db/ledger-store.js";
import { loadPolicy } from "./domain/policy.js";
import { HttpError } from "./engine/errors.js";
import { AccessControl } from "./core/access.js";
import { RunEngine } from "./pipelines/engine.js";
import { StageSeries } from "./pipelines/stage-series.js";
import { PlantService, newId } from "./plant/plant.js";

export interface RailStatus {
  rail: string;
  mode: string;
  live: boolean;
}

export interface McpSaleView {
  tool: string;
  amount: string;
  payer: string | null;
  transaction: string;
  url: string;
  at: string;
}

export interface System {
  cfg: Config;
  db: Db;
  access: AccessControl;
  rails: RailStatus[];
  warnings: string[];
  policy: ReturnType<typeof loadPolicy>;
  ledger: LedgerStore;
  rec: Recorder;
  auth: Auth;
  sigs: Signatures;
  plant: PlantService;
  templates: Templates;
  engine: RunEngine;
  series: StageSeries;
  inbox: Inbox;
  monitor: Monitor;
  proof: Proof;
  validation: Validation;
  trust: Trust;
  agents: Agents;
  workOrders: WorkOrders;
  /** Deadlines on Hedera's Schedule Service, when the operator is configured */
  schedules: Schedules | null;
  autonomy: Autonomy;
  passports: Passports;
  openings: Openings;
  jobs: Jobs;
  names: Names;
  lotNames: LotNames;
  readings: Readings;
  /** The media each stage's machine captures for its outcomes */
  outputs: MachineOutputs;
  /** machine bodies: virtual machines with their own agent. Always present; they start only when a runtime is configured (BODY_RUNTIME) */
  bodies: Bodies;
  /** an org's machines for the library's templates, created on one manager signature */
  fleet: Fleet;
  stageProofs: StageProofs;
  /** Proof of work through 0G Private Computer */
  contributions: Contributions;
  /** A validator selects the valid proof of work; rewards vest on-chain */
  selection: Selection;
  /** Testers' cases against validators, decided by the manager */
  cases: Cases;
  agentNfts: AgentNfts;
  agentLicenses: AgentLicenses;
  agentMemory: AgentMemory;
  machines: Machines;
  payOnProof: import("./core/finance.js").PayOnProof;
  /** x402: the paid assessment route's middleware and terms, when Ordo sells assessments */
  x402: { middleware: import("hono").MiddlewareHandler; terms: { network: string; payTo: string; price: string; asset: string } } | null;
  /** The metered MCP server: tools other agents pay for per call over x402 */
  mcp: (ReturnType<typeof import("./chain/mcp.js").meteredMcp> & { sales(limit?: number): Promise<McpSaleView[]> }) | null;
  ensNames: { lookup(addresses: string[]): Promise<Record<string, string | null>> } | null;
  /** Stage resources: vendors' offers, the x402 storefront, machines' look-ahead purchases and the resource gate */
  resources: Resources;
  /** Org treasuries (OrdoTreasury): run budgets and machine top-ups as Hedera schedules a manager approves */
  budgets: import("./core/budgets.js").Budgets;
  /** One engine cycle: pull data, advance runs, watch for anomalies, refund expired escrows, anchor. Throttled and lease-guarded. */
  advance(force?: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function buildSystem(cfg: Config, opts: { now?: () => number; policyText?: string; llm?: LlmProvider; trustTransport?: Transport; x402Facilitator?: import("@x402/core/server").FacilitatorClient; x402Fetch?: typeof fetch; machineBank?: import("./chain/machine-bank.js").MachineBank; partyBank?: import("./chain/machine-bank.js").PartyBank; ensTransport?: Transport; blobStore?: import("./chain/zerog.js").BlobStore; inftTransport?: Transport; scheduler?: ScheduleRail; treasury?: import("./chain/treasury.js").TreasuryRail } = {}): Promise<System> {
  const warnings: string[] = [];
  if (cfg.VERCEL && !cfg.DATABASE_URL) throw new Error("On Vercel, DATABASE_URL is required (add Neon from the Vercel Marketplace)");
  const now = opts.now ?? Date.now;
  const db = await openDb({ url: cfg.DATABASE_URL, dataDir: cfg.DATA_DIR });
  await migrate(db);
  const policy = loadPolicy(opts.policyText ?? readFileSync(resolve(cfg.POLICY_FILE), "utf8"));

  // ---- LLM ----
  let llm: LlmProvider = opts.llm ?? new OfflineLlm();
  const federated = cfg.ANTHROPIC_FEDERATION_RULE_ID && cfg.ANTHROPIC_ORGANIZATION_ID && cfg.ANTHROPIC_SERVICE_ACCOUNT_ID;
  const provider = cfg.LLM_PROVIDER ?? (cfg.ANTHROPIC_API_KEY || federated ? "claude" : "offline");
  if (!opts.llm && provider === "gemini") {
    if (cfg.GEMINI_API_KEY) llm = await geminiProvider(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL, cfg.LLM_TIMEOUT_MS);
    else warnings.push("LLM_PROVIDER=gemini but GEMINI_API_KEY is missing; agents use their deterministic offline reasoning");
  } else if (!opts.llm && provider === "claude") {
    // Claude thinks before it answers: 25 s a call, so a diagnosis and a recommendation fit in one 60 s function
    const { claudeProvider } = await import("./adapters/claude.js");
    const timeout = Math.max(cfg.LLM_TIMEOUT_MS, 25_000);
    if (cfg.ANTHROPIC_API_KEY) llm = claudeProvider({ apiKey: cfg.ANTHROPIC_API_KEY }, cfg.CLAUDE_MODEL, timeout);
    else if (federated) {
      const { readFileSync } = await import("node:fs");
      const { vercelOidcToken } = await import("./adapters/vercel-oidc.js");
      const file = cfg.ANTHROPIC_IDENTITY_TOKEN_FILE;
      const identityToken = file ? () => readFileSync(file, "utf8").trim() : cfg.ANTHROPIC_IDENTITY_TOKEN ? () => cfg.ANTHROPIC_IDENTITY_TOKEN! : vercelOidcToken;
      llm = claudeProvider(
        { federation: { ruleId: cfg.ANTHROPIC_FEDERATION_RULE_ID!, organizationId: cfg.ANTHROPIC_ORGANIZATION_ID!, serviceAccountId: cfg.ANTHROPIC_SERVICE_ACCOUNT_ID!, workspaceId: cfg.ANTHROPIC_WORKSPACE_ID, identityToken } },
        cfg.CLAUDE_MODEL,
        timeout,
      );
    } else warnings.push("LLM_PROVIDER=claude needs ANTHROPIC_API_KEY or Workload Identity Federation (ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID); agents use their deterministic offline reasoning");
  } else if (!opts.llm && provider === "openai_compat") {
    if (cfg.OPENAI_COMPAT_BASE_URL && cfg.OPENAI_COMPAT_MODEL)
      llm = openAiCompatProvider({
        name: "openai-compat",
        baseUrl: cfg.OPENAI_COMPAT_BASE_URL,
        model: cfg.OPENAI_COMPAT_MODEL,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
        headers: async (): Promise<Record<string, string>> => (cfg.OPENAI_COMPAT_API_KEY ? { authorization: `Bearer ${cfg.OPENAI_COMPAT_API_KEY}` } : {}),
      });
    else warnings.push("openai_compat needs OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL; agents use offline reasoning");
  } else if (!opts.llm && provider === "0g") {
    const { zeroGComputeProvider } = await import("./chain/zerog.js");
    llm = await zeroGComputeProvider(cfg).catch((e) => {
      warnings.push(`0G Compute unavailable (${e instanceof Error ? e.message : e}); agents use offline reasoning`);
      return new OfflineLlm();
    });
  }

  // ---- Proof rails ----
  let anchor: AnchorAdapter = new LocalSignedAnchor(cfg.LEDGER_SIGNING_KEY);
  if (anchor instanceof LocalSignedAnchor && anchor.ephemeral)
    warnings.push(cfg.VERCEL ? "LEDGER_SIGNING_KEY not set: each serverless instance signs with a different key." : "LEDGER_SIGNING_KEY not set; checkpoints use a key that changes on restart");
  let hedera: Awaited<ReturnType<typeof import("./chain/hedera.js")["hederaFromConfig"]>> | null = null;
  if (cfg.ANCHOR === "hedera" || cfg.HEDERA_PASSPORT_TOKEN_ID || (cfg.HEDERA_SCHEDULES === "on" && cfg.HEDERA_OPERATOR_ID && cfg.HEDERA_OPERATOR_KEY)) {
    try {
      const h = await import("./chain/hedera.js");
      hedera = h.hederaFromConfig(cfg);
      if (cfg.ANCHOR === "hedera") anchor = hedera.anchor();
    } catch (e) {
      warnings.push(`Hedera not configured (${e instanceof Error ? e.message : e}); using the local signed anchor`);
    }
  }
  let ensNames: System["ensNames"] = null;
  if (cfg.IDENTITY === "ens") {
    const { EnsNames } = await import("./chain/ens.js");
    ensNames = new EnsNames(cfg.ENS_RPC_URL);
  }

  const ledger = new LedgerStore(db);
  const jobs = new Jobs(db, now);
  const rec = new Recorder(db, ledger);
  const auth = new Auth(db, { sessionTtlMs: cfg.SESSION_TTL_HOURS * 3_600_000, rpcUrl: cfg.AUTH_RPC_URL, bootstrapAdmin: cfg.BOOTSTRAP_ADMIN_ADDRESS });
  const sigs = new Signatures(db, cfg.AUTH_RPC_URL);
  const plant = new PlantService(db, now);
  const templates = new Templates(db, rec);
  await templates.ensureLibrary();
  const engine = new RunEngine(db, plant, templates, rec, now);
  const series = new StageSeries(db, plant, now);
  engine.series = series;
  engine.requireMachines = cfg.STAGE_MACHINES === "required";
  const inbox = new Inbox(db, rec, sigs, engine, plant, templates, cfg.SIGNATURE_CHAIN_ID);
  engine.inbox = inbox;
  const agents = new Agents(llm);
  const monitor = new Monitor(db, plant, agents, inbox, rec, policy, now);
  const proof = new Proof(db, ledger, anchor);
  let trustChain: TrustChain | null = null;
  if (cfg.TRUST_CONTRACT_ADDRESS && cfg.TRUST_RELAYER_KEY && cfg.TRUST_CHAIN_ID && (cfg.TRUST_RPC_URL || opts.trustTransport)) {
    trustChain = new TrustChain(
      {
        chainId: cfg.TRUST_CHAIN_ID,
        name: cfg.TRUST_CHAIN_NAME,
        rpcUrl: cfg.TRUST_RPC_URL ?? "http://in-process",
        explorerUrl: cfg.TRUST_EXPLORER_URL ?? null,
        address: cfg.TRUST_CONTRACT_ADDRESS as `0x${string}`,
        workOrders: (cfg.TRUST_WORKORDERS_ADDRESS as `0x${string}` | undefined) ?? null,
        policies: (cfg.TRUST_POLICIES_ADDRESS as `0x${string}` | undefined) ?? null,
        relayerKey: cfg.TRUST_RELAYER_KEY as `0x${string}`,
        symbol: cfg.TRUST_SYMBOL,
        decimals: cfg.TRUST_DECIMALS,
      },
      opts.trustTransport,
    );
  } else if (cfg.TRUST_CONTRACT_ADDRESS || cfg.TRUST_RELAYER_KEY) {
    warnings.push("OrdoTrust needs TRUST_CONTRACT_ADDRESS, TRUST_RELAYER_KEY, TRUST_CHAIN_ID and TRUST_RPC_URL together; validator stakes are off");
  }
  const trust = new Trust(db, rec, sigs, trustChain, cfg.SIGNATURE_CHAIN_ID);
  inbox.trust = trust;
  const validation = new Validation(db, rec, ledger, sigs, engine, inbox, cfg.SIGNATURE_CHAIN_ID, trust);
  validation.series = series;
  // ---- Evidence copies on 0G Storage ----
  if (opts.blobStore || cfg.EVIDENCE_STORE === "0g") {
    try {
      const store = opts.blobStore ?? new (await import("./chain/zerog.js")).ZeroGStorage(cfg);
      validation.replicas = new Replicas(db, jobs, rec, store);
    } catch (e) {
      warnings.push(`0G Storage unusable (${e instanceof Error ? e.message : e}); evidence stays in the database only`);
    }
  }

  // ---- The maintenance agent's own account: it escrows vendor payments in OrdoWorkOrders ----
  let payer: AgentPayer | null = null;
  // the Agent Kit policy reads work orders, which need the payer: bind it late
  const checkEscrow = (p: { siteId: string; workOrderId: string; vendor: string; amount: string }) => workOrders.checkEscrow(p);
  if (trustChain && cfg.TRUST_WORKORDERS_ADDRESS && cfg.HEDERA_AGENT_KEY) {
    try {
      const onHedera = [295, 296, 297].includes(trustChain.cfg.chainId);
      if (onHedera && cfg.HEDERA_AGENT_ID) {
        const { HederaAgentKitPayer } = await import("./chain/agent-kit.js");
        payer = new HederaAgentKitPayer({
          network: cfg.HEDERA_NETWORK,
          agentId: cfg.HEDERA_AGENT_ID,
          agentKey: cfg.HEDERA_AGENT_KEY,
          workOrders: cfg.TRUST_WORKORDERS_ADDRESS as Hex,
          check: checkEscrow,
          audit: hedera && cfg.HEDERA_TOPIC_ID ? { topicId: cfg.HEDERA_TOPIC_ID, client: hedera.client } : undefined,
        });
      } else {
        const raw = cfg.HEDERA_AGENT_KEY.trim();
        const key = /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? raw.replace(/^(0x)?/, "0x") : `0x${(await import("./chain/hedera.js")).parseHederaKey(raw).toStringRaw()}`;
        payer = new EvmAgentPayer({ ...trustChain.cfg, workOrders: cfg.TRUST_WORKORDERS_ADDRESS as Hex }, key as Hex, opts.trustTransport);
      }
    } catch (e) {
      warnings.push(`Agent account unusable (${e instanceof Error ? e.message : e}); work orders assign vendors without escrow`);
    }
  } else if (cfg.TRUST_WORKORDERS_ADDRESS && !cfg.HEDERA_AGENT_KEY) {
    warnings.push("TRUST_WORKORDERS_ADDRESS is set but HEDERA_AGENT_KEY is not: work orders assign vendors without escrow");
  }
  const workOrders = new WorkOrders(db, rec, sigs, trust, payer, now);
  inbox.workOrders = workOrders;
  // ---- Deadlines on Hedera's Schedule Service: escrow refunds, validator payouts, stage timeouts ----
  let schedules: Schedules | null = null;
  const scheduleRail = opts.scheduler ?? (hedera && cfg.HEDERA_SCHEDULES === "on" ? hedera.scheduler() : null);
  if (scheduleRail) {
    // contract calls are scheduled only on a trust chain on Hedera itself
    const onHedera = Boolean(opts.scheduler || (trustChain && [295, 296, 297].includes(trustChain.cfg.chainId)));
    schedules = new Schedules(db, rec, scheduleRail, () => (onHedera ? trust.chain : null), now);
    workOrders.schedules = schedules;
    trust.schedules = schedules;
    if (cfg.HEDERA_TOPIC_ID || opts.scheduler) engine.timeouts = schedules;
  }
  const autonomy = new Autonomy(db, rec, sigs, plant, trust, policy, cfg.SIGNATURE_CHAIN_ID);
  let passportRail: import("./chain/passport.js").PassportRail | null = null;
  if (cfg.HEDERA_PASSPORT_TOKEN_ID && hedera) passportRail = (await import("./chain/passport.js")).hederaPassports(hedera.client, cfg.HEDERA_NETWORK, cfg.HEDERA_PASSPORT_TOKEN_ID);
  if (cfg.HEDERA_PASSPORT_TOKEN_ID && !publicBase(cfg)) warnings.push("Set PUBLIC_URL so lot passport NFTs point at a public page");
  // ---- x402: Ordo sells vibration assessments per call; the agent buys one for each work order ----
  let x402: System["x402"] = null;
  const x402Net = (await import("./chain/x402.js")).x402Network(cfg.HEDERA_NETWORK);
  const payTo = cfg.X402_PAY_TO ?? cfg.HEDERA_OPERATOR_ID;
  // bound below, once machines exist: vendors' call-outs are priced and paid to the vendor's own account
  let machines: Machines | null = null;
  if (x402Net && payTo) {
    const { x402Seller } = await import("./chain/x402.js");
    x402 = x402Seller({
      network: x402Net,
      payTo,
      price: cfg.X402_PRICE_TINYBARS,
      facilitatorUrl: cfg.X402_FACILITATOR_URL,
      facilitator: opts.x402Facilitator,
      vendors: { payTo: (id) => machines!.vendorAccount(id), deposit: (id) => machines!.calloutDeposit(id) },
    });
  }
  const assessUrl = cfg.X402_ASSESSMENT_URL ?? (x402 && publicBase(cfg) ? `${publicBase(cfg)}${(await import("./chain/x402.js")).ASSESSMENT_PATH}` : null);
  if (x402Net && cfg.HEDERA_AGENT_ID && cfg.HEDERA_AGENT_KEY && assessUrl) {
    try {
      const { X402Buyer } = await import("./chain/x402.js");
      const buyer = new X402Buyer({ network: x402Net, agentId: cfg.HEDERA_AGENT_ID, agentKey: cfg.HEDERA_AGENT_KEY, maxPerCall: cfg.X402_MAX_TINYBARS }, opts.x402Fetch);
      workOrders.assessments = new Assessments(jobs, plant, rec, buyer, assessUrl);
    } catch (e) {
      warnings.push(`x402 buyer unusable (${e instanceof Error ? e.message : e}); work orders open without an assessment`);
    }
  }
  // ---- Machines that pay for themselves: each machine its own Hedera account, buying over x402 when it drifts ----
  let machineBank = opts.machineBank ?? null;
  if (!machineBank && x402Net && cfg.HEDERA_OPERATOR_ID && cfg.HEDERA_OPERATOR_KEY) {
    try {
      const client = (hedera ?? (await import("./chain/hedera.js")).hederaFromConfig(cfg)).client;
      const mirror = (cfg.HEDERA_MIRROR_URL ?? `https://${cfg.HEDERA_NETWORK}.mirrornode.hedera.com`).replace(/\/$/, "");
      machineBank = (await import("./chain/machine-bank.js")).hederaMachineBank(client, cfg.HEDERA_NETWORK, mirror, cfg.HEDERA_TOPIC_ID ?? null);
    } catch (e) {
      warnings.push(`Machine wallets unavailable (${e instanceof Error ? e.message : e})`);
    }
  }
  const { X402Buyer: MachineBuyer } = await import("./chain/x402.js");
  machines = new Machines(
    db,
    rec,
    jobs,
    plant,
    x402Net ? machineBank : null,
    (accountId, key, perCall) => new MachineBuyer({ network: x402Net!, agentId: accountId, agentKey: key, maxPerCall: perCall }, opts.x402Fetch),
    { assess: x402 ? assessUrl : null, base: publicBase(cfg), assessPrice: cfg.X402_PRICE_TINYBARS },
    cfg.HEDERA_OPERATOR_KEY ?? cfg.LEDGER_SIGNING_KEY ?? "ordo-local",
    now,
  );
  monitor.machines = machines;

  // ---- Pay on proof: Ordo USD (Stablecoin Studio) held for a lot until OrdoTrust records its release ----
  let payChain: import("./chain/payonproof.js").PayOnProofChain | null = null;
  if (cfg.STABLECOIN_ADDRESS && cfg.STABLECOIN_TOKEN_ADDRESS && cfg.PAY_ON_PROOF_ADDRESS && cfg.TRUST_RELAYER_KEY && cfg.TRUST_CHAIN_ID && (cfg.TRUST_RPC_URL || opts.trustTransport)) {
    const { PayOnProofChain } = await import("./chain/payonproof.js");
    payChain = new PayOnProofChain(
      {
        rpcUrl: cfg.TRUST_RPC_URL ?? "http://in-process",
        chainId: cfg.TRUST_CHAIN_ID,
        coin: cfg.STABLECOIN_ADDRESS as `0x${string}`,
        token: cfg.STABLECOIN_TOKEN_ADDRESS as `0x${string}`,
        address: cfg.PAY_ON_PROOF_ADDRESS as `0x${string}`,
        relayerKey: cfg.TRUST_RELAYER_KEY as `0x${string}`,
        symbol: cfg.STABLECOIN_SYMBOL,
        decimals: cfg.STABLECOIN_DECIMALS,
        explorerUrl: cfg.TRUST_EXPLORER_URL,
      },
      opts.trustTransport,
    );
  } else if (cfg.PAY_ON_PROOF_ADDRESS || cfg.STABLECOIN_ADDRESS) {
    warnings.push("Pay on proof needs STABLECOIN_ADDRESS, STABLECOIN_TOKEN_ADDRESS, PAY_ON_PROOF_ADDRESS and the OrdoTrust chain settings (TRUST_RPC_URL, TRUST_CHAIN_ID, TRUST_RELAYER_KEY)");
  }
  let partyBank = opts.partyBank ?? null;
  if (!partyBank && payChain && cfg.HEDERA_OPERATOR_ID && cfg.HEDERA_OPERATOR_KEY) {
    const client = (hedera ?? (await import("./chain/hedera.js")).hederaFromConfig(cfg)).client;
    partyBank = (await import("./chain/machine-bank.js")).hederaParties(client, cfg.HEDERA_NETWORK, cfg.PAY_ON_PROOF_PARTY_TINYBARS);
  }
  const { PayOnProof } = await import("./core/finance.js");
  const payOnProof = new PayOnProof(db, rec, jobs, payChain, partyBank, cfg.HEDERA_OPERATOR_KEY ?? cfg.LEDGER_SIGNING_KEY ?? "ordo-local", now);

  const passports = new Passports(db, rec, sigs, engine, trust, proof, passportRail, publicBase(cfg), cfg.SIGNATURE_CHAIN_ID, now);
  passports.specs = new SpecProofs(db, rec, now);
  const stageProofs = new StageProofs(db, engine, now);
  const readings = new Readings(db, engine, plant, rec, now);
  const outputs = new MachineOutputs(db, engine, readings, plant, rec, now);
  validation.stageProofs = stageProofs;
  validation.specProofs = passports.specs;
  readings.specProofs = passports.specs;
  passports.stages = stageProofs;
  if (!stageProofs.enabled) warnings.push("The stage-check circuit (server/zk) is missing: signed stage readings are kept but not proven");
  if (!passports.specs.enabled) warnings.push("The spec-check circuit (server/zk) is missing: public passports show criteria without zero-knowledge proofs");

  // ---- ENSv2 names on Sepolia for the site, its people, assets and agents ----
  let nameRail: import("./chain/ensv2.js").EnsV2 | null = null;
  const ensParts = [cfg.ENS_PARENT_NAME, cfg.ENS_REGISTRY_ADDRESS, cfg.ENS_RESOLVER_ADDRESS, cfg.ENS_OWNER_KEY];
  if (ensParts.every(Boolean)) {
    const { EnsV2 } = await import("./chain/ensv2.js");
    nameRail = new EnsV2(
      {
        rpcUrl: cfg.ENS_SEPOLIA_RPC_URL,
        ownerKey: cfg.ENS_OWNER_KEY!.replace(/^(0x)?/, "0x") as Hex,
        parentName: cfg.ENS_PARENT_NAME!,
        parentRegistry: cfg.ENS_REGISTRY_ADDRESS as Hex,
        resolver: cfg.ENS_RESOLVER_ADDRESS as Hex,
        factory: cfg.ENS_FACTORY_ADDRESS as Hex | undefined,
        userRegistryImpl: cfg.ENS_USER_REGISTRY_IMPL as Hex | undefined,
        chainId: cfg.ENS_CHAIN_ID,
        credentials: cfg.ENS_ROLES_ADDRESS as Hex | undefined,
        lotResolver: cfg.ENS_LOT_RESOLVER_ADDRESS as Hex | undefined,
      },
      opts.ensTransport,
    );
  } else if (ensParts.some(Boolean)) {
    warnings.push("ENS names need ENS_PARENT_NAME, ENS_REGISTRY_ADDRESS, ENS_RESOLVER_ADDRESS and ENS_OWNER_KEY together");
  }
  const names = new Names(db, rec, nameRail, publicBase(cfg), () => payer?.address ?? null, now);
  if (Boolean(cfg.ENS_ROLES_ADDRESS) !== Boolean(cfg.ENS_LOT_RESOLVER_ADDRESS)) warnings.push("ENS credentials and lot names need ENS_ROLES_ADDRESS and ENS_LOT_RESOLVER_ADDRESS together");
  const lotNames = new LotNames(db, rec, nameRail?.credentialsLive ? nameRail : null, engine, passports, now);
  validation.lots = lotNames;
  passports.lots = lotNames;

  // ---- Agents as ERC-7857 iNFTs on 0G ----
  let inftRail: (import("./core/agent-nfts.js").AgentNftRail & import("./core/agent-licenses.js").LicenseRail) | null = null;
  if (cfg.ZG_INFT_ADDRESS && cfg.ZG_PRIVATE_KEY) {
    const { AgentNftChain } = await import("./chain/inft.js");
    inftRail = new AgentNftChain({ rpcUrl: cfg.ZG_RPC_URL, chainId: cfg.ZG_CHAIN_ID, address: cfg.ZG_INFT_ADDRESS as Hex, key: cfg.ZG_PRIVATE_KEY.replace(/^(0x)?/, "0x") as Hex }, opts.inftTransport);
  } else if (cfg.ZG_INFT_ADDRESS) {
    warnings.push("ZG_INFT_ADDRESS is set but ZG_PRIVATE_KEY is not: agents are not minted as iNFTs");
  }
  const agentNfts = new AgentNfts(db, rec, inftRail, policy.hash, () => (llm.name === "gemini" ? `gemini:${cfg.GEMINI_MODEL}` : llm.name === "claude" ? `claude:${cfg.CLAUDE_MODEL}` : llm.name), now);
  // ---- Licensing proven agents between sites through their iNFTs; playbooks on 0G Storage with the evidence ----
  const agentLicenses = new AgentLicenses(db, rec, sigs, inftRail, validation.replicas?.store ?? null, cfg.SIGNATURE_CHAIN_ID, now);
  // ---- Agent memory on 0G, sealed for the agent's site and its licensees, named by the agent's iNFT ----
  const agentMemory = new AgentMemory(db, rec, agentLicenses, validation.replicas?.store ?? null, (h) => (validation.replicas?.store.kind === "0g-storage" ? `https://chainscan-galileo.0g.ai/tx/${h}` : null), cfg.ZG_PRIVATE_KEY ?? cfg.LEDGER_SIGNING_KEY ?? "ordo-local", now);
  const contributions = new Contributions(
    db,
    engine,
    rec,
    sigs,
    routerFromConfig(cfg),
    cfg.ZG_PRIVATE_KEY ?? cfg.LEDGER_SIGNING_KEY ?? "ordo-local",
    cfg.POW_PACKAGE,
    cfg.POW_SESSION_MINUTES * 60_000,
    now,
  );
  contributions.replicas = validation.replicas ?? null;
  outputs.replicas = validation.replicas ?? null;
  contributions.outputs = outputs;
  const selection = new Selection(db, engine, rec, sigs, trust, contributions, now);
  const cases = new Cases(db, engine, rec, sigs, trust, selection, contributions, now);
  agentLicenses.memory = agentMemory;
  agentNfts.licensed = async (siteId) => {
    const out = await agentLicenses.licensedData(siteId);
    for (const [a, d] of await agentMemory.latestData(siteId)) out.set(a, [...d, ...(out.get(a) ?? [])]);
    return out;
  };
  monitor.licenses = agentLicenses;
  passports.names = names;
  const openings = new Openings(db, engine);

  // ---- Machine bodies: a runner per runtime, and BODY_RUNTIME picks the one new starts use ----
  const bodyRunners = new Map<BodyRuntime, BodyRunner>();
  const bodyRuntime = cfg.BODY_RUNTIME === "off" ? null : cfg.BODY_RUNTIME;
  let bodies: Bodies;
  if (cfg.BODY_RUNTIME === "local") {
    const { LocalBodies } = await import("./core/bodies-local.js");
    const { fileURLToPath } = await import("node:url");
    const bundle = resolve(cfg.BODY_BUNDLE ?? fileURLToPath(new URL("../../body/dist/body.mjs", import.meta.url)));
    bodyRunners.set("local", new LocalBodies({ bundle, report: (id, state, error) => void bodies.runnerReport(id, state, error).catch(() => undefined), log: (l) => console.log(l) }));
  }
  if (cfg.BODY_RUNTIME === "sandbox") {
    // one Vercel Sandbox microVM per machine (server/src/core/bodies-sandbox.ts); null without a Vercel token
    const { sandboxBodies } = await import("./core/bodies-sandbox.js");
    const runner = sandboxBodies(cfg, (w) => warnings.push(w));
    if (runner) bodyRunners.set("sandbox", runner);
    else warnings.push("BODY_RUNTIME=sandbox but the Vercel Sandbox is not configured; virtual machines are created but do not run");
  }
  {
    const { tmpdir } = await import("node:os");
    const bodyDir = cfg.DATA_DIR === "memory" ? resolve(tmpdir(), "ordo-bodies") : resolve(cfg.DATA_DIR, "bodies");
    bodies = new Bodies(db, rec, plant, engine, readings, machines, contributions.router, bodyRunners, bodyRuntime, {
      ordoUrl: (rt) => cfg.BODY_ORDO_URL ?? (rt === "local" ? `http://127.0.0.1:${cfg.PORT}` : publicBase(cfg)),
      secret: cfg.HEDERA_OPERATOR_KEY ?? cfg.LEDGER_SIGNING_KEY ?? "ordo-local",
      dataDir: (assetId) => (bodyRuntime === "local" ? resolve(bodyDir, assetId) : null),
      stageS: cfg.BODY_STAGE_S,
      hederaNetwork: cfg.HEDERA_NETWORK,
    }, now);
    bodies.replicas = validation.replicas ?? null;
    if (bodyRuntime) void bodies.resume().catch((e) => console.error("[ordo] bodies", e));
  }

  // ---- The metered MCP server: assessments, forecasts and lot verdicts sold per tool call to any agent, over x402 ----
  let mcp: System["mcp"] = null;
  if (x402Net && payTo) {
    const { meteredMcp } = await import("./chain/mcp.js");
    const { hashscanTx } = await import("./chain/x402.js");
    const server = meteredMcp({
      network: x402Net,
      payTo,
      price: cfg.X402_PRICE_TINYBARS,
      facilitatorUrl: cfg.X402_FACILITATOR_URL,
      facilitator: opts.x402Facilitator,
      passport: (runId) => passports.publicView(runId).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e))),
      onSale: async (s) => {
        await db.query("INSERT INTO mcp_sales (id, tool, amount, payer, tx_id, network) VALUES ($1, $2, $3, $4, $5, $6)", [newId("sale"), s.tool, s.amount, s.payer, s.transaction, s.network]);
      },
    });
    const sales = async (limit = 20): Promise<McpSaleView[]> =>
      (await db.query<{ tool: string; amount: string; payer: string | null; tx_id: string; created_at: string }>("SELECT tool, amount, payer, tx_id, created_at::text AS created_at FROM mcp_sales ORDER BY created_at DESC LIMIT $1", [limit])).rows.map((r) => ({
        tool: r.tool,
        amount: r.amount,
        payer: r.payer,
        transaction: r.tx_id,
        url: hashscanTx(x402Net, r.tx_id),
        at: new Date(r.created_at).toISOString(),
      }));
    mcp = { ...server, sales };
  }

  // ---- Stage resources: vendors' offers sold over x402, bought ahead by machines from their own accounts ----
  const resources = new Resources(db, rec, sigs, engine, plant, machines.bank, { payTo: payTo ?? null, network: cfg.HEDERA_NETWORK, chainId: cfg.SIGNATURE_CHAIN_ID }, cfg.HEDERA_OPERATOR_KEY ?? cfg.LEDGER_SIGNING_KEY ?? "ordo-local", now);
  engine.resources = resources;
  if (x402Net && payTo) {
    const { x402Seller } = await import("./chain/x402.js");
    resources.store = x402Seller({
      network: x402Net,
      payTo,
      price: cfg.X402_PRICE_TINYBARS,
      facilitatorUrl: cfg.X402_FACILITATOR_URL,
      facilitator: opts.x402Facilitator,
      offers: { payTo: (id) => resources.payTo(id), price: (id, sku, qty) => resources.price(id, sku, qty), settled: (s) => resources.settled(s) },
    }).middleware;
  }
  // ---- Org treasuries: each org's HBAR answers to its own key contract in OrdoTreasury, spent through schedules a manager approves ----
  let treasuryRail = opts.treasury ?? null;
  if (!treasuryRail && cfg.TREASURY_CONTRACT_ADDRESS) {
    const onHedera = trustChain && [295, 296, 297].includes(trustChain.cfg.chainId);
    if (onHedera && cfg.HEDERA_OPERATOR_ID && cfg.HEDERA_OPERATOR_KEY && cfg.TRUST_RPC_URL && cfg.TRUST_RELAYER_KEY) {
      try {
        const h = await import("./chain/hedera.js");
        const client = (hedera ?? h.hederaFromConfig(cfg)).client;
        treasuryRail = (await import("./chain/treasury.js")).hederaTreasury({
          client,
          operatorKey: h.parseHederaKey(cfg.HEDERA_OPERATOR_KEY),
          network: cfg.HEDERA_NETWORK,
          mirrorUrl: (cfg.HEDERA_MIRROR_URL ?? `https://${cfg.HEDERA_NETWORK}.mirrornode.hedera.com`).replace(/\/$/, ""),
          topicId: cfg.HEDERA_TOPIC_ID ?? null,
          contract: cfg.TREASURY_CONTRACT_ADDRESS as Hex,
          rpcUrl: cfg.TRUST_RPC_URL,
          chainId: trustChain!.cfg.chainId,
          relayerKey: cfg.TRUST_RELAYER_KEY as Hex,
        });
      } catch (e) {
        warnings.push(`Org treasuries unavailable (${e instanceof Error ? e.message : e})`);
      }
    } else warnings.push("TREASURY_CONTRACT_ADDRESS needs OrdoTrust on Hedera (TRUST_*) and the operator (HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY); org treasuries are off");
  }
  const { Budgets } = await import("./core/budgets.js");
  const budgets = new Budgets(db, rec, sigs, inbox, engine, templates, trust, trustChain ? treasuryRail : null, { marginPct: cfg.TREASURY_BUDGET_MARGIN_PCT, hours: cfg.TREASURY_BUDGET_HOURS, seed: cfg.TREASURY_SEED_TINYBARS, topUpMax: cfg.TREASURY_TOPUP_MAX_TINYBARS }, now);
  budgets.offerPrices = (siteId) => resources.offerPrices(siteId);

  const advance = async (force = false) => {
    // throttle: one cycle per 4 s across all instances (the lease is left to expire, not released)
    if (!force && !(await plant.tryLease("advance", 4_000))) return;
    // one failing site or service must not stop the cycle for everyone else
    await plant.ingest().catch((e) => console.error("[ordo] ingest", e));
    await engine.tick();
    const sites = await db.query<{ id: string }>("SELECT id FROM sites");
    for (const s of sites.rows) await monitor.scan(s.id).catch((e) => console.error(`[ordo] monitor ${s.id}`, e));
    await schedules?.reconcile().catch((e) => console.error("[ordo] schedules", e));
    await workOrders.refundExpired().catch((e) => console.error("[ordo] refunds", e));
    await passports.reconcile().catch((e) => console.error("[ordo] passports", e));
    await stageProofs.reconcile().catch((e) => console.error("[ordo] stage proofs", e));
    await jobs.run().catch((e) => console.error("[ordo] jobs", e));
    await payOnProof.reconcile().catch((e) => console.error("[ordo] pay on proof", e));
    await machines!.topUps().catch((e) => console.error("[ordo] machine top-ups", e));
    await names.reconcile().catch((e) => console.error("[ordo] ens", e));
    await lotNames.reconcile().catch((e) => console.error("[ordo] ens lots", e));
    await agentLicenses.reconcile().catch((e) => console.error("[ordo] licences", e));
    await agentMemory.reconcile().catch((e) => console.error("[ordo] agent memory", e));
    await agentNfts.reconcile().catch((e) => console.error("[ordo] inft", e));
    await contributions.reconcile().catch((e) => console.error("[ordo] proof-of-work sessions", e));
    await selection.reconcile().catch((e) => console.error("[ordo] reward settlement", e));
    await budgets.reconcile().catch((e) => console.error("[ordo] budgets", e));
    await bodies.reconcile().catch((e) => console.error("[ordo] machine bodies", e));
    const head = await ledger.head();
    const last = (await proof.anchors(1))[0];
    if (head && (!last || head.seq - last.toSeq >= cfg.ANCHOR_EVERY || (head.seq > last.toSeq && now() - Date.parse(last.ts) > 30 * 60_000))) await proof.anchorHead(null, null).catch((e) => console.error("[ordo] anchor", e));
  };

  const rails: RailStatus[] = [
    { rail: "database", mode: db.kind === "postgres" ? "postgres" : cfg.DATA_DIR === "memory" ? "pglite (memory)" : "pglite (disk)", live: db.kind === "postgres" },
    { rail: "identity", mode: `SIWE wallet sign-in${ensNames ? " + ENS primary names" : ""}`, live: true },
    { rail: "ens names", mode: nameRail ? `ENSv2 on Sepolia under ${cfg.ENS_PARENT_NAME}` : "off: no names issued", live: Boolean(nameRail) },
    { rail: "ens credentials", mode: lotNames.live ? `roles from member names (OrdoEnsRoles ${cfg.ENS_ROLES_ADDRESS}) · lot names via OrdoLotResolver ${cfg.ENS_LOT_RESOLVER_ADDRESS}` : "off: ENS names are records only", live: lotNames.live },
    { rail: "signatures", mode: "EIP-712 typed data", live: true },
    { rail: "trust contract", mode: trustChain ? `OrdoTrust ${cfg.TRUST_CONTRACT_ADDRESS} · ${cfg.TRUST_CHAIN_NAME} (${cfg.TRUST_CHAIN_ID})` : "off: validators approved in-app, no stakes", live: Boolean(trustChain) },
    { rail: "ai", mode: llm.name === "gemini" ? `gemini:${cfg.GEMINI_MODEL}` : llm.name === "claude" ? `claude:${cfg.CLAUDE_MODEL}` : llm.name, live: llm.name !== "offline" },
    { rail: "anchor", mode: anchor.kind, live: anchor.kind !== "local-signed" },
    {
      rail: "agent payments",
      mode: workOrders.live ? `${payer!.kind === "hedera-agent-kit" ? "Hedera Agent Kit" : "agent key"} → OrdoWorkOrders ${cfg.TRUST_WORKORDERS_ADDRESS}` : "off: work orders assign a vendor, no escrow",
      live: workOrders.live,
    },
    { rail: "evidence copies", mode: validation.replicas ? `${validation.replicas.store.kind}, encrypted · ${cfg.ZG_INDEXER_URL}` : "database only", live: Boolean(validation.replicas) },
    { rail: "agent memory", mode: agentMemory.live ? `encrypted versions on ${agentMemory.store!.kind}, keys sealed per site, named on each agent's iNFT` : "off: needs 0G Storage", live: agentMemory.live },
    { rail: "agent iNFTs", mode: inftRail ? `ERC-7857 OrdoAgentNFT ${cfg.ZG_INFT_ADDRESS} · 0G (${cfg.ZG_CHAIN_ID})` : "off", live: Boolean(inftRail) },
    { rail: "lot passports", mode: passportRail ? `HTS NFT ${passportRail.tokenId}` : "in-app passports, no NFT", live: Boolean(passportRail) },
    {
      rail: "pay on proof",
      mode: payOnProof.live ? `${cfg.STABLECOIN_SYMBOL} (Stablecoin Studio ${cfg.STABLECOIN_ADDRESS}) held by OrdoPayOnProof ${cfg.PAY_ON_PROOF_ADDRESS} until OrdoTrust records the release` : "off",
      live: payOnProof.live,
    },
    { rail: "machine wallets", mode: machines.live ? "each machine can hold its own Hedera account and pay over x402" : "off", live: machines.live },
    { rail: "metered mcp", mode: mcp ? `${mcp.tools.length - 1} tools at ${Number(cfg.X402_PRICE_TINYBARS) / 1e8} HBAR a call, paid over x402` : "off", live: Boolean(mcp) },
    {
      rail: "x402 assessments",
      mode: [x402 ? `sells at ${Number(cfg.X402_PRICE_TINYBARS) / 1e8} HBAR to ${x402.terms.payTo}` : null, workOrders.assessments ? "agent buys one per work order" : null].filter(Boolean).join(" · ") || "off",
      live: Boolean(x402 && workOrders.assessments),
    },
    {
      rail: "hedera schedules",
      mode: schedules ? [trustChain && (opts.scheduler || [295, 296, 297].includes(trustChain.cfg.chainId)) ? "escrow refunds · validator payouts" : null, engine.timeouts ? "stage timeouts" : null].filter(Boolean).join(" · ") || "on, nothing to schedule" : "off: the server runs deadlines",
      live: Boolean(schedules),
    },
    {
      rail: "0g private computer",
      mode: contributions.router.network === "mock" ? "off: proof-of-work sessions use the terminal agent's scripted interviewer" : `${contributions.router.model} on the ${contributions.router.network} Router (${contributions.router.baseUrl}), ${TRUST_LABEL[contributions.router.trustMode]} · npx ${cfg.POW_PACKAGE}`,
      live: contributions.router.network !== "mock",
    },
    { rail: "autonomy policies", mode: trustChain?.cfg.policies ? `OrdoPolicies ${cfg.TRUST_POLICIES_ADDRESS}` : "in-app signatures", live: Boolean(trustChain?.cfg.policies) },
    {
      rail: "resource purchasing",
      mode: resources.store ? `vendors' offers sold over x402 (paid to each vendor) · machines buy ahead from their own accounts · receipts signed by ${resources.receiptSigner}` : "off: stages wait for resources until a manager waives them",
      live: Boolean(resources.store && machines.bank),
    },
    {
      rail: "org treasury",
      mode: budgets.live ? `OrdoTreasury ${budgets.rail!.contract}: run budgets and top-ups as Hedera schedules a manager approves (HIP-755)${cfg.HEDERA_TOPIC_ID ? "" : " · no HCS topic, so no over-budget top-ups"}` : "off: machines spend only what their wallets hold",
      live: budgets.live,
    },
    {
      rail: "machine bodies",
      mode: bodyRuntime ? `${bodyRuntime} runtime · ${contributions.router.network === "mock" ? "no 0G brain (bodies label their outputs so)" : `0G brain ${contributions.router.model}`}` : "off: virtual machines are created but their bodies do not run (BODY_RUNTIME)",
      live: Boolean(bodyRuntime && bodyRunners.has(bodyRuntime)),
    },
  ];

  return {
    cfg,
    db,
    access: new AccessControl(db),
    rails,
    warnings,
    policy,
    ledger,
    rec,
    auth,
    sigs,
    plant,
    series,
    templates,
    engine,
    inbox,
    monitor,
    proof,
    validation,
    trust,
    agents,
    workOrders,
    schedules,
    autonomy,
    passports,
    openings,
    jobs,
    names,
    lotNames,
    readings,
    outputs,
    bodies,
    fleet: new Fleet(db, rec, sigs, bodies, cfg.SIGNATURE_CHAIN_ID),
    stageProofs,
    contributions,
    selection,
    cases,
    agentNfts,
    agentLicenses,
    agentMemory,
    x402,
    mcp,
    machines,
    payOnProof,
    ensNames,
    resources,
    budgets,
    advance,
    close: async () => {
      await bodies.shutdown();
      await db.close();
    },
  };
}
