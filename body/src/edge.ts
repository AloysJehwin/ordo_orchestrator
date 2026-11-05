import { createHash, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { PROOF_DOMAIN } from "../../server/src/auth/auth.js";
import { OUTPUT_TYPES, scaleValue } from "../../server/src/auth/output-types.js";
import { edgeMessage } from "../../server/src/core/readings.js";
import type { MediaFile } from "./media/capture.js";

export interface Analysis {
  summary: string;
  value?: number;
  anomaly?: string;
  requestId?: string;
  model?: string;
  provider?: string;
  teeVerified?: boolean | null;
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Uploads one capture over the signed edge channel: the file and its preview as multipart, the request signed over its
 * raw bytes like every edge request, and the file itself signed as an OrdoOutput (its hash, the lot, stage and outcome,
 * the value read and when).
 */
export async function uploadOutput(
  o: { url: string; account: PrivateKeyAccount; fetch?: typeof fetch },
  st: { site: string; runId: string; stage: string; asset: string },
  outcome: string,
  value: number,
  capturedAt: number,
  file: MediaFile,
  preview: MediaFile | null,
  analysis: Analysis | null,
): Promise<{ id: string; version: number; sha256: string; previewSha256: string | null }> {
  const hex = sha256(file.bytes);
  const signature = await o.account.signTypedData({
    domain: PROOF_DOMAIN,
    types: OUTPUT_TYPES,
    primaryType: "OrdoOutput",
    message: { site: st.site, runId: st.runId, stage: st.stage, asset: st.asset, outcome, sha256: `0x${hex}` as Hex, value: scaleValue(value), capturedAt: BigInt(capturedAt) },
  });
  const meta = { runId: st.runId, stage: st.stage, outcome, capturedAt, value, sha256: hex, signature, ...(analysis ? { analysis } : {}) };
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set("file", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), `${outcome}.${file.ext}`);
  if (preview) form.set("preview", new Blob([new Uint8Array(preview.bytes)], { type: preview.mime }), `${outcome}-preview.${preview.ext}`);
  // the multipart bytes as they will be sent: the signature covers exactly these
  const req = new Request("http://edge/", { method: "POST", body: form });
  const raw = new Uint8Array(await req.arrayBuffer());
  const contentType = req.headers.get("content-type")!;
  const path = "/v1/edge/outputs";
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(12).toString("hex");
  const sig = await o.account.signMessage({ message: edgeMessage(ts, nonce, "POST", path, raw) });
  const res = await (o.fetch ?? fetch)(`${o.url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    body: raw,
    headers: { "content-type": contentType, "x-ordo-device": o.account.address, "x-ordo-ts": String(ts), "x-ordo-nonce": nonce, "x-ordo-sig": sig },
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; id?: string; version?: number; sha256?: string; previewSha256?: string | null };
  if (!res.ok) throw new Error(`upload ${outcome}: ${res.status} ${json.error ?? ""}`.trim());
  return { id: json.id ?? "", version: json.version ?? 0, sha256: json.sha256 ?? `sha256:${hex}`, previewSha256: json.previewSha256 ?? null };
}
