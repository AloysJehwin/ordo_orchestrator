import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionGoneError } from "../src/errors.js";
import { OrdoApiError } from "../src/ordo-api.js";
import { waitForSignature } from "../src/poll.js";

/** @param {string} status */
const st = (status) => /** @type {any} */ ({ status, contributionId: "c", signUrl: "u", proofUrl: status === "signed" ? "p" : null });

/** A fake clock: sleep advances time instantly. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (/** @type {number} */ ms) => void (t += ms) };
}

test("polls through submitted and transient errors until signed", async () => {
  const replies = [st("submitted"), new OrdoApiError("down", 503), new OrdoApiError("no net", 0), st("submitted"), st("signed")];
  let calls = 0;
  const final = await waitForSignature({
    client: {
      status: async () => {
        const r = replies[calls++];
        if (r instanceof Error) throw r;
        return r;
      },
    },
    intervalMs: 3000,
    ...clock(),
  });
  assert.equal(final.status, "signed");
  assert.equal(calls, 5);
});

test("stops on expired", async () => {
  const final = await waitForSignature({ client: { status: async () => st("expired") }, ...clock() });
  assert.equal(final.status, "expired");
});

test("a gone session (401/404/410) throws SessionGoneError", async () => {
  await assert.rejects(
    waitForSignature({ client: { status: async () => Promise.reject(new OrdoApiError("gone", 410)) }, ...clock() }),
    SessionGoneError,
  );
});

test("times out after the deadline", async () => {
  let calls = 0;
  const final = await waitForSignature({
    client: { status: async () => (calls++, st("submitted")) },
    intervalMs: 3000,
    timeoutMs: 30 * 60_000,
    ...clock(),
  });
  assert.equal(final.status, "timeout");
  assert.equal(calls, 601);
});

test("reports trouble once after repeated failures", async () => {
  let troubles = 0;
  let calls = 0;
  await waitForSignature({
    client: {
      status: async () => {
        calls += 1;
        if (calls <= 5) throw new OrdoApiError("down", 502);
        return st("signed");
      },
    },
    onTrouble: () => void (troubles += 1),
    ...clock(),
  });
  assert.equal(troubles, 1);
});
