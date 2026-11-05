import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../../src/db/db.js";
import { MIGRATIONS } from "../../src/db/migrations.js";

describe("migrations", () => {
  it("creates the v2 schema on an empty database and is idempotent", async () => {
    const db = await openDb({ dataDir: "memory" });
    expect(await migrate(db)).toBe(MIGRATIONS.length);
    expect(await migrate(db)).toBe(0);
    const t = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const names = t.rows.map((r) => r.table_name);
    for (const n of ["users", "sessions", "sites", "memberships", "assets", "telemetry", "templates", "runs", "stage_runs", "inbox_items", "validation_packages", "signatures", "ledger", "package_signatures", "blobs"]) expect(names).toContain(n);
    await db.close();
  });

  it("upgrades a v1 demo database and archives its ledger", async () => {
    const db = await openDb({ dataDir: "memory" });
    await db.query("CREATE TABLE ledger (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, incident_id TEXT, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL UNIQUE)");
    await db.query("CREATE TABLE anchors (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, to_seq INTEGER NOT NULL, entry_hash TEXT NOT NULL, ref TEXT NOT NULL, url TEXT, data_json TEXT NOT NULL, ts TEXT NOT NULL)");
    await db.query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await db.query("INSERT INTO ledger VALUES (1,'t','a','sim.reset',null,'{}','h','p','e')");
    expect(await migrate(db)).toBe(MIGRATIONS.length - 1);
    expect((await db.query<{ n: string }>("SELECT COUNT(*)::text n FROM ledger_v1_demo")).rows[0]!.n).toBe("1");
    expect((await db.query<{ n: string }>("SELECT COUNT(*)::text n FROM ledger")).rows[0]!.n).toBe("0");
    await db.close();
  });

  it("maps the old roles onto the four roles, keeps approved validators, and opens orgs to joining", async () => {
    const db = await openDb({ dataDir: "memory" });
    // the schema just before the four-role model
    await db.query("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.version < 24)) {
      for (const stmt of m.sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean)) await db.query(stmt);
      await db.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
    }
    const old: [string, string[]][] = [["usr_admin", ["admin", "plant_manager"]], ["usr_op", ["operator"]], ["usr_qe", ["quality_engineer"]], ["usr_lead", ["maintenance_lead", "operator"]], ["usr_v", ["operator"]]];
    for (const [id] of old) await db.query("INSERT INTO users (id, address) VALUES ($1, $2)", [id, `0x${id}`]);
    await db.query("INSERT INTO sites (id, name, timezone, created_by) VALUES ('site_1', 'Plant', 'UTC', 'usr_admin')");
    for (const [id, roles] of old) for (const r of roles) await db.query("INSERT INTO memberships (site_id, user_id, role) VALUES ('site_1', $1, $2)", [id, r]);
    await db.query("INSERT INTO validators (site_id, user_id, scope, status) VALUES ('site_1', 'usr_v', 'quality', 'approved'), ('site_1', 'usr_op', 'quality', 'removed')");
    await db.query("INSERT INTO invites (id, site_id, address, role) VALUES ('inv_1', 'site_1', '0xa', 'supervisor'), ('inv_2', 'site_1', '0xb', 'operator')");

    expect(await migrate(db)).toBe(MIGRATIONS.filter((x) => x.version >= 24).length);
    const rows = (await db.query<{ user_id: string; role: string }>("SELECT user_id, role FROM memberships WHERE site_id = 'site_1' ORDER BY user_id, role")).rows;
    const by = Object.fromEntries(old.map(([id]) => [id, rows.filter((r) => r.user_id === id).map((r) => r.role)]));
    expect(by).toEqual({
      usr_admin: ["manager"], // two old manager roles are one manager now
      usr_op: ["contributor"], // a removed validator stays out
      usr_qe: ["validator"],
      usr_lead: ["contributor", "manager"],
      usr_v: ["contributor", "validator"],
    });
    expect((await db.query<{ role: string }>("SELECT role FROM invites ORDER BY id")).rows.map((r) => r.role)).toEqual(["manager", "contributor"]);
    expect((await db.query<{ open_join: boolean }>("SELECT open_join FROM sites WHERE id = 'site_1'")).rows[0]!.open_join).toBe(true);
    await db.close();
  });
});
