import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ORDO_AGENT_NFT_ABI } from "./ordo-agent-nft-abi.js";
import type { SigArg } from "./trust.js";
import { ZG_EXPLORER } from "./zerog.js";

export interface IntelligentData {
  dataDescription: string;
  dataHash: Hex;
}
export interface AgentNftConfig {
  rpcUrl: string;
  chainId: number;
  address: Address;
  /** Ordo's 0G account: mints and updates */
  key: Hex;
}

/** OrdoAgentNFT on 0G Galileo: one ERC-7857 token per agent per site. Its blocks are quick, so writes wait. */
export class AgentNftChain {
  private pub;
  private wallet;
  readonly owner: Address;

  constructor(
    readonly cfg: AgentNftConfig,
    transport?: Transport,
  ) {
    const chain = defineChain({ id: cfg.chainId, name: "0G-Galileo-Testnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
    const t = transport ?? http(cfg.rpcUrl, { timeout: 30_000 });
    const account = privateKeyToAccount(cfg.key);
    this.owner = account.address;
    this.pub = createPublicClient({ chain, transport: t });
    this.wallet = createWalletClient({ chain, transport: t, account });
  }

  private async write(functionName: string, args: unknown[]) {
    const { request } = await this.pub.simulateContract({ address: this.cfg.address, abi: ORDO_AGENT_NFT_ABI, functionName, args, account: this.wallet.account } as never);
    const hash = await this.wallet.writeContract(request as never);
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 45_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return r;
  }
  private read<T>(functionName: string, args: unknown[]): Promise<T> {
    return this.pub.readContract({ address: this.cfg.address, abi: ORDO_AGENT_NFT_ABI, functionName, args } as never) as Promise<T>;
  }

  txUrl(hash: string) {
    return this.cfg.chainId === 16602 ? `${ZG_EXPLORER}/tx/${hash}` : null;
  }
  tokenUrl(tokenId: number) {
    return this.cfg.chainId === 16602 ? `${ZG_EXPLORER}/token/${this.cfg.address}?a=${tokenId}` : null;
  }

  async tokenOf(agent: string): Promise<number> {
    return Number(await this.read<bigint>("tokenOfAgent", [agent]));
  }
  async mint(agent: string, datas: IntelligentData[]): Promise<{ tokenId: number; hash: Hex }> {
    const r = await this.write("mint", [datas, this.owner, agent]);
    for (const l of r.logs) {
      try {
        const e = decodeEventLog({ abi: ORDO_AGENT_NFT_ABI, data: l.data, topics: l.topics });
        if (e.eventName === "Minted") return { tokenId: Number((e.args as { tokenId: bigint }).tokenId), hash: r.transactionHash };
      } catch {}
    }
    throw new Error("mint did not report a token");
  }
  async update(tokenId: number, datas: IntelligentData[]): Promise<Hex> {
    return (await this.write("update", [BigInt(tokenId), datas])).transactionHash;
  }
  async authorize(tokenId: number, user: Address): Promise<Hex> {
    return (await this.write("authorizeUsage", [BigInt(tokenId), user])).transactionHash;
  }
  async revoke(tokenId: number, user: Address): Promise<Hex> {
    return (await this.write("revokeAuthorization", [BigInt(tokenId), user])).transactionHash;
  }
  async grantLicense(tokenId: number, licensee: string, expiresAt: number, termsHash: Hex, sig: SigArg): Promise<Hex> {
    return (await this.write("grantLicense", [BigInt(tokenId), licensee, BigInt(expiresAt), termsHash, sig])).transactionHash;
  }
  async revokeLicense(tokenId: number, licensee: string, sig: SigArg): Promise<Hex> {
    return (await this.write("revokeLicense", [BigInt(tokenId), licensee, sig])).transactionHash;
  }
  async licenseOf(tokenId: number, licensee: string): Promise<{ active: boolean; expiresAt: number; termsHash: Hex }> {
    const [active, expiresAt, termsHash] = await this.read<[boolean, bigint, Hex]>("licenseOf", [BigInt(tokenId), licensee]);
    return { active, expiresAt: Number(expiresAt), termsHash };
  }
  datas(tokenId: number): Promise<readonly IntelligentData[]> {
    return this.read("intelligentDatasOf", [BigInt(tokenId)]);
  }
  authorizedUsers(tokenId: number): Promise<readonly Address[]> {
    return this.read("authorizedUsersOf", [BigInt(tokenId)]);
  }
}
