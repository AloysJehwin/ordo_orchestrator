import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { ENSV2_ABI, registryInitData, resolverInitData } from "../../src/chain/ensv2.js";
import { deployer } from "./anvil.js";

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

