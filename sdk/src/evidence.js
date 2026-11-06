// Evidence files are hashed on the contributor's machine. Only the name, size and SHA-256
// are recorded; the file itself never leaves the machine.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

export class EvidenceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "EvidenceError";
  }
}

/**
 * @typedef {object} HashedEvidence
 * @property {string} name      File name only (no directory).
 * @property {number} size      Bytes.
 * @property {string} sha256    Hex.
 * @property {string} path      Absolute path, for local display only. Never sent.
 */

/**
 * Hash one evidence file.
 * @param {string} input        Path as typed: relative to cwd, absolute, or starting with ~/.
 *                              Surrounding quotes and backslash-escaped spaces (as pasted by a
 *                              terminal drag-and-drop) are accepted.
 * @param {{ cwd?: string, maxBytes?: number, alsoIn?: string[] }} [options]  `alsoIn`: more directories a relative path may be in
 * @returns {Promise<HashedEvidence>}
 */
export async function hashEvidence(input, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const maxBytes = options.maxBytes ?? MAX_EVIDENCE_BYTES;
  if (typeof input !== "string" || input.trim() === "") {
    throw new EvidenceError("No path was given.");
  }

  let resolved = null;
  /** @type {import("node:fs").Stats | null} */
  let stats = null;
  // a relative path is looked for under the working directory, then under each extra directory (the notes file's)
  const relative = !path.isAbsolute(input.trim()) && !/^~([/\\]|$)/.test(input.trim());
  const roots = [cwd, ...(relative ? (options.alsoIn ?? []).filter((d) => d !== cwd) : [])];
  for (const candidate of roots.flatMap((root) => pathCandidates(input, root))) {
    try {
      stats = await stat(candidate);
      resolved = candidate;
      break;
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new EvidenceError(`Permission denied reading ${display(candidate, cwd)}.`);
      }
    }
  }
  if (!resolved || !stats) {
    throw new EvidenceError(`No file at ${display(resolveOne(input.trim(), cwd), cwd)}.`);
  }
  if (!stats.isFile()) {
    const kind = stats.isDirectory() ? "a directory" : "not a regular file";
    throw new EvidenceError(`${display(resolved, cwd)} is ${kind}; attach individual files.`);
  }
  if (stats.size > maxBytes) {
    throw new EvidenceError(
      `${display(resolved, cwd)} is ${formatBytes(stats.size)}, over the ${formatBytes(maxBytes)} limit for evidence files.`,
    );
  }

  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of createReadStream(resolved)) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new EvidenceError(`${display(resolved, cwd)} grew past ${formatBytes(maxBytes)} while reading.`);
      }
      hash.update(chunk);
    }
  } catch (err) {
    if (err instanceof EvidenceError) throw err;
    throw new EvidenceError(`Could not read ${display(resolved, cwd)}: ${/** @type {Error} */ (err).message}`);
  }
  return { name: path.basename(resolved), size, sha256: hash.digest("hex"), path: resolved };
}

/**
 * The ways a typed path might be meant, most literal first.
 * @param {string} input
 * @param {string} cwd
 */
function pathCandidates(input, cwd) {
  const forms = new Set();
  const trimmed = input.trim();
  forms.add(trimmed);
  const unquoted = trimmed.replace(/^(['"])(.*)\1$/s, "$2");
  forms.add(unquoted);
  forms.add(unquoted.replace(/\\(.)/g, "$1"));
  return [...forms].filter(Boolean).map((form) => resolveOne(form, cwd));
}

/**
 * @param {string} p
 * @param {string} cwd
 */
function resolveOne(p, cwd) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

/**
 * Show a path relative to cwd when it is inside it.
 * @param {string} absolute
 * @param {string} cwd
 */
function display(absolute, cwd) {
  const rel = path.relative(cwd, absolute);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : absolute;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
