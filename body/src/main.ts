import type { Hex } from "viem";
import type { AssetKind } from "../../server/src/domain/types.js";
import { BODY_PROFILES } from "../../server/src/edge/profiles.js";
import { askServer } from "./ask.js";
import { Brain } from "./brain.js";
import { Body } from "./loop.js";
import { replay } from "./replay.js";

const USAGE = `ordo-body: a virtual machine's body.

  ordo-body                      run, configured by the environment Ordo starts it with
  ordo-body replay <log> [dir]   render an episode log's captures again and check them against what was signed

Environment: ORDO_URL, BODY_KEY, BODY_ASSET, BODY_PROFILE, BODY_SEED; optional BODY_ASK_PORT, BODY_ASK_TOKEN,
BODY_ASK_HOST, BODY_DATA_DIR, BODY_STAGE_S, BODY_TICK_S, BODY_DECIDE_S, BODY_FFMPEG, ZG_ROUTER_URL, ZG_ROUTER_KEY,
ZG_ROUTER_MODEL, ZG_ROUTER_TRUST_MODE, HEDERA_NETWORK, MACHINE_ACCOUNT_ID, MACHINE_ACCOUNT_KEY (the machine's own account, which buys what its
next stages consume over x402).`;

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} is not set.\n\n${USAGE}`);
    process.exit(2);
  }
  return v;
}
const int = (name: string, def: number, min: number) => {
  const n = Number(process.env[name] ?? def);
  return Number.isFinite(n) && n >= min ? n : def;
};

async function run() {
  const url = need("ORDO_URL");
  const key = need("BODY_KEY") as Hex;
  const kind = need("BODY_PROFILE") as AssetKind;
  if (kind === "system" || !(kind in BODY_PROFILES)) {
    console.error(`BODY_PROFILE ${kind} has no process model; one of ${Object.keys(BODY_PROFILES).join(", ")}`);
    process.exit(2);
  }
  const zgUrl = process.env.ZG_ROUTER_URL?.trim();
  const zgKey = process.env.ZG_ROUTER_KEY?.trim();
  const brain = zgUrl && zgKey ? new Brain({ url: zgUrl, key: zgKey, model: process.env.ZG_ROUTER_MODEL?.trim() || "0gm-1.0-35b-a3b", trustMode: process.env.ZG_ROUTER_TRUST_MODE?.trim() || "private" }) : null;
  const accountId = process.env.MACHINE_ACCOUNT_ID?.trim();
  const body = new Body({
    url,
    key,
    asset: need("BODY_ASSET"),
    kind: kind as Exclude<AssetKind, "system">,
    seed: need("BODY_SEED"),
    dataDir: process.env.BODY_DATA_DIR?.trim() || null,
    stageS: int("BODY_STAGE_S", 120, 5),
    tickS: int("BODY_TICK_S", 5, 1),
    decideS: int("BODY_DECIDE_S", 30, 5),
    failLimit: int("BODY_FAIL_LIMIT", 3, 1),
    brain,
    hedera: accountId ? { network: process.env.HEDERA_NETWORK?.trim() || "testnet", accountId } : null,
    machineKey: process.env.MACHINE_ACCOUNT_KEY?.trim() || null,
  });
  const port = process.env.BODY_ASK_PORT ? Number(process.env.BODY_ASK_PORT) : null;
  if (port) {
    // on Ordo's own host the body answers on loopback only; in a microVM it listens on every interface
    const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
    const host = process.env.BODY_ASK_HOST?.trim() || (loopback ? "127.0.0.1" : "0.0.0.0");
    askServer(body, { port, host, token: process.env.BODY_ASK_TOKEN?.trim() || null });
    console.log(`answers on ${host}:${port}/ask`);
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.race([body.stop(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  await body.start();
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "replay") {
  if (!rest[0]) {
    console.error(USAGE);
    process.exit(2);
  }
  replay(rest[0], rest[1]).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(USAGE);
} else {
  run().catch((e: Error) => {
    console.error(`body: ${e.stack ?? e.message}`);
    process.exit(1);
  });
}
