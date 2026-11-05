import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ZeroGStorage } from "../../src/chain/zerog.js";

/** The 0G SDKs load in Ordo's runtime and do their local work; the network calls are exercised on testnet. */
describe("0G SDKs", () => {
  it("compute a file's Merkle root locally, and the compute broker loads", async () => {
    const { MemData } = await import("@0gfoundation/0g-storage-ts-sdk");
    const [tree, err] = await new MemData(new TextEncoder().encode("Concept report")).merkleTree();
    expect(err).toBeNull();
    expect(tree!.rootHash()).toMatch(/^0x[0-9a-f]{64}$/);
    const { createZGComputeNetworkBroker } = await import("@0gfoundation/0g-compute-ts-sdk");
    expect(typeof createZGComputeNetworkBroker).toBe("function");
  });
  it("needs a key, and derives a stable encryption key from it", () => {
    expect(() => new ZeroGStorage(loadConfig({} as NodeJS.ProcessEnv))).toThrow(/ZG_PRIVATE_KEY/);
    const cfg = loadConfig({ ZG_PRIVATE_KEY: `0x${"11".repeat(32)}` } as NodeJS.ProcessEnv);
    expect((new ZeroGStorage(cfg) as any).key).toEqual((new ZeroGStorage(cfg) as any).key);
  });
});
