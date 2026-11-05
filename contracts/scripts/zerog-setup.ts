/**
 * Deploys OrdoAgentNFT (agents as ERC-7857 iNFTs) on 0G Galileo with Ordo's 0G account, which becomes its minter.
 * Run from the "0G setup" workflow (.github/workflows/zerog-setup.yml), or locally:
 *
 *   ZG_PRIVATE_KEY=0x… pnpm --filter @ordo/contracts setup:zerog
 *
 * Prints only public values.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { need } from "./env.js";

const rpc = process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai";
const chain = defineChain({ id: 16602, name: "0G-Galileo-Testnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(need("ZG_PRIVATE_KEY").replace(/^(0x)?/, "0x") as Hex);
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
const wallet = createWalletClient({ chain, transport: http(rpc, { timeout: 60_000 }), account });

const balance = await pub.getBalance({ address: account.address });
console.log(`0G account ${account.address} · ${formatEther(balance)} 0G`);
if (balance === 0n) throw new Error("The 0G account has no testnet tokens: use https://faucet.0g.ai first");

const art = JSON.parse(readFileSync(new URL("../artifacts/OrdoAgentNFT.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [account.address] });
const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: https://chainscan-galileo.0g.ai/tx/${hash}`);

console.log(`OrdoAgentNFT deployed: https://chainscan-galileo.0g.ai/address/${r.contractAddress} (tx https://chainscan-galileo.0g.ai/tx/${hash})

# ---- set in Vercel (Production and Preview) ----
ZG_INFT_ADDRESS=${r.contractAddress}
`);
