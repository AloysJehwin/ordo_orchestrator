/**
 * ENSv2 on Sepolia. Every name that holds others has its own registry: Ordo's root (ordo.eth, registered once by
 * setup:ens) points at a UserRegistry the ENS owner account administers, and OrdoNames (setup:ens-contracts) issues
 * everything under it in batches: orgs with their registries, people's handles, role names, machines, agents, runs
 * and stages. Records live in Ordo's PermissionedResolver; run names resolve through OrdoRunResolver, which adds the
 * release records.
 *
 * A person's name is minted to the person's own wallet with no roles on the token, so it cannot be transferred or
 * repointed: it is a credential that says who they are in the org, and OrdoNames reads roles from the names held.
 */
import {
  bytesToHex,
  concat,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  formatEther,
  http,
  keccak256,
  labelhash,
  namehash,
  parseAbi,
  stringToBytes,
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ORDO_NAMES_ABI, ORDO_RUN_RESOLVER_ABI } from "./ordo-ens-abi.js";

/** The contracts ENS Labs deployed on Sepolia on 2026-10-01 (contracts-v2, deploy/mainnet-v2-20261002). */
export const ENSV2_SEPOLIA = {
  verifiableFactory: "0xda70306c98e97ece36f997a21368e53298572991",
  userRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
  permissionedResolverImpl: "0x115eb53f0c60696633855f90b138178fb40b2b2c",
  ethRegistrar: "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3",
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  mockUsdc: "0x240b0316df57887dbbe58b586508b19e633a14aa",
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
} as const;

/** Every role and its admin role (each role is one bit at 4k, admins shifted by 128). */
export const ALL_ROLES = BigInt(`0x${"1".repeat(64)}`);
/** ENSv2 registry roles OrdoNames needs on the root's registry, and what a manager gets on their org's */
export const ROLE_REGISTRAR = 1n << 0n;
export const ROLE_UNREGISTER = 1n << 12n;
export const ROLE_RENEW = 1n << 16n;
export const ROLE_SET_SUBREGISTRY = 1n << 20n;
export const ROLE_SET_RESOLVER = 1n << 24n;
export const NAMES_ROOT_ROLES = ROLE_REGISTRAR | ROLE_UNREGISTER | ROLE_RENEW | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER;
/** PermissionedResolver roles: set address, set text, set contenthash */
export const NAMES_RESOLVER_ROLES = (1n << 0n) | (1n << 4n) | (1n << 8n);
const COIN_ETH = 60n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export const ENSV2_ABI = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
  "function initialize(Grant[] grants)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function unregister(uint256 anyId)",
  "function setParent(address parent, string label)",
  "function findOwner(string label) view returns (address)",
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function setResolver(uint256 anyId, address resolver)",
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function multicall(bytes[] calls) returns (bytes[])",
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
]);
const RESOLVER_INIT_ABI = parseAbi(["struct Grant { address account; uint256 roleBitmap; }", "function initialize(Grant[] grants, bytes[] calls)"]);

/** The custom errors a batched name operation can fail with, so `Failed` reasons read as words. */
const OP_ERRORS = parseAbi([
  "error CannotReduceExpiry(uint64 oldExpiry, uint64 newExpiry)",
  "error CannotSetPastExpiry(uint64 expiry)",
  "error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACInvalidAccount()",
  "error EACInvalidRoleBitmap(uint256 roleBitmap)",
  "error EACMaxAssignees(uint256 resource, uint256 role)",
  "error EACMinAssignees(uint256 resource, uint256 role)",
  "error EACRootResourceNotAllowed()",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error ERC1155InvalidReceiver(address receiver)",
  "error FailedCall()",
  "error InvalidOwner()",
  "error LabelAlreadyRegistered(string label)",
  "error LabelAlreadyReserved(string label)",
  "error LabelExpired(uint256 tokenId)",
  "error DNSDecodingFailed(bytes dns)",
  "error InvalidEVMAddress(bytes addressBytes)",
  "error InvalidRecord()",
  "error UnsupportedResolverProfile(bytes4 selector)",
  "error Taken(string label, address holder)",
  "error UnknownOp(uint8 kind)",
  "error WrongRegistry(address expected, address made)",
  "error Error(string message)",
]);

/** A failed operation's revert data as words: "LabelAlreadyRegistered(acme)", or the selector when unknown. */
export function opErrorMessage(reason: Hex): string {
  if (!reason || reason === "0x") return "reverted with no reason (out of gas?)";
  try {
    const r = decodeErrorResult({ abi: OP_ERRORS, data: reason });
    return `${r.errorName}${r.args?.length ? `(${(r.args as readonly unknown[]).map(String).join(", ")})` : ""}`;
  } catch {
    return `reverted ${reason.slice(0, 10)}`;
  }
}

/** DNS wire format of a name, as ENSv2 resolvers take it. */
export function dnsEncode(name: string): Hex {
  const parts = name
    .split(".")
    .filter(Boolean)
    .map((l) => {
      const b = stringToBytes(l);
      if (b.length > 63) throw new Error(`Label too long: ${l}`);
      return concat([new Uint8Array([b.length]), b]);
    });
  return bytesToHex(concat([...parts, new Uint8Array([0])]));
}

/** A DNS-safe label from a display name: "Priya Raman" → "priya-raman". */
export function toLabel(s: string): string {
  const l = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return l || "x";
}

/** A Hedera account's long-zero EVM address (0.0.1234 → 0x…04d2), the form its ENSIP-11 record takes. */
export function hederaEvm(account: string): Address | null {
  const m = /^0\.0\.(\d+)$/.exec(account.trim());
  if (!m) return null;
  return `0x${BigInt(m[1]!).toString(16).padStart(40, "0")}` as Address;
}
/** The account a long-zero EVM address stands for (0x…04d2 → 0.0.1234), or null for any other address. */
export function hederaAccountOf(evm: string): string | null {
  const h = evm.toLowerCase().replace(/^0x/, "");
  if (h.length !== 40 || !h.startsWith("000000000000000000000000")) return null;
  return `0.0.${BigInt(`0x${h}`).toString()}`;
}

export interface EnsV2Config {
  /** one RPC URL, or several separated by commas (tried in order) */
  rpcUrl: string;
  ownerKey: Hex;
  /** Ordo's root name (ordo.eth) and the UserRegistry it points at */
  parentName: string;
  parentRegistry: Address;
  resolver: Address;
  factory?: Address;
  userRegistryImpl?: Address;
  /** Tests run against anvil (chain 31337) */
  chainId?: number;
  /** OrdoNames (issues names in batches, reads roles from them) and OrdoRunResolver (releases), once deployed */
  names?: Address;
  runResolver?: Address;
}

export type TxState = { state: "pending" } | { state: "success"; logs: { data: Hex; topics: Hex[] }[] } | { state: "reverted"; hash: Hex };

/** One operation in an OrdoNames batch (OrdoNames.Op). */
export interface NameOp {
  kind: number;
  parent: Address;
  label: string;
  owner: Address;
  resolver: Address;
  salt: bigint;
  expiry: bigint;
  roles: bigint;
  records: Hex[];
  site: Hex;
  slot: number;
  member: number;
}
export const OP = { issue: 0, records: 1, revoke: 2, grant: 3, ungrant: 4 } as const;

/** How a batch went: per operation, the registry it made (applied) or why it failed. */
export type BatchState =
  | { state: "pending" }
  | { state: "reverted"; gasUsed: bigint; feeWei: bigint }
  | { state: "mined"; gasUsed: bigint; feeWei: bigint; applied: Map<number, Address>; failed: Map<number, string> };

/** Text, address and Hedera-account records for a name, as calls on Ordo's resolver. */
export function recordCalls(name: string, r: { texts?: Record<string, string>; addr?: Address | null; coin?: { type: number; evm: Address } | null }): Hex[] {
  const dns = dnsEncode(name);
  const calls = Object.entries(r.texts ?? {}).map(([k, v]) => encodeFunctionData({ abi: ENSV2_ABI, functionName: "setText", args: [dns, k, v] }));
  if (r.addr) calls.push(encodeFunctionData({ abi: ENSV2_ABI, functionName: "setAddress", args: [dns, COIN_ETH, r.addr] }));
  if (r.coin) calls.push(encodeFunctionData({ abi: ENSV2_ABI, functionName: "setAddress", args: [dns, BigInt(r.coin.type), r.coin.evm] }));
  return calls;
}

/** viem transport over one or more comma-separated RPC URLs. */
export function rpcTransport(urls: string, timeout = 30_000): Transport {
  const list = urls
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return list.length === 1 ? http(list[0], { timeout }) : fallback(list.map((u) => http(u, { timeout })));
}

/**
 * Writes return as soon as a transaction is broadcast; `check` and `batchState` report later whether it landed.
 * Sepolia blocks take ~12 s, so Ordo's engine cycle sends in one pass and confirms in a later one instead of waiting.
 */
export class EnsV2 {
  private pub;
  private wallet;
  private account;
  readonly owner: Address;
  readonly factory: Address;
  readonly userRegistryImpl: Address;
  private predicted = new Map<string, Address>();

  constructor(
    readonly cfg: EnsV2Config,
    transport?: Transport,
  ) {
    const chain = { ...sepolia, id: cfg.chainId ?? sepolia.id };
    const t = transport ?? rpcTransport(cfg.rpcUrl);
    const account = privateKeyToAccount(cfg.ownerKey, { nonceManager });
    this.account = account;
    this.owner = account.address;
    this.pub = createPublicClient({ chain, transport: t });
    this.wallet = createWalletClient({ chain, transport: t, account });
    this.factory = cfg.factory ?? ENSV2_SEPOLIA.verifiableFactory;
    this.userRegistryImpl = cfg.userRegistryImpl ?? ENSV2_SEPOLIA.userRegistryImpl;
  }

  private async send(address: Address, functionName: string, args: unknown[], abi: Abi = ENSV2_ABI, gas?: bigint): Promise<Hex> {
    try {
      const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account: this.wallet.account, ...(gas ? { gas } : {}) } as never);
      return await this.wallet.writeContract(request as never);
    } catch (e) {
      // a failed send may leave the nonce manager ahead of the chain
      nonceManager.reset({ address: this.owner, chainId: this.pub.chain!.id });
      throw e;
    }
  }
  private read<T>(address: Address, functionName: string, args: unknown[], abi: Abi = ENSV2_ABI): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  }
  private need(a: Address | undefined, what: string): Address {
    if (!a) throw new Error(`${what} is not configured`);
    return a;
  }

  /** Where a set of transactions stands: pending until all are mined; reverted names the first that failed. */
  async check(hashes: Hex[]): Promise<TxState> {
    const logs: { data: Hex; topics: Hex[] }[] = [];
    for (const hash of hashes) {
      const r = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (!r) return { state: "pending" };
      if (r.status !== "success") return { state: "reverted", hash };
      logs.push(...r.logs.map((l) => ({ data: l.data, topics: l.topics as Hex[] })));
    }
    return { state: "success", logs };
  }
  /** Wait for transactions (scripts and tests; the app uses check). */
  async wait(hashes: Hex[]) {
    for (const hash of hashes) await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    const s = await this.check(hashes);
    if (s.state !== "success") throw new Error(s.state === "reverted" ? `reverted: ${s.hash}` : "not mined");
    return s.logs;
  }

  txUrl(hash: string) {
    return this.cfg.chainId && this.cfg.chainId !== sepolia.id ? null : `https://sepolia.etherscan.io/tx/${hash}`;
  }
  appUrl(name: string) {
    return `https://sepolia.app.ens.domains/${name}`;
  }
  addressUrl(address: string) {
    return this.cfg.chainId && this.cfg.chainId !== sepolia.id ? null : `https://sepolia.etherscan.io/address/${address}`;
  }

  // ---------------------------------------------------------------- OrdoNames batches
  get namesLive() {
    return Boolean(this.cfg.names);
  }
  get releasesLive() {
    return Boolean(this.cfg.names && this.cfg.runResolver);
  }

  /** The address of the registry OrdoNames makes with `salt` (it deploys it the first time a name needs it). */
  async predictRegistry(salt: bigint): Promise<Address> {
    const k = salt.toString();
    const hit = this.predicted.get(k);
    if (hit) return hit;
    const a = await this.read<Address>(this.need(this.cfg.names, "ENS_NAMES_ADDRESS"), "predictRegistry", [salt], ORDO_NAMES_ABI as Abi);
    this.predicted.set(k, a);
    return a;
  }

  /**
   * Send a batch with an explicit gas limit. Operations that fail inside it are reported (Failed), not reverted, which
   * is also why gas is not estimated: estimation would settle on a limit where some operations run out and are caught.
   * Callers pass a generous limit from per-operation guides; unused gas costs nothing.
   */
  async sendExecute(ops: NameOp[], gas: bigint): Promise<Hex> {
    try {
      const data = encodeFunctionData({ abi: ORDO_NAMES_ABI as Abi, functionName: "execute", args: [ops] });
      return await this.wallet.sendTransaction({ to: this.need(this.cfg.names, "ENS_NAMES_ADDRESS"), data, gas } as never);
    } catch (e) {
      nonceManager.reset({ address: this.owner, chainId: this.pub.chain!.id });
      throw e;
    }
  }

  /**
   * Gas one operation needs, measured on its own: `executeOne` has no try/catch around it, so the estimate is the gas
   * at which the operation really succeeds. Null when it cannot be measured yet (its parent is in the same batch) or
   * would fail anyway.
   */
  async estimateOne(op: NameOp): Promise<bigint | null> {
    const names = this.need(this.cfg.names, "ENS_NAMES_ADDRESS");
    try {
      return await this.pub.estimateGas({ account: names, to: names, data: encodeFunctionData({ abi: ORDO_NAMES_ABI as Abi, functionName: "executeOne", args: [op, 0n] }) });
    } catch {
      return null;
    }
  }

  /** How a batch went, operation by operation. */
  async batchState(hash: Hex): Promise<BatchState> {
    const r = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
    if (!r) return { state: "pending" };
    const feeWei = r.gasUsed * (r.effectiveGasPrice ?? 0n);
    if (r.status !== "success") return { state: "reverted", gasUsed: r.gasUsed, feeWei };
    const applied = new Map<number, Address>();
    const failed = new Map<number, string>();
    const names = this.cfg.names!.toLowerCase();
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== names) continue;
      try {
        const e = decodeEventLog({ abi: ORDO_NAMES_ABI as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.eventName === "Applied") {
          const a = e.args as unknown as { index: bigint; registry: Address };
          applied.set(Number(a.index), a.registry);
        } else if (e.eventName === "Failed") {
          const a = e.args as unknown as { index: bigint; reason: Hex };
          failed.set(Number(a.index), opErrorMessage(a.reason));
        }
      } catch {}
    }
    return { state: "mined", gasUsed: r.gasUsed, feeWei, applied, failed };
  }

  /** Role bits a wallet holds at a site through the names it holds, as contracts see them. */
  async roles(siteId: string, account: Address): Promise<number> {
    return Number(await this.read<number>(this.need(this.cfg.names, "ENS_NAMES_ADDRESS"), "roles", [keccak256(stringToBytes(siteId)), account], ORDO_NAMES_ABI as Abi));
  }
  /** The name a wallet goes by at a site, as OrdoNames knows it ("" if none). */
  nameOf(siteId: string, account: Address): Promise<string> {
    return this.read<string>(this.need(this.cfg.names, "ENS_NAMES_ADDRESS"), "nameOf", [keccak256(stringToBytes(siteId)), account], ORDO_NAMES_ABI as Abi);
  }
  /** Does `account` hold these root roles on a registry or resolver? */
  hasRootRoles(target: Address, roles: bigint, account: Address): Promise<boolean> {
    return this.read<boolean>(target, "hasRootRoles", [roles, account]);
  }

  /** Sepolia's base fee in gwei. */
  async baseFeeGwei(): Promise<number> {
    const b = await this.pub.getBlock();
    return Number(b.baseFeePerGas ?? 0n) / 1e9;
  }
  /** The ENS owner account's balance in ETH. */
  async balanceEth(): Promise<number> {
    return Number(formatEther(await this.pub.getBalance({ address: this.owner })));
  }
  /** Is there contract code at an address? */
  async hasCode(address: Address): Promise<boolean> {
    return ((await this.pub.getCode({ address })) ?? "0x") !== "0x";
  }

  /** Record a release on the run's own resolver (the one its name was issued with), else the configured one. */
  sendRecordRelease(i: { lot: unknown; sigs: unknown[]; proofs: unknown[]; params: unknown[]; resolver?: Address | null }): Promise<Hex> {
    return this.send(i.resolver ?? this.need(this.cfg.runResolver, "ENS_RUN_RESOLVER_ADDRESS"), "recordRelease", [i.lot, i.sigs, i.proofs, i.params], ORDO_RUN_RESOLVER_ABI as Abi);
  }

  private v2 = new Map<string, Promise<boolean>>();
  /**
   * Whether a run resolver checks which machine ran each stage (OrdoRunResolver v2, which has ATTESTERS): its runs
   * then carry a com.ordo.machine.<stage> record for each stage. Remembered per address.
   */
  machineScoped(resolver: Address): Promise<boolean> {
    const k = resolver.toLowerCase();
    let p = this.v2.get(k);
    if (!p) {
      p = this.read<number>(resolver, "ATTESTERS", [], ORDO_RUN_RESOLVER_ABI as Abi).then(
        (n) => Number(n) > 0,
        (e: unknown) => {
          // v1 has no ATTESTERS: the call reverts or returns nothing. Anything else (the RPC) is asked again next time,
          // and fails the caller rather than passing for v1, which would drop a v2 run's machine records.
          for (let c = e as { name?: string; cause?: unknown } | undefined; c; c = c.cause as typeof c)
            if (/Revert|ZeroData|FunctionNotFound/.test(c.name ?? "")) return false;
          this.v2.delete(k);
          throw e;
        },
      );
      this.v2.set(k, p);
    }
    return p;
  }

  // ---------------------------------------------------------------- reading records
  /** Read a record through a resolver the way a client would (ENSIP-10 resolve). Defaults to Ordo's resolver. */
  private async resolveCall(name: string, data: Hex, resolver?: Address): Promise<Hex> {
    return this.read<Hex>(resolver ?? this.cfg.resolver, "resolve", [dnsEncode(name), data]);
  }
  async text(name: string, key: string, resolver?: Address): Promise<string> {
    const out = await this.resolveCall(name, encodeFunctionData({ abi: ENSV2_ABI, functionName: "text", args: [namehash(name), key] }), resolver);
    return decodeFunctionResult({ abi: ENSV2_ABI, functionName: "text", data: out }) as string;
  }
  async addr(name: string, resolver?: Address): Promise<Address> {
    const out = await this.resolveCall(name, encodeFunctionData({ abi: ENSV2_ABI, functionName: "addr", args: [namehash(name)] }), resolver);
    return decodeFunctionResult({ abi: ENSV2_ABI, functionName: "addr", data: out }) as Address;
  }
  /** An ENSIP-11 address record (bytes; "0x" when unset). */
  async coinAddr(name: string, coinType: number, resolver?: Address): Promise<Hex> {
    const out = await this.resolveCall(name, encodeFunctionData({ abi: ENSV2_ABI, functionName: "addr", args: [namehash(name), BigInt(coinType)] }), resolver);
    return decodeFunctionResult({ abi: ENSV2_ABI, functionName: "addr", args: [namehash(name), BigInt(coinType)], data: out } as never) as Hex;
  }

  /**
   * Resolve any name through ENS's Universal Resolver: its addr(60) and an ENSIP-11 record. Names outside Ordo go
   * this way; Ordo's own are answered from its table first.
   */
  async resolveName(name: string, coinType?: number): Promise<{ addr: Address | null; coin: Hex | null }> {
    const ur = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes result, address resolver)"]);
    const call = async (data: Hex) => {
      const [result] = (await this.pub.readContract({ address: ENSV2_SEPOLIA.universalResolver, abi: ur, functionName: "resolve", args: [dnsEncode(name), data] })) as readonly [Hex, Address];
      return result;
    };
    const node = namehash(name);
    const a = await call(encodeFunctionData({ abi: ENSV2_ABI, functionName: "addr", args: [node] })).catch(() => null);
    const addr = a ? (decodeFunctionResult({ abi: ENSV2_ABI, functionName: "addr", data: a }) as Address) : null;
    let coin: Hex | null = null;
    if (coinType !== undefined) {
      const c = await call(encodeFunctionData({ abi: ENSV2_ABI, functionName: "addr", args: [node, BigInt(coinType)] })).catch(() => null);
      coin = c ? (decodeFunctionResult({ abi: ENSV2_ABI, functionName: "addr", args: [node, BigInt(coinType)], data: c } as never) as Hex) : null;
    }
    return { addr: addr && addr !== ZERO ? addr : null, coin: coin && coin !== "0x" ? coin : null };
  }

  // ---------------------------------------------------------------- direct writes from the owner account (scripts and tests)
  /** Deploy a new UserRegistry administered by the owner. Its address comes from the receipt (registryFrom). */
  sendCreateRegistry(salt: bigint): Promise<Hex> {
    return this.send(this.factory, "deployProxy", [this.userRegistryImpl, salt, registryInitData(this.owner)]);
  }
  registryFrom(logs: { data: Hex; topics: Hex[] }[]): Address {
    for (const l of logs) {
      try {
        const e = decodeEventLog({ abi: ENSV2_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.eventName === "ProxyDeployed") return (e.args as { proxyAddress: Address }).proxyAddress;
      } catch {}
    }
    throw new Error("VerifiableFactory did not report the new registry");
  }

  /** Register `label` in `registry` with its records, linking its own registry when it has one. */
  async sendIssue(i: { registry: Address; label: string; name: string; owner: Address; subregistry?: Address; roleBitmap?: bigint; expiresAt: number; texts: Record<string, string>; addr?: Address }): Promise<Hex[]> {
    const out: Hex[] = [];
    if (i.subregistry) out.push(await this.send(i.subregistry, "setParent", [i.registry, i.label]));
    const current = await this.read<Address>(i.registry, "findOwner", [i.label]);
    if (current.toLowerCase() !== i.owner.toLowerCase())
      out.push(await this.send(i.registry, "register", [i.label, i.owner, i.subregistry ?? ZERO, this.cfg.resolver, i.roleBitmap ?? 0n, BigInt(Math.floor(i.expiresAt / 1000))]));
    out.push(await this.sendRecords(i.name, i.texts, i.addr));
    return out;
  }

  sendRecords(name: string, texts: Record<string, string>, addr?: Address): Promise<Hex> {
    return this.send(this.cfg.resolver, "multicall", [recordCalls(name, { texts, addr })]);
  }

  /** Burn the name (its records stay, marked revoked). */
  async sendRevoke(registry: Address, label: string, name: string): Promise<Hex[]> {
    const out: Hex[] = [];
    if ((await this.read<Address>(registry, "findOwner", [label])) !== ZERO) out.push(await this.send(registry, "unregister", [BigInt(labelhash(label))]));
    out.push(await this.sendRecords(name, { "com.ordo.status": "revoked" }));
    return out;
  }

  ownerOf(registry: Address, label: string): Promise<Address> {
    return this.read<Address>(registry, "findOwner", [label]);
  }
  subregistryOf(registry: Address, label: string): Promise<Address> {
    return this.read<Address>(registry, "getSubregistry", [label]);
  }
  resolverOf(registry: Address, label: string): Promise<Address> {
    return this.read<Address>(registry, "getResolver", [label]);
  }
}

/** Calldata to deploy Ordo's resolver through the VerifiableFactory, with the owner holding every role. */
export const resolverInitData = (owner: Address) => encodeFunctionData({ abi: RESOLVER_INIT_ABI, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }], []] });
/** Calldata to deploy a UserRegistry through the VerifiableFactory, with the owner holding every role. */
export const registryInitData = (owner: Address) => encodeFunctionData({ abi: ENSV2_ABI, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }]] });
