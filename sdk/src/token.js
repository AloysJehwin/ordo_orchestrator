// The session token and command-line arguments.
//
// Token format: opw1.<base64url(apiBaseUrl)>.<secret>
// The secret is opaque base64url. It is never printed, logged or put in an error message.
import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export const TOKEN_PREFIX = "opw1";
export const TOKEN_ENV = "ORDO_POW_TOKEN";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MIN_SECRET_LENGTH = 16;

/**
 * @typedef {object} ParsedToken
 * @property {string} apiBaseUrl  Normalized, without a trailing slash.
 * @property {string} secret
 */

/**
 * Parse a session token. Throws UsageError with a message that never contains the token.
 * @param {string} token
 * @returns {ParsedToken}
 */
export function parseToken(token) {
  const hint = `Copy the whole command from the Ordo console; the token starts with "${TOKEN_PREFIX}.".`;
  if (typeof token !== "string" || token.trim() === "") {
    throw new UsageError(`Missing token. ${hint}`);
  }
  const parts = token.trim().split(".");
  if (parts[0] !== TOKEN_PREFIX) {
    throw new UsageError(`That is not an Ordo proof-of-work token. ${hint}`);
  }
  if (parts.length !== 3) {
    throw new UsageError(`The token is malformed (expected three parts separated by dots). ${hint}`);
  }
  const [, encodedUrl = "", secret = ""] = parts;
  if (!BASE64URL.test(encodedUrl)) {
    throw new UsageError(`The token's API address is not valid base64url. ${hint}`);
  }
  if (!BASE64URL.test(secret) || secret.length < MIN_SECRET_LENGTH) {
    throw new UsageError(`The token's secret is missing or truncated. ${hint}`);
  }
  let decoded;
  try {
    decoded = Buffer.from(encodedUrl, "base64url").toString("utf8");
  } catch {
    throw new UsageError(`The token's API address could not be decoded. ${hint}`);
  }
  const apiBaseUrl = normalizeBaseUrl(decoded, "The token's API address");
  return { apiBaseUrl, secret };
}

/**
 * Build a token (used by tests and by anyone scripting against a local server).
 * @param {string} apiBaseUrl
 * @param {string} secret
 */
export function formatToken(apiBaseUrl, secret) {
  return `${TOKEN_PREFIX}.${Buffer.from(apiBaseUrl, "utf8").toString("base64url")}.${secret}`;
}

/**
 * Validate an http(s) base URL and strip trailing slashes, query and fragment.
 * @param {string} raw
 * @param {string} [what]
 */
export function normalizeBaseUrl(raw, what = "The API address") {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new UsageError(`${what} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`${what} must be an http or https URL.`);
  }
  if (url.username || url.password) {
    throw new UsageError(`${what} must not contain credentials.`);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * True for localhost and loopback addresses, where plain http is acceptable.
 * @param {string} url
 */
export function isLoopback(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
}

/**
 * @typedef {object} Invocation
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} open
 * @property {ParsedToken | null} token
 * @property {"argument" | "env" | null} tokenSource
 * @property {string | null} notes  An observations file to answer from (--notes)
 */

/**
 * Parse argv (without the node and script entries) and the environment.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Invocation}
 */
export function parseInvocation(argv, env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        api: { type: "string" },
        notes: { type: "string" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new UsageError(`Unknown option. Run with --help to see the options.`);
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      throw new UsageError(`An option has a missing or unexpected value (--api needs a URL, for example --api https://ordo.example.com; --notes needs a file).`);
    }
    throw new UsageError(`Could not read the arguments. Run with --help to see the options.`);
  }
  const { values, positionals } = parsed;
  const help = Boolean(values.help);
  const version = Boolean(values.version);
  const open = !values["no-open"] && !isTruthy(env.ORDO_POW_NO_OPEN);
  const notes = typeof values.notes === "string" && values.notes.trim() ? values.notes : null;
  if (help || version) return { help, version, open, token: null, tokenSource: null, notes };

  if (positionals.length > 1) {
    throw new UsageError(`Expected one token, got ${positionals.length} arguments.`);
  }
  /** @type {"argument" | "env" | null} */
  let tokenSource = null;
  let raw = "";
  if (positionals.length === 1 && positionals[0]) {
    raw = positionals[0];
    tokenSource = "argument";
  } else if (env[TOKEN_ENV]) {
    raw = env[TOKEN_ENV] ?? "";
    tokenSource = "env";
  } else {
    throw new UsageError(
      `Missing token. Pass it as the first argument or in the ${TOKEN_ENV} environment variable.`,
    );
  }
  const token = parseToken(raw);
  if (values.api !== undefined) token.apiBaseUrl = normalizeBaseUrl(values.api, "--api");
  return { help, version, open, token, tokenSource, notes };
}

/** @param {string | undefined} value */
export function isTruthy(value) {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
