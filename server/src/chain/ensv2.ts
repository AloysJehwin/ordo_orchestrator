/**
 * ENSv2 on Sepolia. Every name has its own registry: Ordo's parent name (registered once by the ENS setup workflow)
 * points at a UserRegistry Ordo administers; each site gets its own UserRegistry under it, and people, assets and
 * agents are names in their site's registry. Records live in Ordo's PermissionedResolver.
 *
 * A person's name is minted to the person's own wallet with no roles on the token, so it cannot be transferred or
 * repointed: it is a credential that says who they are at the site. The site keeps the registry's root roles, so it
 * can revoke the name when the person leaves.
 */
import {
  bytesToHex,
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
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
import { ORDO_ENS_ROLES_ABI, ORDO_LOT_RESOLVER_ABI } from "./ordo-ens-abi.js";

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
const COIN_ETH = 60n;

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
]);
const RESOLVER_INIT_ABI = parseAbi(["struct Grant { address account; uint256 roleBitmap; }", "function initialize(Grant[] grants, bytes[] calls)"]);

/** DNS wire format of a name, as ENSv2 resolvers take it. */
export function dnsEncode(name: string): Hex {
  const parts = name.split(".").filter(Boolean).map((l) => {
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

export interface EnsV2Config {
  rpcUrl: string;
  ownerKey: Hex;
  /** Ordo's parent name, e.g. ordo-mfg.eth, and the UserRegistry it points at */
  parentName: string;
  parentRegistry: Address;
  resolver: Address;
  factory?: Address;
  userRegistryImpl?: Address;
  /** Tests run against anvil (chain 31337) */
  chainId?: number;
  /** OrdoEnsRoles (roles read from member names) and OrdoLotResolver (lot names), once deployed */
  credentials?: Address;
  lotResolver?: Address;
}

export type TxState = { state: "pending" } | { state: "success"; logs: { data: Hex; topics: Hex[] }[] } | { state: "reverted"; hash: Hex };

/**
 * Writes return as soon as a transaction is broadcast; `check` reports later whether it landed. Sepolia blocks take
 * ~12 s, so Ordo's engine cycle sends in one pass and confirms in a later one instead of waiting.
 */
export class EnsV2 {
  private pub;
  private wallet;
  private account;
  readonly owner: Address;
  readonly factory: Address;
  readonly userRegistryImpl: Address;

  constructor(
    readonly cfg: EnsV2Config,
    transport?: Transport,
  ) {
    const chain = { ...sepolia, id: cfg.chainId ?? sepolia.id };
    const t = transport ?? http(cfg.rpcUrl, { timeout: 30_000 });
    const account = privateKeyToAccount(cfg.ownerKey, { nonceManager });
    this.account = account;
    this.owner = account.address;
    this.pub = createPublicClient({ chain, transport: t });
    this.wallet = createWalletClient({ chain, transport: t, account });
    this.factory = cfg.factory ?? ENSV2_SEPOLIA.verifiableFactory;
    this.userRegistryImpl = cfg.userRegistryImpl ?? ENSV2_SEPOLIA.userRegistryImpl;
  }

  private async send(address: Address, functionName: string, args: unknown[], abi: Abi = ENSV2_ABI): Promise<Hex> {
    const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account: this.wallet.account } as never);
    return this.wallet.writeContract(request as never);
  }
  private read<T>(address: Address, functionName: string, args: unknown[], abi: Abi = ENSV2_ABI): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
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

  /** Deploy a new UserRegistry for a site, administered by Ordo. Its address comes from the receipt (registryFrom). */
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

  /**
   * Register `label` in `registry` with its records (and, for a site, link its own registry to the parent). The owner
   * gets `roleBitmap` on the name: 0 makes it a credential its owner holds but cannot transfer or repoint. Skips the
   * registration if a previous attempt already made it.
   */
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
    const dns = dnsEncode(name);
    const calls = Object.entries(texts).map(([k, v]) => encodeFunctionData({ abi: ENSV2_ABI, functionName: "setText", args: [dns, k, v] }));
    if (addr) calls.push(encodeFunctionData({ abi: ENSV2_ABI, functionName: "setAddress", args: [dns, COIN_ETH, addr] }));
    return this.send(this.cfg.resolver, "multicall", [calls]);
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

  /** Read a text record from Ordo's resolver, the way a resolver client would (ENSIP-10 resolve). */
  async text(name: string, key: string): Promise<string> {
    const data = encodeFunctionData({ abi: ENSV2_ABI, functionName: "text", args: [namehash(name), key] });
    const out = await this.read<Hex>(this.cfg.resolver, "resolve", [dnsEncode(name), data]);
    return decodeFunctionResult({ abi: ENSV2_ABI, functionName: "text", data: out }) as string;
  }
  async addr(name: string): Promise<Address> {
    const data = encodeFunctionData({ abi: ENSV2_ABI, functionName: "addr", args: [namehash(name)] });
    const out = await this.read<Hex>(this.cfg.resolver, "resolve", [dnsEncode(name), data]);
    return decodeFunctionResult({ abi: ENSV2_ABI, functionName: "addr", data: out }) as Address;
  }

  // ---------------------------------------------------------------- credentials and lot names (OrdoEnsRoles, OrdoLotResolver)
  get credentialsLive() {
    return Boolean(this.cfg.credentials && this.cfg.lotResolver);
  }
  private need(a: Address | undefined, what: string): Address {
    if (!a) throw new Error(`${what} is not configured`);
    return a;
  }
  /** The site label OrdoEnsRoles has for an Ordo site id ("" when not linked). */
  linkedLabel(siteId: string): Promise<string> {
    return this.read<string>(this.need(this.cfg.credentials, "ENS_ROLES_ADDRESS"), "siteLabel", [keccak256(stringToBytes(siteId))], ORDO_ENS_ROLES_ABI as Abi);
  }
  /** Tie a site id to its name in OrdoEnsRoles (Ordo owns the site name, so it may). */
  sendLinkSite(siteId: string, label: string): Promise<Hex> {
    return this.send(this.need(this.cfg.credentials, "ENS_ROLES_ADDRESS"), "linkSite", [siteId, label], ORDO_ENS_ROLES_ABI as Abi);
  }
  /** The resolver a name in a registry points at. */
  resolverOf(registry: Address, label: string): Promise<Address> {
    return this.read<Address>(registry, "getResolver", [label]);
  }
  /** Point a site name at the lot resolver, which answers its lot-… names and passes the rest to Ordo's resolver. */
  sendUseLotResolver(label: string): Promise<Hex> {
    return this.send(this.cfg.parentRegistry, "setResolver", [BigInt(labelhash(label)), this.need(this.cfg.lotResolver, "ENS_LOT_RESOLVER_ADDRESS")]);
  }
  /** Role bits a wallet holds at a site through its member name, as the contracts see them. */
  async rolesOf(siteId: string, label: string, account: Address): Promise<number> {
    return Number(await this.read<number>(this.need(this.cfg.credentials, "ENS_ROLES_ADDRESS"), "rolesOf", [keccak256(stringToBytes(siteId)), label, account], ORDO_ENS_ROLES_ABI as Abi));
  }
  sendRecordRelease(i: { lot: unknown; sigs: unknown[]; proofs: unknown[]; params: unknown[] }): Promise<Hex> {
    return this.send(this.need(this.cfg.lotResolver, "ENS_LOT_RESOLVER_ADDRESS"), "recordRelease", [i.lot, i.sigs, i.proofs, i.params], ORDO_LOT_RESOLVER_ABI as Abi);
  }
  /** Sign a CCIP-Read answer the way OrdoLotResolver.resolveWithProof checks it. */
  signAnswer(request: Hex, result: Hex, expires: bigint): Promise<Hex> {
    const resolver = this.need(this.cfg.lotResolver, "ENS_LOT_RESOLVER_ADDRESS");
    const hash = keccak256(encodePacked(["bytes2", "address", "uint64", "bytes32", "bytes32"], ["0x1900", resolver, expires, keccak256(request), keccak256(result)]));
    return this.account.sign!({ hash });
  }
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Calldata to deploy Ordo's resolver through the VerifiableFactory, with the owner holding every role. */
export const resolverInitData = (owner: Address) => encodeFunctionData({ abi: RESOLVER_INIT_ABI, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }], []] });
/** Calldata to deploy a UserRegistry through the VerifiableFactory, with the owner holding every role. */
export const registryInitData = (owner: Address) => encodeFunctionData({ abi: ENSV2_ABI, functionName: "initialize", args: [[{ account: owner, roleBitmap: ALL_ROLES }]] });
