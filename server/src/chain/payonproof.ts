import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, parseAbi, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ORDO_PAY_ON_PROOF_ABI } from "./ordo-payonproof-abi.js";

/** What Ordo calls on a Stablecoin Studio stablecoin's proxy (CashIn, HederaTokenManager and HoldManagement facets) */
export const STABLECOIN_ABI = parseAbi([
  "struct Hold { int64 amount; uint256 expirationTimestamp; address escrow; address to; bytes data; }",
  "function mint(address account, int64 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function createHold(Hold hold) returns (bool, uint256)",
  "event HoldCreated(address indexed operator, address indexed tokenHolder, uint256 holdId, Hold hold, bytes operatorData)",
]);
/** The stablecoin's HTS token through its ERC-20 facade */
const TOKEN_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

export interface PayOnProofConfig {
  rpcUrl: string;
  chainId: number;
  /** the Stablecoin Studio stablecoin (its proxy) */
  coin: Address;
  /** its HTS token's EVM address */
  token: Address;
  /** OrdoPayOnProof */
  address: Address;
  /** Ordo's key: the stablecoin's cash-in role, and it opens and settles orders */
  relayerKey: Hex;
  symbol: string;
  decimals: number;
  explorerUrl?: string;
}

export interface OnchainOrder {
  buyer: Address;
  holdId: bigint;
  amount: bigint;
  expiresAt: number;
  payee: Address;
  ask: bigint;
  state: "none" | "open" | "paid" | "refunded";
}
const STATES = ["none", "open", "paid", "refunded"] as const;

/**
 * Pay on proof, on Hedera's EVM: Ordo USD, a stablecoin made with Stablecoin Studio, and OrdoPayOnProof, which pays a
 * customer's hold only when OrdoTrust records the lot's release. Each party signs its own steps with its own key.
 */
export class PayOnProofChain {
  private pub;
  private chain;
  private transport: Transport;
  readonly relayer: Address;

  constructor(
    readonly cfg: PayOnProofConfig,
    transport?: Transport,
  ) {
    this.chain = defineChain({ id: cfg.chainId, name: `chain-${cfg.chainId}`, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
    this.transport = transport ?? http(cfg.rpcUrl, { timeout: 30_000 });
    this.pub = createPublicClient({ chain: this.chain, transport: this.transport });
    this.relayer = privateKeyToAccount(cfg.relayerKey).address;
  }

  private async send(key: Hex, address: Address, abi: unknown, functionName: string, args: unknown[]) {
    const wallet = createWalletClient({ chain: this.chain, transport: this.transport, account: privateKeyToAccount(key) });
    const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account: wallet.account } as never);
    const hash = await wallet.writeContract(request as never);
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return r;
  }
  private read<T>(functionName: string, args: unknown[]): Promise<T> {
    return this.pub.readContract({ address: this.cfg.address, abi: ORDO_PAY_ON_PROOF_ABI, functionName, args } as never) as Promise<T>;
  }

  txUrl(hash: string): string | null {
    if (!this.cfg.explorerUrl) return null;
    const base = this.cfg.explorerUrl.replace(/\/$/, "");
    return `${base}/${base.includes("hashscan.io") ? "transaction" : "tx"}/${hash}`;
  }

  /** Stablecoin Studio's cash-in: new Ordo USD minted to an account (a customer's deposit) */
  async cashIn(to: Address, amount: bigint): Promise<Hex> {
    return (await this.send(this.cfg.relayerKey, this.cfg.coin, STABLECOIN_ABI, "mint", [to, amount])).transactionHash;
  }
  balanceOf(account: Address): Promise<bigint> {
    return this.pub.readContract({ address: this.cfg.coin, abi: STABLECOIN_ABI, functionName: "balanceOf", args: [account] });
  }
  terms(siteId: string, packageId: string, payee: Address): Promise<Hex> {
    return this.read("terms", [siteId, packageId, payee]);
  }

  /** The customer locks the price on its own balance, for OrdoPayOnProof to release on proof */
  async hold(buyerKey: Hex, amount: bigint, expiresAt: number, data: Hex): Promise<{ hash: Hex; holdId: bigint }> {
    const r = await this.send(buyerKey, this.cfg.coin, STABLECOIN_ABI, "createHold", [{ amount, expirationTimestamp: BigInt(expiresAt), escrow: this.cfg.address, to: "0x0000000000000000000000000000000000000000", data }]);
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== this.cfg.coin.toLowerCase()) continue;
      try {
        const e = decodeEventLog({ abi: STABLECOIN_ABI, data: l.data, topics: l.topics });
        if (e.eventName === "HoldCreated") return { hash: r.transactionHash, holdId: e.args.holdId };
      } catch {}
    }
    throw new Error("The stablecoin did not report the hold");
  }
  async open(buyer: Address, holdId: bigint, siteId: string, packageId: string, payee: Address): Promise<{ hash: Hex; key: Hex }> {
    const r = await this.send(this.cfg.relayerKey, this.cfg.address, ORDO_PAY_ON_PROOF_ABI, "open", [buyer, holdId, siteId, packageId, payee]);
    return { hash: r.transactionHash, key: await this.read<Hex>("keyOf", [buyer, holdId]) };
  }
  async order(key: Hex): Promise<OnchainOrder> {
    const [buyer, holdId, amount, expiresAt, , , payee, ask, state] = await this.read<readonly [Address, bigint, bigint, bigint, Hex, Hex, Address, bigint, number]>("orders", [key]);
    return { buyer, holdId, amount, expiresAt: Number(expiresAt), payee, ask, state: STATES[state] ?? "none" };
  }
  async releasedAt(key: Hex): Promise<number> {
    return Number(await this.read<bigint>("releasedAt", [key]));
  }
  async settle(key: Hex): Promise<Hex> {
    return (await this.send(this.cfg.relayerKey, this.cfg.address, ORDO_PAY_ON_PROOF_ABI, "settle", [key])).transactionHash;
  }
  async refundExpired(key: Hex): Promise<Hex> {
    return (await this.send(this.cfg.relayerKey, this.cfg.address, ORDO_PAY_ON_PROOF_ABI, "refundExpired", [key])).transactionHash;
  }
  async waive(key: Hex, payeeKey: Hex): Promise<Hex> {
    return (await this.send(payeeKey, this.cfg.address, ORDO_PAY_ON_PROOF_ABI, "waive", [key])).transactionHash;
  }
  async offer(key: Hex, ask: bigint, payeeKey: Hex): Promise<Hex> {
    return (await this.send(payeeKey, this.cfg.address, ORDO_PAY_ON_PROOF_ABI, "offer", [key, ask])).transactionHash;
  }
  /** A financier buys the receivable: it lets OrdoPayOnProof take the price from its balance, then takes the receivable */
  async take(key: Hex, price: bigint, buyerKey: Hex): Promise<Hex> {
    await this.send(buyerKey, this.cfg.token, TOKEN_ABI, "approve", [this.cfg.address, price]);
    return (await this.send(buyerKey, this.cfg.address, ORDO_PAY_ON_PROOF_ABI, "take", [key, price])).transactionHash;
  }
}
