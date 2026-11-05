// Wait for the contributor to sign in the console.
/** @import { SessionStatus } from "./types.js" */
/** @import { OrdoClient } from "./ordo-api.js" */
import { SessionGoneError } from "./errors.js";
import { OrdoApiError } from "./ordo-api.js";

export const POLL_INTERVAL_MS = 3_000;
export const POLL_TIMEOUT_MS = 30 * 60_000;

/**
 * Poll the session status until it is signed or expired, or the timeout passes.
 * Network hiccups and server errors are ignored (reported once) and polling continues.
 * @param {{
 *   client: Pick<OrdoClient, "status">,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   onTrouble?: (error: OrdoApiError) => void,
 *   onUpdate?: (status: SessionStatus) => void,
 * }} options
 * @returns {Promise<SessionStatus | { status: "timeout" }>}
 */
export async function waitForSignature({
  client,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  onTrouble = () => {},
  onUpdate = () => {},
}) {
  const deadline = now() + timeoutMs;
  let failures = 0;
  for (;;) {
    try {
      const status = await client.status();
      failures = 0;
      onUpdate(status);
      if (status.status === "signed" || status.status === "expired") return status;
    } catch (err) {
      if (!(err instanceof OrdoApiError)) throw err;
      if (err.gone) throw new SessionGoneError();
      failures += 1;
      if (failures === 3) onTrouble(err);
    }
    if (now() + intervalMs > deadline) return { status: "timeout" };
    await sleep(intervalMs);
  }
}
