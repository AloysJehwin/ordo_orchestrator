import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { sha256 } from "../domain/canonical.js";

export interface ExternalRef {
  ref: string;
  url: string | null;
}

// ---------- Anchor: puts the ledger head somewhere outside Ordo's database ----------
export interface AnchorInput {
  toSeq: number;
  entryHash: string;
  siteId: string | null;
  subject: string | null;
}
export interface AnchorAdapter {
  readonly kind: string;
  anchor(input: AnchorInput): Promise<ExternalRef & { data: Record<string, unknown> }>;
  verify(stored: { toSeq: number; entryHash: string; ref: string; data: Record<string, unknown> }): Promise<{ ok: boolean; detail: string }>;
}

/** Signed checkpoint: Ed25519 signature over `toSeq:entryHash` with a key outside the DB. */
export class LocalSignedAnchor implements AnchorAdapter {
  readonly kind = "local-signed";
  private priv: KeyObject;
  private pub: KeyObject;
  readonly ephemeral: boolean;
  constructor(pkcs8Base64?: string) {
    if (pkcs8Base64) {
      this.priv = createPrivateKey({ key: Buffer.from(pkcs8Base64, "base64"), format: "der", type: "pkcs8" });
      this.ephemeral = false;
    } else {
      this.priv = generateKeyPairSync("ed25519").privateKey;
      this.ephemeral = true;
    }
    this.pub = createPublicKey(this.priv);
  }
  publicKeyHex(): string {
    return (this.pub.export({ format: "der", type: "spki" }) as Buffer).toString("hex");
  }
  async anchor(i: AnchorInput) {
    const msg = Buffer.from(`${i.toSeq}:${i.entryHash}`);
    const signature = sign(null, msg, this.priv).toString("base64");
    return { ref: `ed25519:${signature.slice(0, 16)}…`, url: null, data: { signature, publicKey: this.publicKeyHex() } };
  }
  async verify(s: { toSeq: number; entryHash: string; data: Record<string, unknown> }) {
    const sig = typeof s.data.signature === "string" ? s.data.signature : "";
    const stored = typeof s.data.publicKey === "string" ? s.data.publicKey : this.publicKeyHex();
    const key = createPublicKey({ key: Buffer.from(stored, "hex"), format: "der", type: "spki" });
    const ok = verify(null, Buffer.from(`${s.toSeq}:${s.entryHash}`), key, Buffer.from(sig, "base64"));
    const pinned = stored === this.publicKeyHex() && !this.ephemeral;
    if (!ok) return { ok, detail: "Checkpoint signature invalid" };
    return { ok, detail: pinned ? "Checkpoint signature valid (pinned key)" : "Checkpoint signature valid, but the signing key is not pinned: set LEDGER_SIGNING_KEY" };
  }
}

// ---------- Identity: human-readable names for assets and agents ----------
export interface IdentityResolver {
  readonly kind: string;
  names(ids: string[]): Promise<Record<string, string | null>>;
}
export class PlainIdentity implements IdentityResolver {
  readonly kind = "plain";
  async names(ids: string[]) {
    return Object.fromEntries(ids.map((id) => [id, null]));
  }
}

// ---------- Evidence store ----------
export interface EvidenceStore {
  readonly kind: string;
  put(bytes: Uint8Array, name: string): Promise<{ uri: string; sha256: string }>;
}
export class LocalEvidenceStore implements EvidenceStore {
  readonly kind = "local";
  constructor(private dir: string) {}
  async put(bytes: Uint8Array) {
    const h = sha256(bytes);
    await mkdir(this.dir, { recursive: true });
    await writeFile(`${this.dir}/${h.slice(7)}.json`, bytes);
    return { uri: `local:${h.slice(7, 23)}`, sha256: h };
  }
  async get(sha: string): Promise<Uint8Array> {
    return readFile(`${this.dir}/${sha.replace("sha256:", "")}.json`);
  }
}
