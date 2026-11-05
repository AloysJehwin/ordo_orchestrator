// Client for the 0G Private Computer Router (OpenAI-compatible chat completions, and speech to text for voice notes).
//
// Every request goes out in the session's trust mode: private (TEE providers only, with verify_tee: true) unless the
// Ordo runs on standard routing, which has no TEE and says so.
// Every successful response yields a receipt: the response key (ZG-Res-Key header, falling
// back to the body's id), the Router request id, the serving provider and its identity, the
// Router's TEE verdict (x_0g_trace.tee_verified), SHA-256 of the exact request bytes sent and
// of the exact response bytes received, the 0G response headers, and the x_0g_trace block.
/** @import { ChatMessage, Receipt, ToolCall } from "./types.js" */
import { canonicalJson, sha256Hex } from "./canonical.js";
import { USER_AGENT } from "./meta.js";
import { networkReason } from "./ordo-api.js";

/** The default trust mode, and the only one served in a TEE */
export const TRUST_MODE = "private";
/** @param {string} [mode] */
export const trustText = (mode = TRUST_MODE) =>
  mode === "private" ? "private mode (TEE providers only)" : mode === "verified" ? "verified mode (verifiable providers, not a TEE)" : "standard routing (not a TEE)";
const AUDIO_MIME = /** @type {Record<string, string>} */ ({ wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac", aac: "audio/aac" });
const TIMEOUT_MS = 180_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * @typedef {object} TransportRequest
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {string} body
 * @property {AbortSignal} signal
 */

/**
 * @typedef {object} TransportResponse
 * @property {number} status
 * @property {string} statusText
 * @property {Headers} headers
 * @property {Uint8Array} body
 */

/** @typedef {(request: TransportRequest) => Promise<TransportResponse>} Transport */

/** @type {Transport} */
export async function fetchTransport({ url, headers, body, signal }) {
  const res = await fetch(url, { method: "POST", headers, body, signal });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, statusText: res.statusText, headers: res.headers, body: bytes };
}

export class RouterError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, code?: string | null, type?: string | null, requestId?: string | null, retryAfterMs?: number | null }} info
   */
  constructor(message, info) {
    super(message);
    this.name = "RouterError";
    this.status = info.status;
    this.code = info.code ?? null;
    this.type = info.type ?? null;
    this.requestId = info.requestId ?? null;
    this.retryAfterMs = info.retryAfterMs ?? null;
  }

  /** 429, 5xx and network failures are retried once. */
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/**
 * @typedef {object} ChatResult
 * @property {ChatMessage & { role: "assistant" }} message
 * @property {string | null} finishReason
 * @property {Receipt} receipt
 */

/**
 * @typedef {object} TranscriptionResult
 * @property {string} text
 * @property {Receipt} receipt
 */

/**
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   audioModel?: string | null,
 *   transport?: Transport,
 *   sleep?: (ms: number) => Promise<void>,
 *   onRetry?: (error: RouterError, delayMs: number) => void,
 *   timeoutMs?: number,
 *   verifyTee?: boolean,
 *   trustMode?: string,
 *   audioVia?: "transcriptions" | "chat",
 * }} options
 */
export function createRouterClient({
  baseUrl,
  apiKey,
  model,
  audioModel = null,
  transport = fetchTransport,
  sleep = defaultSleep,
  onRetry = () => {},
  timeoutMs = TIMEOUT_MS,
  trustMode = TRUST_MODE,
  verifyTee = trustMode === "private",
  audioVia = audioModel && !/whisper/i.test(audioModel) ? "chat" : "transcriptions",
}) {
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}/chat/completions`;
  // speech to text takes a JSON body with the audio in file_base64; verify_tee is a query parameter on this endpoint
  const transcriptionUrl = `${root}/audio/transcriptions${verifyTee ? "?verify_tee=true" : ""}`;

  /**
   * One round trip, no retry.
   * @param {string} bodyText
   * @param {string} [target]
   */
  async function once(bodyText, target = url) {
    /** @type {TransportResponse} */
    let res;
    try {
      res = await transport({
        url: target,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": USER_AGENT,
          "x-0g-provider-trust-mode": trustMode,
        },
        body: bodyText,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RouterError(`Could not reach the 0G Router (${networkReason(err)}).`, { status: 0 });
    }
    if (res.status < 200 || res.status >= 300) throw errorFromResponse(res);
    return res;
  }

  /**
   * One request, retried once on 429, 5xx or a network failure.
   * @param {string} bodyText
   * @param {string} [target]
   */
  async function withRetry(bodyText, target = url) {
    try {
      return await once(bodyText, target);
    } catch (err) {
      if (!(err instanceof RouterError) || !err.retryable) throw err;
      const delay = Math.min(err.retryAfterMs ?? (err.status === 429 ? 5_000 : 2_000), MAX_RETRY_DELAY_MS);
      onRetry(err, delay);
      await sleep(delay);
      return once(bodyText, target);
    }
  }

  /**
   * A voice note through an omni chat model (one that hears audio): the audio goes as an input_audio data URI and the
   * model is asked for a verbatim transcript.
   * @param {Uint8Array} bytes
   * @param {string} filename
   * @returns {Promise<TranscriptionResult>}
   */
  async function transcribeByChat(bytes, filename) {
    const ext = (filename.split(".").pop() ?? "").toLowerCase();
    const mime = AUDIO_MIME[ext] ?? "audio/wav";
    /** @type {Record<string, unknown>} */
    const requestBody = {
      model: audioModel,
      stream: false,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this voice note verbatim, in its own language. Reply with the transcript only; if nothing is said, reply with an empty line." },
            { type: "input_audio", input_audio: { data: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, format: ext || "wav" } },
          ],
        },
      ],
    };
    if (verifyTee) requestBody.verify_tee = true;
    const bodyText = canonicalJson(requestBody);
    const requestSha256 = sha256Hex(bodyText);
    const res = await withRetry(bodyText);
    const responseSha256 = sha256Hex(res.body);
    /** @type {Record<string, any>} */
    let data;
    try {
      data = JSON.parse(Buffer.from(res.body).toString("utf8"));
    } catch {
      throw new RouterError("The 0G Router sent a transcription that is not JSON.", { status: res.status });
    }
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((/** @type {any} */ p) => p?.text ?? "").join("") : null;
    if (text === null) throw new RouterError("The 0G Router's transcription has no text.", { status: res.status });
    const receipt = buildReceipt({ data, headers: res.headers, model: /** @type {string} */ (audioModel), requestSha256, responseSha256 });
    receipt.kind = "transcription";
    return { text: text.trim(), receipt };
  }

  return {
    model,
    audioModel,
    trustMode,

    /**
     * @param {{ messages: ChatMessage[], tools: unknown[] }} input
     * @returns {Promise<ChatResult>}
     */
    async chat({ messages, tools }) {
      /** @type {Record<string, unknown>} */
      const requestBody = { model, messages, tools, tool_choice: "auto", stream: false };
      if (verifyTee) requestBody.verify_tee = true;
      // The exact bytes sent are the canonical serialization, so requestSha256 is reproducible.
      const bodyText = canonicalJson(requestBody);
      const requestSha256 = sha256Hex(bodyText);

      const res = await withRetry(bodyText);

      const responseSha256 = sha256Hex(res.body);
      /** @type {Record<string, any>} */
      let data;
      try {
        data = JSON.parse(Buffer.from(res.body).toString("utf8"));
      } catch {
        throw new RouterError("The 0G Router sent a response that is not JSON.", { status: res.status });
      }
      const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
      const raw = choice?.message;
      if (!raw || typeof raw !== "object") {
        throw new RouterError("The 0G Router's response has no message.", { status: res.status });
      }
      const receipt = buildReceipt({ data, headers: res.headers, model, requestSha256, responseSha256 });
      return {
        message: toAssistantMessage(raw),
        finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
        receipt,
      };
    },

    /**
     * Transcribe a voice note with the session's speech-to-text model, in the session's trust mode: whisper's
     * transcription endpoint, or a chat turn to an omni model that hears audio. The receipt binds the exact request
     * (the audio included) and response bytes, like a chat turn's, and keeps the Router's request id.
     * @param {{ bytes: Uint8Array, filename: string }} input
     * @returns {Promise<TranscriptionResult>}
     */
    async transcribe({ bytes, filename }) {
      if (!audioModel) throw new RouterError("This session has no speech-to-text model.", { status: 403 });
      if (audioVia === "chat") return transcribeByChat(bytes, filename);
      const bodyText = canonicalJson({ model: audioModel, file_base64: Buffer.from(bytes).toString("base64"), filename, response_format: "json" });
      const requestSha256 = sha256Hex(bodyText);
      const res = await withRetry(bodyText, transcriptionUrl);
      const responseSha256 = sha256Hex(res.body);
      /** @type {Record<string, any>} */
      let data;
      try {
        data = JSON.parse(Buffer.from(res.body).toString("utf8"));
      } catch {
        throw new RouterError("The 0G Router sent a transcription that is not JSON.", { status: res.status });
      }
      if (typeof data?.text !== "string") throw new RouterError("The 0G Router's transcription has no text.", { status: res.status });
      const receipt = buildReceipt({ data, headers: res.headers, model: audioModel, requestSha256, responseSha256 });
      receipt.kind = "transcription";
      return { text: data.text.trim(), receipt };
    },
  };
}

/** @typedef {ReturnType<typeof createRouterClient>} RouterClient */

/**
 * Keep only what the conversation needs to send back: content and tool calls.
 * Reasoning text and provider-specific fields are dropped.
 * @param {Record<string, any>} raw
 * @returns {ChatMessage & { role: "assistant" }}
 */
function toAssistantMessage(raw) {
  const content = typeof raw.content === "string" ? raw.content : null;
  /** @type {ToolCall[]} */
  const toolCalls = Array.isArray(raw.tool_calls)
    ? raw.tool_calls
        .filter((/** @type {any} */ call) => call && typeof call.function?.name === "string")
        .map((/** @type {any} */ call, /** @type {number} */ i) => ({
          id: typeof call.id === "string" && call.id ? call.id : `call_${i}`,
          type: "function",
          function: {
            name: call.function.name,
            arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
          },
        }))
    : [];
  /** @type {ChatMessage & { role: "assistant" }} */
  const message = { role: "assistant", content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

/** Router headers kept on a receipt besides the zg-, x-0g- and 0g- prefixed ones. */
const ROUTER_HEADERS = new Set(["x-request-id", "x-provider"]);

/**
 * Response headers worth keeping on a receipt: everything 0G-specific
 * (ZG-Res-Key, X-Provider, X-Request-ID and any zg-, x-0g- or 0g- header).
 * @param {Headers} headers
 * @returns {Record<string, string>}
 */
export function captureHeaders(headers) {
  /** @type {Record<string, string>} */
  const kept = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (key.startsWith("zg-") || key.startsWith("x-0g-") || key.startsWith("0g-") || ROUTER_HEADERS.has(key)) kept[key] = value;
  });
  return kept;
}

/**
 * @param {{ data: Record<string, any>, headers: Headers, model: string, requestSha256: string, responseSha256: string }} input
 * @returns {Receipt}
 */
export function buildReceipt({ data, headers, model, requestSha256, responseSha256 }) {
  const trace = data.x_0g_trace ?? data.trace;
  /** @type {Record<string, unknown>} */
  const t = trace && typeof trace === "object" ? trace : {};
  const str = (/** @type {unknown} */ v) => (typeof v === "string" && v ? v : null);
  /** @type {Receipt} */
  const receipt = {
    resKey: str(headers.get("zg-res-key")) ?? str(data.id),
    requestId: str(t.request_id) ?? str(headers.get("x-request-id")),
    provider: str(t.provider) ?? str(headers.get("x-provider")),
    providerIdentity: str(t.provider_identity),
    teeVerified: typeof t.tee_verified === "boolean" ? t.tee_verified : null,
    model: typeof data.model === "string" && data.model ? data.model : model,
    at: new Date().toISOString(),
    requestSha256,
    responseSha256,
    headers: captureHeaders(headers),
  };
  if (trace !== undefined && trace !== null) receipt.trace = trace;
  return receipt;
}

/**
 * @param {TransportResponse} res
 * @returns {RouterError}
 */
function errorFromResponse(res) {
  /** @type {Record<string, any> | null} */
  let data = null;
  try {
    data = JSON.parse(Buffer.from(res.body).toString("utf8"));
  } catch {
    data = null;
  }
  const err = data && typeof data.error === "object" && data.error ? data.error : {};
  const message = typeof err.message === "string" ? err.message : typeof data?.error === "string" ? data.error : "";
  return new RouterError(message || `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`, {
    status: res.status,
    code: typeof err.code === "string" ? err.code : null,
    type: typeof err.type === "string" ? err.type : null,
    requestId:
      typeof data?.request_id === "string"
        ? data.request_id
        : typeof data?.x_0g_trace?.request_id === "string"
          ? data.x_0g_trace.request_id
          : res.headers.get("x-request-id"),
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
  });
}

/**
 * Retry-After is either seconds or an HTTP date.
 * @param {string | null} value
 * @returns {number | null}
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * A readable, secret-free explanation of a Router failure.
 * @param {unknown} error
 * @param {string} model
 */
export function describeRouterError(error, model) {
  if (!(error instanceof RouterError)) return `Unexpected error talking to the 0G Router: ${/** @type {Error} */ (error)?.message ?? error}`;
  const detail = error.message && !/^HTTP \d+/.test(error.message) ? ` (${error.message})` : "";
  const ref = error.requestId ? ` [request ${error.requestId}]` : "";
  switch (true) {
    case error.status === 0:
      return `${error.message} Check your connection.`;
    case error.status === 401:
      return `The 0G Router rejected this session's key (401). The session may have ended; get a new command from the Ordo console.${ref}`;
    case error.status === 402:
      return `The organization's 0G Private Computer balance is too low (402 insufficient balance). Ask your Ordo manager to top up the account on pc.0g.ai, then try again.${ref}`;
    case error.status === 403:
      return `This session's Router key is not allowed to use ${model} (403)${detail}.${ref}`;
    case error.status === 429:
      return `The 0G Router is rate limiting this account (429). Wait a minute and try again.${ref}`;
    case error.status === 503:
      return `No private (TEE) provider is serving ${model} right now (503)${detail}. Try again in a few minutes.${ref}`;
    case error.status === 502:
      return `The model provider failed and the Router could not fail over (502)${detail}.${ref}`;
    case error.status >= 500:
      return `The 0G Router had an internal error (${error.status})${detail}.${ref}`;
    default:
      return `The 0G Router refused the request (${error.status})${detail}.${ref}`;
  }
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
