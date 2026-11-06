import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { ENSV2_ABI, registryInitData, resolverInitData } from "../../src/chain/ensv2.js";
import { ANVIL_KEYS, deployer } from "./anvil.js";

/** The ENSv2 contracts ENS Labs deployed on Sepolia, deployed afresh on anvil (they need Cancun). */
type Artifact = { abi: Abi; bytecode: Hex };
export const C = JSON.parse(readFileSync(resolve(__dirname, "ensv2/contracts.json"), "utf8")) as Record<string, Artifact>;

/** Deploys the stack: a resolver and a parent UserRegistry standing in for the one the setup workflow links under the parent name. */
export async function deployEnsV2(url: string) {
  const d = deployer(url);
  const owner = d.account.address;
  const namerImpl = await d.deploy(C.ContractNamer_Implementation!);
  const namer = await d.deploy(C.ContractNamer_Proxy!, [namerImpl, encodeFunctionData({ abi: C.ContractNamer_Implementation!.abi, functionName: "initialize", args: [owner] })]);
  const labelStore = await d.deploy(C.LabelStore!, [namer]);
  const renderer = await d.deploy(C.ENSURIRenderer!, [owner, "https://metadata.ens.domains/local/0x", "/", ".json"]);
  const boxed = await d.deploy(C.BoxedENSURIRenderer!, [owner, renderer]);
  const userRegistryImpl = await d.deploy(C.UserRegistryImpl!, [labelStore, boxed, owner]);
  const resolverImpl = await d.deploy(C.PermissionedResolverImpl!, [owner]);
  const factory = await d.deploy(C.VerifiableFactory!);
  const proxy = async (impl: Address, salt: bigint, data: Hex) => {
    const hash = await d.wallet.writeContract({ address: factory, abi: ENSV2_ABI, functionName: "deployProxy", args: [impl, salt, data] });
    const r = await d.pub.waitForTransactionReceipt({ hash });
    for (const l of r.logs) {
      try {
        const e = decodeEventLog({ abi: ENSV2_ABI, data: l.data, topics: l.topics });
        if (e.eventName === "ProxyDeployed") return (e.args as { proxyAddress: Address }).proxyAddress;
      } catch {}
    }
    throw new Error("no proxy");
  };
  const resolver = await proxy(resolverImpl, 1n, resolverInitData(owner));
  // stands in for the UserRegistry the setup workflow links under ordo-test.eth
  const parentRegistry = await proxy(userRegistryImpl, 2n, registryInitData(owner));
  return { owner, factory, userRegistryImpl, resolver, parentRegistry, pub: d.pub };
}


/**
 * Ordo's ENS contracts on top of the stack: OrdoNames with its roles on the root's registry and resolver, as
 * setup:ens-contracts grants them, and (with `releases`) the verifiers and OrdoRunResolver.
 */
export async function deployOrdoEns(url: string, stack: Awaited<ReturnType<typeof deployEnsV2>>, opts: { root?: string; releases?: boolean } = {}) {
  const { ORDO_NAMES_ABI, ORDO_NAMES_BYTECODE, ORDO_RUN_RESOLVER_ABI, ORDO_RUN_RESOLVER_BYTECODE, ORDO_STAGE_VERIFIER_ABI, ORDO_STAGE_VERIFIER_BYTECODE, ORDO_SPEC_VERIFIER_ABI, ORDO_SPEC_VERIFIER_BYTECODE } = await import("../../src/chain/ordo-ens-abi.js");
  const { NAMES_ROOT_ROLES, NAMES_RESOLVER_ROLES } = await import("../../src/chain/ensv2.js");
  const d = deployer(url);
  const names = await d.deploy({ abi: ORDO_NAMES_ABI, bytecode: ORDO_NAMES_BYTECODE }, [stack.factory, stack.userRegistryImpl, stack.parentRegistry, stack.resolver, opts.root ?? "ordo-test.eth", stack.owner]);
  for (const [target, roles] of [
    [stack.parentRegistry, NAMES_ROOT_ROLES],
    [stack.resolver, NAMES_RESOLVER_ROLES],
  ] as const) {
    const hash = await d.wallet.writeContract({ address: target, abi: ENSV2_ABI, functionName: "grantRootRoles", args: [roles, names] });
    await d.pub.waitForTransactionReceipt({ hash });
  }
  let runResolver: Address | undefined;
  if (opts.releases) {
    const stageVerifier = await d.deploy({ abi: ORDO_STAGE_VERIFIER_ABI, bytecode: ORDO_STAGE_VERIFIER_BYTECODE }, []);
    const specVerifier = await d.deploy({ abi: ORDO_SPEC_VERIFIER_ABI, bytecode: ORDO_SPEC_VERIFIER_BYTECODE }, []);
    runResolver = await d.deploy({ abi: ORDO_RUN_RESOLVER_ABI, bytecode: ORDO_RUN_RESOLVER_BYTECODE }, [names, stageVerifier, specVerifier, stack.resolver]);
  }
  return { names, runResolver };
}

/** The env that boots Ordo against the stack and Ordo's ENS contracts on anvil. */
export const ensEnv = (url: string, stack: Awaited<ReturnType<typeof deployEnsV2>>, ordo: { names: Address; runResolver?: Address }, extra: Record<string, string> = {}) => ({
  ENS_PARENT_NAME: "ordo-test.eth",
  ENS_REGISTRY_ADDRESS: stack.parentRegistry,
  ENS_RESOLVER_ADDRESS: stack.resolver,
  ENS_OWNER_KEY: ANVIL_KEYS[0]!,
  ENS_SEPOLIA_RPC_URL: url,
  ENS_CHAIN_ID: "31337",
  ENS_FACTORY_ADDRESS: stack.factory,
  ENS_USER_REGISTRY_IMPL: stack.userRegistryImpl,
  ENS_NAMES_ADDRESS: ordo.names,
  ...(ordo.runResolver ? { ENS_RUN_RESOLVER_ADDRESS: ordo.runResolver } : {}),
  // anvil's gas is priced like a busy mainnet: lift the daily cap
  ENS_DAILY_ETH: "1000",
  ENS_MAX_FEE_GWEI: "1000",
  PUBLIC_URL: "https://ordo.example",
  ...extra,
});
