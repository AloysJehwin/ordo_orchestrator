import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

/** Primary ENS names for the wallets that sign in (reverse resolution on Ethereum mainnet). */
export class EnsNames {
  private client;
  private cache = new Map<string, { name: string | null; at: number }>();
  constructor(rpcUrl?: string) {
    this.client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  }
  async lookup(addresses: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    await Promise.all(
      [...new Set(addresses.map((a) => a.toLowerCase()))].map(async (a) => {
        const hit = this.cache.get(a);
        if (hit && Date.now() - hit.at < 30 * 60_000) {
          out[a] = hit.name;
          return;
        }
        const name = await Promise.race([this.client.getEnsName({ address: a as `0x${string}` }).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
        out[a] = name;
        this.cache.set(a, { name, at: Date.now() });
      }),
    );
    return out;
  }
}
