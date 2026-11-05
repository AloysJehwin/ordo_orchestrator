// Canonical JSON (object keys sorted, no whitespace) and SHA-256 helpers.
import { createHash } from "node:crypto";

/**
 * Serialize like JSON.stringify, but with object keys sorted at every level so the same
 * value always produces the same bytes. Undefined members and functions are dropped,
 * as JSON.stringify does; non-finite numbers become null.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const out = serialize(value);
  return out === undefined ? "null" : out;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function serialize(value) {
  if (value === null) return "null";
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") throw new TypeError("canonicalJson: BigInt is not serializable");
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  const withToJson = /** @type {{ toJSON?: () => unknown }} */ (value);
  if (typeof withToJson.toJSON === "function") return serialize(withToJson.toJSON());
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item) ?? "null").join(",")}]`;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const members = [];
  for (const key of Object.keys(record).sort()) {
    const member = serialize(record[key]);
    if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * Hex SHA-256 of a string (UTF-8) or bytes.
 * @param {string | Uint8Array} data
 */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
