/**
 * Ordo's edge gateway for one machine: pushes its counters and signs each finished stage's counts with its own key.
 *
 *   GATEWAY_KEY=0x… ORDO_URL=https://… GATEWAY_ASSET=ast_… pnpm --filter @ordo/server gateway            (simulated machine)
 *   … MTCONNECT_URL=http://agent:5000 MTCONNECT_DEVICE=Mazak pnpm --filter @ordo/server gateway               (a real machine)
 *
 * Without GATEWAY_KEY it prints a new key and its address: set the asset's data source to "gateway" with that address,
 * and the site issues it a member name with the device role. GATEWAY_EVERY_S (default 10) is the cycle; SIM_CYCLE_S
 * and SIM_SCRAP_EVERY shape the simulated machine.
 *
 *   … SIM_PROFILE=bioreactor pnpm --filter @ordo/server gateway        (a simulated instrument: bioreactor, fplc, plate_reader)
 *
 * A profile emits that instrument's signals and counts one batch every SIM_STAGE_S (default 180) seconds, so a stage of
 * quantity 1 closes on its own. The data is simulated: say so in any demo.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Gateway, type ProfileSignal } from "../src/edge/gateway.js";

/** Instrument profiles for the lab demo. Values are plausible, not measured. */
export const PROFILES: Record<string, ProfileSignal[]> = {
  bioreactor: [
    { name: "temperature", base: 37, swing: 0.6, periodS: 420 },
    { name: "od600", base: 0.25, drift: 1.1, swing: 0.02, periodS: 300 },
    { name: "dissolved_oxygen", base: 48, drift: -10, swing: 4, periodS: 500 },
    { name: "ph", base: 7.1, swing: 0.08, periodS: 700 },
  ],
  fplc: [
    { name: "yield_mg_l", base: 11.5, drift: 1.2, swing: 0.2, periodS: 400 },
    { name: "purity_pct", base: 96.2, drift: 0.9, swing: 0.3, periodS: 300 },
    { name: "pressure_bar", base: 1.9, swing: 0.5, periodS: 240 },
  ],
  plate_reader: [
    { name: "specific_activity", base: 58, drift: 4, swing: 1.5, periodS: 360 },
    { name: "aggregate_pct", base: 2.6, swing: 0.6, periodS: 300 },
  ],
};

const key = process.env.GATEWAY_KEY;
if (!key) {
  const k = generatePrivateKey();
  console.log(`No GATEWAY_KEY: here is a new one. Keep it on the gateway only.\n\nGATEWAY_KEY=${k}\naddress ${privateKeyToAccount(k).address}  (the asset's gateway data source)`);
  process.exit(0);
}
const need = (n: string) => process.env[n] ?? (() => { throw new Error(`Set ${n}`); })();
const gw = new Gateway({
  url: need("ORDO_URL"),
  key: key.replace(/^(0x)?/, "0x") as Hex,
  assetId: need("GATEWAY_ASSET"),
  source: process.env.MTCONNECT_URL
    ? { kind: "mtconnect", agentUrl: process.env.MTCONNECT_URL, device: need("MTCONNECT_DEVICE") }
    : process.env.SIM_PROFILE
      ? { kind: "profile", stageS: Number(process.env.SIM_STAGE_S ?? 180), batchUnits: Number(process.env.SIM_BATCH_UNITS ?? 1), signals: PROFILES[process.env.SIM_PROFILE] ?? (() => { throw new Error(`Unknown SIM_PROFILE ${process.env.SIM_PROFILE}: one of ${Object.keys(PROFILES).join(", ")}`); })() }
      : { kind: "simulate", cycleS: Number(process.env.SIM_CYCLE_S ?? 6), scrapEvery: Number(process.env.SIM_SCRAP_EVERY ?? 0) },
  log: (l) => console.log(`[gateway] ${l}`),
});
const every = Number(process.env.GATEWAY_EVERY_S ?? 10) * 1000;
console.log(`[gateway] ${gw.account.address} → ${process.env.ORDO_URL} for ${process.env.GATEWAY_ASSET}`);
for (;;) {
  await gw.tick().catch((e: unknown) => console.error(`[gateway] ${e instanceof Error ? e.message : e}`));
  await new Promise((r) => setTimeout(r, every));
}
