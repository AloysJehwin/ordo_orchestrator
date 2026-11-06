import type { Hex } from "viem";
import type { Signatures, TypedSignature, User } from "../auth/auth.js";
import type { Db, Queryable } from "../db/db.js";
import { ASSET_KINDS, MACHINE_ROLE_LABEL, MACHINE_ROLES, type AssetKind, type MachineRole } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { Recorder } from "./recorder.js";

/** What a role allows: a runner the kinds of stage it may run, a buyer what it may spend (tinybar, as decimal strings). */
export interface MachineCaps {
  kinds?: AssetKind[];
  order?: string;
  daily?: string;
}
/** What a machine may do now: the roles it holds, with their caps as both the signed grant and its ENS name allow. */
export interface MachineAuthority {
  attester: boolean;
  runner: AssetKind[] | null;
  buyer: { order: bigint; daily: bigint } | null;
}
export interface MachineRoleView {
  role: MachineRole;
  label: string;
  /** pending: signed, counts once its role name is on ENS */
  state: "pending" | "held";
  caps: MachineCaps;
  /** what the role name on ENS says (null until it is there) */
  heldCaps: MachineCaps | null;
  grantedBy: string | null;
  createdAt: string;
}

interface Row {
  site_id: string;
  asset_id: string;
  role: MachineRole;
  state: "pending" | "held";
  caps_json: string;
  held_caps_json: string | null;
  granted_by: string | null;
  created_at: string;
}

const ENTITY_ROLE: Record<MachineRole, string> = { attester: "ATTESTER", buyer: "BUYER", runner: "RUNNER" };

/** The text records a machine's role name carries for its caps (cnc-07.buyers.acme.ordo.eth: com.ordo.cap.order…). */
export function capsTexts(role: MachineRole, caps: MachineCaps): Record<string, string> {
  if (role === "runner") return { "com.ordo.kinds": [...(caps.kinds ?? [])].sort().join(",") };
  if (role === "buyer") return { "com.ordo.cap.order": caps.order ?? "0", "com.ordo.cap.daily": caps.daily ?? "0" };
  return {};
}

/** A cap change counts at once when it gives less, and once on ENS when it gives more: the lower of the two applies. */
function effective(role: MachineRole, wanted: MachineCaps, held: MachineCaps | null): MachineCaps | null {
  if (!held) return null;
  if (role === "runner") return { kinds: (wanted.kinds ?? []).filter((k) => (held.kinds ?? []).includes(k)) };
  if (role === "buyer") {
    const min = (a?: string, b?: string) => (BigInt(a ?? "0") < BigInt(b ?? "0") ? (a ?? "0") : (b ?? "0"));
    return { order: min(wanted.order, held.order), daily: min(wanted.daily, held.daily) };
  }
  return {};
}

const parse = (s: string | null): MachineCaps | null => (s ? (JSON.parse(s) as MachineCaps) : null);
const same = (role: MachineRole, a: MachineCaps | null, b: MachineCaps | null) => Boolean(a && b) && JSON.stringify(capsTexts(role, a!)) === JSON.stringify(capsTexts(role, b!));

/**
 * Machine roles, each an ENS role name a manager grants with a signature: Attester (signs its own stages' readings
 * and outputs), Buyer (buys over x402 within caps per order and per day) and Runner (may be given stages of the kinds
 * listed). As with people, a grant counts once its role name is on ENS and a removal at once. Creating a machine gives
 * it Runner for its kind (and Attester when it has its own key); enabling its wallet gives it Buyer within the
 * wallet's limits; pausing the wallet takes Buyer away.
 */
export class MachineRoles {
  private ensLive: () => boolean = () => false;
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private chainId: number,
  ) {}

  /** Roles are decided by ENS names: a grant waits for its role name. */
  useEns(live: () => boolean) {
    this.ensLive = live;
  }

  // ---------------------------------------------------------------- what machines may do
  /** Every machine's authority at an org, by asset id (machines with no role are left out). */
  async of(siteId: string): Promise<Map<string, MachineAuthority>> {
    const rows = (await this.db.query<Row>("SELECT * FROM machine_roles WHERE site_id = $1 AND state = 'held'", [siteId])).rows;
    return this.fold(rows);
  }
  /** One machine's authority, wherever it is. */
  async ofAsset(assetId: string): Promise<MachineAuthority> {
    const rows = (await this.db.query<Row>("SELECT * FROM machine_roles WHERE asset_id = $1 AND state = 'held'", [assetId])).rows;
    return this.fold(rows).get(assetId) ?? { attester: false, runner: null, buyer: null };
  }
  private fold(rows: Row[]) {
    const out = new Map<string, MachineAuthority>();
    for (const r of rows) {
      const a = out.get(r.asset_id) ?? { attester: false, runner: null, buyer: null };
      const caps = effective(r.role, JSON.parse(r.caps_json) as MachineCaps, parse(r.held_caps_json));
      if (r.role === "attester") a.attester = true;
      if (r.role === "runner" && caps) a.runner = caps.kinds ?? [];
      if (r.role === "buyer" && caps) a.buyer = { order: BigInt(caps.order ?? "0"), daily: BigInt(caps.daily ?? "0") };
      out.set(r.asset_id, a);
    }
    return out;
  }
  /** The kinds of stage each machine may run (Runner), by asset id. */
  async runners(siteId: string): Promise<Map<string, AssetKind[]>> {
    const out = new Map<string, AssetKind[]>();
    for (const [id, a] of await this.of(siteId)) if (a.runner) out.set(id, a.runner);
    return out;
  }
  /** A machine's roles, pending ones too, for the floor. */
  async list(siteId: string, assetId: string): Promise<MachineRoleView[]> {
    const rows = (await this.db.query<Row>("SELECT site_id, asset_id, role, state, caps_json, held_caps_json, granted_by, created_at::text AS created_at FROM machine_roles WHERE site_id = $1 AND asset_id = $2 ORDER BY role", [siteId, assetId])).rows;
    return rows.map((r) => ({ role: r.role, label: MACHINE_ROLE_LABEL[r.role], state: r.state, caps: JSON.parse(r.caps_json) as MachineCaps, heldCaps: parse(r.held_caps_json), grantedBy: r.granted_by, createdAt: new Date(r.created_at).toISOString() }));
  }

  // ---------------------------------------------------------------- given without a signature
  /** A new machine: Runner for its own kind, and Attester when it has its own key (its gateway signs). */
  async seedMachine(q: Queryable, siteId: string, assetId: string, kind: AssetKind, gateway: boolean, by: string) {
    const caps = JSON.stringify({ kinds: [kind] });
    await q.query("INSERT INTO machine_roles (site_id, asset_id, role, caps_json, held_caps_json, granted_by) VALUES ($1,$2,'runner',$3,$3,$4) ON CONFLICT DO NOTHING", [siteId, assetId, caps, by]);
    if (gateway) await q.query("INSERT INTO machine_roles (site_id, asset_id, role, granted_by) VALUES ($1,$2,'attester',$3) ON CONFLICT DO NOTHING", [siteId, assetId, by]);
  }
  /** A machine changed: no key, no Attester; a new kind moves a Runner that only ran the old one. */
  async machineChanged(q: Queryable, assetId: string, before: { kind: AssetKind; gateway: boolean }, after: { kind: AssetKind; gateway: boolean }) {
    if (before.gateway && !after.gateway) await q.query("DELETE FROM machine_roles WHERE asset_id = $1 AND role = 'attester'", [assetId]);
    if (before.kind !== after.kind) {
      const r = (await q.query<{ caps_json: string }>("SELECT caps_json FROM machine_roles WHERE asset_id = $1 AND role = 'runner'", [assetId])).rows[0];
      const kinds = r ? ((JSON.parse(r.caps_json) as MachineCaps).kinds ?? []) : [];
      if (kinds.length === 1 && kinds[0] === before.kind) await q.query("UPDATE machine_roles SET caps_json = $1 WHERE asset_id = $2 AND role = 'runner'", [JSON.stringify({ kinds: [after.kind] }), assetId]);
    }
  }
  /** A machine's wallet opened for the first time: Buyer, within the wallet's limits. */
  async seedBuyer(siteId: string, assetId: string, caps: { order: string; daily: string }, by: string) {
    const c = JSON.stringify({ order: caps.order, daily: caps.daily });
    await this.db.query("INSERT INTO machine_roles (site_id, asset_id, role, caps_json, held_caps_json, granted_by) VALUES ($1,$2,'buyer',$3,$3,$4) ON CONFLICT DO NOTHING", [siteId, assetId, c, by]);
  }
  /** A paused wallet: the machine is no longer a Buyer (resuming does not give it back; a manager signs a grant). */
  async dropBuyer(assetId: string) {
    await this.db.query("DELETE FROM machine_roles WHERE asset_id = $1 AND role = 'buyer'", [assetId]);
  }

  // ---------------------------------------------------------------- granted with a manager's signature
  private entity(assetId: string, role: MachineRole, caps: MachineCaps) {
    const t = capsTexts(role, caps);
    const extra = role === "runner" ? `;kinds=${t["com.ordo.kinds"]}` : role === "buyer" ? `;order=${t["com.ordo.cap.order"]};daily=${t["com.ordo.cap.daily"]}` : "";
    return `${assetId}#${ENTITY_ROLE[role]}${extra}`;
  }
  private async asset(siteId: string, assetId: string) {
    const a = (await this.db.query<{ name: string; kind: AssetKind; source_json: string }>("SELECT name, kind, source_json FROM assets WHERE id = $1 AND site_id = $2 AND archived_at IS NULL", [assetId, siteId])).rows[0];
    if (!a) throw new HttpError(404, "Machine not found");
    const src = JSON.parse(a.source_json) as { type: string; device?: string };
    return { name: a.name, kind: a.kind, gateway: src.type === "gateway" && /^0x[0-9a-fA-F]{40}$/.test(src.device ?? "") };
  }
  private clean(role: MachineRole, caps: MachineCaps): MachineCaps {
    if (role === "runner") {
      const kinds = [...new Set(caps.kinds ?? [])].filter((k) => (ASSET_KINDS as readonly string[]).includes(k));
      if (!kinds.length) throw new HttpError(400, "A runner needs at least one kind of stage it may run");
      return { kinds: kinds.sort() };
    }
    if (role === "buyer") {
      const n = (v: string | undefined, what: string) => {
        if (!v || !/^\d{1,18}$/.test(v) || BigInt(v) <= 0n) throw new HttpError(400, `A buyer needs a ${what} cap above zero (tinybar)`);
        return BigInt(v).toString();
      };
      const order = n(caps.order, "per-order");
      const daily = n(caps.daily, "daily");
      if (BigInt(order) > BigInt(daily)) throw new HttpError(400, "The per-order cap cannot be above the daily cap");
      return { order, daily };
    }
    return {};
  }
  private describe(role: MachineRole, caps: MachineCaps) {
    if (role === "runner") return ` for ${(caps.kinds ?? []).join(", ")} stages`;
    if (role === "buyer") return `, up to ${Number(caps.order) / 1e8} HBAR an order and ${Number(caps.daily) / 1e8} HBAR a day`;
    return "";
  }

  /** What a manager signs to give a machine a role (or change its caps), or take it away. */
  async request(siteId: string, manager: User, assetId: string, role: MachineRole, grant: boolean, caps: MachineCaps, comment: string, clientChainId?: number): Promise<TypedSignature> {
    if (!(MACHINE_ROLES as readonly string[]).includes(role)) throw new HttpError(400, "Unknown machine role");
    const a = await this.asset(siteId, assetId);
    const have = (await this.db.query<Row>("SELECT * FROM machine_roles WHERE asset_id = $1 AND role = $2", [assetId, role])).rows[0];
    if (grant && role === "attester" && !a.gateway) throw new HttpError(409, `${a.name} has no key of its own (a gateway or a machine body), so it cannot sign: its stages are attested by people`);
    const c = grant ? this.clean(role, caps) : {};
    if (grant && have && same(role, JSON.parse(have.caps_json) as MachineCaps, c)) throw new HttpError(409, `${a.name} is already a ${MACHINE_ROLE_LABEL[role]}${this.describe(role, c)}`);
    if (!grant && !have) throw new HttpError(409, `${a.name} is not a ${MACHINE_ROLE_LABEL[role]}`);
    return this.sigs.request(manager, {
      action: grant ? "machine.role.grant" : "machine.role.revoke",
      entity: this.entity(assetId, role, c),
      meaning: grant ? `${have ? "Change" : "Make"} ${a.name} ${have ? "as" : "a"} ${MACHINE_ROLE_LABEL[role]}${this.describe(role, c)}` : `Remove ${a.name} as ${MACHINE_ROLE_LABEL[role]}`,
      comment,
      site: siteId,
      chainId: clientChainId ?? this.chainId,
    });
  }

  async set(siteId: string, manager: User, assetId: string, role: MachineRole, grant: boolean, caps: MachineCaps, input: { comment: string; nonce: string; signature: Hex }) {
    const a = await this.asset(siteId, assetId);
    const c = grant ? this.clean(role, caps) : {};
    const viaEns = this.ensLive();
    let pending = false;
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, manager, { action: grant ? "machine.role.grant" : "machine.role.revoke", entity: this.entity(assetId, role, c) }, { nonce: input.nonce, signature: input.signature });
      const have = (await q.query<Row>("SELECT * FROM machine_roles WHERE asset_id = $1 AND role = $2", [assetId, role])).rows[0];
      if (!grant) await q.query("DELETE FROM machine_roles WHERE asset_id = $1 AND role = $2", [assetId, role]);
      else if (!have) {
        // with ENS names on, the role counts once its role name is on-chain
        pending = viaEns;
        await q.query("INSERT INTO machine_roles (site_id, asset_id, role, state, caps_json, held_caps_json, granted_by, signature_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
          siteId,
          assetId,
          role,
          viaEns ? "pending" : "held",
          JSON.stringify(c),
          viaEns ? null : JSON.stringify(c),
          manager.address,
          s.id,
        ]);
      } else {
        // new caps: less counts at once (the lower of old and new applies), more once the role name says so
        const held = parse(have.held_caps_json);
        pending = viaEns && !same(role, effective(role, c, held), c);
        await q.query("UPDATE machine_roles SET caps_json = $1, held_caps_json = $2, granted_by = $3, signature_id = $4 WHERE asset_id = $5 AND role = $6", [
          JSON.stringify(c),
          viaEns ? have.held_caps_json : JSON.stringify(c),
          manager.address,
          s.id,
          assetId,
          role,
        ]);
      }
      return s;
    });
    await this.rec.decide(siteId, {
      agent: `user:${manager.address}`,
      kind: grant ? "machine.role_granted" : "machine.role_revoked",
      assetId,
      summary: grant ? `Made ${a.name} a ${MACHINE_ROLE_LABEL[role]}${this.describe(role, c)}${pending ? " (counts once on ENS)" : ""}` : `Removed ${a.name} as ${MACHINE_ROLE_LABEL[role]}`,
      reason: input.comment || null,
      data: { role, caps: c, signatureId: sig.id, typedData: sig.typed, signature: input.signature },
    });
    return { pending, roles: await this.list(siteId, assetId) };
  }

  // ---------------------------------------------------------------- following ENS
  /** Grants and cap rises whose role name now says them count. Called each engine cycle, after batches are confirmed. */
  async promote(): Promise<number> {
    const r = await this.db.query<Row & { have_json: string; name: string }>(
      `SELECT m.*, n.have_json, n.name FROM machine_roles m
         JOIN ens_names n ON n.id = 'ens:' || m.site_id || ':machinerole:' || m.role || ':' || m.asset_id
        WHERE (m.state = 'pending' OR m.held_caps_json IS DISTINCT FROM m.caps_json) AND n.have_json IS NOT NULL`,
    );
    let n = 0;
    for (const x of r.rows) {
      const have = JSON.parse(x.have_json) as { revoke?: boolean; texts: Record<string, string> };
      if (have.revoke) continue;
      const caps = JSON.parse(x.caps_json) as MachineCaps;
      // the name must say these caps, not older ones
      const t = capsTexts(x.role, caps);
      if (Object.entries(t).some(([k, v]) => have.texts[k] !== v)) continue;
      await this.db.query("UPDATE machine_roles SET state = 'held', held_caps_json = caps_json, confirmed_at = now() WHERE asset_id = $1 AND role = $2 AND caps_json = $3", [x.asset_id, x.role, x.caps_json]);
      n++;
      if (x.state === "pending")
        await this.rec.decide(x.site_id, { agent: "system:ens", kind: "machine.role_held", assetId: x.asset_id, summary: `${x.name} is on-chain: the ${MACHINE_ROLE_LABEL[x.role]} role counts now`, data: { role: x.role, name: x.name } });
    }
    return n;
  }

  /** A role name taken back on-chain: the machine no longer holds the role. */
  async lapse(siteId: string, assetId: string, role: MachineRole, name: string) {
    const gone = await this.db.query("DELETE FROM machine_roles WHERE asset_id = $1 AND role = $2 RETURNING role", [assetId, role]);
    if (gone.rows.length)
      await this.rec.decide(siteId, { agent: "system:ens", kind: "machine.role_lapsed", assetId, summary: `${name} is no longer held on-chain: the ${MACHINE_ROLE_LABEL[role]} role has ended`, data: { role, name } });
  }
}
