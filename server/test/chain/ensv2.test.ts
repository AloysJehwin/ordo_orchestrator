import type { Abi, Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENSV2_ABI, EnsV2, dnsEncode, toLabel } from "../../src/chain/ensv2.js";
import { ANVIL_KEYS, anvilPath, deployer, startAnvil } from "../fixtures/anvil.js";
import { C, deployEnsV2 } from "../fixtures/ensv2.js";

const run = anvilPath() || process.env.CI ? describe : describe.skip;
if (!anvilPath()) console.warn("anvil not found: skipping the ENSv2 contract tests (CI installs Foundry)");

run("ENSv2 names on the real contracts", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let ens: EnsV2;
  let stack: Awaited<ReturnType<typeof deployEnsV2>>;
  let site: Address;
  const person = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployEnsV2(anvil.url);
    ens = new EnsV2({ rpcUrl: anvil.url, ownerKey: ANVIL_KEYS[0]!, parentName: "ordo-test.eth", parentRegistry: stack.parentRegistry, resolver: stack.resolver, factory: stack.factory, userRegistryImpl: stack.userRegistryImpl, chainId: 31337 });
  }, 60_000);
  afterAll(() => anvil?.stop());

  it("encodes names and labels", () => {
    expect(dnsEncode("a.bc.eth")).toBe("0x01610262630365746800");
    expect(toLabel("Priya Rámán (QA)")).toBe("priya-raman-qa");
    expect(toLabel("CNC-07")).toBe("cnc-07");
  });

  it("gives a site its own registry under the parent, with records in Ordo's resolver", async () => {
    site = ens.registryFrom(await ens.wait([await ens.sendCreateRegistry(101n)]));
    await ens.wait(await ens.sendIssue({ registry: stack.parentRegistry, label: "chennai-1", name: "chennai-1.ordo-test.eth", owner: ens.owner, subregistry: site, roleBitmap: 0n, expiresAt: Date.now() + 365 * 86_400_000, texts: { "com.ordo.type": "site", "com.ordo.site": "Chennai Plant 1" } }));
    expect(await stack.pub.readContract({ address: stack.parentRegistry, abi: ENSV2_ABI, functionName: "getSubregistry", args: ["chennai-1"] })).toBe(site);
    expect(await ens.text("chennai-1.ordo-test.eth", "com.ordo.site")).toBe("Chennai Plant 1");
  }, 60_000);

  it("mints a person's name to their wallet as a credential they cannot transfer, and revokes it", async () => {
    const name = "priya.chennai-1.ordo-test.eth";
    await ens.wait(await ens.sendIssue({ registry: site, label: "priya", name, owner: person, expiresAt: Date.now() + 365 * 86_400_000, texts: { "com.ordo.type": "person", "com.ordo.roles": "validator,quality_engineer" }, addr: person }));
    expect(await ens.ownerOf(site, "priya")).toBe(person);
    expect(await ens.text(name, "com.ordo.roles")).toBe("validator,quality_engineer");
    expect((await ens.addr(name)).toLowerCase()).toBe(person.toLowerCase());

    // the holder has no roles on the token: a transfer fails
    const holder = deployer(anvil.url, ANVIL_KEYS[1]!);
    const id = (await stack.pub.readContract({ address: site, abi: [...ENSV2_ABI, ...(C.UserRegistryImpl!.abi as Abi)], functionName: "findTokenId" as never, args: ["priya"] as never })) as bigint;
    await expect(
      holder.pub.simulateContract({ address: site, abi: C.UserRegistryImpl!.abi, functionName: "safeTransferFrom", args: [person, ens.owner, id, 1n, "0x"], account: holder.account } as never),
    ).rejects.toThrow();

    await ens.wait(await ens.sendRevoke(site, "priya", name));
    expect(await ens.ownerOf(site, "priya")).toBe("0x0000000000000000000000000000000000000000");
    expect(await ens.text(name, "com.ordo.status")).toBe("revoked");
  }, 60_000);
});
