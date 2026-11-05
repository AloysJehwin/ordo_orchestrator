import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createPublicClient, getAddress, http, verifyMessage, verifyTypedData, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Db, Queryable } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import { ROLES, type Role } from "../domain/types.js";

export const SESSION_COOKIE = "ordo_session";
const NONCE_TTL_MS = 5 * 60_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

export interface User {
  id: string;
  address: string;
  displayName: string | null;
}
export interface Membership {
  siteId: string;
  siteName: string;
  roles: Role[];
}
export interface Principal {
  user: User;
  sessionId: string;
  memberships: Membership[];
}

export interface AuthOptions {
  sessionTtlMs: number;
  /** Optional RPC used to verify smart-contract wallets (ERC-1271 / ERC-6492). */
  rpcUrl?: string;
  bootstrapAdmin?: string;
}

/**
 * Sign-In with Ethereum (EIP-4361) and server-side sessions. The wallet is the identity;
 * only a SHA-256 of the session token is stored, so a database leak can't be replayed.
 */
export class Auth {
  constructor(
    private db: Db,
    private opts: AuthOptions,
  ) {}

  async issueNonce(): Promise<string> {
    const nonce = randomBytes(16).toString("hex");
    await this.db.query("INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, $2)", [nonce, new Date(Date.now() + NONCE_TTL_MS)]);
    await this.db.query("DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 day'");
    return nonce;
  }

  /** Verify a signed SIWE message and open a session. Returns the session token (to set as a cookie). */
  async signIn(input: { message: string; signature: Hex; domain: string; userAgent?: string }): Promise<{ token: string; principal: Principal }> {
    const msg = parseSiweMessage(input.message);
    if (!msg.address || !msg.nonce) throw new HttpError(400, "Malformed sign-in message");
    if (!validateSiweMessage({ message: msg, domain: input.domain })) throw new HttpError(401, `Sign-in message is for another site or expired (expected domain ${input.domain})`);
    const used = await this.db.query<{ nonce: string }>(
      "UPDATE auth_nonces SET used_at = now() WHERE nonce = $1 AND used_at IS NULL AND expires_at > now() RETURNING nonce",
      [msg.nonce],
    );
    if (!used.rows[0]) throw new HttpError(401, "Sign-in nonce is unknown, used or expired. Try again.");
    const ok = await this.verify(msg.address, input.message, input.signature);
    if (!ok) throw new HttpError(401, "Signature does not match the wallet address");

    const address = getAddress(msg.address).toLowerCase();
    const user = await this.upsertUser(address);
    await this.acceptInvites(user);
    const token = randomBytes(32).toString("base64url");
    await this.db.query("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)", [
      sha(token),
      user.id,
      new Date(Date.now() + this.opts.sessionTtlMs),
      input.userAgent?.slice(0, 200) ?? null,
    ]);
    return { token, principal: { user, sessionId: sha(token), memberships: await this.memberships(user.id) } };
  }

  private async verify(address: Hex, message: string, signature: Hex): Promise<boolean> {
    if (await verifyMessage({ address, message, signature }).catch(() => false)) return true;
    if (!this.opts.rpcUrl) return false;
    const client = createPublicClient({ transport: http(this.opts.rpcUrl) });
    return client.verifyMessage({ address, message, signature }).catch(() => false);
  }

  async principal(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    const r = await this.db.query<{ id: string; user_id: string; address: string; display_name: string | null }>(
      "SELECT s.id, s.user_id, u.address, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()",
      [sha(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    await this.db.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [row.user_id]);
    const user = { id: row.user_id, address: row.address, displayName: row.display_name };
    return { user, sessionId: row.id, memberships: await this.memberships(user.id) };
  }

  async signOut(sessionId: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  }

  private async upsertUser(address: string): Promise<User> {
    const existing = await this.db.query<{ id: string; display_name: string | null }>("SELECT id, display_name FROM users WHERE address = $1", [address]);
    if (existing.rows[0]) return { id: existing.rows[0].id, address, displayName: existing.rows[0].display_name };
    const id = newId("usr");
    await this.db.query("INSERT INTO users (id, address) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING", [id, address]);
    const r = await this.db.query<{ id: string; display_name: string | null }>("SELECT id, display_name FROM users WHERE address = $1", [address]);
    return { id: r.rows[0]!.id, address, displayName: r.rows[0]!.display_name };
  }

  async setDisplayName(userId: string, name: string): Promise<void> {
    await this.db.query("UPDATE users SET display_name = $1 WHERE id = $2", [name.trim().slice(0, 60), userId]);
  }

  private async acceptInvites(user: User): Promise<void> {
    const inv = await this.db.query<{ id: string; site_id: string; role: string; created_by: string | null }>(
      "SELECT id, site_id, role, created_by FROM invites WHERE address = $1 AND accepted_at IS NULL",
      [user.address],
    );
    for (const i of inv.rows) {
      await this.db.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [i.site_id, user.id, i.role, i.created_by]);
      await this.db.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [i.id]);
    }
  }

  async memberships(userId: string): Promise<Membership[]> {
    const r = await this.db.query<{ site_id: string; name: string; role: string }>(
      "SELECT m.site_id, s.name, m.role FROM memberships m JOIN sites s ON s.id = m.site_id WHERE m.user_id = $1 ORDER BY s.created_at",
      [userId],
    );
    const by = new Map<string, Membership>();
    for (const row of r.rows) {
      const m = by.get(row.site_id) ?? { siteId: row.site_id, siteName: row.name, roles: [] };
      if ((ROLES as readonly string[]).includes(row.role)) m.roles.push(row.role as Role);
      by.set(row.site_id, m);
    }
    return [...by.values()];
  }

  /** The first site is created by the first wallet to sign in (or the configured bootstrap admin). */
  async canBootstrap(user: User): Promise<boolean> {
    const n = await this.db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM sites");
    if (Number(n.rows[0]?.n ?? 0) > 0) return false;
    return !this.opts.bootstrapAdmin || this.opts.bootstrapAdmin.toLowerCase() === user.address;
  }
}

// ---------------- EIP-712 signatures for decisions that matter ----------------
export const SIGNATURE_TYPES = {
  OrdoSignature: [
    { name: "action", type: "string" },
    { name: "entity", type: "string" },
    { name: "meaning", type: "string" },
    { name: "comment", type: "string" },
    { name: "site", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
  ],
} as const;

export interface SignatureRequest {
  action: string;
  entity: string;
  meaning: string;
  comment: string;
  site: string;
  chainId: number;
  /** the contract that will verify it (OrdoTrust): the domain then names that deployment (version 2) */
  verifyingContract?: Hex;
}
export interface TypedSignature {
  domain: { name: "Ordo"; version: "1" | "2"; chainId: number; verifyingContract?: Hex };
  types: typeof SIGNATURE_TYPES;
  primaryType: "OrdoSignature";
  message: { action: string; entity: string; meaning: string; comment: string; site: string; nonce: string; issuedAt: string };
}

/**
 * What the three people who release a package sign: exactly what is released (contracts/src/OrdoProofs.sol). The
 * domain has no chain: the same statement is checked by OrdoTrust (Hedera) and OrdoLotResolver (Sepolia).
 */
export const RELEASE_TYPES = {
  OrdoRelease: [
    { name: "site", type: "string" },
    { name: "packageId", type: "string" },
    { name: "runId", type: "string" },
    { name: "lot", type: "string" },
    { name: "meaning", type: "string" },
    { name: "statement", type: "string" },
    { name: "comment", type: "string" },
    { name: "contentHash", type: "bytes32" },
    { name: "proofRoot", type: "bytes32" },
    { name: "nonce", type: "string" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
/** What a machine's gateway, or an operator, signs for a stage: a commitment to the counts, not the counts. */
export const READING_TYPES = {
  OrdoReading: [
    { name: "site", type: "string" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "asset", type: "string" },
    { name: "commitment", type: "uint256" },
    { name: "anchor", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;
/**
 * What the source of a measured parameter (an instrument's gateway, or the operator) signs: a commitment to the value,
 * Poseidon(subject, value × 10⁴, salt), exactly what the spec-check circuit hashes, never the value. `criterion` is the
 * criterion's label, or `label#max` for the upper bound of a range.
 */
export const MEASUREMENT_TYPES = {
  OrdoMeasurement: [
    { name: "site", type: "string" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "asset", type: "string" },
    { name: "criterion", type: "string" },
    { name: "commitment", type: "uint256" },
    { name: "anchor", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;
export const PROOF_DOMAIN = { name: "Ordo", version: "2" } as const;
export interface ReleaseMessage {
  site: string;
  packageId: string;
  runId: string;
  lot: string;
  meaning: "performed" | "reviewed" | "approved";
  statement: string;
  comment: string;
  contentHash: Hex;
  proofRoot: Hex;
  nonce: string;
  /** unix seconds, as a decimal string so it survives JSON */
  deadline: string;
}
export interface ReleaseTyped {
  domain: typeof PROOF_DOMAIN;
  types: typeof RELEASE_TYPES;
  primaryType: "OrdoRelease";
  message: ReleaseMessage;
}
/** How long the three release signatures stay valid for the contracts */
const RELEASE_TTL_S = 30 * 86_400;

/**
 * Electronic signatures. The server issues the exact typed data to sign (with a single-use nonce),
 * the user's wallet signs it, and the action endpoint verifies it before acting. A signature can
 * only be used once and only for the action and entity it names.
 */
export class Signatures {
  constructor(
    private db: Db,
    private rpcUrl?: string,
  ) {}

  async request(user: User, r: SignatureRequest): Promise<TypedSignature> {
    const nonce = randomBytes(12).toString("hex");
    const message = { action: r.action, entity: r.entity, meaning: r.meaning, comment: r.comment.slice(0, 500), site: r.site, nonce, issuedAt: new Date().toISOString() };
    const domain: TypedSignature["domain"] = r.verifyingContract
      ? { name: "Ordo", version: "2", chainId: r.chainId, verifyingContract: r.verifyingContract }
      : { name: "Ordo", version: "1", chainId: r.chainId };
    const typed: TypedSignature = { domain, types: SIGNATURE_TYPES, primaryType: "OrdoSignature", message };
    await this.store(user, nonce, r.entity, typed);
    return typed;
  }

  /** A release statement for one link of a package's signature chain (entity `<packageId>#<meaning>`). */
  async requestRelease(user: User, r: Omit<ReleaseMessage, "nonce" | "deadline">): Promise<ReleaseTyped> {
    const nonce = randomBytes(12).toString("hex");
    const message: ReleaseMessage = { ...r, comment: r.comment.slice(0, 500), nonce, deadline: String(Math.floor(Date.now() / 1000) + RELEASE_TTL_S) };
    const typed: ReleaseTyped = { domain: PROOF_DOMAIN, types: RELEASE_TYPES, primaryType: "OrdoRelease", message };
    await this.store(user, nonce, `${r.packageId}#${r.meaning}`, typed);
    return typed;
  }

  private async store(user: User, nonce: string, entity: string, typed: TypedSignature | ReleaseTyped) {
    await this.db.query("INSERT INTO signature_nonces (nonce, user_id, entity, typed_json, expires_at) VALUES ($1, $2, $3, $4, $5)", [
      nonce,
      user.id,
      entity,
      JSON.stringify(typed),
      new Date(Date.now() + 10 * 60_000),
    ]);
  }

  /** Verify and consume a signature for exactly this action and entity. Returns the stored signature id. */
  async consume(q: Queryable, user: User, expect: { action: string; entity: string }, proof: { nonce: string; signature: Hex }): Promise<{ id: string; typed: TypedSignature }> {
    const typed = await this.take<TypedSignature>(q, user, proof.nonce);
    if (typed.primaryType !== "OrdoSignature" || typed.message.action !== expect.action || typed.message.entity !== expect.entity) throw new HttpError(400, "This signature was for a different action");
    const id = await this.verify(q, user, typed, proof.signature, { action: typed.message.action, entity: typed.message.entity, meaning: typed.message.meaning, comment: typed.message.comment });
    return { id, typed };
  }

  /** Verify and consume a release statement for exactly this package link. */
  async consumeRelease(q: Queryable, user: User, expect: { packageId: string; meaning: string }, proof: { nonce: string; signature: Hex }): Promise<{ id: string; typed: ReleaseTyped }> {
    const typed = await this.take<ReleaseTyped>(q, user, proof.nonce);
    if (typed.primaryType !== "OrdoRelease" || typed.message.packageId !== expect.packageId || typed.message.meaning !== expect.meaning) throw new HttpError(400, "This signature was for a different action");
    const m = typed.message;
    const id = await this.verify(q, user, typed, proof.signature, { action: "validation.sign", entity: `${m.packageId}#${m.meaning}`, meaning: m.statement, comment: m.comment });
    return { id, typed };
  }

  private async take<T>(q: Queryable, user: User, nonce: string): Promise<T> {
    const r = await q.query<{ typed_json: string }>(
      "UPDATE signature_nonces SET used_at = now() WHERE nonce = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING typed_json",
      [nonce, user.id],
    );
    const row = r.rows[0];
    if (!row) throw new HttpError(401, "Signature request is unknown, used or expired. Sign again.");
    return JSON.parse(row.typed_json) as T;
  }

  private async verify(q: Queryable, user: User, typed: TypedSignature | ReleaseTyped, signature: Hex, row: { action: string; entity: string; meaning: string; comment: string }) {
    const message = typed.primaryType === "OrdoRelease" ? { ...typed.message, deadline: BigInt(typed.message.deadline) } : typed.message;
    const params = { address: user.address as Hex, domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message, signature } as Parameters<typeof verifyTypedData>[0];
    let ok = await verifyTypedData(params).catch(() => false);
    if (!ok && this.rpcUrl) ok = await createPublicClient({ transport: http(this.rpcUrl) }).verifyTypedData(params as never).catch(() => false);
    if (!ok) throw new HttpError(401, "Signature does not match your wallet");
    const id = newId("sig");
    await q.query("INSERT INTO signatures (id, user_id, address, action, entity, meaning, comment, typed_data, signature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
      id,
      user.id,
      user.address,
      row.action,
      row.entity,
      row.meaning,
      row.comment,
      JSON.stringify(typed),
      signature,
    ]);
    return id;
  }
}
