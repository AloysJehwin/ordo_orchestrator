// A local stand-in for the 0G Private Computer Router: answers chat completions from a script.
import http from "node:http";

/**
 * @typedef {object} ScriptedResponse
 * @property {number} [status]
 * @property {Record<string, string>} [headers]
 * @property {unknown} json
 */

/**
 * @typedef {object} RouterCall
 * @property {http.IncomingHttpHeaders} headers
 * @property {string} rawBody
 * @property {any} body
 * @property {Buffer} responseBytes
 * @property {number} status
 */

/**
 * @param {{ apiKey: string, script: ((body: any, index: number) => ScriptedResponse)[] }} options
 */
export async function startFakeRouter({ apiKey, script }) {
  /** @type {RouterCall[]} */
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;
    const path = new URL(req.url ?? "/", "http://local").pathname;
    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    const index = calls.length;
    const body = JSON.parse(rawBody);
    /** @type {ScriptedResponse} */
    let reply;
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      reply = { status: 401, json: { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } } };
    } else {
      const step = script[index];
      reply = step
        ? step(body, index)
        : { status: 500, json: { error: { message: "script exhausted", type: "server_error", code: "internal_error" } } };
    }
    const responseBytes = Buffer.from(JSON.stringify(reply.json));
    const status = reply.status ?? 200;
    calls.push({ headers: req.headers, rawBody, body, responseBytes, status });
    res.writeHead(status, { "content-type": "application/json", ...(reply.headers ?? {}) });
    res.end(responseBytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

export const PROVIDER = "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C";

/**
 * An OpenAI-shaped completion as the Router returns it.
 * @param {number} index
 * @param {{
 *   content?: string | null,
 *   toolCalls?: { name: string, args: Record<string, unknown> }[],
 *   resKeyHeader?: boolean,
 *   traceProvider?: boolean,
 *   teeVerified?: boolean | null,   // null: not reported
 * }} reply
 * @returns {ScriptedResponse}
 */
export function completion(index, { content = null, toolCalls = [], resKeyHeader = true, traceProvider = true, teeVerified = true }) {
  /** @type {Record<string, unknown>} */
  const message = { role: "assistant", content, reasoning_content: "thinking about the stage" };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call, i) => ({
      id: `call_${index}_${i}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
  }
  /** @type {Record<string, string>} */
  const headers = {
    "x-0g-served-by": `node-${index}`,
    "X-Request-ID": `req-${index}`,
    "X-Provider": PROVIDER,
    "x-ratelimit-remaining-requests": "99",
  };
  if (resKeyHeader) headers["ZG-Res-Key"] = `rk-${index}`;
  /** @type {Record<string, unknown>} */
  const trace = { request_id: `req-${index}`, billing: { input_cost: "10", output_cost: "4", total_cost: "14", currency: "0g" } };
  if (traceProvider) {
    trace.provider = PROVIDER;
    trace.provider_identity = "phala-tdx";
  }
  if (teeVerified !== null) trace.tee_verified = teeVerified;
  return {
    headers,
    json: {
      id: `chatcmpl-${index}`,
      object: "chat.completion",
      created: 1_700_000_000 + index,
      model: "zai-org/GLM-5.3",
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      x_0g_trace: trace,
    },
  };
}
