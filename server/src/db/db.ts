import { mkdirSync } from "node:fs";
import { MIGRATIONS } from "./migrations.js";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}

/** Postgres when DATABASE_URL is set; otherwise embedded Postgres (PGlite) on disk or in memory. */
export async function openDb(opts: { url?: string; dataDir?: string }): Promise<Db> {
  if (opts.url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: opts.url, max: 5 });
    return {
      kind: "postgres",
      query: async (sql, params) => pool.query(sql, params as unknown[]) as never,
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn({ query: async (s, p) => client.query(s, p as unknown[]) as never });
          await client.query("COMMIT");
          return out;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = opts.dataDir && opts.dataDir !== "memory" ? `${opts.dataDir}/pg` : undefined;
  if (dir) mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: "pglite",
    query: async (sql, params) => db.query(sql, params as unknown[]) as never,
    tx: async (fn) => db.transaction(async (t) => fn({ query: async (s, p) => t.query(s, p as unknown[]) as never })),
    close: () => db.close(),
  };
}

const MIGRATION_LOCK = 4241;

/** Apply pending migrations in order. Databases created by the v1 demo are detected and upgraded. */
export async function migrate(db: Db): Promise<number> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => Number(r.version)));
  if (done.size === 0) {
    // A v1 database (pre-migrations) already has the ledger table: mark v1 as applied.
    const v1 = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM information_schema.tables WHERE table_name = 'ledger'");
    if (Number(v1.rows[0]?.n ?? 0) > 0) {
      await db.query("INSERT INTO schema_migrations (version, name) VALUES (1, 'demo schema (pre-existing)')");
      done.add(1);
    }
  }
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const ran = await db.tx(async (q) => {
      // two cold starts can migrate at once: the second waits here, then skips what the first applied
      if (db.kind === "postgres") await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      if ((await q.query("SELECT 1 FROM schema_migrations WHERE version = $1", [m.version])).rows.length) return false;
      const sql = m.sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
      return true;
    });
    if (ran) applied += 1;
  }
  return applied;
}
