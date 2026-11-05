import { createWalletClient, custom, formatUnits, getAddress, parseAbi, parseEther, type EIP1193Provider } from "viem";
import { createSiweMessage } from "viem/siwe";
import { api } from "../api";
import type { Me, ReadingTyped, TrustChainInfo, TypedSignature } from "../types";

export interface WalletInfo {
  id: string;
  name: string;
  icon: string | null;
  provider: EIP1193Provider;
}

/** EIP-6963: every installed wallet announces itself; fall back to window.ethereum. */
export function discoverWallets(onChange: (w: WalletInfo[]) => void): () => void {
  const found = new Map<string, WalletInfo>();
  const emit = () => onChange([...found.values()]);
  const handler = (e: Event) => {
    const d = (e as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }>).detail;
    if (!d?.provider) return;
    found.set(d.info.rdns || d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
    emit();
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const t = setTimeout(() => {
    const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (!found.size && eth) {
      found.set("injected", { id: "injected", name: "Browser wallet", icon: null, provider: eth });
      emit();
    } else emit();
  }, 400);
  return () => {
    clearTimeout(t);
    window.removeEventListener("eip6963:announceProvider", handler);
  };
}

let active: WalletInfo | null = null;
const remember = (id: string) => {
  try {
    localStorage.setItem("ordo.wallet", id);
  } catch {
    /* private mode */
  }
};
export const rememberedWallet = () => {
  try {
    return localStorage.getItem("ordo.wallet");
  } catch {
    return null;
  }
};
export const setActiveWallet = (w: WalletInfo) => {
  active = w;
};

/** Set by "Switch account": the sign-in page that follows opens the wallet's account picker. */
const PICK = "ordo.pickAccount";
export const requestAccountPick = () => {
  try {
    sessionStorage.setItem(PICK, "1");
  } catch {
    /* private mode */
  }
};
export const takeAccountPick = () => {
  try {
    const v = sessionStorage.getItem(PICK) === "1";
    sessionStorage.removeItem(PICK);
    return v;
  } catch {
    return false;
  }
};

async function client(expected?: string) {
  if (!active) throw new Error("Connect your wallet first");
  const c = createWalletClient({ transport: custom(active.provider) });
  const [account] = await c.requestAddresses();
  if (!account) throw new Error("The wallet returned no account");
  if (expected && getAddress(account) !== getAddress(expected)) throw new Error(`Switch your wallet to ${short(expected)}: you are signed in with that address`);
  return { c, account };
}

/**
 * Asks the wallet to show its account picker again. Wallets otherwise hand back the account the site was last
 * connected with, so without this there is no way to sign in as a different one. Wallets without EIP-2255 skip it.
 */
async function pickAccount(w: WalletInfo) {
  try {
    await w.provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] } as never);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4001) throw e; // the person closed the picker
  }
}

/** Sign-In with Ethereum: the server issues a nonce, the wallet signs the EIP-4361 message. `pick` opens the wallet's account picker first. */
export async function signIn(w: WalletInfo, opts: { pick?: boolean } = {}): Promise<Me> {
  active = w;
  if (opts.pick) await pickAccount(w);
  const { c, account } = await client();
  const chainId = await c.getChainId().catch(() => 1);
  const n = await api.post<{ nonce: string; domain: string; uri: string }>("/v1/auth/nonce");
  const message = createSiweMessage({
    domain: n.domain,
    address: account,
    statement: "Sign in to Ordo. This proves you control this wallet; it does not send a transaction or cost gas.",
    uri: n.uri,
    version: "1",
    chainId,
    nonce: n.nonce,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 10 * 60_000),
  });
  const signature = await c.signMessage({ account, message });
  remember(w.id);
  return api.post<Me>("/v1/auth/verify", { message, signature });
}

export async function walletChainId(): Promise<number | undefined> {
  if (!active) return undefined;
  return createWalletClient({ transport: custom(active.provider) }).getChainId().catch(() => undefined);
}

/** Sign the exact EIP-712 typed data the server issued. Its uint fields arrive as decimal strings (JSON), so they become bigints. */
export async function signTyped(typed: TypedSignature | ReadingTyped, expectedAddress: string): Promise<`0x${string}`> {
  const { c, account } = await client(expectedAddress);
  const message: Record<string, unknown> = { ...typed.message };
  for (const f of typed.types[typed.primaryType] ?? []) if (/^uint/.test(f.type) && typeof message[f.name] === "string") message[f.name] = BigInt(message[f.name] as string);
  return c.signTypedData({ account, domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message } as never);
}

export const hasActiveWallet = () => active !== null;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------------- Chains and contract calls ----------------

/** Put the wallet on the chain a signature or transaction is for, adding the chain if the wallet lacks it. */
/** Chains Ordo signs on besides the trust chain: agent licences are signed for 0G Galileo, where the iNFTs live. */
const KNOWN_CHAINS: Record<number, { chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] }> = {
  16602: { chainName: "0G Galileo Testnet", rpcUrls: ["https://evmrpc-testnet.0g.ai"], nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, blockExplorerUrls: ["https://chainscan-galileo.0g.ai"] },
};

export async function ensureChain(chainId: number, trust: TrustChainInfo | null): Promise<void> {
  if (!active) throw new Error("Connect your wallet first");
  const c = createWalletClient({ transport: custom(active.provider) });
  const current = await c.getChainId().catch(() => undefined);
  if (current === chainId) return;
  const hex = `0x${chainId.toString(16)}`;
  try {
    await active.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] } as never);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if ((code === 4902 || code === -32603) && trust && trust.chainId === chainId) {
      await active.provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: trust.name, rpcUrls: [trust.rpcUrl], nativeCurrency: { name: trust.symbol, symbol: trust.symbol, decimals: 18 }, blockExplorerUrls: trust.explorerUrl ? [trust.explorerUrl] : undefined }],
      } as never);
    } else if ((code === 4902 || code === -32603) && KNOWN_CHAINS[chainId]) {
      await active.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, ...KNOWN_CHAINS[chainId] }] } as never);
    } else throw new Error(`Switch your wallet to chain ${chainId}${trust?.chainId === chainId ? ` (${trust.name})` : ""} and try again`);
  }
}

const TRUST_WRITE_ABI = parseAbi(["function stake(string siteId) payable", "function requestUnstake(string siteId)", "function withdraw(string siteId)"]);

/** A staking transaction from the person's own wallet. `amount` is in whole native units (e.g. "10" HBAR). */
export async function trustTx(trust: TrustChainInfo, expected: string, fn: "stake" | "requestUnstake" | "withdraw", siteId: string, amount?: string): Promise<`0x${string}`> {
  await ensureChain(trust.chainId, trust);
  const { c, account } = await client(expected);
  const chain = { id: trust.chainId, name: trust.name, nativeCurrency: { name: trust.symbol, symbol: trust.symbol, decimals: 18 }, rpcUrls: { default: { http: [trust.rpcUrl] } } };
  // Wallets and JSON-RPC relays (Hedera's included) take value in 18-decimal units.
  return c.writeContract({ account, chain, address: trust.address as `0x${string}`, abi: TRUST_WRITE_ABI, functionName: fn, args: [siteId], value: fn === "stake" ? parseEther(amount ?? "0") : undefined } as never);
}

const REWARDS_ABI = parseAbi(["function fundRewards(string siteId) payable"]);

/** Add money to a site's reward pool in OrdoTrust from the person's own wallet. `amount` in whole native units. */
export async function fundRewardsTx(trust: TrustChainInfo, expected: string, siteId: string, amount: string): Promise<`0x${string}`> {
  await ensureChain(trust.chainId, trust);
  const { c, account } = await client(expected);
  const chain = { id: trust.chainId, name: trust.name, nativeCurrency: { name: trust.symbol, symbol: trust.symbol, decimals: 18 }, rpcUrls: { default: { http: [trust.rpcUrl] } } };
  return c.writeContract({ account, chain, address: trust.address as `0x${string}`, abi: REWARDS_ABI, functionName: "fundRewards", args: [siteId], value: parseEther(amount) } as never);
}

const FUND_ABI = parseAbi(["function fund(string siteId) payable"]);

/** Add money to a site's OrdoWorkOrders fund from the person's own wallet. `amount` in whole native units. */
export async function fundTx(trust: TrustChainInfo, expected: string, siteId: string, amount: string): Promise<`0x${string}`> {
  if (!trust.workOrders) throw new Error("OrdoWorkOrders is not configured");
  await ensureChain(trust.chainId, trust);
  const { c, account } = await client(expected);
  const chain = { id: trust.chainId, name: trust.name, nativeCurrency: { name: trust.symbol, symbol: trust.symbol, decimals: 18 }, rpcUrls: { default: { http: [trust.rpcUrl] } } };
  return c.writeContract({ account, chain, address: trust.workOrders as `0x${string}`, abi: FUND_ABI, functionName: "fund", args: [siteId], value: parseEther(amount) } as never);
}

/** Contract units (tinybars on Hedera) to a display amount. */
export const fromUnits = (v: string | bigint, decimals: number) => {
  const s = formatUnits(BigInt(v), decimals);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};
