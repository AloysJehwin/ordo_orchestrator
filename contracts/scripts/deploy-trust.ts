/**
 * Deploys OrdoTrust (role credentials, validator and tester stakes, releases, cases against validators, rewards).
 *
 *   Hedera testnet (default):  HEDERA_OPERATOR_KEY=0x… pnpm --filter @ordo/contracts deploy:trust
 *   Any EVM chain:             TRUST_RPC_URL=… TRUST_CHAIN_ID=… DEPLOYER_KEY=0x… TRUST_DECIMALS=18 pnpm … deploy:trust
 *
 * MIN_STAKE is in whole native units (default 10). On Hedera the contract sees tinybars (8 decimals).
 * Prints the TRUST_* variables to set in Vercel. The relayer key only pays gas: every write it sends
 * carries a person's signature that the contract checks. Only the registrar (TRUST_REGISTRAR, default this
 * deployer) may register a site, so set it to the relayer's address when the relayer is another key.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpc = process.env.TRUST_RPC_URL ?? process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";
const chainId = Number(process.env.TRUST_CHAIN_ID ?? 296);
const decimals = Number(process.env.TRUST_DECIMALS ?? (chainId === 295 || chainId === 296 || chainId === 297 ? 8 : 18));
const rawKey = process.env.DEPLOYER_KEY ?? process.env.HEDERA_OPERATOR_KEY;
if (!rawKey) throw new Error("Set DEPLOYER_KEY (or HEDERA_OPERATOR_KEY): an ECDSA key with funds on the target chain");
const key = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
const minStake = parseUnits(process.env.MIN_STAKE ?? "10", decimals);
const cooldown = BigInt(process.env.UNSTAKE_COOLDOWN_SECONDS ?? 7 * 24 * 3600);

const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const transport = http(rpc);
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ chain, transport, account });
const { abi, bytecode } = JSON.parse(readFileSync(new URL("../artifacts/OrdoTrust.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };

const registrar = (process.env.TRUST_REGISTRAR ?? account.address) as Hex;
const hash = await wallet.deployContract({ abi, bytecode, args: [minStake, cooldown, registrar], gas: 6_000_000n } as never);
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
const explorer = chainId === 296 ? "https://hashscan.io/testnet" : chainId === 295 ? "https://hashscan.io/mainnet" : "";
console.log(`OrdoTrust deployed at ${r.contractAddress} (tx ${hash}), sites registered by ${registrar}

# ---- set in Vercel (Production and Preview) ----
TRUST_RPC_URL=${rpc}
TRUST_CHAIN_ID=${chainId}
TRUST_CHAIN_NAME=${chainId === 296 ? "Hedera Testnet" : `Chain ${chainId}`}
TRUST_EXPLORER_URL=${explorer}
TRUST_CONTRACT_ADDRESS=${r.contractAddress}
TRUST_SYMBOL=${chainId >= 295 && chainId <= 297 ? "HBAR" : "ETH"}
TRUST_DECIMALS=${decimals}
TRUST_RELAYER_KEY=<the key of ${registrar}, with a little gas money>
`);
