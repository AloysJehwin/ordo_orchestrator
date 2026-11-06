import { keccak256, stringToBytes, toBytes, type Address, type Hex } from "viem";
import { chainErrorMessage } from "../chain/errors.js";
import { hederaEvm, OP, recordCalls, ROLE_REGISTRAR, type BatchState, type NameOp } from "../chain/ensv2.js";
import type { Db } from "../db/db.js";
import { AGENT_INFO, AGENTS, ASSET_KIND_LABEL, ROLE_LABEL, type AgentKey, type AssetKind, type Role } from "../domain/types.js";
import type { Handles } from "./handles.js";
import {
  agentLabel,
  BUDGET_LABEL,
  COLLECTION_LABEL,
  COLLECTIONS,
  hederaCoin,
  MEMBER,
  ROLE_COLLECTION,
  runLabel,
  slotOf,
  stageLabel,
  SYSTEM_AGENTS,
  toLabel,
  topupLabel,
  withSuffix,
  workOrderLabel,
  type Collection,
} from "./name-scheme.js";
import type { Recorder } from "./recorder.js";

/** What Names needs from ENSv2 and OrdoNames (EnsV2 in production). */
export interface NameRail {
  readonly owner: Address;
  readonly cfg: { parentName: string; parentRegistry: Address; names?: Address; runResolver?: Address };
  predictRegistry(salt: bigint): Promise<Address>;
  sendExecute(ops: NameOp[], gas: bigint): Promise<Hex>;
  /** gas one operation needs on its own, or null when it cannot be measured yet */
  estimateOne(op: NameOp): Promise<bigint | null>;
  batchState(hash: Hex): Promise<BatchState>;
  baseFeeGwei(): Promise<number>;
  balanceEth(): Promise<number>;
  txUrl(hash: string): string | null;
  appUrl(name: string): string;
}

export interface NameLimits {
  /** sending pauses while the base fee is above this (gwei) */
  maxFeeGwei: number;
  /** or once this much ETH went on names today (UTC) */
  dailyEth: number;
  /** estimated gas a batch may use */
  batchGas: number;
  /** how long names are registered for */
  years: number;
  /** Hedera network, for the ENSIP-11 coin type of account records */
  hederaNetwork?: string;
}

export type NameKind =
  | "org"
  | "collection"
  | "treasury"
  | "person"
  | "role"
  | "registrar"
  | "machine"
  | "agent"
  | "line"
  | "vendor"
  | "customer"
  | "financier"
  | "pipeline"
  | "run"
  | "stage"
  | "budget"
  | "topup"
  | "workorder";
type Status = "pending" | "sent" | "issued" | "revoked" | "failed";

/** What a name should be: who holds it, where it resolves, and its records. */
interface Want {
  owner: Address;
  resolver: Address | null;
  texts: Record<string, string>;
  addr: Address | null;
  coin: { type: number; evm: Address } | null;
  /** registrar rows: the registry roles the holder gets on the org's registry */
  roles?: string;
  revoke?: boolean;
}
interface Row {
  id: string;
  site_id: string;
  kind: NameKind;
  ref: string;
  parent_id: string | null;
  depth: number;
  prio: number;
  ord: number;
  label: string;
  name: string;
  salt: string | null;
  registry: string | null;
  slot: number;
  member: number;
  address: string | null;
  hedera: string | null;
  want_json: string;
  have_json: string | null;
  sent_json: string | null;
  status: Status;
  batch_id: string | null;
  tx_hash: string | null;
  error: string | null;
  attempts: number;
  quiet_until: string | null;
}
interface Wanted {
  kind: NameKind;
  ref: string;
  /** key (kind:ref) of the name this one is under; null for the org, under the root */
  parent: string | null;
  label: string;
  /** names that hold others get their own registry */
  own?: boolean;
  slot?: number;
  member?: number;
  prio: number;
  ord?: number;
  want: Want;
  address?: string | null;
  hedera?: string | null;
}
interface BatchRow {
  id: string;
  ops: number[];
  /** "issue" | "records" | "revoke" | "grant" | "ungrant" | "reissue" */
  what: string;
  parent: string | null;
}

export interface NameView {
  kind: NameKind;
  ref: string;
  name: string;
  label: string;
  parent: string | null;
  depth: number;
  status: Status;
  error: string | null;
  url: string;
  txUrl: string | null;
  owner: string | null;
  address: string | null;
  hedera: string | null;
  records: Record<string, string>;
  /** the collection a name is in (validators, machines, runs…) */
  collection: string | null;
}
export interface DirectoryEntry {
  kind: NameKind;
  ref: string;
  name: string;
  status: Status;
  address: string | null;
  hedera: string | null;
}
export interface GasState {
  paused: boolean;
  reason: string | null;
  spentTodayEth: number;
  dailyEth: number;
  maxFeeGwei: number;
  baseFeeGwei: number | null;
  balanceEth: number | null;
}

const MAX_ATTEMPTS = 6;
/** a batch not mined in this long is dropped and its names sent again (every operation is safe to repeat) */
const STUCK_MS = 10 * 60_000;
/** status records wait this long, so a name is not rewritten on every change */
const QUIET_MS = 30_000;
const MAX_OPS = 16;
const MAX_IN_FLIGHT = 2;
const LOW_BALANCE_ETH = 0.002;
/** records that change often and are written only once they settle */
const NOISY = new Set(["com.ordo.status", "com.ordo.since", "com.ordo.health", "com.ordo.job"]);
/** a machine's status records settle longer, so a machine flapping between running and idle is not a transaction a minute */
const MACHINE_QUIET_MS = 5 * 60_000;
/** how long a machine's live status is reused between plans */
const MACHINE_STATUS_TTL_MS = 60_000;
/** names kept when what they name is gone: they are the record of what happened */
const HISTORY = new Set<NameKind>(["run", "stage", "budget", "topup", "workorder"]);
/** at most this many managers get registrar rights on their org's registry (an ENSv2 root role holds 15 accounts) */
const MAX_REGISTRARS = 12;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ACTIVE_RUN = new Set(["running"]);
const TERMINAL_STAGE = new Set(["completed", "skipped", "done_deviation"]);

const key = (kind: NameKind, ref: string) => `${kind}:${ref}`;
const sort = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/**
 * ENSv2 names for everything in Ordo, under its root (ordo.eth): each org with its own registry, and in it a handle
 * for each person, role names people hold (priya.validators.acme.ordo.eth), machines, agents, lines, vendors,
 * finance parties, pipelines, the treasury, work orders, and runs with their stages, budget and top-ups. The engine
 * cycle plans what each name should say, then issues pending names in batches through OrdoNames: one transaction for
 * many names, each operation succeeding or failing on its own. A child rides in the same batch as its parent, since
 * the parent's registry address is known before it exists. Names never block production: they are known (and shown)
 * as soon as they are planned, and land on-chain shortly after.
 */
export class Names {
  private gas: GasState;
  private gasCheckedAt = 0;
  /** a reconcile in progress: engine cycles can overlap, and two passes would send the same names twice */
  private running = false;
  /** each machine's live status, from the plant (set by wiring); cached a minute per org */
  private machineViews: ((siteId: string) => Promise<{ id: string; status: string }[]>) | null = null;
  private machineCache = new Map<string, { at: number; status: Map<string, string> }>();
  private sites = new Set<string>();

  constructor(
    private db: Db,
    private rec: Recorder,
    private rail: NameRail | null,
    private handles: Handles,
    private publicUrl: string | null,
    private agentAddress: () => Address | null,
    private limits: NameLimits,
    private now: () => number,
  ) {
    this.gas = { paused: false, reason: null, spentTodayEth: 0, dailyEth: limits.dailyEth, maxFeeGwei: limits.maxFeeGwei, baseFeeGwei: null, balanceEth: null };
  }

  get live() {
    return Boolean(this.rail?.cfg.names);
  }
  get root() {
    return this.rail?.cfg.parentName ?? null;
  }
  /** kept for older callers: the root name */
  get parent() {
    return this.root;
  }
  private get coinType() {
    return hederaCoin(this.limits.hederaNetwork);
  }

  // ---------------------------------------------------------------- engine cycle
  /** Plan every org's names, confirm batches in flight, and send the next batch. */
  async reconcile(_limit?: number): Promise<number> {
    if (!this.live || this.running) return 0;
    this.running = true;
    try {
      const sites = await this.db.query<{ id: string }>("SELECT id FROM sites ORDER BY created_at");
      for (const s of sites.rows) await this.plan(s.id).catch((e) => console.error(`[ordo] ens plan ${s.id}`, e));
      await this.confirm();
      return await this.send();
    } finally {
      this.running = false;
    }
  }

  /** Where machines' live status comes from (the plant's views), for the status records on their names. */
  useMachineStatus(views: (siteId: string) => Promise<{ id: string; status: string }[]>) {
    this.machineViews = views;
  }

  /** Each machine's live status at an org, or null when it cannot be read now (its records keep what they had). */
  private async machineStatus(siteId: string): Promise<Map<string, string> | null> {
    if (!this.machineViews) return null;
    const hit = this.machineCache.get(siteId);
    if (hit && this.now() - hit.at < MACHINE_STATUS_TTL_MS) return hit.status;
    try {
      const status = new Map((await this.machineViews(siteId)).map((v) => [v.id, v.status]));
      this.machineCache.set(siteId, { at: this.now(), status });
      return status;
    } catch {
      return hit?.status ?? null;
    }
  }

  /** Ask for an org's names to be planned again soon (after a change a route made). */
  touch(siteId: string) {
    this.sites.add(siteId);
  }

  /** The name an entity has (planning it now if it is new), before it is on-chain. */
  async ensure(siteId: string, kind: NameKind, ref: string): Promise<string | null> {
    if (!this.live) return null;
    const have = await this.nameOf(siteId, kind, ref);
    if (have) return have;
    await this.plan(siteId);
    return this.nameOf(siteId, kind, ref);
  }

  // ---------------------------------------------------------------- what each name should say
  private async plan(siteId: string) {
    this.sites.delete(siteId);
    const rail = this.rail!;
    const site = (await this.db.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!site) return;
    const rows = await this.rows(siteId);
    const byKey = new Map(rows.filter((r) => !r.id.includes(":was:")).map((r) => [key(r.kind, r.ref), r]));
    const names = new Map([...byKey].map(([k, r]) => [k, r.name]));
    const seen = new Set<string>();
    const ordo = rail.owner;
    const url: Record<string, string> = this.publicUrl ? { url: this.publicUrl } : {};
    const T = (type: string, description: string, extra: Record<string, string> = {}) => sort({ "com.ordo.type": type, description, ...extra });
    const coin = (account: string | null | undefined, evm?: string | null) => {
      if (!account) return null;
      const a = (evm && /^0x[0-9a-fA-F]{40}$/.test(evm) ? evm.toLowerCase() : hederaEvm(account)) as Address | null;
      return a ? { type: this.coinType, evm: a } : null;
    };
    const want = (owner: Address, texts: Record<string, string>, extra: Partial<Want> = {}): Want => ({ owner: owner.toLowerCase() as Address, resolver: null, texts, addr: null, coin: null, ...extra });
    const upsert = async (w: Wanted) => {
      const k = key(w.kind, w.ref);
      seen.add(k);
      const had = byKey.get(k) ?? null;
      const name = await this.upsert(siteId, w, had, w.parent ? (names.get(w.parent) ?? null) : rail.cfg.parentName, w.parent ? (byKey.get(w.parent)?.id ?? null) : null);
      if (name) {
        names.set(k, name);
        // a new row (or one that took a new handle): read it back, so names under it know its id
        if (!had || had.name !== name) {
          const r = (await this.db.query<Row>(`SELECT ${COLS} FROM ens_names WHERE id = $1`, [`ens:${siteId}:${k}`])).rows[0];
          if (r) byKey.set(k, r);
        }
      }
      return name;
    };
    const ORG = key("org", siteId);
    const coll = (c: Collection) => key("collection", c);

    // ---- the org, its collections and its treasury
    const treasury = (await this.db.query<{ account_id: string; key_address: string }>("SELECT account_id, key_address FROM treasuries WHERE site_id = $1", [siteId])).rows[0];
    const orgName = await upsert({
      kind: "org",
      ref: siteId,
      parent: null,
      label: toLabel(site.name),
      own: true,
      slot: slotOf("org"),
      prio: 0,
      want: want(ordo, T("org", `${site.name}, run on Ordo`, url), { coin: coin(treasury?.account_id) }),
      hedera: treasury?.account_id ?? null,
    });
    if (!orgName) return;
    for (const c of COLLECTIONS) await upsert({ kind: "collection", ref: c, parent: ORG, label: c, own: true, slot: slotOf(c), prio: 0, want: want(ordo, T("collection", `${COLLECTION_LABEL[c]} of ${site.name}`)) });
    if (treasury)
      await upsert({
        kind: "treasury",
        ref: siteId,
        parent: ORG,
        label: "treasury",
        prio: 0,
        want: want(ordo, T("treasury", `Treasury of ${site.name}: pays run budgets and top-ups`, { "com.hedera.account": treasury.account_id }), { coin: coin(treasury.account_id) }),
        hedera: treasury.account_id,
      });

    // ---- people: a handle each, and a name in each role collection they hold
    const members = await this.db.query<{ user_id: string; role: Role; address: string; created_at: string }>(
      "SELECT m.user_id, m.role, u.address, m.created_at::text FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 ORDER BY m.created_at",
      [siteId],
    );
    const scopes = new Map((await this.db.query<{ user_id: string; scope: string | null }>("SELECT user_id, scope FROM validators WHERE site_id = $1 AND status = 'approved'", [siteId])).rows.map((v) => [v.user_id, v.scope]));
    const people = new Map<string, { address: Address; roles: Role[] }>();
    for (const m of members.rows) {
      const p = people.get(m.user_id) ?? { address: m.address.toLowerCase() as Address, roles: [] };
      p.roles.push(m.role);
      people.set(m.user_id, p);
    }
    let registrars = 0;
    for (const [userId, p] of people) {
      const handle = await this.handles.ensure(userId);
      const person = await upsert({
        kind: "person",
        ref: userId,
        parent: ORG,
        label: handle,
        member: MEMBER.person,
        prio: 0,
        want: want(p.address, T("person", p.roles.map((r) => ROLE_LABEL[r]).join(", ")), { addr: p.address }),
        address: p.address,
      });
      if (!person) continue;
      for (const role of p.roles) {
        const scope = role === "validator" ? scopes.get(userId) : null;
        await upsert({
          kind: "role",
          ref: `${role}:${userId}`,
          parent: coll(ROLE_COLLECTION[role]),
          label: handle,
          prio: 0,
          want: want(p.address, T("role", `${ROLE_LABEL[role]} at ${site.name}`, { "com.ordo.person": person, ...(scope ? { "com.ordo.validator": scope } : {}) }), { addr: p.address }),
          address: p.address,
        });
        // managers may register names in their org's registry themselves
        if (role === "manager" && registrars < MAX_REGISTRARS) {
          registrars++;
          await upsert({ kind: "registrar", ref: userId, parent: ORG, label: handle, prio: 0, want: want(p.address, {}, { roles: ROLE_REGISTRAR.toString() }), address: p.address });
        }
      }
    }

    // ---- agents, then machines (held by their gateway's key, which then signs as DEVICE), lines
    for (const k of [...AGENTS, ...SYSTEM_AGENTS]) {
      const line = AGENT_INFO[k as AgentKey];
      const addr = k === "maintenance" ? this.agentAddress() : null;
      await upsert({
        kind: "agent",
        ref: k,
        parent: coll("agents"),
        label: agentLabel(k),
        prio: 1,
        want: want(ordo, T("agent", line ? `${line.label}: ${line.scope}` : `Ordo's ${k} service`), { addr: addr ? (addr.toLowerCase() as Address) : null }),
        address: addr?.toLowerCase() ?? null,
      });
    }
    const assets = await this.db.query<{
      id: string;
      name: string;
      kind: AssetKind;
      source_json: string;
      owning_agent: string;
      zone: string | null;
      account_id: string | null;
      evm_address: string | null;
    }>(
      "SELECT a.id, a.name, a.kind, a.source_json, a.owning_agent, z.name AS zone, w.account_id, w.evm_address FROM assets a LEFT JOIN zones z ON z.id = a.zone_id LEFT JOIN machine_wallets w ON w.asset_id = a.id WHERE a.site_id = $1 AND a.archived_at IS NULL ORDER BY a.created_at",
      [siteId],
    );
    // what each machine is doing now: its live status, its open incidents and the stage it runs
    const live = await this.machineStatus(siteId);
    const incidents = await this.db.query<{ asset_id: string; severity: string }>("SELECT asset_id, severity FROM incidents WHERE site_id = $1 AND status <> 'closed'", [siteId]);
    const health = new Map<string, string>();
    for (const i of incidents.rows) if (health.get(i.asset_id) !== "alarm") health.set(i.asset_id, i.severity === "alarm" ? "alarm" : "warn");
    const jobs = await this.db.query<{ asset_id: string; run_id: string; code: string }>(
      "SELECT sr.asset_id, sr.run_id, sr.code FROM stage_runs sr JOIN runs r ON r.id = sr.run_id WHERE r.site_id = $1 AND sr.state IN ('running','awaiting_approval','held') AND sr.asset_id IS NOT NULL ORDER BY sr.started_at",
      [siteId],
    );
    const job = new Map(jobs.rows.map((j) => [j.asset_id, j]));
    for (const a of assets.rows) {
      const src = JSON.parse(a.source_json) as { type: string; device?: string };
      const device = src.type === "gateway" && src.device && /^0x[0-9a-fA-F]{40}$/.test(src.device) ? (src.device.toLowerCase() as Address) : null;
      const prev = byKey.get(key("machine", a.id));
      const had = prev?.want_json ? (JSON.parse(prev.want_json) as Want).texts : {};
      // status and since: the live value when there is one, else what the name already says
      const status = live ? (live.get(a.id) ?? null) : (had["com.ordo.status"] ?? null);
      const since = status ? (had["com.ordo.status"] === status && had["com.ordo.since"] ? had["com.ordo.since"] : `${new Date(this.now()).toISOString().slice(0, 16)}Z`) : null;
      const j = job.get(a.id);
      // the stage it runs, by the stage's name (in words, with its run's name, until the stage has one of its own)
      const jobName = j ? (names.get(key("stage", `${j.run_id}:${j.code}`)) ?? `stage ${j.code} of ${names.get(key("run", j.run_id)) ?? j.run_id}`) : null;
      const agentName = names.get(key("agent", a.owning_agent));
      const kindLabel = ASSET_KIND_LABEL[a.kind] ?? a.kind;
      await upsert({
        kind: "machine",
        ref: a.id,
        parent: coll("machines"),
        label: toLabel(a.name),
        member: device ? MEMBER.machine : 0,
        prio: 1,
        want: want(
          device ?? ordo,
          T("machine", `${a.name}, ${kindLabel}${a.zone ? ` in ${a.zone}` : ""} at ${site.name}`, {
            "com.ordo.kind": a.kind,
            ...(orgName ? { "com.ordo.org": orgName } : {}),
            ...(a.zone ? { "com.ordo.zone": a.zone } : {}),
            ...(agentName ? { "com.ordo.agent": agentName } : {}),
            "com.ordo.source": src.type,
            ...(a.account_id ? { "com.hedera.account": a.account_id } : {}),
            ...(status ? { "com.ordo.status": status, "com.ordo.since": since! } : {}),
            "com.ordo.health": health.get(a.id) ?? "ok",
            ...(jobName ? { "com.ordo.job": jobName } : {}),
          }),
          { addr: device, coin: coin(a.account_id, a.evm_address) },
        ),
        address: device,
        hedera: a.account_id,
      });
    }
    const lines = await this.db.query<{ id: string; name: string; autonomy: string }>("SELECT id, name, autonomy FROM lines WHERE site_id = $1 ORDER BY created_at", [siteId]);
    for (const l of lines.rows) await upsert({ kind: "line", ref: l.id, parent: coll("lines"), label: toLabel(l.name), prio: 1, want: want(ordo, T("line", `${l.name} at ${site.name}`, { "com.ordo.autonomy": l.autonomy })) });

    // ---- vendors (held by their wallet, which then holds VENDOR), customers, financiers, pipelines
    const vendors = await this.db.query<{ id: string; address: string; company: string; hedera_account: string | null }>("SELECT id, address, company, hedera_account FROM vendors WHERE site_id = $1 AND status = 'approved' ORDER BY created_at", [siteId]);
    for (const v of vendors.rows) {
      const addr = v.address.toLowerCase() as Address;
      await upsert({
        kind: "vendor",
        ref: v.id,
        parent: coll("vendors"),
        label: toLabel(v.company),
        member: MEMBER.supplier,
        prio: 1,
        want: want(addr, T("vendor", `${v.company}, a vendor of ${site.name}`, v.hedera_account ? { "com.hedera.account": v.hedera_account } : {}), { addr, coin: coin(v.hedera_account) }),
        address: addr,
        hedera: v.hedera_account,
      });
    }
    const parties = await this.db.query<{ id: string; kind: string; name: string; account_id: string | null; evm_address: string | null }>(
      "SELECT id, kind, name, account_id, evm_address FROM finance_parties WHERE site_id = $1 AND status <> 'failed' ORDER BY created_at",
      [siteId],
    );
    for (const f of parties.rows) {
      // the plant's own pay-on-proof account belongs to the org, not to a customer
      if (f.kind === "plant") continue;
      const kind = f.kind === "financier" ? "financier" : "customer";
      await upsert({
        kind,
        ref: f.id,
        parent: coll(kind === "financier" ? "financiers" : "customers"),
        label: toLabel(f.name),
        prio: 1,
        want: want(ordo, T(kind, `${f.name}, a ${kind} of ${site.name}`, f.account_id ? { "com.hedera.account": f.account_id } : {}), { coin: coin(f.account_id, f.evm_address) }),
        hedera: f.account_id,
      });
    }
    const pipelines = await this.db.query<{ id: string; name: string; category: string }>("SELECT id, name, category FROM templates WHERE site_id = $1 AND archived_at IS NULL ORDER BY created_at", [siteId]);
    for (const t of pipelines.rows) await upsert({ kind: "pipeline", ref: t.id, parent: coll("pipelines"), label: toLabel(t.name), prio: 1, want: want(ordo, T("pipeline", t.name, { "com.ordo.category": t.category })) });

    // ---- runs (own registry; OrdoRunResolver adds the release records), their stages, budget and top-ups
    const runs = await this.db.query<{ id: string; order_ref: string; quantity: number; status: string; line_id: string | null; started_at: string; template_id: string; template: string; version: number; spec_json: string }>(
      `SELECT r.id, r.order_ref, r.quantity, r.status, r.line_id, r.started_at::text, t.id AS template_id, t.name AS template, tv.version, tv.spec_json
       FROM runs r JOIN template_versions tv ON tv.id = r.template_version_id JOIN templates t ON t.id = tv.template_id WHERE r.site_id = $1 ORDER BY r.started_at`,
      [siteId],
    );
    const stageRows = await this.db.query<{ run_id: string; code: string; state: string; asset_id: string | null }>("SELECT s.run_id, s.code, s.state, s.asset_id FROM stage_runs s JOIN runs r ON r.id = s.run_id WHERE r.site_id = $1", [siteId]);
    const stagesOf = new Map<string, typeof stageRows.rows>();
    for (const s of stageRows.rows) stagesOf.set(s.run_id, [...(stagesOf.get(s.run_id) ?? []), s]);
    const budgets = await this.db.query<{ id: string; run_id: string; kind: string; stage_code: string | null; resource: string | null; total: string; schedule_id: string | null; status: string; asset_id: string | null }>(
      "SELECT id, run_id, kind, stage_code, resource, total, schedule_id, status, asset_id FROM budget_schedules WHERE site_id = $1 ORDER BY created_at",
      [siteId],
    );
    const treasuryName = names.get(key("treasury", siteId)) ?? null;
    const runResolver = rail.cfg.runResolver ? (rail.cfg.runResolver.toLowerCase() as Address) : null;
    for (const r of runs.rows) {
      const active = ACTIVE_RUN.has(r.status);
      const started = Date.parse(r.started_at) / 1000;
      const prio = active ? 2 : 3;
      const ord = active ? started : -started;
      const product = `${r.template} v${r.version}`;
      const runName = await upsert({
        kind: "run",
        ref: r.id,
        parent: coll("runs"),
        label: runLabel(r.order_ref, r.id),
        own: true,
        prio,
        ord,
        want: want(
          ordo,
          T("run", `Lot ${r.order_ref}: ${r.quantity} units of ${product}, made at ${site.name}`, {
            ...(this.publicUrl ? { url: `${this.publicUrl.replace(/\/$/, "")}/#/passport/${r.id}` } : {}),
            ...(r.line_id && names.get(key("line", r.line_id)) ? { "com.ordo.line": names.get(key("line", r.line_id))! } : {}),
            ...(names.get(key("pipeline", r.template_id)) ? { "com.ordo.pipeline": names.get(key("pipeline", r.template_id))! } : {}),
            ...(active ? {} : { "com.ordo.status": r.status }),
          }),
          { resolver: runResolver },
        ),
      });
      if (!runName) continue;
      const RUN = key("run", r.id);
      const specStages = new Map(((JSON.parse(r.spec_json) as { stages?: { code: string; name: string }[] }).stages ?? []).map((s) => [s.code, s.name]));
      for (const s of stagesOf.get(r.id) ?? []) {
        const machine = s.asset_id ? names.get(key("machine", s.asset_id)) : undefined;
        await upsert({
          kind: "stage",
          ref: `${r.id}:${s.code}`,
          parent: RUN,
          label: stageLabel(s.code, specStages.get(s.code)),
          prio,
          ord,
          want: want(ordo, T("stage", `Stage ${s.code}${specStages.get(s.code) ? `, ${specStages.get(s.code)}` : ""} of lot ${r.order_ref}`, { ...(machine ? { "com.ordo.machine": machine } : {}), ...(TERMINAL_STAGE.has(s.state) ? { "com.ordo.status": s.state } : {}) })),
        });
      }
      const mine = budgets.rows.filter((b) => b.run_id === r.id);
      const runBudget = mine.filter((b) => b.kind === "run").at(-1);
      if (runBudget)
        await upsert({
          kind: "budget",
          ref: r.id,
          parent: RUN,
          label: BUDGET_LABEL,
          prio,
          ord,
          want: want(ordo, T("budget", `Budget of lot ${r.order_ref}: ${runBudget.total}`, { "com.ordo.amount": runBudget.total, ...(runBudget.schedule_id ? { "com.hedera.schedule": runBudget.schedule_id } : {}), ...(treasuryName ? { "com.ordo.treasury": treasuryName } : {}), "com.ordo.status": runBudget.status })),
        });
      for (const b of mine.filter((x) => x.kind === "topup")) {
        const machine = b.asset_id ? names.get(key("machine", b.asset_id)) : undefined;
        const stage = b.stage_code ? names.get(key("stage", `${r.id}:${b.stage_code}`)) : undefined;
        await upsert({
          kind: "topup",
          ref: b.id,
          parent: RUN,
          label: topupLabel(b.stage_code ?? "run", b.resource ?? "resources"),
          prio,
          ord,
          want: want(
            ordo,
            T("topup", `Top-up of ${b.total} for ${b.resource ?? "resources"} at stage ${b.stage_code ?? "?"} of lot ${r.order_ref}`, {
              "com.ordo.amount": b.total,
              ...(b.schedule_id ? { "com.hedera.schedule": b.schedule_id } : {}),
              ...(machine ? { "com.ordo.machine": machine } : {}),
              ...(stage ? { "com.ordo.stage": stage } : {}),
              "com.ordo.status": b.status,
            }),
          ),
        });
      }
    }

    // ---- work orders
    const wos = await this.db.query<{ id: string; title: string; status: string; vendor_id: string | null; asset_id: string | null; run_id: string | null }>(
      "SELECT id, title, status, vendor_id, asset_id, run_id FROM work_orders WHERE site_id = $1 ORDER BY created_at, id",
      [siteId],
    );
    let n = 0;
    for (const w of wos.rows) {
      n++;
      const open = !["released", "refunded", "cancelled", "failed", "done"].includes(w.status);
      const extra: Record<string, string> = { "com.ordo.status": w.status };
      if (w.vendor_id && names.get(key("vendor", w.vendor_id))) extra["com.ordo.vendor"] = names.get(key("vendor", w.vendor_id))!;
      if (w.asset_id && names.get(key("machine", w.asset_id))) extra["com.ordo.machine"] = names.get(key("machine", w.asset_id))!;
      if (w.run_id && names.get(key("run", w.run_id))) extra["com.ordo.run"] = names.get(key("run", w.run_id))!;
      await upsert({ kind: "workorder", ref: w.id, parent: coll("workorders"), label: workOrderLabel(n), prio: open ? 2 : 3, want: want(ordo, T("workorder", w.title, extra)) });
    }

    // ---- names no longer wanted are revoked, except the ones that are history
    for (const [k, r] of byKey) {
      if (seen.has(k) || r.status === "revoked" || HISTORY.has(r.kind)) continue;
      const w = JSON.parse(r.want_json) as Want;
      if (w.revoke) continue;
      await this.setWant(r, { ...w, revoke: true }, false);
    }
  }

  /** Insert or update one name's row. Returns its name. */
  private async upsert(siteId: string, w: Wanted, r: Row | null, parentName: string | null, parentId: string | null): Promise<string | null> {
    if (!parentName) return null;
    const depth = w.parent === null ? 0 : w.kind === "collection" || w.kind === "person" || w.kind === "treasury" || w.kind === "registrar" ? 1 : w.kind === "stage" || w.kind === "budget" || w.kind === "topup" ? 3 : 2;
    // people and their role names follow the person's handle: a new handle revokes the old names and issues new ones
    if (r && (w.kind === "person" || w.kind === "role" || w.kind === "registrar") && r.label !== w.label) {
      const old = JSON.parse(r.want_json) as Want;
      await this.db.query("UPDATE ens_names SET id = $1, ref = $2, name = $3, updated_at = now() WHERE id = $4", [`${r.id}:was:${r.label}`, `${r.ref}#was:${r.label}`, w.kind === "registrar" ? `${r.name}#was` : r.name, r.id]);
      await this.setWant({ ...r, id: `${r.id}:was:${r.label}` }, { ...old, revoke: true }, false);
      r = null;
    }
    if (!r) return this.insert(siteId, w, parentName, parentId, depth);
    const fields = [w.prio, w.ord ?? 0, depth, parentId, w.address ?? null, w.hedera ?? null, w.member ?? 0, w.slot ?? 0] as const;
    const now = [Number(r.prio), Number(r.ord), Number(r.depth), r.parent_id, r.address, r.hedera, Number(r.member), Number(r.slot)];
    if (fields.some((f, i) => f !== now[i]))
      await this.db.query("UPDATE ens_names SET prio = $1, ord = $2, depth = $3, parent_id = $4, address = $5, hedera = $6, member = $7, slot = $8, updated_at = now() WHERE id = $9", [...fields, r.id]);
    const before = JSON.parse(r.want_json) as Want;
    if (JSON.stringify(before) !== JSON.stringify(w.want) || r.status === "revoked") await this.setWant(r, w.want, true);
    return r.name;
  }

  /** A new name: the label, with -2, -3… while the name is taken. */
  private async insert(siteId: string, w: Wanted, parentName: string, parentId: string | null, depth: number): Promise<string | null> {
    const id = `ens:${siteId}:${key(w.kind, w.ref)}`;
    const salt = w.own ? BigInt(keccak256(toBytes(`ordo:names:${this.rail!.cfg.parentName}:${siteId}:${w.kind}:${w.ref}`))).toString() : null;
    for (let n = 1; n < 100; n++) {
      const label = withSuffix(w.label, n);
      const name = w.kind === "registrar" ? `${label}#registrar.${parentName}` : `${label}.${parentName}`;
      const r = await this.db.query(
        `INSERT INTO ens_names (id, site_id, kind, ref, parent_id, depth, prio, ord, label, name, salt, slot, member, address, hedera, want_json, status, next_try_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17) ON CONFLICT DO NOTHING RETURNING id`,
        [id, siteId, w.kind, w.ref, parentId, depth, w.prio, w.ord ?? 0, label, name, salt, w.slot ?? 0, w.member ?? 0, w.address ?? null, w.hedera ?? null, JSON.stringify(w.want), this.iso()],
      );
      if (r.rows.length) return name;
      const mine = (await this.db.query<{ name: string }>("SELECT name FROM ens_names WHERE id = $1", [id])).rows[0];
      if (mine) return mine.name;
    }
    return null;
  }

  /** A name should now say this: queue it, letting noisy records settle first. */
  private async setWant(r: Row, w: Want, quietable: boolean) {
    const have = r.have_json ? (JSON.parse(r.have_json) as Want) : null;
    const noisyOnly = quietable && have && !have.revoke && r.status === "issued" && !w.revoke && sameExcept(have, w, NOISY);
    // a machine's status settles for minutes, but a new alarm goes out in seconds
    const alarm = r.kind === "machine" && w.texts["com.ordo.health"] === "alarm" && have?.texts["com.ordo.health"] !== "alarm";
    const window = r.kind === "machine" && !alarm ? MACHINE_QUIET_MS : QUIET_MS;
    const quiet = noisyOnly ? (r.quiet_until && Date.parse(r.quiet_until) > this.now() && !alarm ? r.quiet_until : this.iso(window)) : null;
    // a name in a batch keeps its status; confirming compares what was sent with what is wanted then
    const status = r.status === "sent" ? "sent" : "pending";
    await this.db.query("UPDATE ens_names SET want_json = $1, status = $2, attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END, error = NULL, next_try_at = $3, quiet_until = $4, updated_at = now() WHERE id = $5", [
      JSON.stringify(w),
      status,
      this.iso(),
      quiet,
      r.id,
    ]);
  }

  // ---------------------------------------------------------------- sending
  /** Check fees, the day's spend and the balance; sending pauses while any is over its limit. */
  private async gasOk(): Promise<boolean> {
    const day = new Date(this.now());
    day.setUTCHours(0, 0, 0, 0);
    const spent = (await this.db.query<{ wei: string | null }>("SELECT sum(CAST(fee_wei AS NUMERIC))::text AS wei FROM ens_batches WHERE mined_at >= $1", [day.toISOString()])).rows[0]?.wei;
    this.gas.spentTodayEth = spent ? Number(spent) / 1e18 : 0;
    if (this.now() - this.gasCheckedAt > 60_000) {
      this.gasCheckedAt = this.now();
      this.gas.baseFeeGwei = await this.rail!.baseFeeGwei().catch(() => this.gas.baseFeeGwei);
      this.gas.balanceEth = await this.rail!.balanceEth().catch(() => this.gas.balanceEth);
    }
    const reason =
      this.gas.balanceEth !== null && this.gas.balanceEth < LOW_BALANCE_ETH
        ? `The ENS owner account has ${this.gas.balanceEth.toFixed(4)} Sepolia ETH: fund it to issue names`
        : this.gas.spentTodayEth >= this.limits.dailyEth
          ? `${this.gas.spentTodayEth.toFixed(4)} ETH went on names today, the daily limit (ENS_DAILY_ETH): names wait for tomorrow`
          : this.gas.baseFeeGwei !== null && this.gas.baseFeeGwei > this.limits.maxFeeGwei
            ? `Sepolia's base fee is ${this.gas.baseFeeGwei.toFixed(2)} gwei, over the ${this.limits.maxFeeGwei} gwei limit (ENS_MAX_FEE_GWEI): names wait`
            : null;
    this.gas.paused = Boolean(reason);
    this.gas.reason = reason;
    return !reason;
  }

  /** Pack the most urgent pending names into one OrdoNames batch and send it. */
  private async send(): Promise<number> {
    const rail = this.rail!;
    const inFlight = Number(
      (await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM ens_batches WHERE status = 'sent' OR (status = 'sending' AND created_at > $1)", [this.iso(-120_000)])).rows[0]?.n ?? 0,
    );
    if (inFlight >= MAX_IN_FLIGHT) return 0;
    const due = await this.db.query<Row>(
      `SELECT ${COLS} FROM ens_names WHERE status = 'pending' AND next_try_at <= $1 AND (quiet_until IS NULL OR quiet_until <= $1) ORDER BY prio, depth, ord, created_at LIMIT 300`,
      [this.iso()],
    );
    if (!due.rows.length) return 0;
    if (!(await this.gasOk())) return 0;
    const parentIds = [...new Set(due.rows.map((r) => r.parent_id).filter(Boolean))] as string[];
    const parents = new Map(
      parentIds.length ? (await this.db.query<Row>(`SELECT ${COLS} FROM ens_names WHERE id = ANY($1)`, [parentIds])).rows.map((p) => [p.id, p]) : [],
    );
    const ops: NameOp[] = [];
    const entries: BatchRow[] = [];
    const sent = new Map<string, Want>();
    const included = new Set<string>();
    let gas = 0;
    const expiry = BigInt(Math.floor(this.now() / 1000) + this.limits.years * 365 * 86_400);
    for (const r of due.rows) {
      const parent = r.parent_id ? parents.get(r.parent_id) : null;
      if (r.parent_id && !(included.has(r.parent_id) || parent?.status === "issued")) continue;
      const parentRegistry = r.parent_id ? await this.registryOf(parent!) : rail.cfg.parentRegistry;
      const built = await this.opsFor(r, parentRegistry, expiry);
      if (!built) continue;
      if (!built.ops.length) {
        await this.done(r, built.result, null, null);
        continue;
      }
      // measured when the parent is already on-chain; a parent in this same batch is not, so the guide stands in
      const measurable = !r.parent_id || parent?.status === "issued";
      let g = 0;
      for (const o of built.ops) g += measurable ? await this.opGas(o) : guide(o);
      if (ops.length && (gas + g > this.limits.batchGas || ops.length + built.ops.length > MAX_OPS)) break;
      entries.push({ id: r.id, ops: built.ops.map((_, i) => ops.length + i), what: built.what, parent: r.parent_id });
      ops.push(...built.ops);
      sent.set(r.id, built.result);
      included.add(r.id);
      gas += g;
    }
    if (!ops.length) return 0;
    const batchId = `ensb_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // each operation's share already carries its margin; the rest is the batch's own overhead
    const gasLimit = BigInt(Math.min(15_500_000, Math.ceil(gas) + 150_000));
    await this.db.query("INSERT INTO ens_batches (id, rows_json, ops, gas_limit, status) VALUES ($1,$2,$3,$4,'sending')", [batchId, JSON.stringify(entries), ops.length, gasLimit.toString()]);
    let hash: Hex;
    try {
      hash = await rail.sendExecute(ops, gasLimit);
    } catch (e) {
      // nothing was sent: the names stay pending and try again shortly
      await this.db.query("UPDATE ens_batches SET status = 'failed', error = $1 WHERE id = $2", [chainErrorMessage(e), batchId]);
      for (const en of entries) await this.db.query("UPDATE ens_names SET error = $1, next_try_at = $2, updated_at = now() WHERE id = $3", [chainErrorMessage(e), this.iso(60_000), en.id]);
      return 0;
    }
    await this.db.query("UPDATE ens_batches SET status = 'sent', tx_hash = $1, sent_at = $2 WHERE id = $3", [hash, this.iso(), batchId]);
    for (const en of entries) await this.db.query("UPDATE ens_names SET status = 'sent', sent_json = $1, batch_id = $2, updated_at = now() WHERE id = $3", [JSON.stringify(sent.get(en.id)), batchId, en.id]);
    return entries.length;
  }

  /**
   * Gas to give one operation in a batch. Its own estimate when there is one, scaled for the 63/64 of the remaining gas
   * a call passes on (the batch calls each operation through try/catch) plus a margin; the guide otherwise. Too little
   * gas does not revert the batch: the operation fails inside it with no reason, so this errs on the generous side.
   */
  private async opGas(op: NameOp): Promise<number> {
    const est = await this.rail!.estimateOne(op).catch(() => null);
    return est ? Math.ceil((Number(est) * 64) / 63 * 1.3) + 40_000 : guide(op);
  }

  /** The registry of a name that has its own (its address is known before it is deployed). */
  private async registryOf(r: Row): Promise<Address> {
    if (r.registry) return r.registry as Address;
    if (!r.salt) throw new Error(`${r.name} has no registry of its own`);
    const a = (await this.rail!.predictRegistry(BigInt(r.salt))).toLowerCase() as Address;
    await this.db.query("UPDATE ens_names SET registry = $1 WHERE id = $2", [a, r.id]);
    r.registry = a;
    return a;
  }

  /**
   * The operations that bring a name to what is wanted, and what it says once they apply. No operations means it
   * already does. null means it cannot be sent yet.
   */
  private async opsFor(r: Row, parent: Address, expiry: bigint): Promise<{ ops: NameOp[]; result: Want; what: string } | null> {
    const w = JSON.parse(r.want_json) as Want;
    const have = r.have_json ? (JSON.parse(r.have_json) as Want) : null;
    const site = keccak256(stringToBytes(r.site_id));
    const base = { parent, label: r.label, resolver: ZERO, salt: 0n, expiry, roles: 0n, records: [] as Hex[], site, slot: 0, member: 0 };
    if (r.kind === "registrar") {
      if (w.revoke) return have && !have.revoke ? { ops: [{ ...base, kind: OP.ungrant, owner: have.owner, roles: BigInt(have.roles ?? "0") }], result: { ...have, revoke: true }, what: "ungrant" } : { ops: [], result: { ...w }, what: "ungrant" };
      if (have && !have.revoke && have.owner === w.owner && have.roles === w.roles) return { ops: [], result: w, what: "grant" };
      return { ops: [{ ...base, kind: OP.grant, owner: w.owner, roles: BigInt(w.roles ?? "0") }], result: w, what: "grant" };
    }
    if (w.revoke) {
      if (!have || have.revoke) return { ops: [], result: { ...(have ?? w), revoke: true }, what: "revoke" };
      const records = recordCalls(r.name, { texts: { "com.ordo.status": "revoked" } });
      return { ops: [{ ...base, kind: OP.revoke, owner: have.owner, records, member: r.member }], result: { ...have, texts: { ...have.texts, "com.ordo.status": "revoked" }, revoke: true }, what: "revoke" };
    }
    if (r.salt) await this.registryOf(r);
    const resolver = (w.resolver ?? ZERO) as Address;
    const issue = (records: Hex[]): NameOp => ({ ...base, kind: OP.issue, owner: w.owner, resolver, salt: r.salt ? BigInt(r.salt) : 0n, records, slot: r.slot, member: r.member });
    // a name that was revoked, never issued, or changes hands or resolver is issued again with every record
    if (!have || have.revoke || have.owner !== w.owner || (have.resolver ?? null) !== (w.resolver ?? null)) {
      const clear = Object.fromEntries(Object.keys(have?.texts ?? {}).filter((k) => !(k in w.texts)).map((k) => [k, ""]));
      const records = recordCalls(r.name, { texts: { ...clear, ...w.texts }, addr: w.addr, coin: w.coin });
      const ops = have && !have.revoke && have.owner !== w.owner ? [{ ...base, kind: OP.revoke, owner: have.owner, member: r.member }, issue(records)] : [issue(records)];
      return { ops, result: w, what: ops.length > 1 ? "reissue" : "issue" };
    }
    const texts: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.texts)) if (have.texts[k] !== v) texts[k] = v;
    for (const k of Object.keys(have.texts)) if (!(k in w.texts) && have.texts[k] !== "") texts[k] = "";
    const addr = w.addr && w.addr !== have.addr ? w.addr : null;
    const coin = w.coin && JSON.stringify(w.coin) !== JSON.stringify(have.coin) ? w.coin : null;
    if (!Object.keys(texts).length && !addr && !coin) return { ops: [], result: w, what: "records" };
    return { ops: [{ ...base, kind: OP.records, owner: w.owner, records: recordCalls(r.name, { texts, addr, coin }) }], result: w, what: "records" };
  }

  // ---------------------------------------------------------------- confirming
  private async confirm() {
    const batches = await this.db.query<{ id: string; tx_hash: string; rows_json: string; sent_at: string }>("SELECT id, tx_hash, rows_json, sent_at::text AS sent_at FROM ens_batches WHERE status = 'sent' ORDER BY sent_at");
    for (const b of batches.rows) await this.confirmBatch(b).catch((e) => console.error(`[ordo] ens batch ${b.id}`, e));
  }

  private async confirmBatch(b: { id: string; tx_hash: string; rows_json: string; sent_at: string }) {
    const entries = JSON.parse(b.rows_json) as BatchRow[];
    const st = await this.rail!.batchState(b.tx_hash as Hex);
    if (st.state === "pending") {
      if (this.now() - Date.parse(b.sent_at) < STUCK_MS) return;
      await this.db.query("UPDATE ens_batches SET status = 'dropped', error = 'Not mined in 10 minutes' WHERE id = $1", [b.id]);
      for (const en of entries) await this.db.query("UPDATE ens_names SET status = 'pending', batch_id = NULL, next_try_at = $1, updated_at = now() WHERE id = $2 AND batch_id = $3", [this.iso(), en.id, b.id]);
      return;
    }
    await this.db.query("UPDATE ens_batches SET status = $1, gas_used = $2, fee_wei = $3, mined_at = $4 WHERE id = $5", [st.state, st.gasUsed.toString(), st.feeWei.toString(), this.iso(), b.id]);
    if (st.state === "reverted") {
      for (const en of entries) await this.fail(en.id, b.id, "The batch transaction reverted", true);
      return;
    }
    const failedRows = new Set<string>();
    const issued: string[] = [];
    const revoked: string[] = [];
    for (const en of entries) {
      const r = (await this.db.query<Row>(`SELECT ${COLS} FROM ens_names WHERE id = $1`, [en.id])).rows[0];
      if (!r || r.batch_id !== b.id) continue;
      const bad = en.ops.find((i) => st.failed.has(i));
      if (bad !== undefined) {
        failedRows.add(en.id);
        const reason = st.failed.get(bad)!;
        if (en.parent && failedRows.has(en.parent)) await this.fail(en.id, b.id, `Waiting for its parent: ${reason}`, false);
        else if (reason.startsWith("Taken(") && (!r.have_json || r.kind === "org" || r.kind === "run")) await this.relabel(r, b.id, reason);
        else await this.fail(en.id, b.id, reason, true);
        continue;
      }
      const sentWant = JSON.parse(r.sent_json!) as Want;
      const issueOp = en.ops[en.ops.length - 1]!;
      const made = st.applied.get(issueOp);
      if (made && made !== ZERO) await this.db.query("UPDATE ens_names SET registry = $1 WHERE id = $2", [made.toLowerCase(), r.id]);
      await this.done(r, sentWant, b.tx_hash as Hex, b.id);
      if (en.what === "revoke" || en.what === "ungrant") revoked.push(r.name);
      else if (en.what !== "records" && en.what !== "grant") issued.push(r.name);
      if (r.kind === "person" || r.kind === "role" || r.kind === "machine" || r.kind === "vendor") {
        if (en.what === "revoke") await this.rec.decide(r.site_id, { agent: "system:ens", kind: "ens.revoked", summary: `Revoked ${r.name}`, data: { name: r.name, tx: b.tx_hash } });
        else if (en.what === "issue" || en.what === "reissue") await this.rec.decide(r.site_id, { agent: "system:ens", kind: "ens.issued", summary: `Issued ${r.name}${sentWant.owner !== this.rail!.owner.toLowerCase() ? ` to ${sentWant.owner}` : ""}`, data: { name: r.name, kind: r.kind, owner: sentWant.owner, tx: b.tx_hash } });
      }
    }
    // one summary per org the batch touched
    const bySite = new Map<string, { issued: number; revoked: number; updated: number; failed: number }>();
    for (const en of entries) {
      const siteId = en.id.split(":")[1]!;
      const c = bySite.get(siteId) ?? { issued: 0, revoked: 0, updated: 0, failed: 0 };
      if (failedRows.has(en.id)) c.failed++;
      else if (en.what === "revoke" || en.what === "ungrant") c.revoked++;
      else if (en.what === "records") c.updated++;
      else c.issued++;
      bySite.set(siteId, c);
    }
    for (const [siteId, c] of bySite) {
      const parts = [c.issued && `issued ${c.issued} name${c.issued === 1 ? "" : "s"}`, c.updated && `updated ${c.updated}`, c.revoked && `revoked ${c.revoked}`].filter(Boolean).join(", ");
      if (!parts) continue;
      await this.rec.decide(siteId, {
        agent: "system:ens",
        kind: "ens.batch",
        summary: `${parts.charAt(0).toUpperCase()}${parts.slice(1)} in one transaction${c.failed ? ` (${c.failed} to retry)` : ""}`,
        data: { tx: b.tx_hash, issued: issued.slice(0, 50), revoked, gasUsed: st.gasUsed.toString() },
      });
    }
  }

  /** An operation failed: count it (unless it only waited on its parent) and back off. */
  private async fail(id: string, batchId: string, reason: string, count: boolean) {
    const r = (await this.db.query<{ attempts: number }>("SELECT attempts FROM ens_names WHERE id = $1", [id])).rows[0];
    if (!r) return;
    const attempts = Number(r.attempts) + (count ? 1 : 0);
    await this.db.query("UPDATE ens_names SET status = $1, error = $2, attempts = $3, next_try_at = $4, sent_json = NULL, batch_id = NULL, updated_at = now() WHERE id = $5 AND batch_id = $6", [
      attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      reason.slice(0, 400),
      attempts,
      this.iso(count ? 60_000 * 2 ** Math.max(0, attempts - 1) : 0),
      id,
      batchId,
    ]);
  }

  /** The label is held by someone else on-chain: take the next free one (-2, -3…), along with everything under it. */
  private async relabel(r: Row, batchId: string, reason: string) {
    const m = /-(\d+)$/.exec(r.label);
    const parentName = r.name.slice(r.label.length + 1);
    for (let n = m ? Number(m[1]) + 1 : 2; n < 100; n++) {
      const label = withSuffix(m ? r.label.slice(0, -m[0].length) : r.label, n);
      const name = `${label}.${parentName}`;
      if ((await this.db.query("SELECT 1 FROM ens_names WHERE name = $1", [name])).rows.length) continue;
      await this.db.query("UPDATE ens_names SET label = $1, name = $2, status = 'pending', batch_id = NULL, sent_json = NULL, error = $3, next_try_at = $4, updated_at = now() WHERE id = $5 AND batch_id = $6", [
        label,
        name,
        `${reason}: now ${name}`,
        this.iso(),
        r.id,
        batchId,
      ]);
      // names under it follow
      const kids = await this.db.query<{ id: string; name: string }>("SELECT id, name FROM ens_names WHERE name LIKE $1", [`%.${r.name}`]);
      for (const k of kids.rows) await this.db.query("UPDATE ens_names SET name = $1, have_json = NULL, status = CASE WHEN status = 'sent' THEN status ELSE 'pending' END, updated_at = now() WHERE id = $2", [`${k.name.slice(0, -r.name.length)}${name}`, k.id]);
      return;
    }
    await this.fail(r.id, batchId, reason, true);
  }

  /** Record what is now on-chain; the name stays pending if what Ordo wants moved on meanwhile. */
  private async done(r: Row, have: Want, tx: Hex | null, batchId: string | null) {
    const want = (await this.db.query<{ want_json: string }>("SELECT want_json FROM ens_names WHERE id = $1", [r.id])).rows[0]!.want_json;
    const status: Status = have.revoke ? "revoked" : JSON.stringify(stripRevoke(JSON.parse(want) as Want)) === JSON.stringify(stripRevoke(have)) ? "issued" : "pending";
    const behind = have.revoke && !(JSON.parse(want) as Want).revoke;
    await this.db.query(
      "UPDATE ens_names SET status = $1, have_json = $2, sent_json = NULL, batch_id = NULL, tx_hash = COALESCE($3, tx_hash), error = NULL, attempts = 0, next_try_at = $4, updated_at = now() WHERE id = $5 AND (batch_id IS NOT DISTINCT FROM $6 OR $6 IS NULL)",
      [behind ? "pending" : status, JSON.stringify(have), tx, this.iso(), r.id, batchId],
    );
  }

  // ---------------------------------------------------------------- reads
  private iso(plus = 0) {
    return new Date(this.now() + plus).toISOString();
  }
  private async rows(siteId: string): Promise<Row[]> {
    return (await this.db.query<Row>(`SELECT ${COLS} FROM ens_names WHERE site_id = $1 ORDER BY depth, created_at`, [siteId])).rows;
  }
  private view(r: Row, collections: Map<string, string>): NameView {
    const want = JSON.parse(r.want_json) as Want;
    return {
      kind: r.kind,
      ref: r.ref,
      name: r.name,
      label: r.label,
      parent: r.parent_id,
      depth: r.depth,
      status: r.status,
      error: r.error,
      url: this.rail?.appUrl(r.name) ?? "",
      txUrl: r.tx_hash ? (this.rail?.txUrl(r.tx_hash) ?? null) : null,
      owner: want.owner ?? null,
      address: r.address,
      hedera: r.hedera,
      records: { ...want.texts, ...(want.addr ? { "addr(60)": want.addr } : {}), ...(want.coin ? { [`addr(${want.coin.type})`]: want.coin.evm } : {}) },
      collection: r.parent_id ? (collections.get(r.parent_id) ?? null) : null,
    };
  }

  /** Every name of an org, in tree order (the registrar grants are not names, so they are left out). */
  async list(siteId: string): Promise<NameView[]> {
    const rows = (await this.rows(siteId)).filter((r) => r.kind !== "registrar");
    const collections = new Map(rows.filter((r) => r.kind === "collection").map((r) => [r.id, r.ref]));
    return rows.map((r) => this.view(r, collections));
  }

  /** The org's names for showing wherever an entity appears: kind, ref, name, and the address or account behind it. */
  async directory(siteId: string): Promise<{ root: string | null; org: string | null; entries: DirectoryEntry[] }> {
    const rows = (await this.rows(siteId)).filter((r) => r.kind !== "registrar" && !r.id.includes(":was:"));
    return {
      root: this.root,
      org: rows.find((r) => r.kind === "org")?.name ?? null,
      entries: rows.map((r) => ({ kind: r.kind, ref: r.ref, name: r.name, status: r.status, address: r.address, hedera: r.hedera })),
    };
  }

  /** An entity's name ("" when it has none yet). */
  async nameOf(siteId: string, kind: NameKind, ref: string): Promise<string | null> {
    return (await this.db.query<{ name: string }>("SELECT name FROM ens_names WHERE id = $1", [`ens:${siteId}:${key(kind, ref)}`])).rows[0]?.name ?? null;
  }
  /**
   * Names for a set of entities at an org, under the keys given; entities without a name are left out. For HCS lines,
   * memos, logs and summaries, so each says what it is about by name.
   */
  async many(siteId: string, want: Record<string, [NameKind, string | null | undefined]>): Promise<Record<string, string>> {
    const ids = new Map<string, string[]>();
    for (const [k, [kind, ref]] of Object.entries(want)) if (ref) ids.set(`ens:${siteId}:${key(kind, ref)}`, [...(ids.get(`ens:${siteId}:${key(kind, ref)}`) ?? []), k]);
    if (!ids.size || !this.live) return {};
    const r = await this.db.query<{ id: string; name: string }>("SELECT id, name FROM ens_names WHERE id = ANY($1) AND status <> 'revoked'", [[...ids.keys()]]);
    const out: Record<string, string> = {};
    for (const x of r.rows) for (const k of ids.get(x.id) ?? []) out[k] = x.name;
    return out;
  }

  /**
   * The name a new child of an entity will get (label.parent, with -2, -3… while taken): for a Hedera memo written
   * before the child exists. Null when the parent has no name.
   */
  async predict(siteId: string, parentKind: NameKind, parentRef: string, label: string): Promise<string | null> {
    const parent = await this.ensure(siteId, parentKind, parentRef);
    if (!parent) return null;
    for (let n = 1; n < 100; n++) {
      const name = `${withSuffix(label, n)}.${parent}`;
      if (!(await this.db.query("SELECT 1 FROM ens_names WHERE name = $1", [name])).rows.length) return name;
    }
    return null;
  }

  /** Is an entity's name on-chain yet? */
  async statusOf(siteId: string, kind: NameKind, ref: string): Promise<Status | null> {
    return (await this.db.query<{ status: Status }>("SELECT status FROM ens_names WHERE id = $1", [`ens:${siteId}:${key(kind, ref)}`])).rows[0]?.status ?? null;
  }

  /** Has an entity's name been on-chain (issued at least once, not revoked), whatever records are still settling? */
  async onChain(siteId: string, kind: NameKind, ref: string): Promise<boolean> {
    const r = (await this.db.query<{ have_json: string | null }>("SELECT have_json FROM ens_names WHERE id = $1", [`ens:${siteId}:${key(kind, ref)}`])).rows[0];
    return Boolean(r?.have_json && !(JSON.parse(r.have_json) as Want).revoke);
  }

  /** Names by wallet address at an org: a person's handle first, then a machine's or vendor's name. */
  async byAddress(siteId: string): Promise<Map<string, string>> {
    const r = await this.db.query<{ address: string; name: string; kind: NameKind }>(
      "SELECT address, name, kind FROM ens_names WHERE site_id = $1 AND address IS NOT NULL AND status <> 'revoked' AND kind IN ('person', 'machine', 'vendor', 'agent') AND id NOT LIKE '%:was:%'",
      [siteId],
    );
    const rank: Partial<Record<NameKind, number>> = { person: 0, machine: 1, vendor: 2, agent: 3 };
    const out = new Map<string, string>();
    for (const x of r.rows.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9))) if (!out.has(x.address.toLowerCase())) out.set(x.address.toLowerCase(), x.name);
    return out;
  }
  /** kept for older callers */
  ofPeople(siteId: string) {
    return this.byAddress(siteId);
  }
  /** Names by Hedera account at an org (treasury, machine wallets, vendors, finance parties, the org). */
  async byHedera(siteId: string): Promise<Map<string, string>> {
    const r = await this.db.query<{ hedera: string; name: string; kind: NameKind }>("SELECT hedera, name, kind FROM ens_names WHERE site_id = $1 AND hedera IS NOT NULL AND status <> 'revoked'", [siteId]);
    const out = new Map<string, string>();
    // the treasury's own name before the org's
    for (const x of r.rows.sort((a) => (a.kind === "treasury" ? -1 : 0))) if (!out.has(x.hedera)) out.set(x.hedera, x.name);
    return out;
  }

  /** A name anywhere in Ordo: what it names. */
  async lookup(name: string): Promise<{ siteId: string; kind: NameKind; ref: string; name: string; status: Status; address: string | null; hedera: string | null } | null> {
    const r = (await this.db.query<Row>(`SELECT ${COLS} FROM ens_names WHERE name = $1`, [name.trim().toLowerCase()])).rows[0];
    return r ? { siteId: r.site_id, kind: r.kind, ref: r.ref, name: r.name, status: r.status, address: r.address, hedera: r.hedera } : null;
  }

  /** A person's names across their orgs: their handle in each, and the role names they hold. */
  async ofUser(userId: string): Promise<{ siteId: string; kind: NameKind; name: string; status: Status; url: string }[]> {
    const r = await this.db.query<{ site_id: string; kind: NameKind; name: string; status: Status }>(
      "SELECT site_id, kind, name, status FROM ens_names WHERE ((kind = 'person' AND ref = $1) OR (kind = 'role' AND ref LIKE $2)) AND id NOT LIKE '%:was:%' ORDER BY depth, created_at",
      [userId, `%:${userId}`],
    );
    return r.rows.filter((x) => x.status !== "revoked").map((x) => ({ siteId: x.site_id, kind: x.kind, name: x.name, status: x.status, url: this.rail?.appUrl(x.name) ?? "" }));
  }

  /** How sending stands: names waiting, and whether gas limits paused it. */
  async state(siteId: string): Promise<{ issued: number; pending: number; failed: number; gas: GasState }> {
    const c = await this.db.query<{ status: string; n: string }>("SELECT status, count(*)::text AS n FROM ens_names WHERE site_id = $1 AND kind <> 'registrar' GROUP BY status", [siteId]);
    const n = (s: string) => Number(c.rows.find((x) => x.status === s)?.n ?? 0);
    return { issued: n("issued") + n("revoked"), pending: n("pending") + n("sent"), failed: n("failed"), gas: { ...this.gas } };
  }
  /** Across every org, for the status rail. */
  async totals(): Promise<{ issued: number; pending: number }> {
    const c = await this.db.query<{ status: string; n: string }>("SELECT status, count(*)::text AS n FROM ens_names WHERE kind <> 'registrar' GROUP BY status");
    const n = (s: string) => Number(c.rows.find((x) => x.status === s)?.n ?? 0);
    return { issued: n("issued"), pending: n("pending") + n("sent") };
  }

  /** Register an org's names now: plan anything missing on the next cycle, and send failed names again from the start. */
  async resync(siteId: string): Promise<{ retried: number }> {
    const r = await this.db.query<{ id: string }>("UPDATE ens_names SET status = 'pending', attempts = 0, next_try_at = $1, error = NULL, updated_at = now() WHERE site_id = $2 AND status = 'failed' RETURNING id", [this.iso(), siteId]);
    this.touch(siteId);
    return { retried: r.rows.length };
  }

  async retry(siteId: string, kind: string, ref: string) {
    await this.db.query("UPDATE ens_names SET status = 'pending', attempts = 0, next_try_at = $1, updated_at = now() WHERE site_id = $2 AND kind = $3 AND ref = $4 AND status = 'failed'", [this.iso(), siteId, kind, ref]);
  }
}

/**
 * Gas for an operation that cannot be measured before it is sent (its parent is in the same batch), generous on
 * purpose: too little and the operation fails inside the batch with no reason; unused gas costs nothing. Measured on
 * Sepolia (Nov 2026): a name that deploys its own registry needs about 1.8M; a person or role name about 0.3M, and
 * each record up to 0.4M more (a person's records cost far more than a collection's of the same size).
 */
function guide(op: NameOp): number {
  const records = op.records.length * 420_000;
  switch (op.kind) {
    case OP.issue:
      return (op.salt ? 2_400_000 : 450_000) + records;
    case OP.records:
      return 120_000 + records;
    case OP.revoke:
      return 200_000 + records;
    default:
      return 200_000;
  }
}

function stripRevoke(w: Want): Want {
  const { revoke: _r, ...rest } = w;
  return rest;
}

/** Do two wants differ only in these records? */
function sameExcept(a: Want, b: Want, keys: Set<string>): boolean {
  const strip = (w: Want) => ({ ...stripRevoke(w), texts: Object.fromEntries(Object.entries(w.texts).filter(([k]) => !keys.has(k))) });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

const COLS =
  "id, site_id, kind, ref, parent_id, depth, prio, ord, label, name, salt, registry, slot, member, address, hedera, want_json, have_json, sent_json, status, batch_id, tx_hash, error, attempts, quiet_until::text AS quiet_until";
