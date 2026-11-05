import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Keys Ordo holds for accounts it runs (machines, finance parties), sealed with AES-256-GCM under a key derived from a server secret. */
export class KeyBox {
  private key: Buffer;
  constructor(label: string, secret: string) {
    this.key = createHash("sha256").update(`ordo:${label}:${secret}`).digest();
  }
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
  }
  unseal(sealed: string): string {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(body!), d.final()]).toString("utf8");
  }
}
