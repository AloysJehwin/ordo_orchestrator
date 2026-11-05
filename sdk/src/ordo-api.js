// Client for the Ordo proof-of-work session API.
/** @import { Session, SessionStatus, FinishPayload, FinishResult } from "./types.js" */
import { USER_AGENT } from "./meta.js";

const TIMEOUT_MS = 30_000;

export class OrdoApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status  HTTP status, or 0 when Ordo could not be reached.
   */
  constructor(message, status) {
    super(message);
    this.name = "OrdoApiError";
    this.status = status;
  }

  /** The session is unknown, revoked or expired. */
  get gone() {
    return this.status === 401 || this.status === 404 || this.status === 410;
  }

  /** Worth trying again: network failure, timeout or a server error. */
  get transient() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/**
 * @param {{ apiBaseUrl: string, secret: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createOrdoClient({ apiBaseUrl, secret, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const origin = new URL(apiBaseUrl).origin;

  /**
   * @param {"GET" | "POST"} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<unknown>}
   */
  async function request(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = {
      authorization: `Bearer ${secret}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetchImpl(`${apiBaseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new OrdoApiError(`Could not reach Ordo at ${origin} (${networkReason(err)}).`, 0);
    }
    const text = await res.text().catch(() => "");
    /** @type {unknown} */
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const detail = errorDetail(data);
      throw new OrdoApiError(
        `Ordo answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${detail ? `: ${detail}` : ""}.`,
        res.status,
      );
    }
    if (data === null || typeof data !== "object") {
      throw new OrdoApiError(`Ordo sent a response that is not JSON (${method} ${path}).`, res.status);
    }
    return data;
  }

  return {
    origin,

    /** @returns {Promise<Session>} */
    async getSession() {
      const data = /** @type {Session} */ (await request("GET", "/v1/pow/session"));
      if (!data.stage || typeof data.stage !== "object") {
        throw new OrdoApiError("Ordo's session response has no stage.", 200);
      }
      data.stage.criteria = Array.isArray(data.stage.criteria) ? data.stage.criteria : [];
      data.stage.parameters = Array.isArray(data.stage.parameters) ? data.stage.parameters : [];
      return data;
    },

    /** @returns {Promise<SessionStatus>} */
    async status() {
      const data = /** @type {SessionStatus} */ (await request("GET", "/v1/pow/session/status"));
      if (!["open", "submitted", "signed", "expired"].includes(data.status)) {
        throw new OrdoApiError(`Ordo reported an unknown session status.`, 200);
      }
      return data;
    },

    /**
     * @param {FinishPayload} payload
     * @returns {Promise<FinishResult>}
     */
    async finish(payload) {
      const data = /** @type {FinishResult} */ (await request("POST", "/v1/pow/session/finish", payload));
      if (typeof data.signUrl !== "string" || !data.signUrl) {
        throw new OrdoApiError("Ordo accepted the record but sent no signing link.", 200);
      }
      return data;
    },
  };
}

/** @typedef {ReturnType<typeof createOrdoClient>} OrdoClient */

/**
 * A short, secret-free description of an error body.
 * @param {unknown} data
 */
function errorDetail(data) {
  if (!data || typeof data !== "object") return "";
  const record = /** @type {Record<string, unknown>} */ (data);
  const err = record.error;
  if (typeof err === "string") return clip(err);
  if (err && typeof err === "object") {
    const message = /** @type {Record<string, unknown>} */ (err).message;
    if (typeof message === "string") return clip(message);
  }
  if (typeof record.message === "string") return clip(record.message);
  return "";
}

/** @param {string} text */
function clip(text) {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** @param {unknown} err */
export function networkReason(err) {
  const e = /** @type {{ name?: string, message?: string, cause?: { code?: string, message?: string } }} */ (err);
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "network error";
}
