/**
 * Registers Ordo's parent name on ENSv2 (Sepolia) with the ENS owner account, once. Run from the "ENS setup" workflow
 * (.github/workflows/ens-setup.yml), or locally:
 *
 *   ENS_OWNER_KEY=0x… ENS_LABEL=ordo-mfg [ENS_SEPOLIA_RPC_URL=…] pnpm --filter @ordo/contracts setup:ens
 *
 * It deploys Ordo's PermissionedResolver and a UserRegistry through ENS's VerifiableFactory, then registers
 * <label>.eth (commit, wait, pay in the testnet's MockUSDC, register) pointing at both. Sites, people, assets and
 * agents are issued later by the app, under that registry. Prints only public values.
 */
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { need } from "./env.js";

// contracts-v2, deploy/mainnet-v2-20261002 (Sepolia set of 2026-10-01)
const ENS = {
  factory: "0xda70306c98e97ece36f997a21368e53298572991",
  userRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
  resolverImpl: "0x115eb53f0c60696633855f90b138178fb40b2b2c",
  registrar: "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3",
  usdc: "0x240b0316df57887dbbe58b586508b19e633a14aa",
} as const;
const ALL_ROLES = BigInt(`0x${"1".repeat(64)}`);
const YEAR = 365n * 86_400n;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

const abi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
  "function initialize(Grant[] grants)",
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function setText(bytes name, string key, string value)",
  "function multicall(bytes[] calls) returns (bytes[])",
]);
const resolverInit = parseAbi(["struct Grant { address account; uint256 roleBitmap; }", "function initialize(Grant[] grants, bytes[] calls)"]);

const label = need("ENS_LABEL").toLowerCase();
if (!/^[a-z0-9-]{3,40}$/.test(label)) throw new Error("ENS_LABEL: 3–40 lowercase letters, digits or hyphens");
const account = privateKeyToAccount(need("ENS_OWNER_KEY").replace(/^(0x)?/, "0x") as Hex);
const transport = http(process.env.ENS_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", { timeout: 60_000 });
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });

async function send(address: Address, functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account } as never);
  const hash = await wallet.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted: https://sepolia.etherscan.io/tx/${hash}`);
  console.log(`  ${functionName}: https://sepolia.etherscan.io/tx/${hash}`);
  return r;
}
async function proxy(impl: Address, salt: bigint, data: Hex): Promise<Address> {
  const r = await send(ENS.factory, "deployProxy", [impl, salt, data]);
  for (const l of r.logs) {
    try {
      const e = decodeEventLog({ abi, data: l.data, topics: l.topics });
      if (e.eventName === "ProxyDeployed") return (e.args as { proxyAddress: Address }).proxyAddress;
    } catch {}
  }
  throw new Error("VerifiableFactory did not report the proxy");
}
const dns = (name: string) =>
  `0x${name
    .split(".")
    .map((l) => Buffer.from([l.length, ...Buffer.from(l)]).toString("hex"))
    .join("")}00` as Hex;

const balance = await pub.getBalance({ address: account.address });
console.log(`ENS owner ${account.address} · ${(Number(balance) / 1e18).toFixed(4)} Sepolia ETH`);
if (balance === 0n) throw new Error("The ENS owner account has no Sepolia ETH: fund it from a faucet first");
if (!(await pub.readContract({ address: ENS.registrar, abi, functionName: "isAvailable", args: [label] }))) throw new Error(`${label}.eth is taken on Sepolia: choose another ENS_LABEL`);

const salt = BigInt(keccak256(toBytes(`ordo:${label}`)));
console.log("Deploying Ordo's resolver and registry…");
const resolver = await proxy(ENS.resolverImpl, salt, encodeFunctionData({ abi: resolverInit, functionName: "initialize", args: [[{ account: account.address, roleBitmap: ALL_ROLES }], []] }));
const registry = await proxy(ENS.userRegistryImpl, salt + 1n, encodeFunctionData({ abi, functionName: "initialize", args: [[{ account: account.address, roleBitmap: ALL_ROLES }]] }));

const [base, premium] = await pub.readContract({ address: ENS.registrar, abi, functionName: "getRegisterPrice", args: [label, YEAR, ENS.usdc] });
const price = base + premium;
console.log(`Registering ${label}.eth for a year: ${Number(price) / 1e6} MockUSDC`);
await send(ENS.usdc, "mint", [account.address, price]);
await send(ENS.usdc, "approve", [ENS.registrar, price]);
const secret = keccak256(toBytes(`${salt}:${Date.now()}`));
const commitment = await pub.readContract({ address: ENS.registrar, abi, functionName: "makeCommitment", args: [label, account.address, secret, registry, resolver, YEAR, ZERO32] });
await send(ENS.registrar, "commit", [commitment]);
const age = Number(await pub.readContract({ address: ENS.registrar, abi, functionName: "MIN_COMMITMENT_AGE" }));
console.log(`Waiting ${age + 15}s for the commitment to mature…`);
await new Promise((r) => setTimeout(r, (age + 15) * 1000));
await send(ENS.registrar, "register", [label, account.address, secret, registry, resolver, YEAR, ENS.usdc, ZERO32]);

const name = `${label}.eth`;
const url = process.env.PUBLIC_URL;
const texts: Record<string, string> = { "com.ordo.type": "org", description: "Manufacturing sites run on Ordo: people, machines and agents with on-chain credentials", ...(url ? { url } : {}) };
await send(resolver, "multicall", [Object.entries(texts).map(([k, v]) => encodeFunctionData({ abi, functionName: "setText", args: [dns(name), k, v] }))]);

console.log(`
${name} registered: https://sepolia.app.ens.domains/${name}

# ---- set in Vercel (Production and Preview) ----
ENS_PARENT_NAME=${name}
ENS_REGISTRY_ADDRESS=${registry}
ENS_RESOLVER_ADDRESS=${resolver}
`);
