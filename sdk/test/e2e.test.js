// End to end: the real bin against a local Ordo API and a local Router (or the mock interviewer).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { canonicalJson } from "../src/canonical.js";
import { formatToken } from "../src/token.js";
import { startFakeOrdo } from "./helpers/fake-ordo.js";
import { completion, PROVIDER, startFakeRouter } from "./helpers/fake-router.js";
import { BIN, runCli } from "./helpers/run-cli.js";

const SECRET = "s3cr3t_SESSION_token-abcdefghijklmnop";
const ROUTER_KEY = "sk-router-session-key-0123456789";
const EVIDENCE = "time,force_kN\n08:00,41.5\n08:01,41.6\n";

const sha256 = (/** @type {string | Buffer} */ data) => createHash("sha256").update(data).digest("hex");

/** @param {string} routerBaseUrl */
function makeSession(routerBaseUrl) {
  return {
    sessionId: "ps_1",
    expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    org: { id: "org_1", name: "Acme Plant" },
    contributor: { address: "0x1234567890abcdef1234567890abcdef12345678", name: "Jane Doe" },
    stage: {
      runId: "run_1",
      orderRef: "WO-17",
      templateName: "Bearing housing",
      code: "PF-20",
      name: "Press fit",
      state: "running",
      criteria: [
        { label: "Bore diameter", kind: "range", target: { min: 11.98, max: 12.02 }, unit: "mm", signal: "bore_d" },
        { label: "Visual check", kind: "boolean", target: true },
      ],
      parameters: [{ signal: "press_force", unit: "kN" }],
    },
    guide: "Ask when the press was last calibrated.",
    router: { baseUrl: `${routerBaseUrl}/v1`, apiKey: ROUTER_KEY, model: "0gm-1.0-35b-a3b", trustMode: "private" },
  };
}

/** @type {string} */
let workdir;
before(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "ordo-pow-e2e-"));
  await writeFile(path.join(workdir, "run-log.csv"), EVIDENCE);
});
after(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** @param {{ stdout: string, stderr: string }} out */
function assertNoSecrets(out) {
  for (const stream of [out.stdout, out.stderr]) {
    assert.ok(!stream.includes(SECRET), "the session secret was printed");
    assert.ok(!stream.includes(ROUTER_KEY), "the Router key was printed");
  }
}

/**
 * @param {any[]} messages
 * @param {string} callId
 */
function toolResult(messages, callId) {
  const msg = messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
  assert.ok(msg, `no tool result for ${callId}`);
  return JSON.parse(msg.content);
}

describe("through the Router", () => {
  test("interviews, records, submits once, and waits for the signature", async () => {
    const router = await startFakeRouter({
      apiKey: ROUTER_KEY,
      script: [
        // 0: rate limited; the client retries once
        () => ({
          status: 429,
          headers: { "retry-after": "0" },
          json: { error: { message: "Rate limit exceeded. Please try again later.", type: "rate_limit_error", code: "rate_limit_exceeded" } },
        }),
        (_b, i) => completion(i, { content: "What did you do on the Press fit stage?" }),
        (_b, i) =>
          completion(i, {
            toolCalls: [
              { name: "note", args: { text: "Pressed 20 housings on press 3" } },
              { name: "record_measurement", args: { criterion: "bore diameter", value: 12.01, unit: "mm" } },
              { name: "record_measurement", args: { criterion: "Torque", value: 5 } },
            ],
          }),
        // no provider in the trace: falls back to the X-Provider header
        (_b, i) => completion(i, { content: "What press force did you use?", traceProvider: false }),
        (_b, i) => completion(i, { toolCalls: [{ name: "record_measurement", args: { criterion: "press_force", value: 41.5, unit: "kN" } }] }),
        // no ZG-Res-Key header on this one: the receipt falls back to the body id
        (_b, i) => completion(i, { content: "Do you have evidence files?", resKeyHeader: false }),
        (_b, i) =>
          completion(i, {
            toolCalls: [
              { name: "attach_evidence", args: { path: "run-log.csv" } },
              { name: "attach_evidence", args: { path: "missing.bin" } },
            ],
          }),
        // verify_tee not reported: teeVerified is null
        (_b, i) => completion(i, { content: "Anything unusual?", teeVerified: null }),
        (_b, i) =>
          completion(i, {
            toolCalls: [
              { name: "finish", args: { summary: "Pressed 20 housings on press 3; bore 12.01 mm at 41.5 kN. One part re-pressed." } },
              { name: "note", args: { text: "One part re-pressed" } },
            ],
          }),
      ],
    });
    const session = makeSession(router.url);
    const ordo = await startFakeOrdo({ secret: SECRET, session, submittedPolls: 2 });
    try {
      const out = await runCli({
        args: [formatToken(ordo.url, SECRET)],
        cwd: workdir,
        input: ["Pressed 20 housings on press 3.", "41.5 kN", "run-log.csv", "/show", "One part re-pressed.", "y", ""].join("\n"),
      });
      assert.equal(out.code, 0, `exit ${out.code}\n${out.stdout}\n${out.stderr}`);
      assertNoSecrets(out);
      assert.match(out.stdout, /Sign your record in the Ordo console:\n\s+http:\/\/127\.0\.0\.1:\d+\/#\/pow\/sign\/c_1/);
      assert.match(out.stdout, /Public proof: http:\/\/127\.0\.0\.1:\d+\/#\/proof\/contribution\/c_1/);
      assert.match(out.stdout, /Evidence.*\n\s+run-log\.csv/); // /show printed the record
      assert.match(out.stderr, /retrying in 0 s/);

      // Exactly one finish, with the expected record.
      assert.equal(ordo.state.finishBodies.length, 1);
      const payload = ordo.state.finishBodies[0];
      assert.equal(payload.summary, "Pressed 20 housings on press 3; bore 12.01 mm at 41.5 kN. One part re-pressed.");
      assert.deepEqual(payload.measurements, [
        { criterion: "Bore diameter", value: 12.01, unit: "mm" },
        { criterion: "press_force", value: 41.5, unit: "kN" },
      ]);
      assert.deepEqual(
        payload.notes.map((/** @type {any} */ n) => n.text),
        ["Pressed 20 housings on press 3", "One part re-pressed"],
      );
      for (const n of payload.notes) assert.ok(!Number.isNaN(Date.parse(n.at)));
      assert.deepEqual(payload.evidence, [{ name: "run-log.csv", sha256: sha256(EVIDENCE), size: Buffer.byteLength(EVIDENCE), mediaType: "text/csv" }]);
      assert.deepEqual(
        payload.transcript.filter((/** @type {any} */ t) => t.role === "user").map((/** @type {any} */ t) => t.content),
        ["Pressed 20 housings on press 3.", "41.5 kN", "run-log.csv", "One part re-pressed."],
      );
      assert.deepEqual(
        payload.transcript.filter((/** @type {any} */ t) => t.role === "assistant").map((/** @type {any} */ t) => t.content),
        ["What did you do on the Press fit stage?", "What press force did you use?", "Do you have evidence files?", "Anything unusual?"],
      );

      // One receipt per successful Router response, bound to the exact bytes on the wire.
      const ok = router.calls.filter((c) => c.status === 200);
      assert.equal(router.calls.length, 9);
      assert.equal(payload.receipts.length, ok.length);
      payload.receipts.forEach((/** @type {any} */ r, /** @type {number} */ k) => {
        const call = /** @type {(typeof ok)[number]} */ (ok[k]);
        const index = router.calls.indexOf(call);
        assert.equal(r.requestSha256, sha256(call.rawBody));
        assert.equal(r.responseSha256, sha256(call.responseBytes));
        assert.equal(r.resKey, index === 5 ? "chatcmpl-5" : `rk-${index}`);
        assert.equal(r.provider, PROVIDER);
        assert.equal(r.providerIdentity, index === 3 ? null : "phala-tdx");
        assert.equal(r.requestId, `req-${index}`);
        assert.equal(r.teeVerified, index === 7 ? null : true);
        assert.equal(r.model, "zai-org/GLM-5.3");
        assert.equal(r.trace.request_id, `req-${index}`);
        assert.equal(r.headers["x-0g-served-by"], `node-${index}`);
        assert.equal(r.headers["x-request-id"], `req-${index}`);
        assert.equal(r.headers["x-provider"], PROVIDER);
        if (index !== 5) assert.equal(r.headers["zg-res-key"], `rk-${index}`);
        assert.equal(r.headers["content-type"], undefined);
        assert.equal(r.headers["x-ratelimit-remaining-requests"], undefined);
        assert.ok(!Number.isNaN(Date.parse(r.at)));
      });

      // What went to the Router.
      for (const call of router.calls) {
        assert.equal(call.headers.authorization, `Bearer ${ROUTER_KEY}`);
        assert.equal(call.headers["x-0g-provider-trust-mode"], "private");
        assert.equal(call.rawBody, canonicalJson(JSON.parse(call.rawBody)), "request body is canonical JSON");
        assert.equal(call.body.model, "0gm-1.0-35b-a3b");
        assert.equal(call.body.tool_choice, "auto");
        assert.equal(call.body.stream, false);
        assert.equal(call.body.verify_tee, true);
        assert.deepEqual(
          call.body.tools.map((/** @type {any} */ t) => t.function.name),
          ["record_measurement", "note", "attach_evidence", "finish"],
        );
        const system = call.body.messages[0];
        assert.equal(system.role, "system");
        assert.match(system.content, /Ask when the press was last calibrated\./);
        assert.match(system.content, /"Bore diameter"/);
        assert.match(system.content, /"press_force"/);
        // reasoning text is not sent back
        assert.ok(call.body.messages.every((/** @type {any} */ m) => m.reasoning_content === undefined));
      }
      // Tool results went back to the model, including the rejections.
      const third = /** @type {any} */ (router.calls[3]).body.messages;
      assert.equal(toolResult(third, "call_2_1").ok, true);
      const rejected = toolResult(third, "call_2_2");
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /"Torque" is not a criterion or parameter of this stage/);
      const seventh = /** @type {any} */ (router.calls[7]).body.messages;
      assert.equal(toolResult(seventh, "call_6_0").sha256, sha256(EVIDENCE));
      assert.match(toolResult(seventh, "call_6_1").error, /No file at missing\.bin/);

      // Ordo: every request authenticated; polled to signed after one finish.
      for (const r of ordo.state.requests) {
        assert.equal(r.headers.authorization, `Bearer ${SECRET}`);
        assert.equal(r.headers.accept, "application/json");
      }
      const paths = ordo.state.requests.map((r) => `${r.method} ${r.path}`);
      assert.deepEqual(paths.slice(0, 2), ["GET /v1/pow/session/status", "GET /v1/pow/session"]);
      assert.equal(paths.filter((p) => p === "POST /v1/pow/session/finish").length, 1);
      assert.equal(ordo.state.status, "signed");
      assert.ok(paths.slice(paths.indexOf("POST /v1/pow/session/finish")).filter((p) => p.endsWith("/status")).length >= 3);
    } finally {
      await ordo.close();
      await router.close();
    }
  });

  test("402 insufficient balance is explained, not retried, and nothing is posted", async () => {
    const router = await startFakeRouter({
      apiKey: ROUTER_KEY,
      script: [
        () => ({
          status: 402,
          json: { error: { message: "Insufficient balance", type: "payment_error", code: "insufficient_balance" }, request_id: "req-402" },
        }),
      ],
    });
    const ordo = await startFakeOrdo({ secret: SECRET, session: makeSession(router.url) });
    try {
      const out = await runCli({ args: [formatToken(ordo.url, SECRET)], cwd: workdir, input: "/quit\n" });
      assert.equal(out.code, 3, out.stdout + out.stderr);
      assertNoSecrets(out);
      assert.match(out.stderr, /balance is too low \(402 insufficient balance\).*\[request req-402\]/);
      assert.match(out.stdout, /Nothing was submitted/);
      assert.equal(router.calls.length, 1);
      assert.equal(ordo.state.finishBodies.length, 0);
    } finally {
      await ordo.close();
      await router.close();
    }
  });

  test("503 is retried once, then explained", async () => {
    const unavailable = () => ({
      status: 503,
      headers: { "retry-after": "0" },
      json: { error: { message: "No provider for trust mode", type: "server_error", code: "no_provider_for_trust_mode" } },
    });
    const router = await startFakeRouter({ apiKey: ROUTER_KEY, script: [unavailable, unavailable] });
    const ordo = await startFakeOrdo({ secret: SECRET, session: makeSession(router.url) });
    try {
      const out = await runCli({ args: [formatToken(ordo.url, SECRET)], cwd: workdir, input: "/quit\n" });
      assert.equal(out.code, 3, out.stdout + out.stderr);
      assert.equal(router.calls.length, 2);
      assert.match(out.stderr, /No private \(TEE\) provider is serving 0gm-1\.0-35b-a3b right now \(503\)/);
      assert.equal(ordo.state.finishBodies.length, 0);
    } finally {
      await ordo.close();
      await router.close();
    }
  });
});

describe("with the mock interviewer (ORDO_POW_MOCK_ROUTER=1)", () => {
  test("runs the whole flow offline, including a declined confirmation", async () => {
    const session = makeSession("https://router.invalid");
    const ordo = await startFakeOrdo({ secret: SECRET, session, submittedPolls: 1 });
    try {
      const out = await runCli({
        args: [formatToken(ordo.url, SECRET)],
        env: { ORDO_POW_MOCK_ROUTER: "1" },
        cwd: workdir,
        input: ["Ran the press fit batch", "12.01 mm", "skip", "41.5", "run-log.csv", "none", "none", "n", "submit", "y", ""].join("\n"),
      });
      assert.equal(out.code, 0, out.stdout + out.stderr);
      assertNoSecrets(out);
      assert.match(out.stdout, /scripted interviewer \(ORDO_POW_MOCK_ROUTER\)/);
      assert.match(out.stdout, /Not sent\. Tell the interviewer what to change\./);
      assert.equal(ordo.state.finishBodies.length, 1);
      const payload = ordo.state.finishBodies[0];
      assert.deepEqual(payload.measurements, [
        { criterion: "Bore diameter", value: 12.01, unit: "mm" },
        { criterion: "press_force", value: 41.5, unit: "kN" },
      ]);
      assert.deepEqual(
        payload.notes.map((/** @type {any} */ n) => n.text),
        ["Work done: Ran the press fit batch", "Not measured: Visual check"],
      );
      assert.deepEqual(payload.evidence, [{ name: "run-log.csv", sha256: sha256(EVIDENCE), size: Buffer.byteLength(EVIDENCE), mediaType: "text/csv" }]);
      assert.equal(payload.summary, "Ran the press fit batch; 2 measurements recorded; 1 evidence file attached.");
      assert.ok(payload.receipts.length > 5);
      for (const [k, r] of payload.receipts.entries()) {
        assert.equal(r.provider, null);
        assert.equal(r.requestId, `mock-${k + 1}`);
        assert.equal(r.teeVerified, null);
        assert.equal(r.model, "ordo-mock-interviewer");
        assert.equal(r.trace.mock, true);
        assert.equal(r.headers["x-0g-mock"], "true");
        assert.match(r.requestSha256, /^[0-9a-f]{64}$/);
        assert.match(r.responseSha256, /^[0-9a-f]{64}$/);
      }
      assert.match(out.stdout, /Public proof: /);
    } finally {
      await ordo.close();
    }
  });

  test("picks the scripted interviewer by itself when Ordo has no Router", async () => {
    const session = { ...makeSession("https://router.invalid"), router: { baseUrl: "mock://router", apiKey: "sk-mock-1", model: "ordo-mock-interviewer", trustMode: "private", network: "mock" } };
    const ordo = await startFakeOrdo({ secret: SECRET, session });
    try {
      const out = await runCli({
        args: [formatToken(ordo.url, SECRET)],
        env: {},
        cwd: workdir,
        input: "Did some work\n/quit\n",
      });
      assert.equal(out.code, 3, out.stdout + out.stderr);
      assert.match(out.stdout, /scripted interviewer \(this Ordo has no 0G Router configured\)/);
      assert.doesNotMatch(out.stdout + out.stderr, /must be an http or https URL/);
    } finally {
      await ordo.close();
    }
  });

  test("/quit stops without posting", async () => {
    const ordo = await startFakeOrdo({ secret: SECRET, session: makeSession("https://router.invalid") });
    try {
      const out = await runCli({
        args: [formatToken(ordo.url, SECRET)],
        env: { ORDO_POW_MOCK_ROUTER: "1" },
        cwd: workdir,
        input: "Did some work\n/quit\n",
      });
      assert.equal(out.code, 3, out.stdout + out.stderr);
      assert.match(out.stdout, /Stopped\. Nothing was submitted\./);
      assert.equal(ordo.state.finishBodies.length, 0);
    } finally {
      await ordo.close();
    }
  });
});

describe("session states", () => {
  test("already submitted: skips the interview and waits (token from env, --api override)", async () => {
    const ordo = await startFakeOrdo({ secret: SECRET, session: makeSession("https://router.invalid"), initialStatus: "submitted", submittedPolls: 1 });
    try {
      const out = await runCli({
        args: ["--api", `${ordo.url}/`],
        env: { ORDO_POW_TOKEN: formatToken("https://ordo.example.invalid", SECRET) },
        cwd: workdir,
      });
      assert.equal(out.code, 0, out.stdout + out.stderr);
      assertNoSecrets(out);
      assert.match(out.stdout, /already submitted/);
      assert.match(out.stdout, /#\/pow\/sign\/c_existing/);
      assert.match(out.stdout, /Public proof: .*c_existing/);
      const paths = ordo.state.requests.map((r) => r.path);
      assert.ok(!paths.includes("/v1/pow/session"), "fetched the session");
      assert.ok(!paths.includes("/v1/pow/session/finish"), "posted a second finish");
    } finally {
      await ordo.close();
    }
  });

  test("an expired session exits 1 with a friendly message", async () => {
    const ordo = await startFakeOrdo({ secret: SECRET, session: makeSession("https://router.invalid"), goneStatus: 410 });
    try {
      const out = await runCli({ args: [formatToken(ordo.url, SECRET)], cwd: workdir });
      assert.equal(out.code, 1);
      assertNoSecrets(out);
      assert.match(out.stderr, /no longer valid/);
      assert.match(out.stderr, /Contribute proof of work/);
    } finally {
      await ordo.close();
    }
  });

  test("a wrong secret is treated as an invalid session", async () => {
    const ordo = await startFakeOrdo({ secret: SECRET, session: makeSession("https://router.invalid") });
    try {
      const wrong = "WRONGsecretWRONGsecret123";
      const out = await runCli({ args: [formatToken(ordo.url, wrong)], cwd: workdir });
      assert.equal(out.code, 1);
      assert.ok(!out.stdout.includes(wrong) && !out.stderr.includes(wrong));
      assert.match(out.stderr, /no longer valid/);
    } finally {
      await ordo.close();
    }
  });

  test("a malformed token exits 2 without echoing it", async () => {
    const bogus = "opw1.not-base64!.supersecretvalue123456";
    const out = await runCli({ args: [bogus], cwd: workdir });
    assert.equal(out.code, 2);
    assert.ok(!out.stdout.includes("supersecretvalue") && !out.stderr.includes("supersecretvalue"));
    assert.match(out.stderr, /not valid base64url/);
  });

  test("an unreachable Ordo exits 1", async () => {
    const out = await runCli({ args: [formatToken("http://127.0.0.1:9", SECRET)], cwd: workdir });
    assert.equal(out.code, 1);
    assertNoSecrets(out);
    assert.match(out.stderr, /Could not reach Ordo at http:\/\/127\.0\.0\.1:9/);
  });
});

describe("Ctrl-C", () => {
  test("while waiting for the signature: explains how to resume, exits 130, and a re-run does not submit twice", async () => {
    const ordo = await startFakeOrdo({ secret: SECRET, session: makeSession("https://router.invalid"), submittedPolls: 1_000_000 });
    try {
      const child = spawn(process.execPath, [BIN, formatToken(ordo.url, SECRET)], {
        cwd: workdir,
        env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", ORDO_POW_NO_OPEN: "1", ORDO_POW_POLL_INTERVAL_MS: "20", ORDO_POW_MOCK_ROUTER: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let interrupted = false;
      child.stdout.on("data", (d) => {
        stdout += d;
        if (!interrupted && stdout.includes("Waiting for your signature")) {
          interrupted = true;
          child.kill("SIGINT");
        }
      });
      child.stdin.end(["Did the work", "skip", "skip", "skip", "none", "none", "y", ""].join("\n"));
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 130, stdout);
      assert.match(stdout, /Stopped waiting\. Your record is submitted; sign it at http:\/\/127\.0\.0\.1:\d+\/#\/pow\/sign\/c_1/);
      assert.match(stdout, /run the same command again\. It will not submit a second time\./);
      assert.equal(ordo.state.finishBodies.length, 1);

      // Re-run: goes straight to waiting, no second finish.
      ordo.state.pollsAfterSubmit = 999_999; // the startup check sees "submitted", the first poll "signed"
      const again = await runCli({ args: [formatToken(ordo.url, SECRET)], cwd: workdir });
      assert.equal(again.code, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /already submitted/);
      assert.equal(ordo.state.finishBodies.length, 1);
    } finally {
      await ordo.close();
    }
  });
});
