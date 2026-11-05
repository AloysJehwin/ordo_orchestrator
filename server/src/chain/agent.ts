import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ORDO_WORK_ORDERS_ABI } from "./ordo-contracts-abi.js";

/** What the maintenance agent asks OrdoWorkOrders to hold for a work order. Amount in contract units. */
export interface EscrowRequest {
  siteId: string;
  workOrderId: string;
  vendor: Address;
  amount: bigint;
  ttlSeconds: number;
  incidentHash: Hex;
}
export interface EscrowResult {
  txId: string;
  url: string | null;
}

/** The agent's own account. It, not the relayer, is msg.sender of every escrow: the contract caps it. */
export interface AgentPayer {
  /** "hedera-agent-kit" on Hedera with an agent account id; "evm" elsewhere */
  readonly kind: string;
  readonly address: Address;
  escrow(r: EscrowRequest): Promise<EscrowResult>;
}

export interface AgentChain {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  workOrders: Address;
}

/** Plain JSON-RPC payer: any EVM chain, and the in-process chain in tests. */
export class EvmAgentPayer implements AgentPayer {
  readonly kind = "evm";
  readonly address: Address;
  private pub;
  private wallet;

  constructor(
    private chain: AgentChain,
    key: Hex,
    transport?: Transport,
  ) {
    const c = defineChain({ id: chain.chainId, name: chain.name, nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } });
    const t = transport ?? http(chain.rpcUrl, { timeout: 20_000 });
    const account = privateKeyToAccount(key);
    this.address = account.address;
    this.pub = createPublicClient({ chain: c, transport: t });
    this.wallet = createWalletClient({ chain: c, transport: t, account });
  }

  async escrow(r: EscrowRequest): Promise<EscrowResult> {
    const args = [r.siteId, r.workOrderId, r.vendor, r.amount, BigInt(r.ttlSeconds), r.incidentHash];
    const { request } = await this.pub.simulateContract({ address: this.chain.workOrders, abi: ORDO_WORK_ORDERS_ABI, functionName: "escrow", args, account: this.wallet.account } as never);
    const hash = await this.wallet.writeContract(request as never);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`escrow reverted (${hash})`);
    const base = this.chain.explorerUrl?.replace(/\/$/, "");
    return { txId: hash, url: base ? `${base}/${base.includes("hashscan.io") ? "transaction" : "tx"}/${hash}` : null };
  }
}
