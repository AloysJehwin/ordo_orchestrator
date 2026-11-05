// Media the interviewer may see: the machine's outcome images and, with the contributor's consent per file, their
// photos (as image parts) and voice notes (as transcripts). Everything else stays hash-only.
//
// The Router takes a chat request body of at most 20 MB, so images are capped per file and per turn, and once the
// model has answered, earlier images in the history are replaced with a placeholder.
/** @import { ChatMessage, ContentPart } from "./types.js" */
import { open } from "node:fs/promises";
import path from "node:path";

/** Largest image shown to the model (raw bytes; base64 adds a third). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Images sent in one request, in raw bytes: keeps the body (base64 plus the history) under the Router's 20 MB. */
export const MAX_TURN_IMAGE_BYTES = 12 * 1024 * 1024;
/** Largest voice note sent for transcription (raw bytes; sent as base64 in a JSON body). */
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
/** How much of a text file (a CSV trace, a JSON export) the model is shown. */
export const MAX_EXCERPT_CHARS = 4000;

/** Image types the chat model reads. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Voice-note types the speech-to-text model takes. */
export const AUDIO_TYPES = new Set(["audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm"]);
const TEXT_TYPES = new Set(["text/csv", "text/plain", "application/json"]);

const BY_EXTENSION = /** @type {Record<string, string>} */ ({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".xml": "application/xml",
});

/**
 * The media type of a file, from its first bytes where they are distinctive, else from its extension.
 * @param {Uint8Array} head  The file's first bytes (16 are enough).
 * @param {string} name
 * @returns {string | undefined}
 */
export function mediaTypeOf(head, name) {
  const b = Buffer.from(head);
  const ascii = (/** @type {number} */ from, /** @type {number} */ to) => b.subarray(from, to).toString("latin1");
  const ext = path.extname(name).toLowerCase();
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (b.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (b.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && ext === ".mp3") return "audio/mpeg";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ext === ".webm" || ext === ".weba" ? "audio/webm" : "video/webm";
  if (b.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "M4A " || ext === ".m4a") return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (b.length >= 5 && ascii(0, 5) === "%PDF-") return "application/pdf";
  return BY_EXTENSION[ext];
}

/**
 * Read the first bytes of a file, to tell its type.
 * @param {string} file
 */
export async function readHead(file, bytes = 16) {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** @param {string | undefined} type */
export const isImage = (type) => Boolean(type && IMAGE_TYPES.has(type));
/** @param {string | undefined} type */
export const isVoiceNote = (type) => Boolean(type && AUDIO_TYPES.has(type));
/** @param {string | undefined} type */
export const isText = (type) => Boolean(type && (TEXT_TYPES.has(type) || type.startsWith("text/")));

/**
 * @param {Uint8Array} bytes
 * @param {string} type
 */
export function dataUrl(bytes, type) {
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * The start of a text file, for the model.
 * @param {Uint8Array} bytes
 */
export function excerpt(bytes) {
  const text = Buffer.from(bytes.subarray(0, MAX_EXCERPT_CHARS * 4)).toString("utf8");
  return text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS)}\n… (${bytes.byteLength} bytes in all)` : text;
}

/**
 * Images waiting to go to the model with the next request, as one user message after the tool results.
 * Tool messages carry text only, so media rides in a user message of content parts.
 */
export function createMediaQueue() {
  /** @type {ContentPart[]} */
  let parts = [];
  let bytes = 0;
  return {
    /**
     * Whether an image of this size still fits in this turn's budget.
     * @param {number} size
     */
    fits(size) {
      return bytes + size <= MAX_TURN_IMAGE_BYTES;
    },
    /**
     * @param {string} caption  What the image is, for the model.
     * @param {Uint8Array} image
     * @param {string} type
     */
    add(caption, image, type) {
      parts.push({ type: "text", text: caption }, { type: "image_url", image_url: { url: dataUrl(image, type) } });
      bytes += image.byteLength;
    },
    /** @returns {ChatMessage | null} The user message to append, if any images are waiting. */
    take() {
      if (!parts.length) return null;
      const message = /** @type {ChatMessage} */ ({ role: "user", content: parts });
      parts = [];
      bytes = 0;
      return message;
    },
    get size() {
      return parts.length;
    },
  };
}

/** @typedef {ReturnType<typeof createMediaQueue>} MediaQueue */

export const IMAGE_PLACEHOLDER = "[image no longer attached: you saw it in an earlier turn]";

/**
 * Replace every image part in the history with a placeholder, once the model has seen them, so later requests stay small.
 * @param {ChatMessage[]} messages
 * @returns {number} How many images were replaced.
 */
export function stripImages(messages) {
  let replaced = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    message.content = message.content.map((part) => {
      if (part.type !== "image_url") return part;
      replaced += 1;
      return { type: "text", text: IMAGE_PLACEHOLDER };
    });
  }
  return replaced;
}

/**
 * The plain text of a message's content, whatever its shape.
 * @param {ChatMessage["content"]} content
 */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

/** @param {string} mime */
export function extensionFor(mime) {
  const known = Object.entries(BY_EXTENSION).find(([, type]) => type === mime);
  if (known) return known[0];
  const sub = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "";
  return sub ? `.${sub.slice(0, 8)}` : ".bin";
}
