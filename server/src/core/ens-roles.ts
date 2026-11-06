import type { Address } from "viem";
import type { Db } from "../db/db.js";
import { ROLE_LABEL, type Role } from "../domain/types.js";
import type { Recorder } from "./recorder.js";

/** What EnsRoles reads on-chain: who holds a label in a registry (EnsV2 in production). */
export interface RoleChain {
  ownerOf(registry: Address, label: string): Promise<Address>;
}

/** how often each org's role names are checked against the chain */
const VERIFY_MS = 5 * 60_000;
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Roles are decided by ENS names. A promotion is pending until its role name (lena.validators.acme.ordo.eth) is on
 * the chain, and counts from then on; the database keeps a copy of what the chain says. Every few minutes the role
 * names Ordo issued are read back: one that is no longer held (taken back on-chain) ends the role, and one that
 * expired is issued again. Nothing here ever grants a role the chain does not show, or one no manager signed.
 */
export class EnsRoles {
  constructor(
    private db: Db,
    private rec: Recorder,
    private chain: RoleChain,
    /** a lease shared by every server instance, so one checks each org at a time */
    private lease: (name: string, ms: number) => Promise<boolean>,
    private now: () => number,
    /** a promotion now counts: its signed OrdoTrust grant goes out */
    private onHeld: (siteId: string, userId: string, role: Role) => Promise<void>,
  ) {}

  /** Pending promotions whose role name, and the person's own name, are now on-chain become held. */
  async promote(): Promise<number> {
    const r = await this.db.query<{ site_id: string; user_id: string; role: Role; role_have: string; person_have: string; name: string }>(
      `SELECT m.site_id, m.user_id, m.role, rn.have_json AS role_have, pn.have_json AS person_have, rn.name
         FROM memberships m
         JOIN ens_names rn ON rn.id = 'ens:' || m.site_id || ':role:' || m.role || ':' || m.user_id
         JOIN ens_names pn ON pn.id = 'ens:' || m.site_id || ':person:' || m.user_id
        WHERE m.state = 'pending' AND rn.have_json IS NOT NULL AND pn.have_json IS NOT NULL`,
    );
    let n = 0;
    for (const x of r.rows) {
      if ((JSON.parse(x.role_have) as { revoke?: boolean }).revoke || (JSON.parse(x.person_have) as { revoke?: boolean }).revoke) continue;
      const u = await this.db.query("UPDATE memberships SET state = 'held', confirmed_at = now() WHERE site_id = $1 AND user_id = $2 AND role = $3 AND state = 'pending' RETURNING role", [x.site_id, x.user_id, x.role]);
      if (!u.rows.length) continue;
      n++;
      await this.rec.decide(x.site_id, { agent: "system:ens", kind: "team.role_held", summary: `${x.name} is on-chain: the ${ROLE_LABEL[x.role]} role counts now`, data: { userId: x.user_id, role: x.role, name: x.name } });
      await this.onHeld(x.site_id, x.user_id, x.role).catch((e) => console.error("[ordo] role held", e));
    }
    return n;
  }

  /**
   * Read back an org's role names: each issued one must still be held by its person. A name taken back on-chain ends
   * the role (except an org's last manager, whose name is issued again); an expired name is issued again.
   */
  async verify(siteId: string): Promise<void> {
    if (!(await this.lease(`ens-roles:${siteId}`, VERIFY_MS))) return;
    const rows = await this.db.query<{ id: string; ref: string; label: string; name: string; have_json: string; expires_at: string | null; registry: string | null }>(
      `SELECT n.id, n.ref, n.label, n.name, n.have_json, n.expires_at::text AS expires_at, p.registry
         FROM ens_names n JOIN ens_names p ON p.id = n.parent_id
        WHERE n.site_id = $1 AND n.kind IN ('role', 'person') AND n.status = 'issued' AND n.id NOT LIKE '%:was:%'`,
      [siteId],
    );
    for (const x of rows.rows) {
      if (!x.registry) continue;
      const have = JSON.parse(x.have_json) as { owner: string; revoke?: boolean };
      if (have.revoke) continue;
      const holder = await this.chain.ownerOf(x.registry as Address, x.label).catch(() => null);
      // unreadable now, or still held: nothing to do
      if (holder === null || holder.toLowerCase() === have.owner.toLowerCase()) continue;
      const person = !x.ref.includes(":");
      const [role, userId] = (person ? ["contributor", x.ref] : x.ref.split(":")) as [Role, string];
      const expired = holder === ZERO && x.expires_at !== null && Date.parse(x.expires_at) <= this.now();
      const lastManager =
        role === "manager" && Number((await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM memberships WHERE site_id = $1 AND role = 'manager' AND state = 'held' AND user_id <> $2", [siteId, userId])).rows[0]!.n) === 0;
      // a person's own name and a contributor's role need no signature (joining gives them), so they are issued again
      if (expired || lastManager || person || role === "contributor") {
        // issue it again: the grant stands (a lapsed name is free to register again)
        await this.db.query("UPDATE ens_names SET have_json = NULL, status = 'pending', attempts = 0, error = NULL, next_try_at = now(), updated_at = now() WHERE id = $1", [x.id]);
        await this.rec.decide(siteId, { agent: "system:ens", kind: "ens.reissue", summary: `${x.name} ${expired ? "expired" : "is no longer held on-chain"}: issuing it again`, data: { name: x.name, holder } });
        continue;
      }
      // the chain decides: the role ends
      const gone = await this.db.query("DELETE FROM memberships WHERE site_id = $1 AND user_id = $2 AND role = $3 RETURNING role", [siteId, userId, role]);
      await this.db.query("UPDATE ens_names SET have_json = $1, updated_at = now() WHERE id = $2", [JSON.stringify({ ...have, revoke: true }), x.id]);
      if (!gone.rows.length) continue;
      const left = await this.db.query("SELECT 1 FROM memberships WHERE site_id = $1 AND user_id = $2 AND state = 'held'", [siteId, userId]);
      if (!left.rows.length) await this.db.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1,$2,'contributor',$2) ON CONFLICT DO NOTHING", [siteId, userId]);
      await this.rec.decide(siteId, {
        agent: "system:ens",
        kind: "team.role_lapsed",
        summary: `${x.name} is no longer held on-chain: the ${ROLE_LABEL[role]} role has ended`,
        data: { userId, role, name: x.name, holder },
      });
    }
  }
}
