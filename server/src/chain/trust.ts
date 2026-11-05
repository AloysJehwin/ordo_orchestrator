import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, toFunctionSelector, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ReleaseTyped, TypedSignature } from "../auth/auth.js";
import { ORDO_POLICIES_ABI, ORDO_WORK_ORDERS_ABI } from "./ordo-contracts-abi.js";
import { ORDO_TRUST_ABI } from "./ordo-trust-abi.js";

/** On-chain role bits in OrdoTrust. MANAGER is the composite an org manager holds (ADMIN | PLANT_MANAGER | SUPERVISOR | VALIDATOR), granted in one signed call. */
export const CHAIN_ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, VENDOR: 32, DEVICE: 64, TESTER: 128, MANAGER: 30 } as const;
export type ChainRole = keyof typeof CHAIN_ROLE;

export interface TrustChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  address: Address;
  /** OrdoWorkOrders (agent escrow for vendors) and OrdoPolicies (autonomy policies), on the same chain */
  workOrders?: Address | null;
  policies?: Address | null;
  relayerKey: Hex;
  symbol: string;
  /** decimals of msg.value inside the contract: 8 on Hedera (tinybars), 18 elsewhere */
  decimals: number;
}

export interface TrustInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  address: string;
  symbol: string;
  decimals: number;
  minStake: string;
  unstakeCooldownSeconds: number;
  relayer: string;
  workOrders: string | null;
  policies: string | null;
}

export interface OnchainWorkOrder {
  agent: string;
  vendor: string;
  amount: string;
  expiresAt: number;
  status: "none" | "escrowed" | "released" | "refunded";
}
export interface OnchainPolicy {
  level: number;
  policyHash: string;
  version: number;
  updatedAt: number;
}
export interface PolicyUpdate {
  lineId: string;
  level: number;
  policyHash: Hex;
  version: number;
}

/** Per-org reward and slashing parameters (OrdoTrust.Settings): amounts in the chain's smallest unit, windows in seconds */
export interface RewardSettings {
  reward: string;
  fee: string;
  challengeWindow: number;
  responseWindow: number;
  defaultSlashBps: number;
  maxSlashBps: number;
  bountyBps: number;
  falseClaimBps: number;
}
/** What the manager signs to change them: the exact entity OrdoTrust.setSettings checks */
export const settingsEntity = (s: RewardSettings) => `r${s.reward}#f${s.fee}#c${s.challengeWindow}#w${s.responseWindow}#d${s.defaultSlashBps}#m${s.maxSlashBps}#b${s.bountyBps}#x${s.falseClaimBps}`;
export interface OnchainAcceptance {
  contributor: string;
  validator: string;
  reward: string;
  fee: string;
  vestAt: number;
  frozen: boolean;
  settled: boolean;
}
export const CASE_STATUS = ["none", "open", "responded", "upheld", "rejected"] as const;
export interface OnchainCase {
  tester: string;
  validator: string;
  bps: number;
  evidenceHash: Hex;
  responseHash: Hex;
  openedAt: number;
  respondBy: number;
  status: (typeof CASE_STATUS)[number];
  amount: string;
}
export type SigArg = { action: string; entity: string; meaning: string; comment: string; site: string; nonce: string; issuedAt: string; signature: Hex };
export const sigArg = (typed: TypedSignature, signature: string): SigArg => ({ ...typed.message, signature: signature as Hex });

/** A release statement as the contracts take it (OrdoProofs.ReleaseSig). */
export type ReleaseSigArg = Omit<ReleaseTyped["message"], "deadline"> & { deadline: bigint; signature: Hex };
export const releaseSigArg = (typed: ReleaseTyped, signature: string): ReleaseSigArg => ({ ...typed.message, deadline: BigInt(typed.message.deadline), signature: signature as Hex });
/** What a release names (OrdoProofs.ReleaseLot). */
export interface ReleaseLot {
  siteId: string;
  lotLabel: string;
  packageId: string;
  runId: string;
  contentHash: Hex;
  proofRoot: Hex;
}

/**
 * The OrdoTrust contract: roles as non-transferable credentials, validator stakes, releases and
 * slashing. Writes are relayed by Ordo's relayer key, but every one carries a person's EIP-712
 * signature that the contract verifies itself.
 */
export class TrustChain {
  private pub;
  private wallet;
  readonly relayer: Address;
  private infoCache: TrustInfo | null = null;

  constructor(
    readonly cfg: TrustChainConfig,
    transport?: Transport,
  ) {
    const chain = defineChain({ id: cfg.chainId, name: cfg.name, nativeCurrency: { name: cfg.symbol, symbol: cfg.symbol, decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
    const t = transport ?? http(cfg.rpcUrl, { timeout: 20_000 });
    const account = privateKeyToAccount(cfg.relayerKey);
    this.relayer = account.address;
    this.pub = createPublicClient({ chain, transport: t });
    this.wallet = createWalletClient({ chain, transport: t, account });
  }

  private read<T>(functionName: string, args: unknown[]): Promise<T> {
    return this.pub.readContract({ address: this.cfg.address, abi: ORDO_TRUST_ABI, functionName, args } as never) as Promise<T>;
  }
  private async write(functionName: string, args: unknown[], address: Address = this.cfg.address, abi: unknown = ORDO_TRUST_ABI): Promise<Hex> {
    const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account: this.wallet.account } as never);
    const hash = await this.wallet.writeContract(request as never);
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }

  async info(): Promise<TrustInfo> {
    if (this.infoCache) return this.infoCache;
    const [minStake, cooldown] = await Promise.all([this.read<bigint>("minStake", []), this.read<bigint>("unstakeCooldown", [])]);
    this.infoCache = {
      chainId: this.cfg.chainId,
      name: this.cfg.name,
      rpcUrl: this.cfg.rpcUrl,
      explorerUrl: this.cfg.explorerUrl,
      address: this.cfg.address,
      symbol: this.cfg.symbol,
      decimals: this.cfg.decimals,
      minStake: minStake.toString(),
      unstakeCooldownSeconds: Number(cooldown),
      relayer: this.relayer,
      workOrders: this.cfg.workOrders ?? null,
      policies: this.cfg.policies ?? null,
    };
    return this.infoCache;
  }

  /** Whether the deployed OrdoTrust has a function (older deployments lack withdrawFor). */
  async hasFunction(signature: string): Promise<boolean> {
    const code = (await this.pub.getCode({ address: this.cfg.address })) ?? "0x";
    return code.toLowerCase().includes(toFunctionSelector(`function ${signature}`).slice(2));
  }

  txUrl(hash: string): string | null {
    if (!this.cfg.explorerUrl) return null;
    const base = this.cfg.explorerUrl.replace(/\/$/, "");
    return `${base}/${base.includes("hashscan.io") ? "transaction" : "tx"}/${hash}`;
  }

  async siteRegistered(siteId: string): Promise<boolean> {
    const s = await this.read<readonly [boolean, Address]>("sites", [await this.read<Hex>("siteKey", [siteId])]);
    return s[0];
  }
  roles(siteId: string, account: string): Promise<number> {
    return this.read<bigint | number>("roles", [this.keyOf(siteId), account]).then(Number);
  }
  isActiveValidator(siteId: string, account: string): Promise<boolean> {
    return this.read<boolean>("isActiveValidator", [siteId, account]);
  }
  isActiveTester(siteId: string, account: string): Promise<boolean> {
    return this.read<boolean>("isActiveTester", [siteId, account]);
  }
  async stakeOf(siteId: string, account: string): Promise<{ amount: string; unlockAt: number }> {
    const s = await this.read<readonly [bigint, bigint]>("stakes", [this.keyOf(siteId), account]);
    return { amount: s[0].toString(), unlockAt: Number(s[1]) };
  }
  private keyOf(siteId: string): Hex {
    // keccak256(bytes(siteId)), same as OrdoTrust.siteKey
    return keccakUtf8(siteId);
  }

  registerSite(siteId: string, treasury: string, sig: SigArg) {
    return this.write("registerSite", [siteId, treasury, sig]);
  }
  grantRole(siteId: string, account: string, role: ChainRole, sig: SigArg) {
    return this.write("grantRole", [siteId, account, CHAIN_ROLE[role], sig]);
  }
  revokeRole(siteId: string, account: string, role: ChainRole, sig: SigArg) {
    return this.write("revokeRole", [siteId, account, CHAIN_ROLE[role], sig]);
  }
  recordRelease(lot: ReleaseLot, sigs: [ReleaseSigArg, ReleaseSigArg, ReleaseSigArg]) {
    return this.write("recordRelease", [lot, sigs]);
  }

  // ---------------------------------------------------------------- v3: settings, rewards, cases
  async settings(siteId: string): Promise<RewardSettings> {
    const r = await this.read<{ reward: bigint; fee: bigint; challengeWindow: bigint; responseWindow: bigint; defaultSlashBps: number; maxSlashBps: number; bountyBps: number; falseClaimBps: number }>("settings", [siteId]);
    return {
      reward: r.reward.toString(),
      fee: r.fee.toString(),
      challengeWindow: Number(r.challengeWindow),
      responseWindow: Number(r.responseWindow),
      defaultSlashBps: Number(r.defaultSlashBps),
      maxSlashBps: Number(r.maxSlashBps),
      bountyBps: Number(r.bountyBps),
      falseClaimBps: Number(r.falseClaimBps),
    };
  }
  setSettings(siteId: string, st: RewardSettings, sig: SigArg) {
    return this.write("setSettings", [siteId, { ...st, reward: BigInt(st.reward), fee: BigInt(st.fee), challengeWindow: BigInt(st.challengeWindow), responseWindow: BigInt(st.responseWindow) }, sig]);
  }
  async rewardPool(siteId: string): Promise<string> {
    return (await this.read<bigint>("rewardPool", [this.keyOf(siteId)])).toString();
  }
  async claimable(siteId: string, account: string): Promise<string> {
    return (await this.read<bigint>("claimable", [this.keyOf(siteId), account])).toString();
  }
  async acceptance(siteId: string, contributionId: string): Promise<OnchainAcceptance | null> {
    const a = await this.read<readonly [Address, Address, bigint, bigint, bigint, boolean, boolean]>("acceptances", [this.keyOf(siteId), keccakUtf8(contributionId)]);
    if (/^0x0{40}$/i.test(a[0])) return null;
    return { contributor: a[0].toLowerCase(), validator: a[1].toLowerCase(), reward: a[2].toString(), fee: a[3].toString(), vestAt: Number(a[4]), frozen: a[5], settled: a[6] };
  }
  async caseOf(siteId: string, caseId: string): Promise<OnchainCase | null> {
    const c = await this.read<readonly [Address, Address, number, Hex, Hex, bigint, bigint, number, bigint, Hex]>("cases", [this.keyOf(siteId), keccakUtf8(caseId)]);
    if (Number(c[7]) === 0) return null;
    return { tester: c[0].toLowerCase(), validator: c[1].toLowerCase(), bps: Number(c[2]), evidenceHash: c[3], responseHash: c[4], openedAt: Number(c[5]), respondBy: Number(c[6]), status: CASE_STATUS[Number(c[7])] ?? "none", amount: c[8].toString() };
  }
  recordAcceptance(siteId: string, contributionId: string, contributor: string, sig: SigArg) {
    return this.write("recordAcceptance", [siteId, contributionId, contributor, sig]);
  }
  settle(siteId: string, contributionId: string) {
    return this.write("settle", [siteId, contributionId]);
  }
  /** Pays an account's claimable rewards to the account itself; Ordo's relayer pays the gas. */
  claimFor(siteId: string, account: string) {
    return this.write("claimFor", [siteId, account]);
  }
  openCase(siteId: string, caseId: string, validator: string, bps: number, evidenceHash: Hex, acceptanceId: string, sig: SigArg) {
    return this.write("openCase", [siteId, caseId, validator, bps, evidenceHash, acceptanceId, sig]);
  }
  respond(siteId: string, caseId: string, responseHash: Hex, sig: SigArg) {
    return this.write("respond", [siteId, caseId, responseHash, sig]);
  }
  decideCase(siteId: string, caseId: string, uphold: boolean, sig: SigArg) {
    return this.write("decideCase", [siteId, caseId, uphold, sig]);
  }

  // ---------------------------------------------------------------- OrdoWorkOrders
  private orders(): Address {
    if (!this.cfg.workOrders) throw new Error("OrdoWorkOrders is not configured (TRUST_WORKORDERS_ADDRESS)");
    return this.cfg.workOrders;
  }
  private readOrders<T>(functionName: string, args: unknown[]): Promise<T> {
    return this.pub.readContract({ address: this.orders(), abi: ORDO_WORK_ORDERS_ABI, functionName, args } as never) as Promise<T>;
  }
  async fundOf(siteId: string): Promise<{ funds: string; paused: boolean }> {
    const k = this.keyOf(siteId);
    const [funds, paused] = await Promise.all([this.readOrders<bigint>("funds", [k]), this.readOrders<boolean>("paused", [k])]);
    return { funds: funds.toString(), paused };
  }
  async agentOf(siteId: string, agent: string): Promise<{ perOrder: string; perDay: string; spentToday: string }> {
    const [caps, spent] = await Promise.all([this.readOrders<readonly [bigint, bigint]>("caps", [this.keyOf(siteId), agent]), this.readOrders<bigint>("spentToday", [siteId, agent])]);
    return { perOrder: caps[0].toString(), perDay: caps[1].toString(), spentToday: spent.toString() };
  }
  async workOrder(siteId: string, workOrderId: string): Promise<OnchainWorkOrder> {
    const key = await this.readOrders<Hex>("orderKey", [siteId, workOrderId]);
    const w = await this.readOrders<readonly [Address, Address, bigint, bigint, number, Hex]>("workOrders", [key]);
    return { agent: w[0], vendor: w[1], amount: w[2].toString(), expiresAt: Number(w[3]), status: (["none", "escrowed", "released", "refunded"] as const)[Number(w[4])] ?? "none" };
  }
  setAgent(siteId: string, agent: string, perOrder: bigint, perDay: bigint, sig: SigArg) {
    return this.write("setAgent", [siteId, agent, perOrder, perDay, sig], this.orders(), ORDO_WORK_ORDERS_ABI);
  }
  setPaused(siteId: string, stop: boolean, sig: SigArg) {
    return this.write("setPaused", [siteId, stop, sig], this.orders(), ORDO_WORK_ORDERS_ABI);
  }
  releaseWorkOrder(siteId: string, workOrderId: string, sig: SigArg) {
    return this.write("release", [siteId, workOrderId, sig], this.orders(), ORDO_WORK_ORDERS_ABI);
  }
  refundWorkOrder(siteId: string, workOrderId: string) {
    return this.write("refund", [siteId, workOrderId], this.orders(), ORDO_WORK_ORDERS_ABI);
  }

  // ---------------------------------------------------------------- OrdoPolicies
  private policiesAddr(): Address {
    if (!this.cfg.policies) throw new Error("OrdoPolicies is not configured (TRUST_POLICIES_ADDRESS)");
    return this.cfg.policies;
  }
  async policyOf(siteId: string, lineId: string): Promise<OnchainPolicy> {
    const p = (await this.pub.readContract({ address: this.policiesAddr(), abi: ORDO_POLICIES_ABI, functionName: "current", args: [siteId, lineId] } as never)) as {
      level: number;
      policyHash: Hex;
      version: number;
      updatedAt: bigint;
    };
    return { level: Number(p.level), policyHash: p.policyHash, version: Number(p.version), updatedAt: Number(p.updatedAt) };
  }
  publishPolicy(siteId: string, update: PolicyUpdate, sigs: SigArg[]) {
    return this.write("publish", [siteId, update, sigs], this.policiesAddr(), ORDO_POLICIES_ABI);
  }
}

const keccakUtf8 = (s: string): Hex => keccak256(toBytes(s));
