/**
 * Deploys Ordo's ENS contracts on Sepolia with the ENS owner account, after setup:ens registered the root name
 * (ordo.eth), and gives them the roles they need on the root's registry and resolver:
 *  - OrdoNames: issues every name under the root in batches (orgs, people's handles, role names, machines, agents,
 *    vendors, runs, stages, budgets, top-ups), deploys the registries of the names that have their own, and answers
 *    roles from the names people hold (a validator holds <handle>.validators.<org>.<root>);
 *  - OrdoStageVerifier and OrdoSpecVerifier: the Groth16 verifiers of the stage-check and spec-check circuits, reused
 *    from ENS_STAGE_VERIFIER_ADDRESS / ENS_SPEC_VERIFIER_ADDRESS, or from the current run resolver
 *    (ENS_RUN_RESOLVER_ADDRESS) or the retired lot resolver (ENS_LOT_RESOLVER_ADDRESS), or deployed when none is set;
 *  - OrdoRunResolver: the resolver of new run names (<order>.runs.<org>.<root>). It records each lot's release only
 *    with three signatures from people holding the role names and proofs that verify, each stage's from the machine
 *    the run name says ran it (v2: com.ordo.machine.<stage>, and the machine's attester name), answers the
 *    com.ordo.release* records from storage, and passes every other record to Ordo's resolver. Runs already named
 *    keep the resolver they were issued with, where their releases are; a new one serves runs named from then on.
 * Run locally:
 *
 *   ENS_OWNER_KEY=0x… ENS_PARENT_NAME=ordo.eth ENS_REGISTRY_ADDRESS=0x… ENS_RESOLVER_ADDRESS=0x… pnpm --filter @ordo/contracts setup:ens-contracts
 *
 * Set ENS_NAMES_ADDRESS to keep an OrdoNames already deployed: then only a new OrdoRunResolver is deployed (its
 * grants are already in place). Prints only public values.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, fallback, formatEther, http, parseAbi, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { need } from "./env.js";

const ENS = {
  factory: "0xda70306c98e97ece36f997a21368e53298572991",
  userRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
} as const satisfies Record<string, Address>;

// ENSv2 role bits (EnhancedAccessControl): what OrdoNames needs on the root's registry and resolver
const REGISTRY_ROLES = (1n << 0n) | (1n << 12n) | (1n << 16n) | (1n << 20n) | (1n << 24n); // registrar, unregister, renew, set subregistry, set resolver
const RESOLVER_ROLES = (1n << 0n) | (1n << 4n) | (1n << 8n); // set address, set text, set contenthash

const account = privateKeyToAccount(need("ENS_OWNER_KEY").replace(/^(0x)?/, "0x") as Hex);
const rootName = need("ENS_PARENT_NAME");
const rootRegistry = need("ENS_REGISTRY_ADDRESS") as Address;
const resolver = need("ENS_RESOLVER_ADDRESS") as Address;
const rpcs = (process.env.ENS_SEPOLIA_RPC_URL || "https://gateway.tenderly.co/public/sepolia,https://sepolia.rpc.thirdweb.com,https://0xrpc.io/sep,https://1rpc.io/sepolia").split(",").map((u) => u.trim()).filter(Boolean);
const transport = fallback(rpcs.map((u) => http(u, { timeout: 60_000 })));
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });

const roleAbi = parseAbi([
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function stageVerifier() view returns (address)",
  "function specVerifier() view returns (address)",
]);

const balance = await pub.getBalance({ address: account.address });
console.log(`ENS owner ${account.address} · ${formatEther(balance)} Sepolia ETH`);
if (balance === 0n) throw new Error("The ENS owner account has no Sepolia ETH: fund it from a faucet first");

const art = (n: string) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
async function deploy(n: string, args: unknown[]): Promise<Address> {
  const a = art(n);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${n} deploy failed: https://sepolia.etherscan.io/tx/${hash}`);
  console.log(`  ${n}: https://sepolia.etherscan.io/address/${r.contractAddress}`);
  return r.contractAddress;
}
/** the address, if a contract is there */
async function deployed(a: string | undefined): Promise<Address | undefined> {
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) return undefined;
  return ((await pub.getCode({ address: a as Address })) ?? "0x") !== "0x" ? (a as Address) : undefined;
}
async function grant(target: Address, roles: bigint, to: Address, what: string) {
  if (await pub.readContract({ address: target, abi: roleAbi, functionName: "hasRootRoles", args: [roles, to] })) return console.log(`  ${what}: already granted`);
  const { request } = await pub.simulateContract({ address: target, abi: roleAbi, functionName: "grantRootRoles", args: [roles, to], account });
  const hash = await wallet.writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${what} reverted: https://sepolia.etherscan.io/tx/${hash}`);
  console.log(`  ${what}: https://sepolia.etherscan.io/tx/${hash}`);
}

// the verifiers carry no state, so the ones already on Sepolia serve the new resolver
async function verifiers(): Promise<[Address, Address]> {
  const stage = await deployed(process.env.ENS_STAGE_VERIFIER_ADDRESS);
  const spec = await deployed(process.env.ENS_SPEC_VERIFIER_ADDRESS);
  if (stage && spec) return [stage, spec];
  for (const [env, what] of [
    ["ENS_RUN_RESOLVER_ADDRESS", "the current run resolver"],
    ["ENS_LOT_RESOLVER_ADDRESS", "the retired lot resolver"],
  ] as const) {
    const old = await deployed(process.env[env]);
    if (!old) continue;
    const s = await pub.readContract({ address: old, abi: roleAbi, functionName: "stageVerifier" });
    const p = await pub.readContract({ address: old, abi: roleAbi, functionName: "specVerifier" });
    console.log(`  verifiers from ${what}: ${s} · ${p}`);
    return [s, p];
  }
  return [await deploy("OrdoStageVerifier", []), await deploy("OrdoSpecVerifier", [])];
}

console.log(`Deploying Ordo's ENS contracts for ${rootName}…`);
const names = (await deployed(process.env.ENS_NAMES_ADDRESS)) ?? (await deploy("OrdoNames", [ENS.factory, ENS.userRegistryImpl, rootRegistry, resolver, rootName, account.address]));
const [stageVerifier, specVerifier] = await verifiers();
const runs = await deploy("OrdoRunResolver", [names, stageVerifier, specVerifier, resolver]);

console.log("Granting OrdoNames its roles…");
await grant(rootRegistry, REGISTRY_ROLES, names, `${rootName} registry: register, unregister, renew, set registry and resolver`);
await grant(resolver, RESOLVER_ROLES, names, "Ordo's resolver: set address, text and contenthash records");

console.log(`
# ---- set in server/.env, Render and Vercel ----
ENS_NAMES_ADDRESS=${names}
ENS_RUN_RESOLVER_ADDRESS=${runs}

ENS_ROLES_ADDRESS and ENS_LOT_RESOLVER_ADDRESS are retired: remove them.
Runs already named keep the run resolver they were issued with; ${runs} serves runs named from now on.
`);
