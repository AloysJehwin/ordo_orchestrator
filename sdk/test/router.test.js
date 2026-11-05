import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalJson, sha256Hex } from "../src/canonical.js";
import { buildReceipt, captureHeaders, createRouterClient, describeRouterError, parseRetryAfter, RouterError } from "../src/router.js";

/** @typedef {import("../src/router.js").TransportRequest} TransportRequest */

/**
 * @param {number} status
 * @param {unknown} json
 * @param {Record<string, string>} [headers]
 */
function reply(status, json, headers = {}) {
  return { status, statusText: "", headers: new Headers(headers), body: new TextEncoder().encode(JSON.stringify(json)) };
}

const ok = (/** @type {Record<string, string>} */ headers = {}) =>
  reply(
    200,
    {
      id: "chatcmpl-1",
      model: "0gm-1.0-35b-a3b",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi", reasoning_content: "…" }, finish_reason: "stop" }],
      x_0g_trace: { request_id: "r1", provider: "0xabc", billing: { total_cost: "1" } },
    },
    headers,
  );

describe("createRouterClient", () => {
  test("sends canonical JSON in private mode and returns a receipt", async () => {
    /** @type {TransportRequest[]} */
    const sent = [];
    const response = ok({ "ZG-Res-Key": "key-1", "X-0G-Thing": "t", "Content-Type": "application/json" });
    const client = createRouterClient({
      baseUrl: "https://router.example/v1/",
      apiKey: "sk-test",
      model: "0gm-1.0-35b-a3b",
      transport: async (req) => {
        sent.push(req);
        return response;
      },
    });
    const messages = /** @type {any[]} */ ([{ role: "user", content: "hello" }]);
    const result = await client.chat({ messages, tools: [] });
    const req = /** @type {TransportRequest} */ (sent[0]);
    assert.equal(req.url, "https://router.example/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer sk-test");
    assert.equal(req.headers["x-0g-provider-trust-mode"], "private");
    assert.equal(req.body, canonicalJson({ model: "0gm-1.0-35b-a3b", messages, tools: [], tool_choice: "auto", stream: false, verify_tee: true }));
    assert.deepEqual(result.message, { role: "assistant", content: "Hi" });
    assert.equal(result.receipt.resKey, "key-1");
    assert.equal(result.receipt.requestId, "r1");
    assert.equal(result.receipt.provider, "0xabc");
    assert.equal(result.receipt.providerIdentity, null);
    assert.equal(result.receipt.teeVerified, null);
    assert.equal(result.receipt.requestSha256, sha256Hex(req.body));
    assert.equal(result.receipt.responseSha256, sha256Hex(response.body));
    assert.deepEqual(result.receipt.headers, { "zg-res-key": "key-1", "x-0g-thing": "t" });
    assert.deepEqual(result.receipt.trace, { request_id: "r1", provider: "0xabc", billing: { total_cost: "1" } });
  });

  test("retries once on 5xx, with backoff", async () => {
    const delays = /** @type {number[]} */ ([]);
    let calls = 0;
    const client = createRouterClient({
      baseUrl: "https://router.example/v1",
      apiKey: "k",
      model: "m",
      sleep: async (ms) => void delays.push(ms),
      transport: async () => (++calls === 1 ? reply(502, { error: { message: "provider failed", code: "provider_error" } }) : ok()),
    });
    const result = await client.chat({ messages: [], tools: [] });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [2000]);
    assert.equal(result.message.content, "Hi");
  });

  test("honours Retry-After on 429 and gives up after one retry", async () => {
    const delays = /** @type {number[]} */ ([]);
    let calls = 0;
    const client = createRouterClient({
      baseUrl: "https://router.example/v1",
      apiKey: "k",
      model: "m",
      sleep: async (ms) => void delays.push(ms),
      transport: async () => {
        calls += 1;
        return reply(429, { error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" } }, { "retry-after": "3" });
      },
    });
    await assert.rejects(client.chat({ messages: [], tools: [] }), (err) => err instanceof RouterError && err.status === 429);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [3000]);
  });

  test("does not retry 401, 402 or 400", async () => {
    for (const status of [400, 401, 402]) {
      let calls = 0;
      const client = createRouterClient({
        baseUrl: "https://router.example/v1",
        apiKey: "k",
        model: "m",
        sleep: async () => {},
        transport: async () => {
          calls += 1;
          return reply(status, { error: { message: "nope", code: "x" }, request_id: "req-9" });
        },
      });
      await assert.rejects(client.chat({ messages: [], tools: [] }), (err) => err instanceof RouterError && err.requestId === "req-9");
      assert.equal(calls, 1, `status ${status}`);
    }
  });

  test("a network failure is retried once and then reported", async () => {
    let calls = 0;
    const client = createRouterClient({
      baseUrl: "https://router.example/v1",
      apiKey: "secret-key",
      model: "m",
      sleep: async () => {},
      transport: async () => {
        calls += 1;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      },
    });
    await assert.rejects(client.chat({ messages: [], tools: [] }), (err) => {
      assert.ok(err instanceof RouterError);
      assert.equal(err.status, 0);
      assert.match(err.message, /ECONNRESET/);
      assert.ok(!err.message.includes("secret-key"));
      return true;
    });
    assert.equal(calls, 2);
  });
});

describe("receipts", () => {
  test("falls back to the body id and a top-level trace", () => {
    const receipt = buildReceipt({
      data: { id: "chatcmpl-9", trace: { provider: "0xdef" } },
      headers: new Headers(),
      model: "m",
      requestSha256: "a",
      responseSha256: "b",
    });
    assert.equal(receipt.resKey, "chatcmpl-9");
    assert.equal(receipt.provider, "0xdef");
    assert.equal(receipt.model, "m");
    assert.deepEqual(receipt.trace, { provider: "0xdef" });
  });

  test("header fallbacks for provider and request id; tee_verified false is kept", () => {
    const receipt = buildReceipt({
      data: { id: "chatcmpl-2", x_0g_trace: { provider_identity: "aliyun", tee_verified: false } },
      headers: new Headers({ "X-Provider": "0xfeed", "X-Request-ID": "rid-2", "ZG-Res-Key": "rk" }),
      model: "m",
      requestSha256: "a",
      responseSha256: "b",
    });
    assert.equal(receipt.resKey, "rk");
    assert.equal(receipt.provider, "0xfeed");
    assert.equal(receipt.requestId, "rid-2");
    assert.equal(receipt.providerIdentity, "aliyun");
    assert.equal(receipt.teeVerified, false);
    assert.deepEqual(receipt.headers, { "x-provider": "0xfeed", "x-request-id": "rid-2", "zg-res-key": "rk" });
  });

  test("no trace, no key", () => {
    const receipt = buildReceipt({ data: {}, headers: new Headers(), model: "m", requestSha256: "a", responseSha256: "b" });
    assert.equal(receipt.resKey, null);
    assert.equal(receipt.requestId, null);
    assert.equal(receipt.provider, null);
    assert.equal(receipt.teeVerified, null);
    assert.equal("trace" in receipt, false);
  });

  test("captureHeaders keeps zg-, x-0g- and 0g- headers plus X-Provider and X-Request-ID", () => {
    const headers = new Headers({ "ZG-Res-Key": "k", "x-0g-a": "1", "0g-b": "2", "x-ratelimit-limit-requests": "60", server: "x", "X-Provider": "0x1", "X-Request-ID": "r" });
    assert.deepEqual(captureHeaders(headers), { "zg-res-key": "k", "x-0g-a": "1", "0g-b": "2", "x-provider": "0x1", "x-request-id": "r" });
  });
});

test("parseRetryAfter", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("Thu, 01 Jan 2026 00:00:00 GMT")), 10_000);
  assert.equal(parseRetryAfter("soon"), null);
});

test("describeRouterError", () => {
  const e = (/** @type {number} */ status, code = "") => new RouterError("m", { status, code, requestId: "r" });
  assert.match(describeRouterError(e(402), "glm"), /balance is too low.*pc\.0g\.ai.*\[request r\]/);
  assert.match(describeRouterError(e(401), "glm"), /rejected this session's key/);
  assert.match(describeRouterError(e(429), "glm"), /rate limiting/);
  assert.match(describeRouterError(e(503), "glm"), /No private \(TEE\) provider is serving glm/);
  assert.match(describeRouterError(e(500), "glm"), /internal error \(500\)/);
});
