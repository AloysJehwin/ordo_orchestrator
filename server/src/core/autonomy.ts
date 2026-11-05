import type { Hex } from "viem";
import type { Signatures, User } from "../auth/auth.js";
import { sigArg } from "../chain/trust.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import { levelRank, type AutonomyLevel, type Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { newId, type PlantService } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";
import type { RelayView, Trust } from "./trust.js";

/** Raising autonomy (or publishing a policy for the first time) needs this many plant managers; lowering needs one. */
export const RAISE_SIGNERS = 1;

export interface AutonomyProposalView {
  id: string;
  lineId: string;
  lineName: string;
  from: AutonomyLevel;
  to: AutonomyLevel;
  version: number;
  comment: string;
  status: "open" | "applied" | "superseded";
  required: number;
  signers: { address: string; name: string | null; at: string }[];
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  onchain: RelayView | null;
}

/**
 * Line autonomy is a policy decision. Lowering it is one plant manager's signature, applied at once — anyone
 * responsible can always make a line safer. Raising it collects signatures on a proposal until two different
 * plant managers have signed. With OrdoPolicies configured, every applied change is published on-chain with the
 * same signatures, and the contract enforces the same rule.
 */
export class Autonomy {
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private plant: PlantService,
    private trust: Trust,
    private policy: { hash: string },
    private defaultChainId: number,
  ) {
    trust.onRetry("policy.publish", (siteId, _ref, p) => this.trust.chain!.publishPolicy(siteId, p.update, p.sigs));
  }

  private get onchain() {
    return Boolean(this.trust.chain?.cfg.policies);
  }
  private policyHex(): Hex {
    return `0x${this.policy.hash.replace(/^sha256:/, "")}`;
  }
  private entity(lineId: string, to: AutonomyLevel, version: number) {
    return `${lineId}#L${levelRank(to)}#${this.policyHex()}#${version}`;
  }
  private required(from: AutonomyLevel, to: AutonomyLevel, version: number) {
    // the first publication of a line sets its baseline, so it counts as a raise
    return version > 1 && levelRank(to) < levelRank(from) ? 1 : RAISE_SIGNERS;
  }

  private async line(siteId: string, lineId: string) {
    const l = (await this.db.query<{ id: string; name: string; autonomy: AutonomyLevel; policy_version: number }>("SELECT id, name, autonomy, policy_version FROM lines WHERE id = $1 AND site_id = $2", [lineId, siteId])).rows[0];
    if (!l) throw new HttpError(404, "Line not found");
    return l;
  }
  /** The open proposal for this line and level, or what a new one would be. */
  private async target(siteId: string, lineId: string, to: AutonomyLevel) {
    const l = await this.line(siteId, lineId);
    if (l.autonomy === to) throw new HttpError(409, `${l.name} is already at ${to}`);
    const open = (await this.db.query<{ id: string; version: number; from_level: AutonomyLevel }>("SELECT id, version, from_level FROM autonomy_proposals WHERE site_id = $1 AND line_id = $2 AND to_level = $3 AND status = 'open'", [siteId, lineId, to])).rows[0];
    return { line: l, proposalId: open?.id ?? null, version: open?.version ?? l.policy_version + 1, from: open?.from_level ?? l.autonomy };
  }

  async request(siteId: string, user: User, roles: Role[], lineId: string, i: { level: AutonomyLevel; comment: string; chainId?: number }) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "Only a manager changes autonomy");
    const t = await this.target(siteId, lineId, i.level);
    const need = this.required(t.from, i.level, t.version);
    return this.sigs.request(user, {
      action: "policy.publish",
      entity: this.entity(lineId, i.level, t.version),
      meaning: `Set ${t.line.name} autonomy ${t.from} → ${i.level}${need > 1 ? ` (one of ${need} managers)` : ""}`,
      comment: i.comment,
      site: siteId,
      chainId: this.onchain ? this.trust.chain!.cfg.chainId : (i.chainId ?? this.defaultChainId),
    });
  }

  async sign(siteId: string, user: User, roles: Role[], lineId: string, i: { level: AutonomyLevel; comment: string; nonce: string; signature: Hex }): Promise<AutonomyProposalView> {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "Only a manager changes autonomy");
    const t = await this.target(siteId, lineId, i.level);
    const id = t.proposalId ?? newId("aut");
    await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "policy.publish", entity: this.entity(lineId, i.level, t.version) }, i);
      if (!t.proposalId) {
        await q.query("UPDATE autonomy_proposals SET status = 'superseded', decided_at = now() WHERE site_id = $1 AND line_id = $2 AND status = 'open'", [siteId, lineId]);
        await q.query("INSERT INTO autonomy_proposals (id, site_id, line_id, from_level, to_level, policy_hash, version, comment, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
          id,
          siteId,
          lineId,
          t.from,
          i.level,
          this.policy.hash,
          t.version,
          i.comment,
          user.address,
        ]);
      }
      const dup = await q.query("SELECT 1 FROM autonomy_signatures WHERE proposal_id = $1 AND user_id = $2", [id, user.id]);
      if (dup.rows.length) throw new HttpError(409, "You already signed this change: it needs another manager");
      await q.query("INSERT INTO autonomy_signatures (proposal_id, user_id, address, signature_id) VALUES ($1,$2,$3,$4)", [id, user.id, user.address, s.id]);
    });
    const p = await this.get(siteId, id);
    if (p.signers.length < p.required) {
      await this.rec.event(`user:${user.address}`, "autonomy.proposed", id, { site: siteId, lineId, from: p.from, to: p.to, signed: p.signers.length, required: p.required });
      return p;
    }
    await this.apply(siteId, p);
    return this.get(siteId, id);
  }

  private async apply(siteId: string, p: AutonomyProposalView) {
    await this.plant.setAutonomy(siteId, p.lineId, p.to);
    await this.db.query("UPDATE lines SET policy_version = $1 WHERE id = $2", [p.version, p.lineId]);
    await this.db.query("UPDATE autonomy_proposals SET status = 'applied', decided_at = now() WHERE id = $1", [p.id]);
    const sigRows = await this.db.query<{ typed_data: string; signature: string; signature_id: string }>(
      "SELECT s.typed_data, s.signature, a.signature_id FROM autonomy_signatures a JOIN signatures s ON s.id = a.signature_id WHERE a.proposal_id = $1 ORDER BY a.created_at",
      [p.id],
    );
    await this.rec.decide(siteId, {
      agent: `user:${p.signers.at(-1)!.address}`,
      kind: "autonomy.set",
      summary: `${p.lineName} autonomy ${p.from} → ${p.to}, signed by ${p.signers.length} manager${p.signers.length > 1 ? "s" : ""}`,
      reason: p.comment || null,
      data: { lineId: p.lineId, from: p.from, to: p.to, version: p.version, policyHash: this.policy.hash, signers: p.signers.map((s) => s.address), signatureIds: sigRows.rows.map((r) => r.signature_id) },
    });
    if (this.onchain) {
      const update = { lineId: p.lineId, level: levelRank(p.to), policyHash: this.policyHex(), version: p.version };
      const sigs = sigRows.rows.map((r) => sigArg(JSON.parse(r.typed_data), r.signature));
      await this.trust.relay(siteId, "policy.publish", p.id, { update, sigs }, () => this.trust.chain!.publishPolicy(siteId, update, sigs), true, this.trust.chain!.cfg.policies!);
    }
  }

  async get(siteId: string, id: string): Promise<AutonomyProposalView> {
    const p = (await this.db.query<{ id: string; line_id: string; name: string; from_level: AutonomyLevel; to_level: AutonomyLevel; version: number; comment: string; status: AutonomyProposalView["status"]; created_by: string; created_at: string; decided_at: string | null }>(
      "SELECT p.id, p.line_id, l.name, p.from_level, p.to_level, p.version, p.comment, p.status, p.created_by, p.created_at::text, p.decided_at::text FROM autonomy_proposals p JOIN lines l ON l.id = p.line_id WHERE p.id = $1 AND p.site_id = $2",
      [id, siteId],
    )).rows[0];
    if (!p) throw new HttpError(404, "Proposal not found");
    const signers = await this.db.query<{ address: string; display_name: string | null; created_at: string }>(
      "SELECT a.address, u.display_name, a.created_at::text FROM autonomy_signatures a JOIN users u ON u.id = a.user_id WHERE a.proposal_id = $1 ORDER BY a.created_at",
      [id],
    );
    return {
      id: p.id,
      lineId: p.line_id,
      lineName: p.name,
      from: p.from_level,
      to: p.to_level,
      version: p.version,
      comment: p.comment,
      status: p.status,
      required: this.required(p.from_level, p.to_level, p.version),
      signers: signers.rows.map((s) => ({ address: s.address, name: s.display_name, at: new Date(s.created_at).toISOString() })),
      createdBy: p.created_by,
      createdAt: new Date(p.created_at).toISOString(),
      decidedAt: p.decided_at ? new Date(p.decided_at).toISOString() : null,
      onchain: this.onchain ? await this.trust.relayOf(siteId, p.id) : null,
    };
  }

  async list(siteId: string): Promise<AutonomyProposalView[]> {
    const r = await this.db.query<{ id: string }>("SELECT id FROM autonomy_proposals WHERE site_id = $1 AND (status = 'open' OR decided_at > now() - interval '7 days') ORDER BY created_at DESC LIMIT 20", [siteId]);
    return Promise.all(r.rows.map((x) => this.get(siteId, x.id)));
  }
}
