import { randomUUID } from "node:crypto";
import type { MachineAuthority, MachineRoles } from "../core/machine-roles.js";
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import {
  AGENT_INFO,
  DataSource,
  SignalLimit,
  type AgentKey,
  type AssetKind,
  type AssetView,
  type AutonomyLevel,
  type MachineRole,
  type Quality,
  type Role,
  type TelemetrySample,
} from "../domain/types.js";
import { deriveStatus, oee, partsProduced, utilization, type Point } from "./metrics.js";
import { parseCurrent, readCurrent } from "./mtconnect.js";

export const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const KEEP_SIGNALS = new Set(["execution", "part_count", "availability", "controller_mode", "emergency_stop", "spindle_speed", "load_pct", "temperature", "program", "feed_override", "vibration", "state", "good", "scrap"]);
const RETENTION_DAYS = 7;
/** A signal is stored when it is one Ordo computes from, has a limit on the asset, or a measured-signal criterion of an active stage reads it. */
const keep = (signal: string, limits: Record<string, SignalLimit>, wanted: Set<string> | undefined) => KEEP_SIGNALS.has(signal) || signal.startsWith("condition.") || Boolean(limits[signal]) || Boolean(wanted?.has(signal));

/** Aggregates of one signal over a window: what a stage's measured-signal criteria read. */
export interface SignalStats {
  last: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  n: number;
}

export interface AssetRow {
  id: string;
  siteId: string;
  zoneId: string | null;
  name: string;
  kind: AssetKind;
  description: string | null;
  owningAgent: AgentKey;
  source: DataSource;
  limits: Record<string, SignalLimit>;
  idealCycleS: number | null;
}
type Latest = Record<string, { value: number | null; text: string | null; ts: string; quality: Quality }>;

/** A machine with its own key (a gateway or a machine body) can sign. */
const hasKey = (s: { type: string; device?: string }) => s.type === "gateway" && /^0x[0-9a-fA-F]{40}$/.test(s.device ?? "");

export class PlantService {
  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {}

  // ---------------- Sites, lines, zones, team ----------------
  async createSite(input: { name: string; timezone: string; lineName: string; zones: string[] }, userId: string): Promise<string> {
    const siteId = newId("site");
    await this.db.tx(async (q) => {
      await q.query("INSERT INTO sites (id, name, timezone, created_by) VALUES ($1, $2, $3, $4)", [siteId, input.name, input.timezone, userId]);
      await q.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1, $2, 'manager', $2)", [siteId, userId]);
      await q.query("INSERT INTO lines (id, site_id, name, autonomy) VALUES ($1, $2, $3, 'L2')", [newId("line"), siteId, input.lineName]);
      let sort = 0;
      for (const z of input.zones.filter((x) => x.trim())) await q.query("INSERT INTO zones (id, site_id, name, sort) VALUES ($1, $2, $3, $4)", [newId("zone"), siteId, z.trim(), sort++]);
    });
    return siteId;
  }

  async site(siteId: string) {
    const s = (await this.db.query<{ id: string; name: string; timezone: string; public_pipelines: boolean; open_join: boolean }>("SELECT id, name, timezone, public_pipelines, open_join FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!s) throw new HttpError(404, "Site not found");
    const lines = (await this.db.query<{ id: string; name: string; autonomy: AutonomyLevel }>("SELECT id, name, autonomy FROM lines WHERE site_id = $1 ORDER BY created_at", [siteId])).rows;
    const zones = (await this.db.query<{ id: string; name: string; sort: number }>("SELECT id, name, sort FROM zones WHERE site_id = $1 ORDER BY sort, name", [siteId])).rows;
    const { public_pipelines, open_join, ...rest } = s;
    return { ...rest, publicPipelines: Boolean(public_pipelines), openJoin: Boolean(open_join), lines, zones };
  }

  async updateSite(siteId: string, patch: { name?: string; timezone?: string; publicPipelines?: boolean; openJoin?: boolean }) {
    if (patch.name) await this.db.query("UPDATE sites SET name = $1 WHERE id = $2", [patch.name, siteId]);
    if (patch.timezone) await this.db.query("UPDATE sites SET timezone = $1 WHERE id = $2", [patch.timezone, siteId]);
    if (patch.publicPipelines !== undefined) await this.db.query("UPDATE sites SET public_pipelines = $1 WHERE id = $2", [patch.publicPipelines, siteId]);
    if (patch.openJoin !== undefined) await this.db.query("UPDATE sites SET open_join = $1 WHERE id = $2", [patch.openJoin, siteId]);
  }

  /** Open joining: any signed-in wallet becomes a contributor of an org that is open. Joining twice changes nothing. */
  async join(siteId: string, userId: string): Promise<{ joined: boolean }> {
    const s = (await this.db.query<{ open_join: boolean }>("SELECT open_join FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!s) throw new HttpError(404, "No org with that code");
    const already = await this.db.query("SELECT 1 FROM memberships WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
    if (already.rows.length) return { joined: false };
    if (!s.open_join) throw new HttpError(403, "This org is closed to new members: ask a manager to add you");
    await this.db.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1, $2, 'contributor', $2) ON CONFLICT DO NOTHING", [siteId, userId]);
    return { joined: true };
  }

  /** Orgs a person can explore and join: open ones, and the ones they are already in. */
  async explore(userId: string | null) {
    const r = await this.db.query<{ id: string; name: string; timezone: string; open_join: boolean; created_at: string; members: string; lines: string; running: string; mine: boolean }>(
      `SELECT s.id, s.name, s.timezone, s.open_join, s.created_at::text,
         (SELECT COUNT(DISTINCT user_id)::text FROM memberships m WHERE m.site_id = s.id) AS members,
         (SELECT COUNT(*)::text FROM lines l WHERE l.site_id = s.id) AS lines,
         (SELECT COUNT(*)::text FROM runs r WHERE r.site_id = s.id AND r.status = 'running') AS running,
         EXISTS (SELECT 1 FROM memberships m WHERE m.site_id = s.id AND m.user_id = $1) AS mine
       FROM sites s WHERE s.open_join OR EXISTS (SELECT 1 FROM memberships m WHERE m.site_id = s.id AND m.user_id = $1)
       ORDER BY s.created_at DESC LIMIT 200`,
      [userId ?? ""],
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, timezone: x.timezone, open: Boolean(x.open_join), members: Number(x.members), lines: Number(x.lines), running: Number(x.running), member: Boolean(x.mine), createdAt: new Date(x.created_at).toISOString() }));
  }
  async addLine(siteId: string, name: string) {
    const id = newId("line");
    await this.db.query("INSERT INTO lines (id, site_id, name) VALUES ($1, $2, $3)", [id, siteId, name]);
    return id;
  }
  async setAutonomy(siteId: string, lineId: string, level: AutonomyLevel) {
    const r = await this.db.query("UPDATE lines SET autonomy = $1 WHERE id = $2 AND site_id = $3 RETURNING id", [level, lineId, siteId]);
    if (!r.rows.length) throw new HttpError(404, "Line not found");
  }
  async addZone(siteId: string, name: string) {
    const id = newId("zone");
    const n = await this.db.query<{ n: string }>("SELECT COUNT(*)::text n FROM zones WHERE site_id = $1", [siteId]);
    await this.db.query("INSERT INTO zones (id, site_id, name, sort) VALUES ($1, $2, $3, $4)", [id, siteId, name, Number(n.rows[0]!.n)]);
    return id;
  }
  async renameZone(siteId: string, zoneId: string, name: string) {
    await this.db.query("UPDATE zones SET name = $1 WHERE id = $2 AND site_id = $3", [name, zoneId, siteId]);
  }
  async deleteZone(siteId: string, zoneId: string) {
    await this.db.query("UPDATE assets SET zone_id = NULL WHERE zone_id = $1 AND site_id = $2", [zoneId, siteId]);
    await this.db.query("DELETE FROM zones WHERE id = $1 AND site_id = $2", [zoneId, siteId]);
  }

  async team(siteId: string) {
    const members = await this.db.query<{ user_id: string; address: string; display_name: string | null; role: string; state: string; last_seen_at: string | null }>(
      "SELECT m.user_id, u.address, u.display_name, m.role, m.state, u.last_seen_at::text FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 ORDER BY u.created_at, m.created_at",
      [siteId],
    );
    // roles held, and promotions waiting for their role name to land on ENS (they count once it has)
    const people = new Map<string, { userId: string; address: string; name: string | null; roles: string[]; pending: string[]; lastSeenAt: string | null }>();
    for (const m of members.rows) {
      const p = people.get(m.user_id) ?? { userId: m.user_id, address: m.address, name: m.display_name, roles: [], pending: [], lastSeenAt: m.last_seen_at };
      (m.state === "held" ? p.roles : p.pending).push(m.role);
      people.set(m.user_id, p);
    }
    const invites = await this.db.query<{ id: string; address: string; role: string; created_at: string }>(
      "SELECT id, address, role, created_at::text FROM invites WHERE site_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC",
      [siteId],
    );
    return { members: [...people.values()], invites: invites.rows.map((i) => ({ id: i.id, address: i.address, role: i.role, createdAt: i.created_at })) };
  }
  async invite(siteId: string, address: string, role: Role, by: string) {
    const addr = address.toLowerCase();
    const user = (await this.db.query<{ id: string }>("SELECT id FROM users WHERE address = $1", [addr])).rows[0];
    if (user) {
      await this.db.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [siteId, user.id, role, by]);
      return { added: true };
    }
    await this.db.query("INSERT INTO invites (id, site_id, address, role, created_by) VALUES ($1, $2, $3, $4, $5)", [newId("inv"), siteId, addr, role, by]);
    return { added: false };
  }
  async addRole(siteId: string, userId: string, role: Role, by: string) {
    const member = await this.db.query("SELECT 1 FROM memberships WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
    if (!member.rows.length) throw new HttpError(404, "Not a member of this org");
    await this.db.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [siteId, userId, role, by]);
  }
  /** Removing someone's last role takes them out of the org. */
  async removeMember(siteId: string, userId: string) {
    const roles = (await this.db.query<{ role: string }>("SELECT role FROM memberships WHERE site_id = $1 AND user_id = $2", [siteId, userId])).rows.map((r) => r.role);
    if (roles.includes("manager")) await this.removeRole(siteId, userId, "manager");
    await this.db.query("DELETE FROM memberships WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
    await this.db.query("DELETE FROM member_access WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
  }
  async removeRole(siteId: string, userId: string, role: Role) {
    if (role === "manager") {
      const managers = await this.db.query<{ n: string }>("SELECT COUNT(*)::text n FROM memberships WHERE site_id = $1 AND role = 'manager' AND state = 'held' AND user_id <> $2", [siteId, userId]);
      if (Number(managers.rows[0]!.n) < 1) throw new HttpError(409, "An org needs at least one manager");
    }
    await this.db.query("DELETE FROM memberships WHERE site_id = $1 AND user_id = $2 AND role = $3", [siteId, userId, role]);
  }
  async cancelInvite(siteId: string, id: string) {
    await this.db.query("DELETE FROM invites WHERE id = $1 AND site_id = $2", [id, siteId]);
  }

  // ---------------- Assets ----------------
  /** Machine roles (Runner, Attester, Buyer): a new machine gets Runner for its kind, and Attester when it has its own key */
  machineRoles: MachineRoles | null = null;

  async createAsset(siteId: string, input: Omit<AssetRow, "id" | "siteId">, by: string): Promise<string> {
    const id = newId("ast");
    const source = DataSource.parse(input.source);
    await this.db.tx(async (q) => {
      await q.query(
        "INSERT INTO assets (id, site_id, zone_id, name, kind, description, owning_agent, source_json, limits_json, ideal_cycle_s, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [id, siteId, input.zoneId, input.name, input.kind, input.description, input.owningAgent, JSON.stringify(source), JSON.stringify(input.limits), input.idealCycleS, by],
      );
      await this.machineRoles?.seedMachine(q, siteId, id, input.kind, hasKey(source), by);
    });
    return id;
  }
  async updateAsset(siteId: string, id: string, input: Omit<AssetRow, "id" | "siteId">) {
    const source = DataSource.parse(input.source);
    await this.db.tx(async (q) => {
      const before = (await q.query<{ kind: AssetKind; source_json: string }>("SELECT kind, source_json FROM assets WHERE id = $1 AND site_id = $2", [id, siteId])).rows[0];
      const r = await q.query(
        "UPDATE assets SET zone_id=$1, name=$2, kind=$3, description=$4, owning_agent=$5, source_json=$6, limits_json=$7, ideal_cycle_s=$8 WHERE id=$9 AND site_id=$10 RETURNING id",
        [input.zoneId, input.name, input.kind, input.description, input.owningAgent, JSON.stringify(source), JSON.stringify(input.limits), input.idealCycleS, id, siteId],
      );
      if (!r.rows.length || !before) throw new HttpError(404, "Asset not found");
      await this.machineRoles?.machineChanged(q, id, { kind: before.kind, gateway: hasKey(JSON.parse(before.source_json)) }, { kind: input.kind, gateway: hasKey(source) });
    });
    await this.db.query("DELETE FROM source_state WHERE asset_id = $1", [id]);
  }
  async archiveAsset(siteId: string, id: string) {
    await this.db.query("UPDATE assets SET archived_at = now() WHERE id = $1 AND site_id = $2", [id, siteId]);
  }

  async assets(siteId?: string): Promise<AssetRow[]> {
    const r = await this.db.query<{ id: string; site_id: string; zone_id: string | null; name: string; kind: string; description: string | null; owning_agent: string; source_json: string; limits_json: string; ideal_cycle_s: number | null }>(
      `SELECT * FROM assets WHERE archived_at IS NULL ${siteId ? "AND site_id = $1" : ""} ORDER BY created_at`,
      siteId ? [siteId] : [],
    );
    return r.rows.map((a) => ({
      id: a.id,
      siteId: a.site_id,
      zoneId: a.zone_id,
      name: a.name,
      kind: a.kind as AssetKind,
      description: a.description,
      owningAgent: a.owning_agent as AgentKey,
      source: JSON.parse(a.source_json) as DataSource,
      limits: JSON.parse(a.limits_json) as Record<string, SignalLimit>,
      idealCycleS: a.ideal_cycle_s === null ? null : Number(a.ideal_cycle_s),
    }));
  }
  async asset(siteId: string, id: string): Promise<AssetRow> {
    const a = (await this.assets(siteId)).find((x) => x.id === id);
    if (!a) throw new HttpError(404, "Asset not found");
    return a;
  }

  // ---------------- Telemetry ----------------
  private async store(assetId: string, rows: { signal: string; ts: string; value: number | null; text: string | null; quality: Quality }[]) {
    if (!rows.length) return 0;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params: unknown[] = [];
      const values = chunk.map((r, j) => {
        params.push(assetId, r.signal, r.ts, r.value, r.text, r.quality);
        const b = j * 6;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
      });
      const res = await this.db.query(`INSERT INTO telemetry (asset_id, signal, ts, value, text_value, quality) VALUES ${values.join(",")} ON CONFLICT DO NOTHING RETURNING asset_id`, params);
      inserted += res.rows.length;
    }
    return inserted;
  }

  private async state(assetId: string): Promise<{ cursor: string | null; lastPollAt: number | null; lastOkAt: number | null; lastError: string | null; latest: Latest }> {
    const r = (await this.db.query<{ cursor: string | null; last_poll_at: string | null; last_ok_at: string | null; last_error: string | null; latest_json: string }>(
      "SELECT cursor, last_poll_at::text, last_ok_at::text, last_error, latest_json FROM source_state WHERE asset_id = $1",
      [assetId],
    )).rows[0];
    return r
      ? { cursor: r.cursor, lastPollAt: r.last_poll_at ? Date.parse(r.last_poll_at) : null, lastOkAt: r.last_ok_at ? Date.parse(r.last_ok_at) : null, lastError: r.last_error, latest: JSON.parse(r.latest_json) }
      : { cursor: null, lastPollAt: null, lastOkAt: null, lastError: null, latest: {} };
  }
  private async saveState(assetId: string, s: { cursor?: string | null; polled?: boolean; ok?: boolean; error?: string | null; latest?: Latest }) {
    const cur = await this.state(assetId);
    const latest = { ...cur.latest, ...(s.latest ?? {}) };
    const nowIso = new Date(this.now()).toISOString();
    await this.db.query(
      `INSERT INTO source_state (asset_id, cursor, last_poll_at, last_ok_at, last_error, latest_json) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (asset_id) DO UPDATE SET cursor = EXCLUDED.cursor, last_poll_at = EXCLUDED.last_poll_at, last_ok_at = EXCLUDED.last_ok_at, last_error = EXCLUDED.last_error, latest_json = EXCLUDED.latest_json`,
      [
        assetId,
        s.cursor === undefined ? cur.cursor : s.cursor,
        s.polled ? nowIso : cur.lastPollAt ? new Date(cur.lastPollAt).toISOString() : null,
        s.ok ? nowIso : cur.lastOkAt ? new Date(cur.lastOkAt).toISOString() : null,
        s.error === undefined ? cur.lastError : s.error,
        JSON.stringify(latest),
      ],
    );
  }
  private toLatest(rows: { signal: string; ts: string; value: number | null; text: string | null; quality: Quality }[]): Latest {
    const out: Latest = {};
    for (const r of rows) if (!out[r.signal] || out[r.signal]!.ts <= r.ts) out[r.signal] = { value: r.value, text: r.text, ts: r.ts, quality: r.quality };
    return out;
  }

  /** A person records a reading or a count (manual data source, or a correction on any asset). */
  async manualReading(siteId: string, assetId: string, r: { signal: string; value: number | null; text: string | null }) {
    await this.asset(siteId, assetId);
    const row = { signal: r.signal.trim().toLowerCase().replace(/\s+/g, "_"), ts: new Date(this.now()).toISOString(), value: r.value, text: r.text, quality: "good" as Quality };
    await this.store(assetId, [row]);
    await this.saveState(assetId, { ok: true, latest: this.toLatest([row]) });
  }

  /** Observations a machine's gateway pushed (its request is signed with the gateway's key; Readings checks that). */
  async gatewayObservations(assetId: string, rows: { signal: string; ts: string; value: number | null; text: string | null }[]) {
    const now = this.now();
    const limits = (await this.assets()).find((a) => a.id === assetId)?.limits ?? {};
    const wanted = (await this.wantedSignals(assetId)).get(assetId);
    const clean = rows
      .map((r) => ({ signal: r.signal.trim().toLowerCase().replace(/\s+/g, "_"), ts: new Date(r.ts).toISOString(), value: r.value, text: r.text, quality: "good" as Quality }))
      .filter((r) => keep(r.signal, limits, wanted) && Math.abs(Date.parse(r.ts) - now) < 86_400_000);
    const inserted = await this.store(assetId, clean);
    await this.saveState(assetId, { polled: true, ok: true, error: null, latest: this.toLatest(clean) });
    return inserted;
  }

  /** A value the machine read from one of its outcome media, as signal `outcome.<key>`: kept whatever the filters. */
  async outcomeObservation(assetId: string, signal: string, ts: string, value: number) {
    return this.store(assetId, [{ signal, ts: new Date(ts).toISOString(), value, text: null, quality: "good" }]);
  }

  async samples(assetId: string, minutes: number): Promise<TelemetrySample[]> {
    const since = new Date(this.now() - minutes * 60_000).toISOString();
    const r = await this.db.query<{ signal: string; ts: string; value: number | null; quality: Quality }>(
      "SELECT signal, ts::text, value, quality FROM telemetry WHERE asset_id = $1 AND ts >= $2 AND value IS NOT NULL ORDER BY ts",
      [assetId, since],
    );
    return r.rows.map((x) => ({ assetId, signal: x.signal, value: Number(x.value), unit: "", minute: Date.parse(x.ts) / 60_000, quality: x.quality }));
  }

  async series(assetId: string, signal: string, minutes: number): Promise<Point[]> {
    const since = new Date(this.now() - minutes * 60_000).toISOString();
    // include the last point before the window so step functions know their starting state
    const r = await this.db.query<{ ts: string; value: number | null; text_value: string | null; quality: Quality }>(
      `(SELECT ts::text, value, text_value, quality FROM telemetry WHERE asset_id = $1 AND signal = $2 AND ts < $3 ORDER BY ts DESC LIMIT 1)
       UNION ALL (SELECT ts::text, value, text_value, quality FROM telemetry WHERE asset_id = $1 AND signal = $2 AND ts >= $3 ORDER BY ts LIMIT 5000)`,
      [assetId, signal, since],
    );
    return r.rows.map((x) => ({ ts: Date.parse(x.ts), value: x.value === null ? null : Number(x.value), text: x.text_value, quality: x.quality })).sort((a, b) => a.ts - b.ts);
  }

  /** Numeric good-quality points of one signal inside a window, oldest first. */
  async seriesBetween(assetId: string, signal: string, fromMs: number, toMs: number): Promise<{ ts: number; value: number }[]> {
    const r = await this.db.query<{ ts: string; value: number }>(
      "SELECT ts::text, value FROM telemetry WHERE asset_id = $1 AND signal = $2 AND ts >= $3 AND ts <= $4 AND value IS NOT NULL AND quality = 'good' ORDER BY ts LIMIT 5000",
      [assetId, signal, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
    );
    return r.rows.map((x) => ({ ts: Date.parse(x.ts), value: Number(x.value) }));
  }

  /** Aggregates of named signals on one asset over a window: what a stage's measured-signal criteria are judged on. */
  async windowStats(assetId: string, signals: string[], fromMs: number, toMs: number): Promise<Record<string, SignalStats>> {
    const out: Record<string, SignalStats> = {};
    if (!signals.length) return out;
    const params = [assetId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), ...signals];
    const list = signals.map((_, i) => `$${i + 4}`).join(",");
    const where = `asset_id = $1 AND ts >= $2 AND ts <= $3 AND value IS NOT NULL AND quality = 'good' AND signal IN (${list})`;
    const agg = await this.db.query<{ signal: string; n: string; min: number; max: number; mean: number }>(`SELECT signal, COUNT(*)::text n, MIN(value) min, MAX(value) max, AVG(value) mean FROM telemetry WHERE ${where} GROUP BY signal`, params);
    const last = await this.db.query<{ signal: string; value: number }>(`SELECT DISTINCT ON (signal) signal, value FROM telemetry WHERE ${where} ORDER BY signal, ts DESC`, params);
    for (const r of agg.rows) out[r.signal] = { last: null, min: Number(r.min), max: Number(r.max), mean: Number(r.mean), n: Number(r.n) };
    for (const r of last.rows) if (out[r.signal]) out[r.signal]!.last = Number(r.value);
    return out;
  }

  /** The signals measured-signal criteria of active stages read, per asset: ingest keeps them even when they are not on the allow-list. */
  async wantedSignals(assetId?: string): Promise<Map<string, Set<string>>> {
    const r = await this.db.query<{ asset_id: string; code: string; spec_json: string }>(
      `SELECT sr.asset_id, sr.code, tv.spec_json FROM stage_runs sr JOIN runs r ON r.id = sr.run_id JOIN template_versions tv ON tv.id = r.template_version_id
       WHERE r.status = 'running' AND sr.state IN ('running','awaiting_approval','held') AND sr.asset_id IS NOT NULL ${assetId ? "AND sr.asset_id = $1" : ""}`,
      assetId ? [assetId] : [],
    );
    const out = new Map<string, Set<string>>();
    for (const row of r.rows) {
      const spec = JSON.parse(row.spec_json) as { stages: { code: string; criteria?: { kind?: string; signal?: string }[] }[] };
      for (const c of spec.stages.find((st) => st.code === row.code)?.criteria ?? []) {
        if (c.kind !== "signal" || !c.signal) continue;
        if (!out.has(row.asset_id)) out.set(row.asset_id, new Set());
        out.get(row.asset_id)!.add(c.signal);
      }
    }
    return out;
  }

  // ---------------- CSV replay of a real dataset ----------------
  /**
   * Accepts long format (time,signal,value) or wide format (time,<signal1>,<signal2>…). Time is seconds
   * from start, or an ISO / epoch timestamp. The series is replayed later at a chosen speed.
   */
  async uploadReplay(siteId: string, assetId: string, name: string, csv: string, by: string): Promise<{ id: string; rows: number; signals: string[]; durationMs: number }> {
    await this.asset(siteId, assetId);
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (lines.length < 2) throw new HttpError(400, "CSV needs a header and at least one row");
    const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
    const long = header.includes("signal") && header.includes("value");
    const tIdx = header.findIndex((h) => ["t", "time", "timestamp", "ts", "seconds"].includes(h));
    if (tIdx < 0) throw new HttpError(400, "CSV needs a time column named t, time, timestamp, ts or seconds");
    const parseT = (v: string): number => {
      const n = Number(v);
      if (Number.isFinite(n)) return n > 1e11 ? n : n > 1e9 ? n * 1000 : n * 1000; // epoch ms, epoch s, or seconds offset
      const d = Date.parse(v);
      if (Number.isNaN(d)) throw new HttpError(400, `Unreadable time value "${v}"`);
      return d;
    };
    const pts: { t: number; signal: string; value: number | null; text: string | null }[] = [];
    for (const line of lines.slice(1)) {
      const cells = line.split(",").map((c) => c.trim());
      const t = parseT(cells[tIdx]!);
      if (long) {
        const sv = cells[header.indexOf("value")] ?? "";
        const n = Number(sv);
        pts.push({ t, signal: cells[header.indexOf("signal")]!.toLowerCase(), value: Number.isFinite(n) && sv !== "" ? n : null, text: Number.isFinite(n) ? null : sv });
      } else
        header.forEach((h, i) => {
          if (i === tIdx || cells[i] === undefined || cells[i] === "") return;
          const n = Number(cells[i]);
          pts.push({ t, signal: h, value: Number.isFinite(n) ? n : null, text: Number.isFinite(n) ? null : cells[i]! });
        });
      if (pts.length > 200_000) throw new HttpError(400, "CSV too large (max 200k points)");
    }
    if (!pts.length) throw new HttpError(400, "No data rows found");
    const t0 = Math.min(...pts.map((p) => p.t));
    const durationMs = Math.max(...pts.map((p) => p.t)) - t0;
    const id = newId("rpl");
    await this.db.tx(async (q) => {
      await q.query("INSERT INTO replay_series (id, asset_id, name, rows, duration_ms, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)", [id, assetId, name, pts.length, durationMs, by]);
      for (let i = 0; i < pts.length; i += 500) {
        const chunk = pts.slice(i, i + 500);
        const params: unknown[] = [];
        const vals = chunk.map((p, j) => {
          params.push(id, p.t - t0, p.signal, p.value, p.text);
          const b = j * 5;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
        });
        await q.query(`INSERT INTO replay_points (series_id, t_ms, signal, value, text_value) VALUES ${vals.join(",")}`, params);
      }
    });
    return { id, rows: pts.length, signals: [...new Set(pts.map((p) => p.signal))], durationMs };
  }

  async replays(siteId: string, assetId: string) {
    await this.asset(siteId, assetId);
    const r = await this.db.query<{ id: string; name: string; rows: number; duration_ms: string; speed: number; started_at: string | null; created_at: string }>(
      "SELECT id, name, rows, duration_ms::text, speed, started_at::text, created_at::text FROM replay_series WHERE asset_id = $1 ORDER BY created_at DESC",
      [assetId],
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, rows: Number(x.rows), durationMs: Number(x.duration_ms), speed: Number(x.speed), startedAt: x.started_at, createdAt: x.created_at }));
  }

  async startReplay(siteId: string, assetId: string, seriesId: string, speed: number) {
    const a = await this.asset(siteId, assetId);
    await this.db.query("UPDATE replay_series SET started_at = $1, speed = $2 WHERE id = $3 AND asset_id = $4", [new Date(this.now()).toISOString(), speed, seriesId, assetId]);
    await this.updateAsset(siteId, assetId, { ...a, source: { type: "replay", seriesId } });
    await this.saveState(assetId, { cursor: "-1", error: null });
  }

  // ---------------- Ingestion (request-driven, lease-guarded) ----------------
  async tryLease(name: string, ms: number): Promise<boolean> {
    const now = this.now();
    const r = await this.db.query(
      `INSERT INTO engine_lease (name, lease_until) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET lease_until = EXCLUDED.lease_until
       WHERE engine_lease.lease_until < $3 RETURNING name`,
      [name, now + ms, now],
    );
    return r.rows.length > 0;
  }
  async releaseLease(name: string) {
    await this.db.query("UPDATE engine_lease SET lease_until = 0 WHERE name = $1", [name]);
  }

  /** Pull new data from every source that is due. Safe to call from every request. */
  async ingest(): Promise<{ polled: number; inserted: number; errors: number }> {
    if (!(await this.tryLease("ingest", 25_000))) return { polled: 0, inserted: 0, errors: 0 };
    let polled = 0;
    let inserted = 0;
    let errors = 0;
    try {
      const assets = await this.assets();
      const now = this.now();
      const wanted = await this.wantedSignals();
      // MTConnect: one /current per agent URL, shared by its devices
      const due = new Map<string, AssetRow[]>();
      for (const a of assets) {
        if (a.source.type !== "mtconnect") continue;
        const st = await this.state(a.id);
        if (st.lastPollAt && now - st.lastPollAt < a.source.pollSeconds * 1000) continue;
        due.set(a.source.agentUrl, [...(due.get(a.source.agentUrl) ?? []), a]);
      }
      for (const [url, group] of due) {
        polled += 1;
        let doc: Record<string, unknown> | null = null;
        let err: string | null = null;
        try {
          doc = await readCurrent(url);
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        for (const a of group) {
          if (!doc) {
            errors += 1;
            await this.saveState(a.id, { polled: true, error: err });
            continue;
          }
          try {
            const device = (a.source as { device: string }).device;
            const obs = parseCurrent(doc, device).filter((o) => keep(o.signal, a.limits, wanted.get(a.id)));
            inserted += await this.store(a.id, obs.map((o) => ({ signal: o.signal, ts: o.ts, value: o.value, text: o.text, quality: o.quality })));
            await this.saveState(a.id, { polled: true, ok: true, error: null, latest: this.toLatest(obs.map((o) => ({ ...o, text: o.text }))) });
          } catch (e) {
            errors += 1;
            await this.saveState(a.id, { polled: true, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      // CSV replays
      for (const a of assets) {
        if (a.source.type !== "replay" || !a.source.seriesId) continue;
        const s = (await this.db.query<{ started_at: string | null; speed: number }>("SELECT started_at::text, speed FROM replay_series WHERE id = $1", [a.source.seriesId])).rows[0];
        if (!s?.started_at) continue;
        const st = await this.state(a.id);
        const start = Date.parse(s.started_at);
        const speed = Number(s.speed) || 1;
        const upTo = (now - start) * speed;
        const from = Number(st.cursor ?? -1);
        const pts = await this.db.query<{ t_ms: string; signal: string; value: number | null; text_value: string | null }>(
          "SELECT t_ms::text, signal, value, text_value FROM replay_points WHERE series_id = $1 AND t_ms > $2 AND t_ms <= $3 ORDER BY t_ms LIMIT 5000",
          [a.source.seriesId, from, upTo],
        );
        if (!pts.rows.length) continue;
        polled += 1;
        const rows = pts.rows.map((p) => ({ signal: p.signal, ts: new Date(start + Number(p.t_ms) / speed).toISOString(), value: p.value === null ? null : Number(p.value), text: p.text_value, quality: "good" as Quality }));
        inserted += await this.store(a.id, rows);
        await this.saveState(a.id, { cursor: pts.rows.at(-1)!.t_ms, polled: true, ok: true, error: null, latest: this.toLatest(rows) });
      }
      if (Math.random() < 0.02) await this.db.query(`DELETE FROM telemetry WHERE ts < now() - interval '${RETENTION_DAYS} days'`);
    } finally {
      await this.releaseLease("ingest");
    }
    return { polled, inserted, errors };
  }

  // ---------------- Views ----------------
  async views(siteId: string): Promise<AssetView[]> {
    const [assets, zones] = await Promise.all([this.assets(siteId), this.db.query<{ id: string; name: string }>("SELECT id, name FROM zones WHERE site_id = $1", [siteId])]);
    const zoneName = new Map(zones.rows.map((z) => [z.id, z.name]));
    const now = this.now();
    const hour = 60 * 60_000;
    const openIncidents = await this.db.query<{ asset_id: string; severity: "warn" | "alarm" }>("SELECT asset_id, severity FROM incidents WHERE site_id = $1 AND status <> 'closed'", [siteId]);
    const sev = new Map(openIncidents.rows.map((r) => [r.asset_id, r.severity]));
    const active = await this.db.query<{ asset_id: string; run_id: string; code: string; name: string | null }>(
      "SELECT sr.asset_id, sr.run_id, sr.code, sr.data_json::json->>'name' AS name FROM stage_runs sr JOIN runs r ON r.id = sr.run_id WHERE r.site_id = $1 AND sr.state IN ('running','awaiting_approval','held') AND sr.asset_id IS NOT NULL",
      [siteId],
    );
    const job = new Map(active.rows.map((r) => [r.asset_id, `${r.run_id} · ${r.code}${r.name ? ` ${r.name}` : ""}`]));
    const quality = await this.db.query<{ asset_id: string; good: string; scrap: string }>(
      "SELECT sr.asset_id, SUM(units_good)::text good, SUM(units_scrap)::text scrap FROM stage_runs sr JOIN runs r ON r.id = sr.run_id WHERE r.site_id = $1 AND sr.ended_at > now() - interval '24 hours' AND sr.asset_id IS NOT NULL GROUP BY sr.asset_id",
      [siteId],
    );
    const q = new Map(quality.rows.map((r) => [r.asset_id, { good: Number(r.good), scrap: Number(r.scrap) }]));
    const authority = this.machineRoles ? await this.machineRoles.of(siteId) : null;

    const out: AssetView[] = [];
    for (const a of assets) {
      const st = await this.state(a.id);
      const lastDataAt = Object.values(st.latest).reduce<number | null>((m, v) => Math.max(m ?? 0, Date.parse(v.ts)), null);
      // MTConnect timestamps a value only when it changes: freshness is the last successful poll.
      const fresh = a.source.type === "mtconnect" ? st.lastOkAt : (lastDataAt ?? st.lastOkAt);
      const { status, detail } = deriveStatus({ kind: a.kind, source: a.source, latest: st.latest, lastDataAt: fresh, now, openIncidentSeverity: sev.get(a.id) ?? null, sourceError: st.lastError });
      let util: number | null = null;
      let parts: number | null = null;
      if (st.latest.execution) util = utilization(await this.series(a.id, "execution", 60), now - hour, now);
      if (st.latest.part_count) parts = partsProduced(await this.series(a.id, "part_count", 60), now - hour, now);
      const qa = q.get(a.id);
      out.push({
        id: a.id,
        name: a.name,
        kind: a.kind,
        zoneId: a.zoneId,
        zoneName: a.zoneId ? zoneName.get(a.zoneId) ?? null : null,
        owningAgent: a.owningAgent,
        source: a.source,
        status,
        statusDetail: detail,
        latest: st.latest,
        utilization: util,
        oee: oee({ availability: util, parts, idealCycleS: a.idealCycleS, activeSeconds: util === null ? null : util * 3600, good: qa?.good ?? null, scrap: qa?.scrap ?? null }),
        currentJob: job.get(a.id) ?? st.latest.program?.text ?? null,
        lastDataAt: lastDataAt ? new Date(lastDataAt).toISOString() : null,
        sourceError: st.lastError,
        limits: a.limits,
        idealCycleS: a.idealCycleS,
        ...(authority ? rolesOf(authority.get(a.id)) : {}),
      });
    }
    return out;
  }
}

/** The roles a machine holds now, for its view. */
function rolesOf(a: MachineAuthority | undefined): Pick<AssetView, "roles" | "runnerKinds"> {
  if (!a) return { roles: [], runnerKinds: null };
  const roles: MachineRole[] = [];
  if (a.runner) roles.push("runner");
  if (a.attester) roles.push("attester");
  if (a.buyer) roles.push("buyer");
  return { roles, runnerKinds: a.runner };
}

export const agentLabel = (k: AgentKey) => AGENT_INFO[k].label;
export { SignalLimit };
