/**
 * Live check of HCS anchoring against testnet. Run on a machine with internet access:
 *   cd server && node --env-file=.env --import tsx scripts/smoke-hedera.ts
 * Prints the HashScan link. Uses a fraction of an HBAR of testnet funds.
 */
import { loadConfig } from "../src/config.js";
import { hederaFromConfig } from "../src/chain/hedera.js";

const cfg = loadConfig();
const h = hederaFromConfig(cfg);
const step = async (name: string, f: () => Promise<unknown>) => {
  try {
    console.log(`✔ ${name}`, await f());
  } catch (e) {
    console.log(`✘ ${name}:`, e instanceof Error ? e.message : e);
  }
};

const entryHash = `sha256:${"ab".repeat(32)}`;
await step("HCS anchor + mirror verify", async () => {
  const a = h.anchor();
  const ref = await a.anchor({ toSeq: 1, entryHash, siteId: "smoke", subject: "SMOKE" });
  await new Promise((r) => setTimeout(r, 6000)); // mirror node lag
  return { ref, verify: await a.verify({ toSeq: 1, entryHash, ref: ref.ref, data: ref.data }) };
});

process.exit(0);
