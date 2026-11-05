import { keccak256, toBytes, type Address, type Hex } from "viem";
import { chainErrorMessage } from "../chain/errors.js";
import { toLabel, type TxState } from "../chain/ensv2.js";
import type { Db } from "../db/db.js";
import { AGENT_INFO, AGENTS, ROLE_LABEL, type Role } from "../domain/types.js";
import type { Recorder } from "./recorder.js";

/** What Names needs from ENSv2 (EnsV2 in production). Writes return once broadcast; check says when they landed. */
export interface NameRail {
  readonly owner: Address;
  readonly cfg: { parentName: string; parentRegistry: Address };
  sendCreateRegistry(salt: bigint): Promise<Hex>;
  registryFrom(logs: { data: Hex; topics: Hex[] }[]): Address;
  sendIssue(i: { registry: Address; label: string; name: string; owner: Address; subregistry?: Address; roleBitmap?: bigint; expiresAt: number; texts: Record<string, string>; addr?: Address }): Promise<Hex[]>;
  sendRecords(name: string, texts: Record<string, string>, addr?: Address): Promise<Hex>;
  sendRevoke(registry: Address, label: string, name: string): Promise<Hex[]>;
  check(hashes: Hex[]): Promise<TxState>;
  txUrl(hash: string): string | null;
  appUrl(name: string): string;
}

/**
 * The role names a person's `com.ordo.roles` record carries: the ones OrdoEnsRoles._roleBit knows, so the Sepolia
 * contracts read the four roles unchanged. A manager holds every manager bit; a tester holds none (lot releases do
 * not involve testers).
 */
const ENS_ROLE_NAMES: Record<Role, string[]> = { manager: ["admin", "operator", "plant_manager", "supervisor", "validator"], validator: ["validator"], tester: [], contributor: ["operator"] };
export const ensRoles = (roles: string[]): string => [...new Set(roles.flatMap((r) => ENS_ROLE_NAMES[r as Role] ?? [r]))].sort().join(",");

type Kind = "site" | "person" | "asset" | "agent" | "device";
type Status = "pending" | "issued" | "revoked" | "failed";
interface Want {
  owner: Address | null;
  addr: Address | null;
  texts: Record<string, string>;
  revoke?: boolean;
}
interface Row {
  id: string;
  site_id: string;
  kind: Kind;
  ref: string;
  label: string;
  name: string;
  registry: string | null;
  want_json: string;
  have_json: string | null;
  status: Status;
  stage: Stage | null;
  sent_json: string | null;
  pending_txs: string | null;
  sent_at: string | null;
  tx_hash: string | null;
  error: string | null;
  attempts: number;
}
type Stage = "registry" | "issue" | "records" | "revoke";
export interface NameView {
  kind: Kind;
  ref: string;
  name: string;
  status: Status;
  error: string | null;
  url: string;
  txUrl: string | null;
  records: Record<string, string>;
}

const MAX_ATTEMPTS = 6;
/** A transaction not mined in this long is sent again */
const STUCK_MS = 10 * 60_000;
const YEAR_MS = 365 * 86_400_000;

/**
 * ENSv2 names for a site and everyone and everything in it: `<site>.<parent>` with its own registry, and in it a
 * name for each person (labelled from their wallet, minted to it, non-transferable, revoked when they hold no role), each asset and each
 * agent. Text records carry what Ordo knows: roles, validator scope, how many releases a person signed. The engine
 * cycle reconciles the names with what Ordo holds and retries with back-off.
 */
export class Names {
  constructor(
    private db: Db,
    private rec: Recorder,
    private rail: NameRail | null,
    private publicUrl: string | null,
    private agentAddress: () => Address | null,
    private now: () => number,
  ) {}

  get live() {
    return Boolean(this.rail);
  }
  get parent() {
    return this.rail?.cfg.parentName ?? null;
  }

  // ---------------------------------------------------------------- what each name should say
  private async wanted(siteId: string): Promise<{ kind: Kind; ref: string; label: string; want: Want }[]> {
    const site = (await this.db.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!site) return [];
    const ordo = this.rail!.owner;
    const out: { kind: Kind; ref: string; label: string; want: Want }[] = [];
    const base = { "com.ordo.site": site.name, ...(this.publicUrl ? { url: this.publicUrl } : {}) };
    out.push({ kind: "site", ref: siteId, label: toLabel(site.name), want: { owner: ordo, addr: null, texts: { "com.ordo.type": "site", description: `${site.name}, run on Ordo`, ...base } } });

    const people = await this.db.query<{ user_id: string; address: string; roles: string; scope: string | null; releases: string }>(
      `SELECT m.user_id, u.address, string_agg(DISTINCT m.role, ',' ORDER BY m.role) AS roles, v.scope,
              (SELECT count(*) FROM package_signatures ps JOIN validation_packages vp ON vp.id = ps.package_id
               WHERE vp.site_id = m.site_id AND ps.user_id = m.user_id AND ps.cleared_at IS NULL)::text AS releases
       FROM memberships m JOIN users u ON u.id = m.user_id
       LEFT JOIN validators v ON v.site_id = m.site_id AND v.user_id = m.user_id AND v.status = 'approved'
       WHERE m.site_id = $1 GROUP BY m.user_id, u.address, v.scope, m.site_id`,
      [siteId],
    );
    for (const p of people.rows) {
      const roles = p.roles.split(",");
      const texts: Record<string, string> = {
        "com.ordo.type": "person",
        "com.ordo.roles": ensRoles(roles),
        description: roles.map((r) => ROLE_LABEL[r as Role] ?? r).join(", "),
        "com.ordo.signed": p.releases,
        ...base,
      };
      if (p.scope) texts["com.ordo.validator"] = p.scope;
      // labels come from the wallet, never the account name: a label is public on-chain for good, even after revoking
      out.push({ kind: "person", ref: p.user_id, label: personLabel(p.address), want: { owner: p.address as Address, addr: p.address as Address, texts } });
    }

    const assets = await this.db.query<{ id: string; name: string; kind: string; source_json: string }>("SELECT id, name, kind, source_json FROM assets WHERE site_id = $1 AND archived_at IS NULL", [siteId]);
    for (const a of assets.rows) {
      const src = JSON.parse(a.source_json) as { type: string; device?: string };
      const device = src.type === "gateway" && src.device ? (src.device.toLowerCase() as Address) : null;
      out.push({ kind: "asset", ref: a.id, label: toLabel(a.name), want: { owner: ordo, addr: null, texts: { "com.ordo.type": "asset", "com.ordo.kind": a.kind, description: a.name, ...(device ? { "com.ordo.device": device } : {}), ...base } } });
      // the machine's gateway holds the device role through its own member name, so contracts accept the counts it signs
      if (device)
        out.push({
          kind: "device",
          ref: a.id,
          label: personLabel(device),
          want: { owner: device, addr: device, texts: { "com.ordo.type": "device", "com.ordo.roles": "device", "com.ordo.asset": a.name, description: `Gateway of ${a.name}: signs the counts it reads from the machine`, ...base } },
        });
    }

    for (const k of AGENTS) {
      const addr = k === "maintenance" ? this.agentAddress() : null;
      out.push({ kind: "agent", ref: k, label: `${toLabel(k)}-agent`, want: { owner: ordo, addr, texts: { "com.ordo.type": "agent", description: `${AGENT_INFO[k].label} agent: ${AGENT_INFO[k].scope}`, ...base } } });
    }
    return out;
  }

  /** Bring the table in line with Ordo (new names, changed records, names to revoke), then do a little chain work. */
  async reconcile(limit = 2): Promise<number> {
    if (!this.rail) return 0;
    const sites = await this.db.query<{ id: string }>("SELECT id FROM sites");
    for (const s of sites.rows) await this.plan(s.id);
    return this.work(limit);
  }

  private async plan(siteId: string) {
    const rows = new Map((await this.rows(siteId)).map((r) => [`${r.kind}:${r.ref}`, r]));
    const wanted = await this.wanted(siteId);
    const seen = new Set<string>();
    let siteName = rows.get(`site:${siteId}`)?.name ?? null;
    for (const w of wanted) {
      const key = `${w.kind}:${w.ref}`;
      seen.add(key);
      const r = rows.get(key);
      const want = JSON.stringify(w.want);
      if (r && r.label !== w.label && r.status !== "revoked" && (w.kind === "person" || w.kind === "device")) {
        // the label scheme changed (member names now carry the whole address): revoke the old name, issue the new one
        const old = JSON.parse(r.want_json) as Want;
        await this.db.query("UPDATE ens_names SET id = $1, ref = $2, want_json = $3, status = 'pending', attempts = 0, error = NULL, next_try_at = $4, updated_at = now() WHERE id = $5", [
          `${r.id}:was:${r.label}`,
          `${r.ref}#was:${r.label}`,
          JSON.stringify({ ...old, revoke: true }),
          this.iso(),
          r.id,
        ]);
        await this.insert(siteId, w.kind, w.ref, w.label, siteName!, w.want);
        continue;
      }
      if (!r) {
        const name = await this.insert(siteId, w.kind, w.ref, w.label, w.kind === "site" ? this.rail!.cfg.parentName : siteName!, w.want);
        if (w.kind === "site") siteName = name;
      } else if (r.status === "revoked") {
        // back after leaving: issue again under the same name
        await this.db.query("UPDATE ens_names SET want_json = $1, have_json = NULL, status = 'pending', attempts = 0, error = NULL, next_try_at = $2, updated_at = now() WHERE id = $3", [want, this.iso(), r.id]);
      } else if (r.want_json !== want) {
        await this.db.query("UPDATE ens_names SET want_json = $1, status = 'pending', attempts = 0, error = NULL, next_try_at = $2, updated_at = now() WHERE id = $3", [want, this.iso(), r.id]);
      }
    }
    for (const [key, r] of rows) {
      if (seen.has(key) || r.status === "revoked") continue;
      const want = JSON.parse(r.want_json) as Want;
      if (want.revoke) continue;
      await this.db.query("UPDATE ens_names SET want_json = $1, status = 'pending', attempts = 0, error = NULL, next_try_at = $2, updated_at = now() WHERE id = $3", [JSON.stringify({ ...want, revoke: true }), this.iso(), r.id]);
    }
  }

  /** Insert a name, adding -2, -3… to the label when the name is taken. Returns the name. */
  private async insert(siteId: string, kind: Kind, ref: string, label: string, parent: string, want: Want): Promise<string | null> {
    for (let n = 1; n < 100; n++) {
      const l = n === 1 ? label : `${label}-${n}`;
      const name = `${l}.${parent}`;
      const r = await this.db.query("INSERT INTO ens_names (id, site_id, kind, ref, label, name, want_json, status, next_try_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) ON CONFLICT DO NOTHING RETURNING id", [
        `ens:${siteId}:${kind}:${ref}`,
        siteId,
        kind,
        ref,
        l,
        name,
        JSON.stringify(want),
        this.iso(),
      ]);
      if (r.rows.length) return name;
      // the row already exists (another instance planned it), or the name is taken: try the next suffix
      const mine = (await this.db.query<{ name: string }>("SELECT name FROM ens_names WHERE site_id = $1 AND kind = $2 AND ref = $3", [siteId, kind, ref])).rows[0];
      if (mine) return mine.name;
    }
    return null;
  }

  private async work(limit: number): Promise<number> {
    const due = await this.db.query<Row>(
      `SELECT ${COLS} FROM ens_names WHERE status = 'pending' AND next_try_at <= $1 ORDER BY CASE kind WHEN 'site' THEN 0 ELSE 1 END, created_at LIMIT ${limit}`,
      [this.iso()],
    );
    for (const r of due.rows) {
      try {
        await this.apply(r);
      } catch (e) {
        const attempts = Number(r.attempts) + 1;
        await this.db.query("UPDATE ens_names SET status = $1, error = $2, attempts = $3, next_try_at = $4, pending_txs = NULL, stage = NULL, updated_at = now() WHERE id = $5", [
          attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          chainErrorMessage(e),
          attempts,
          this.iso(60_000 * 2 ** (attempts - 1)),
          r.id,
        ]);
      }
    }
    return due.rows.length;
  }

  /** One step for a name: confirm what is in flight, or send the next transactions. */
  private async apply(r: Row) {
    const rail = this.rail!;
    if (r.pending_txs) return this.confirm(r);

    const want = JSON.parse(r.want_json) as Want;
    const have = r.have_json ? (JSON.parse(r.have_json) as Want) : null;
    let registry: Address;
    if (r.kind === "site") {
      registry = rail.cfg.parentRegistry;
    } else {
      const site = (await this.db.query<{ registry: string | null; have_json: string | null }>("SELECT registry, have_json FROM ens_names WHERE site_id = $1 AND kind = 'site'", [r.site_id])).rows[0];
      // wait for the site's own name and registry (it goes first each cycle), without counting it as a failure
      if (!site?.registry || !site.have_json) return;
      registry = site.registry as Address;
    }

    if (want.revoke) {
      if (!have) return this.done(r, "revoked", null, null);
      return this.sent(r, "revoke", want, await rail.sendRevoke(registry, r.label, r.name));
    }
    if (!have) {
      if (r.kind === "site" && !r.registry) return this.sent(r, "registry", want, [await rail.sendCreateRegistry(BigInt(keccak256(toBytes(r.site_id))))]);
      const hashes = await rail.sendIssue({
        registry,
        label: r.label,
        name: r.name,
        owner: want.owner ?? rail.owner,
        subregistry: (r.registry as Address | null) ?? undefined,
        roleBitmap: 0n,
        expiresAt: this.now() + YEAR_MS,
        texts: want.texts,
        addr: want.addr ?? undefined,
      });
      return this.sent(r, "issue", want, hashes);
    }
    const changed: Record<string, string> = Object.fromEntries(Object.entries(want.texts).filter(([k, v]) => have.texts[k] !== v));
    // a record that is no longer wanted (a revoked validator's scope) is cleared, or contracts reading ENS keep honouring it
    for (const k of Object.keys(have.texts)) if (!(k in want.texts) && have.texts[k] !== "") changed[k] = "";
    const addr = want.addr && want.addr !== have.addr ? want.addr : undefined;
    if (!Object.keys(changed).length && !addr) return this.done(r, "issued", want, null);
    return this.sent(r, "records", want, [await rail.sendRecords(r.name, changed, addr)]);
  }

  private async sent(r: Row, stage: Stage, want: Want, hashes: Hex[]) {
    await this.db.query("UPDATE ens_names SET stage = $1, sent_json = $2, pending_txs = $3, sent_at = $4, next_try_at = $5, updated_at = now() WHERE id = $6", [
      stage,
      JSON.stringify(want),
      JSON.stringify(hashes),
      this.iso(),
      this.iso(),
      r.id,
    ]);
  }

  private async confirm(r: Row) {
    const hashes = JSON.parse(r.pending_txs!) as Hex[];
    const st = await this.rail!.check(hashes);
    if (st.state === "pending") {
      if (this.now() - Date.parse(r.sent_at!) > STUCK_MS) throw new Error("Not mined in 10 minutes; sending again");
      return;
    }
    if (st.state === "reverted") throw new Error(`Transaction reverted: ${st.hash}`);
    const sent = JSON.parse(r.sent_json!) as Want;
    const last = hashes[hashes.length - 1]!;
    if (r.stage === "registry") {
      const registry = this.rail!.registryFrom(st.logs);
      await this.db.query("UPDATE ens_names SET registry = $1, stage = NULL, pending_txs = NULL, tx_hash = $2, next_try_at = $3, updated_at = now() WHERE id = $4", [registry, last, this.iso(), r.id]);
    } else if (r.stage === "revoke") {
      await this.done(r, "revoked", r.have_json ? JSON.parse(r.have_json) : null, last);
      await this.rec.decide(r.site_id, { agent: "system:ens", kind: "ens.revoked", summary: `Revoked ${r.name}`, data: { name: r.name, tx: last } });
    } else {
      await this.done(r, "issued", sent, last);
      if (r.stage === "issue")
        await this.rec.decide(r.site_id, { agent: "system:ens", kind: "ens.issued", summary: `Issued ${r.name}${r.kind === "person" || r.kind === "device" ? ` to ${sent.owner}` : ""}`, data: { name: r.name, kind: r.kind, owner: sent.owner, tx: last } });
    }
  }

  /** Record what is now on-chain; the name stays pending if what Ordo wants moved on meanwhile. */
  private async done(r: Row, status: Status, have: Want | null, tx: Hex | null) {
    const want = (await this.db.query<{ want_json: string }>("SELECT want_json FROM ens_names WHERE id = $1", [r.id])).rows[0]!.want_json;
    const behind = status === "issued" && have !== null && want !== JSON.stringify(have);
    await this.db.query(
      "UPDATE ens_names SET status = $1, have_json = $2, tx_hash = COALESCE($3, tx_hash), stage = NULL, sent_json = NULL, pending_txs = NULL, error = NULL, attempts = 0, next_try_at = $4, updated_at = now() WHERE id = $5",
      [behind ? "pending" : status, have ? JSON.stringify(have) : null, tx, this.iso(), r.id],
    );
  }

  // ---------------------------------------------------------------- reads
  private iso(plus = 0) {
    return new Date(this.now() + plus).toISOString();
  }
  private async rows(siteId: string): Promise<Row[]> {
    return (await this.db.query<Row>(`SELECT ${COLS} FROM ens_names WHERE site_id = $1 ORDER BY created_at`, [siteId])).rows;
  }
  private view(r: Row): NameView {
    const want = JSON.parse(r.want_json) as Want;
    return {
      kind: r.kind,
      ref: r.ref,
      name: r.name,
      status: r.status,
      error: r.error,
      url: this.rail?.appUrl(r.name) ?? "",
      txUrl: r.tx_hash ? this.rail?.txUrl(r.tx_hash) ?? null : null,
      records: { ...want.texts, ...(want.addr ? { "addr(60)": want.addr } : {}) },
    };
  }

  async list(siteId: string): Promise<NameView[]> {
    return (await this.rows(siteId)).map((r) => this.view(r));
  }

  /** Issued names of people and gateways at a site, by wallet address, for showing names wherever an address appears. */
  async ofPeople(siteId: string): Promise<Map<string, string>> {
    const r = await this.db.query<{ name: string; want_json: string }>("SELECT name, want_json FROM ens_names WHERE site_id = $1 AND kind IN ('person', 'device') AND status = 'issued'", [siteId]);
    return new Map(r.rows.map((x) => [(JSON.parse(x.want_json) as Want).owner!.toLowerCase(), x.name]));
  }

  async retry(siteId: string, kind: string, ref: string) {
    await this.db.query("UPDATE ens_names SET status = 'pending', attempts = 0, next_try_at = $1, updated_at = now() WHERE site_id = $2 AND kind = $3 AND ref = $4 AND status = 'failed'", [this.iso(), siteId, kind, ref]);
  }
}

/**
 * A member's label (a person's or a gateway's): `member-` and their whole wallet address, which their name's addr
 * record shows anyway. OrdoEnsRoles.memberLabel derives the same label, so no one can take another member's name.
 */
export const personLabel = (address: string) => `member-${address.slice(2).toLowerCase()}`;

const COLS = "id, site_id, kind, ref, label, name, registry, want_json, have_json, status, stage, sent_json, pending_txs, sent_at::text AS sent_at, tx_hash, error, attempts";
