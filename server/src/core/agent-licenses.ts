import { createHash } from "node:crypto";
import { keccak256, toBytes, type Hex } from "viem";
import type { Signatures, User } from "../auth/auth.js";
import type { IntelligentData } from "../chain/inft.js";
import { chainErrorMessage } from "../chain/errors.js";
import { sigArg, type SigArg } from "../chain/trust.js";
import type { BlobStore } from "../chain/zerog.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import { AGENT_INFO, AGENTS, type AgentKey, type Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { newId } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";

/** An agent is proven once people have decided this many of its recommendations and accepted at least this share. */
export const PROVEN = { minDecided: 3, minRate: 0.75 };
/** How many accepted cases a playbook carries (newest first). */
const PLAYBOOK_CASES = 20;
const MAX_ATTEMPTS = 6;
/** Licence terms Ordo offers, in days. */
export const LICENSE_DAYS = [7, 30, 90] as const;

/** What licensing needs from OrdoAgentNFT (AgentNftChain in production). */
export interface LicenseRail {
  readonly cfg: { address: string; chainId: number };
  grantLicense(tokenId: number, licensee: string, expiresAt: number, termsHash: Hex, sig: SigArg): Promise<Hex>;
  revokeLicense(tokenId: number, licensee: string, sig: SigArg): Promise<Hex>;
  licenseOf(tokenId: number, licensee: string): Promise<{ active: boolean; expiresAt: number; termsHash: Hex }>;
  txUrl(hash: string): string | null;
  tokenUrl(tokenId: number): string | null;
}

export interface TrackRecord {
  recommended: number;
  decided: number;
  accepted: number;
  overridden: number;
  /** accepted / decided */
  rate: number | null;
  proven: boolean;
}
export interface PlaybookCase {
  assetKind: string;
  signal: string;
  level: string;
  anomalyKind: string;
  tools: string[];
  /** the actions' settings that carry over between sites (priority, window, sampling), not this site's ids */
  settings: Record<string, string | number>[];
  reason: string;
  /** "person" when someone picked the recommended option, "policy" when the guard let the agent act on its own */
  acceptedBy: "person" | "policy";
}
export interface Playbook {
  agent: AgentKey;
  site: string;
  record: TrackRecord;
  cases: PlaybookCase[];
}
export type LicenseStatus = "requested" | "declined" | "signed" | "active" | "revoking" | "revoked" | "expired" | "failed";
export interface LicenseView {
  id: string;
  agent: AgentKey;
  agentLabel: string;
  licensor: { id: string; name: string };
  licensee: { id: string; name: string };
  tokenId: number | null;
  tokenUrl: string | null;
  status: LicenseStatus;
  days: number;
  expiresAt: string | null;
  termsHash: string | null;
  record: TrackRecord | null;
  cases: number;
  playbookSha256: string | null;
  storage: { root: string; url: string } | null;
  txUrl: string | null;
  error: string | null;
  requestedBy: string;
  grantedBy: string | null;
  createdAt: string;
}
export interface MarketAgent {
  site: { id: string; name: string };
  agent: AgentKey;
  label: string;
  scope: string;
  tokenId: number | null;
  tokenUrl: string | null;
  record: TrackRecord;
  license: LicenseView | null;
}
/** A licensed playbook as the licensee's agent sees it when it recommends. */
export interface LicensedPlaybook {
  licenseId: string;
  from: string;
  agent: AgentKey;
  tokenId: number | null;
  record: TrackRecord;
  cases: PlaybookCase[];
  /** the licensor's live memory version it came from, when this site holds a key for it */
  memory: { version: number; root: string; onchain: boolean } | null;
}

interface Row {
  id: string;
  licensor_site: string;
  licensor_name: string;
  licensee_site: string;
  licensee_name: string;
  agent: AgentKey;
  token_id: number | null;
  status: LicenseStatus;
  days: number;
  expires_at: string | null;
  terms_json: string | null;
  terms_hash: string | null;
  playbook_json: string | null;
  playbook_sha: string | null;
  storage_root: string | null;
  storage_tx: string | null;
  grant_sig_json: string | null;
  revoke_sig_json: string | null;
  tx_hash: string | null;
  error: string | null;
  attempts: number;
  requested_by: string;
  granted_by: string | null;
  created_at: string;
}
const COLS = `l.id, l.licensor_site, a.name AS licensor_name, l.licensee_site, b.name AS licensee_name, l.agent, l.token_id, l.status, l.days,
  l.expires_at::text AS expires_at, l.terms_json, l.terms_hash, l.playbook_json, l.playbook_sha, l.storage_root, l.storage_tx, l.grant_sig_json,
  l.revoke_sig_json, l.tx_hash, l.error, l.attempts, l.requested_by, l.granted_by, l.created_at::text AS created_at`;
const FROM = "agent_licenses l JOIN sites a ON a.id = l.licensor_site JOIN sites b ON b.id = l.licensee_site";
const OPEN: LicenseStatus[] = ["requested", "signed", "active", "revoking"];
const SETTINGS = ["priority", "windowMinutes", "sampleRatePct"];

/**
 * Licensing a proven agent from one site to another through its ERC-7857 iNFT on 0G. An agent is proven by its track
 * record: how often people accepted what it recommended. Its playbook is the accepted cases. A plant manager at the
 * licensee asks; a plant manager at the agent's own site (one of the token's authorized users) signs a grant that
 * pins the playbook by its SHA-256, and Ordo relays it to OrdoAgentNFT, which checks the signer itself. The playbook
 * goes to 0G Storage, encrypted. While the licence is active on-chain, the licensee's agent of the same kind reads the
 * playbook as precedent when it recommends, and its own token's intelligent data names the licence.
 */
export class AgentLicenses {
  /** Live agent memory on 0G (set by the wiring): a licensee reads the licensor's current memory, sealed for it */
  memory: import("./agent-memory.js").AgentMemory | null = null;

  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    readonly rail: LicenseRail | null,
    private store: BlobStore | null,
    private defaultChainId: number,
    private now: () => number,
  ) {}

  // ---------------- Track record and playbook ----------------

  private async outcomes(siteId: string, agent: AgentKey) {
    return (
      await this.db.query<{ data_json: string; incident_json: string | null; asset_kind: string | null; executed: string; ib_status: string | null; decided_option: number | null; recommended: number | null }>(
        `SELECT d.data_json, i.data_json AS incident_json, s.kind AS asset_kind,
          (SELECT COUNT(*) FROM decisions x WHERE x.site_id = d.site_id AND x.incident_id = d.incident_id AND x.kind = 'action.executed')::text AS executed,
          ib.status AS ib_status, ib.decided_option, ib.recommended
         FROM decisions d LEFT JOIN incidents i ON i.id = d.incident_id AND i.site_id = d.site_id LEFT JOIN assets s ON s.id = d.asset_id
         LEFT JOIN inbox_items ib ON ib.site_id = d.site_id AND ib.incident_id = d.incident_id
         WHERE d.site_id = $1 AND d.agent = $2 AND d.kind = 'incident.recommended' ORDER BY d.ts DESC LIMIT 500`,
        [siteId, `agent:${agent}`],
      )
    ).rows.map((r) => {
      const asked = r.ib_status !== null;
      const decided = asked ? r.ib_status !== "pending" : Number(r.executed) > 0;
      const accepted = asked ? r.ib_status === "approved" && r.decided_option !== null && Number(r.decided_option) === Number(r.recommended) : Number(r.executed) > 0;
      return { ...r, decided, accepted, acceptedBy: (asked ? "person" : "policy") as PlaybookCase["acceptedBy"] };
    });
  }

  async record(siteId: string, agent: AgentKey): Promise<TrackRecord> {
    return toRecord(await this.outcomes(siteId, agent));
  }

  async playbook(siteId: string, agent: AgentKey): Promise<Playbook> {
    const rows = await this.outcomes(siteId, agent);
    const cases: PlaybookCase[] = [];
    for (const r of rows.filter((x) => x.accepted)) {
      if (cases.length >= PLAYBOOK_CASES) break;
      const d = JSON.parse(r.data_json) as { actions?: { tool: string; args?: Record<string, unknown> }[]; reason?: string };
      const a = (r.incident_json ? (JSON.parse(r.incident_json) as { anomaly?: { signal: string; level: string; kind: string } }).anomaly : undefined) ?? null;
      if (!a || !d.actions?.length) continue;
      cases.push({
        assetKind: r.asset_kind ?? "unknown",
        signal: a.signal,
        level: a.level,
        anomalyKind: a.kind,
        tools: d.actions.map((x) => x.tool),
        settings: d.actions.map((x) => Object.fromEntries(Object.entries(x.args ?? {}).filter(([k, v]) => SETTINGS.includes(k) && (typeof v === "string" || typeof v === "number"))) as Record<string, string | number>),
        reason: (d.reason ?? "").slice(0, 400),
        acceptedBy: r.acceptedBy,
      });
    }
    return { agent, site: siteId, record: toRecord(rows), cases };
  }

  // ---------------- Market ----------------

  /** Proven agents at other sites that list publicly, with this site's licence for each if it has one. */
  async market(siteId: string): Promise<MarketAgent[]> {
    const sites = (await this.db.query<{ id: string; name: string }>("SELECT id, name FROM sites WHERE id <> $1 AND public_pipelines ORDER BY name", [siteId])).rows;
    const tokens = new Map(
      (await this.db.query<{ site_id: string; agent: string; token_id: number | null }>("SELECT site_id, agent, token_id FROM agent_nfts WHERE token_id IS NOT NULL")).rows.map((r) => [`${r.site_id}/${r.agent}`, Number(r.token_id)]),
    );
    const mine = await this.rows("l.licensee_site = $1", [siteId]);
    const out: MarketAgent[] = [];
    for (const s of sites)
      for (const agent of AGENTS) {
        const tokenId = tokens.get(`${s.id}/${agent}`) ?? null;
        // with 0G on, only an agent that has its iNFT can be licensed
        if (this.rail && tokenId === null) continue;
        const record = await this.record(s.id, agent);
        if (!record.proven) continue;
        const lic = mine.find((l) => l.licensor_site === s.id && l.agent === agent);
        out.push({ site: s, agent, label: AGENT_INFO[agent].label, scope: AGENT_INFO[agent].scope, tokenId, tokenUrl: tokenId === null ? null : this.rail?.tokenUrl(tokenId) ?? null, record, license: lic ? this.view(lic) : null });
      }
    return out;
  }

  // ---------------- Requests, grants, revokes ----------------

  async list(siteId: string): Promise<{ incoming: LicenseView[]; outgoing: LicenseView[] }> {
    return {
      incoming: (await this.rows("l.licensor_site = $1", [siteId])).map((r) => this.view(r)),
      outgoing: (await this.rows("l.licensee_site = $1", [siteId])).map((r) => this.view(r)),
    };
  }

  async request(siteId: string, user: User, roles: Role[], i: { site: string; agent: AgentKey; days: number }): Promise<LicenseView> {
    pm(roles, "Only a plant manager licenses an agent for this site");
    if (i.site === siteId) throw new HttpError(400, "This agent is already yours");
    const from = (await this.db.query<{ name: string; public_pipelines: boolean }>("SELECT name, public_pipelines FROM sites WHERE id = $1", [i.site])).rows[0];
    if (!from?.public_pipelines) throw new HttpError(404, "No listed site with that id");
    const record = await this.record(i.site, i.agent);
    if (!record.proven) throw new HttpError(409, `${AGENT_INFO[i.agent].label} at ${from.name} is not proven yet`);
    const tokenId = (await this.db.query<{ token_id: number | null }>("SELECT token_id FROM agent_nfts WHERE site_id = $1 AND agent = $2", [i.site, i.agent])).rows[0]?.token_id ?? null;
    if (this.rail && tokenId === null) throw new HttpError(409, "That agent has no iNFT on 0G yet");
    const open = await this.db.query(`SELECT 1 FROM agent_licenses WHERE licensor_site = $1 AND licensee_site = $2 AND agent = $3 AND status IN (${OPEN.map((x) => `'${x}'`).join(",")})`, [i.site, siteId, i.agent]);
    if (open.rows.length) throw new HttpError(409, "This site already has an open licence or request for that agent");
    const id = newId("lic");
    await this.db.query("INSERT INTO agent_licenses (id, licensor_site, licensee_site, agent, token_id, status, days, requested_by, contract) VALUES ($1,$2,$3,$4,$5,'requested',$6,$7,$8)", [
      id,
      i.site,
      siteId,
      i.agent,
      tokenId === null ? null : Number(tokenId),
      i.days,
      user.address,
      this.rail?.cfg.address.toLowerCase() ?? null,
    ]);
    const v = await this.get(id);
    const summary = `${v.licensee.name} asked ${v.licensor.name} to license its ${v.agentLabel.toLowerCase()} for ${i.days} days`;
    for (const s of [siteId, i.site]) await this.rec.decide(s, { agent: `user:${user.address}`, kind: "agent.license_requested", summary, data: { licenseId: id, agent: i.agent, licensor: i.site, licensee: siteId, days: i.days, record } });
    return v;
  }

  /** Typed data for a grant or revoke. A grant fixes its expiry and terms (the playbook as it is now) here. */
  async signRequest(siteId: string, user: User, roles: Role[], id: string, i: { kind: "grant" | "revoke"; comment: string; chainId?: number }) {
    pm(roles, "Only a plant manager of the agent's site licenses it");
    const r = await this.row(id, siteId);
    const chainId = this.rail?.cfg.chainId ?? i.chainId ?? this.defaultChainId;
    if (i.kind === "revoke") {
      if (r.status !== "active") throw new HttpError(409, "Only an active licence can be revoked");
      return this.sigs.request(user, { action: "agent.unlicense", entity: revokeEntity(r), meaning: `End ${r.licensee_name}'s licence to the ${AGENT_INFO[r.agent].label.toLowerCase()}`, comment: i.comment, site: siteId, chainId });
    }
    if (r.status !== "requested") throw new HttpError(409, "This request is no longer open");
    const pb = await this.playbook(siteId, r.agent);
    if (!pb.record.proven) throw new HttpError(409, "This agent is no longer proven: its record fell below the bar");
    const playbook = JSON.stringify(pb);
    const sha = createHash("sha256").update(playbook).digest("hex");
    const expiresAt = Math.floor(this.now() / 1000) + r.days * 86_400;
    const terms = { agent: `${siteId}/${r.agent}`, tokenId: r.token_id === null ? null : Number(r.token_id), contract: this.rail?.cfg.address ?? null, licensee: r.licensee_site, expiresAt, days: r.days, playbookSha256: `sha256:${sha}`, record: pb.record };
    const termsJson = JSON.stringify(terms);
    const termsHash = keccak256(toBytes(termsJson));
    await this.db.query("UPDATE agent_licenses SET expires_at = $1, terms_json = $2, terms_hash = $3, playbook_json = $4, playbook_sha = $5, updated_at = now() WHERE id = $6", [
      new Date(expiresAt * 1000).toISOString(),
      termsJson,
      termsHash,
      playbook,
      sha,
      id,
    ]);
    return this.sigs.request(user, {
      action: "agent.license",
      entity: grantEntity(r, expiresAt, termsHash),
      meaning: `License the ${AGENT_INFO[r.agent].label.toLowerCase()} to ${r.licensee_name} for ${r.days} days (${pb.cases.length} accepted cases, ${pct(pb.record.rate)} accepted)`,
      comment: i.comment,
      site: siteId,
      chainId,
    });
  }

  async grant(siteId: string, user: User, roles: Role[], id: string, i: { nonce: string; signature: Hex }): Promise<LicenseView> {
    pm(roles, "Only a plant manager of the agent's site licenses it");
    const r = await this.row(id, siteId);
    if (r.status !== "requested" || !r.terms_hash || !r.expires_at) throw new HttpError(409, "Sign the grant again: this request changed");
    const expiresAt = Math.floor(Date.parse(r.expires_at) / 1000);
    const status: LicenseStatus = this.rail ? "signed" : "active";
    await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "agent.license", entity: grantEntity(r, expiresAt, r.terms_hash as Hex) }, i);
      const u = await q.query("UPDATE agent_licenses SET status = $1, grant_sig_json = $2, granted_by = $3, attempts = 0, error = NULL, next_try_at = now(), updated_at = now() WHERE id = $4 AND status = 'requested' RETURNING id", [
        status,
        JSON.stringify(sigArg(s.typed, i.signature)),
        user.address,
        id,
      ]);
      if (!u.rows.length) throw new HttpError(409, "This request is no longer open");
    });
    const v = await this.get(id);
    const summary = `${v.licensor.name} licensed its ${v.agentLabel.toLowerCase()} to ${v.licensee.name} until ${v.expiresAt!.slice(0, 10)}${this.rail ? "; sending to 0G" : ""}`;
    for (const s of [r.licensor_site, r.licensee_site]) await this.rec.decide(s, { agent: `user:${user.address}`, kind: "agent.license_granted", summary, data: { licenseId: id, termsHash: r.terms_hash, terms: JSON.parse(r.terms_json!) } });
    return v;
  }

  async decline(siteId: string, user: User, roles: Role[], id: string): Promise<LicenseView> {
    pm(roles, "Only a plant manager of the agent's site answers licence requests");
    const u = await this.db.query("UPDATE agent_licenses SET status = 'declined', updated_at = now() WHERE id = $1 AND licensor_site = $2 AND status = 'requested' RETURNING licensee_site", [id, siteId]);
    if (!u.rows.length) throw new HttpError(409, "This request is no longer open");
    const v = await this.get(id);
    for (const s of [v.licensor.id, v.licensee.id]) await this.rec.decide(s, { agent: `user:${user.address}`, kind: "agent.license_declined", summary: `${v.licensor.name} declined to license its ${v.agentLabel.toLowerCase()} to ${v.licensee.name}`, data: { licenseId: id } });
    return v;
  }

  async revoke(siteId: string, user: User, roles: Role[], id: string, i: { nonce: string; signature: Hex }): Promise<LicenseView> {
    pm(roles, "Only a plant manager of the agent's site revokes its licences");
    const r = await this.row(id, siteId);
    if (r.status !== "active") throw new HttpError(409, "Only an active licence can be revoked");
    await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "agent.unlicense", entity: revokeEntity(r) }, i);
      await q.query("UPDATE agent_licenses SET status = $1, revoke_sig_json = $2, attempts = 0, error = NULL, next_try_at = now(), updated_at = now() WHERE id = $3", [this.rail ? "revoking" : "revoked", JSON.stringify(sigArg(s.typed, i.signature)), id]);
    });
    const v = await this.get(id);
    for (const s of [r.licensor_site, r.licensee_site]) await this.rec.decide(s, { agent: `user:${user.address}`, kind: "agent.license_revoked", summary: `${v.licensor.name} ended ${v.licensee.name}'s licence to its ${v.agentLabel.toLowerCase()}`, data: { licenseId: id } });
    return v;
  }

  // ---------------- On-chain ----------------

  /** Expire licences, then one 0G step per due licence: store the playbook, grant, confirm; or revoke. */
  async reconcile(limit = 1): Promise<number> {
    const expired = await this.db.query<{ id: string }>("UPDATE agent_licenses SET status = 'expired', updated_at = now() WHERE status = 'active' AND expires_at <= $1 RETURNING id", [this.iso()]);
    for (const e of expired.rows) {
      const v = await this.get(e.id);
      for (const s of [v.licensor.id, v.licensee.id]) await this.rec.decide(s, { agent: "system:0g", kind: "agent.license_expired", summary: `${v.licensee.name}'s licence to the ${v.agentLabel.toLowerCase()} of ${v.licensor.name} expired`, data: { licenseId: e.id } });
    }
    if (!this.rail) return expired.rows.length;
    const due = await this.rows("l.status IN ('signed','revoking') AND l.next_try_at <= $1", [this.iso()], limit);
    for (const r of due) {
      try {
        await this.step(r);
      } catch (e) {
        const attempts = Number(r.attempts) + 1;
        await this.db.query("UPDATE agent_licenses SET status = $1, error = $2, attempts = $3, next_try_at = $4, updated_at = now() WHERE id = $5", [
          attempts >= MAX_ATTEMPTS ? "failed" : r.status,
          chainErrorMessage(e),
          attempts,
          this.iso(60_000 * 2 ** (attempts - 1)),
          r.id,
        ]);
      }
    }
    return expired.rows.length + due.length;
  }

  private async step(r: Row) {
    const rail = this.rail!;
    const tokenId = Number(r.token_id);
    // a retry after a transaction that landed must not resend it: the signature's nonce is spent
    const before = await rail.licenseOf(tokenId, r.licensee_site);
    if (r.status === "revoking") {
      const tx = before.expiresAt === 0 ? r.tx_hash : await rail.revokeLicense(tokenId, r.licensee_site, JSON.parse(r.revoke_sig_json!));
      await this.db.query("UPDATE agent_licenses SET status = 'revoked', tx_hash = $1, error = NULL, updated_at = now() WHERE id = $2", [tx, r.id]);
      return;
    }
    if (this.store && !r.storage_root) {
      const put = await this.store.put(new TextEncoder().encode(r.playbook_json!));
      await this.db.query("UPDATE agent_licenses SET storage_root = $1, storage_tx = $2, error = NULL, attempts = 0, updated_at = now() WHERE id = $3", [put.root, put.tx, r.id]);
      return;
    }
    const expiresAt = Math.floor(Date.parse(r.expires_at!) / 1000);
    const landed = before.active && before.termsHash.toLowerCase() === r.terms_hash!.toLowerCase();
    const tx = landed ? (r.tx_hash as Hex) : await rail.grantLicense(tokenId, r.licensee_site, expiresAt, r.terms_hash as Hex, JSON.parse(r.grant_sig_json!));
    const on = await rail.licenseOf(tokenId, r.licensee_site);
    if (!on.active || on.termsHash.toLowerCase() !== r.terms_hash!.toLowerCase()) throw new Error("The licence did not show up on-chain after the grant");
    await this.db.query("UPDATE agent_licenses SET status = 'active', tx_hash = $1, error = NULL, attempts = 0, updated_at = now() WHERE id = $2", [tx, r.id]);
    const v = await this.get(r.id);
    for (const s of [r.licensor_site, r.licensee_site])
      await this.rec.decide(s, {
        agent: "system:0g",
        kind: "agent.licensed",
        summary: `${v.licensee.name} now runs the ${v.agentLabel.toLowerCase()} of ${v.licensor.name} under licence on iNFT #${tokenId}`,
        data: { licenseId: r.id, tokenId, tx, txUrl: rail.txUrl(tx), termsHash: r.terms_hash, storageRoot: r.storage_root },
      });
  }

  // ---------------- What the licensee's agents read ----------------

  /** Active licences this site holds for an agent kind, with the cases closest to this asset and signal first. */
  async playbooksFor(siteId: string, agent: AgentKey, near?: { assetKind: string; signal: string }): Promise<LicensedPlaybook[]> {
    const rows = await this.rows("l.licensee_site = $1 AND l.agent = $2 AND l.status = 'active' AND l.expires_at > $3", [siteId, agent, this.iso()]);
    const score = (c: PlaybookCase) => (near ? Number(c.assetKind === near.assetKind) * 2 + Number(c.signal === near.signal) : 0);
    return Promise.all(
      rows.map(async (r) => {
        // the licensor's live memory when this site holds a key for it; else the playbook the grant pinned
        const live = await this.memory?.read(siteId, r.licensor_site, agent).catch((e: unknown) => (console.error("[ordo] agent memory", e), null));
        const pb = live?.playbook ?? (JSON.parse(r.playbook_json!) as Playbook);
        return {
          licenseId: r.id,
          from: r.licensor_name,
          agent,
          tokenId: r.token_id === null ? null : Number(r.token_id),
          record: pb.record,
          cases: [...pb.cases].sort((a, b) => score(b) - score(a)).slice(0, 5),
          memory: live ? { version: live.version, root: live.root, onchain: live.onchain } : null,
        };
      }),
    );
  }

  /** Intelligent data for the licensee's own tokens: one entry per active licence, hashed with its terms. */
  async licensedData(siteId: string): Promise<Map<AgentKey, IntelligentData[]>> {
    const out = new Map<AgentKey, IntelligentData[]>();
    for (const r of await this.rows("l.licensee_site = $1 AND l.status = 'active'", [siteId])) {
      const list = out.get(r.agent) ?? [];
      list.push({ dataDescription: `license:${r.licensor_site}/${r.agent}#${r.token_id ?? "-"}`, dataHash: r.terms_hash as Hex });
      out.set(r.agent, list);
    }
    return out;
  }

  // ---------------- Rows ----------------

  private async rows(where: string, params: unknown[], limit = 100): Promise<Row[]> {
    return (await this.db.query<Row>(`SELECT ${COLS} FROM ${FROM} WHERE ${where} ORDER BY l.created_at DESC LIMIT ${limit}`, params)).rows;
  }
  private async row(id: string, licensorSite: string): Promise<Row> {
    const r = (await this.rows("l.id = $1 AND l.licensor_site = $2", [id, licensorSite]))[0];
    if (!r) throw new HttpError(404, "Licence not found");
    return r;
  }
  async get(id: string): Promise<LicenseView> {
    const r = (await this.rows("l.id = $1", [id]))[0];
    if (!r) throw new HttpError(404, "Licence not found");
    return this.view(r);
  }
  private view(r: Row): LicenseView {
    const pb = r.playbook_json ? (JSON.parse(r.playbook_json) as Playbook) : null;
    const tokenId = r.token_id === null ? null : Number(r.token_id);
    return {
      id: r.id,
      agent: r.agent,
      agentLabel: AGENT_INFO[r.agent].label,
      licensor: { id: r.licensor_site, name: r.licensor_name },
      licensee: { id: r.licensee_site, name: r.licensee_name },
      tokenId,
      tokenUrl: tokenId === null ? null : this.rail?.tokenUrl(tokenId) ?? null,
      status: r.status,
      days: Number(r.days),
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      termsHash: r.terms_hash,
      record: pb?.record ?? null,
      cases: pb?.cases.length ?? 0,
      playbookSha256: r.playbook_sha ? `sha256:${r.playbook_sha}` : null,
      storage: r.storage_root ? { root: r.storage_root, url: r.storage_tx ? this.rail?.txUrl(r.storage_tx) ?? "" : "" } : null,
      txUrl: r.tx_hash ? this.rail?.txUrl(r.tx_hash) ?? null : null,
      error: r.error,
      requestedBy: r.requested_by,
      grantedBy: r.granted_by,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  private iso(plus = 0) {
    return new Date(this.now() + plus).toISOString();
  }
}

function toRecord(rows: { decided: boolean; accepted: boolean }[]): TrackRecord {
  const decided = rows.filter((r) => r.decided).length;
  const accepted = rows.filter((r) => r.accepted).length;
  const rate = decided ? Math.round((accepted / decided) * 100) / 100 : null;
  return { recommended: rows.length, decided, accepted, overridden: decided - accepted, rate, proven: decided >= PROVEN.minDecided && (rate ?? 0) >= PROVEN.minRate };
}
const pm = (roles: Role[], msg: string) => {
  if (!canApproveAny(roles, "manager")) throw new HttpError(403, msg);
};
const pct = (r: number | null) => (r === null ? "none" : `${Math.round(r * 100)}%`);
/** Same strings OrdoAgentNFT rebuilds and checks. */
const grantEntity = (r: Pick<Row, "licensor_site" | "agent" | "licensee_site">, expiresAt: number, termsHash: Hex) => `${r.licensor_site}/${r.agent}>${r.licensee_site}#${expiresAt}#${termsHash.toLowerCase()}`;
const revokeEntity = (r: Pick<Row, "licensor_site" | "agent" | "licensee_site">) => `${r.licensor_site}/${r.agent}>${r.licensee_site}`;
