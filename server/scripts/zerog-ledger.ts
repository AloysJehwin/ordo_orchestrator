/**
 * Funds Ordo's 0G Compute ledger so LLM_PROVIDER=0g can pay for diagnosis, and lists the inference providers.
 *   ZG_PRIVATE_KEY=0x… ZG_LEDGER_0G=3 pnpm --filter @ordo/server zerog:ledger
 * Creates the ledger with ZG_LEDGER_0G (3 minimum) the first time, tops it up after. Prints only public values.
 */
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";

const key = process.env.ZG_PRIVATE_KEY;
if (!key) throw new Error("Set ZG_PRIVATE_KEY");
const amount = Number(process.env.ZG_LEDGER_0G ?? 3);
const wallet = new Wallet(key.replace(/^(0x)?/, "0x"), new JsonRpcProvider(process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai"));
console.log(`0G account ${wallet.address} · ${formatEther(await wallet.provider!.getBalance(wallet.address))} 0G`);
const broker = await createZGComputeNetworkBroker(wallet as never);
const existing = await broker.ledger.getLedger().catch(() => null);
if (existing) await broker.ledger.depositFund(amount);
else await broker.ledger.addLedger(amount);
console.log(`Compute ledger ${existing ? "topped up" : "created"} with ${amount} 0G`);
const services = (await broker.inference.listService()) as unknown as { provider: string; model?: string; serviceType?: string; verifiability?: string }[];
console.log("\nInference providers (set ZG_PROVIDER_ADDRESS to choose one):");
for (const s of services) console.log(`  ${s.provider}  ${s.serviceType ?? ""}  ${s.model ?? ""}  ${s.verifiability || "not verifiable"}`);
