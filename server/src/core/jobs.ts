import type { Db } from "../db/db.js";
import { chainErrorMessage } from "../chain/errors.js";
import { newId } from "../plant/plant.js";

export type JobStatus = "pending" | "done" | "failed";

export interface JobView {
  id: string;
  kind: string;
  ref: string;
  status: JobStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

interface Row {
  id: string;
  site_id: string | null;
  kind: string;
  ref: string;
  payload_json: string;
  status: JobStatus;
  result_json: string | null;
  error: string | null;
  attempts: number;
  updated_at: string;
}

type Handler = (payload: any, job: { id: string; siteId: string | null; ref: string }) => Promise<Record<string, unknown>>;

const MAX_ATTEMPTS = 6;
const view = (r: Row): JobView => ({
  id: r.id,
  kind: r.kind,
  ref: r.ref,
  status: r.status,
  result: r.result_json ? JSON.parse(r.result_json) : null,
  error: r.error,
  attempts: Number(r.attempts),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/**
 * Work on other networks (ENS registrations, 0G uploads, iNFT mints) that must not hold up a request. Jobs run in
 * the engine cycle, a few at a time, retried with back-off (1, 2, 4… minutes) until they succeed or give up.
 */
export class Jobs {
  private handlers = new Map<string, Handler>();
  constructor(
    private db: Db,
    private now: () => number,
  ) {}

  register(kind: string, handler: Handler) {
    this.handlers.set(kind, handler);
  }
  has(kind: string) {
    return this.handlers.has(kind);
  }

  /** Queue a job unless one for the same kind and ref is pending or done. */
  async enqueue(siteId: string | null, kind: string, ref: string, payload: unknown): Promise<string> {
    const existing = await this.db.query<{ id: string }>("SELECT id FROM chain_jobs WHERE kind = $1 AND ref = $2 AND status <> 'failed' ORDER BY created_at DESC LIMIT 1", [kind, ref]);
    if (existing.rows[0]) return existing.rows[0].id;
    const id = newId("job");
    await this.db.query("INSERT INTO chain_jobs (id, site_id, kind, ref, payload_json, status, next_try_at) VALUES ($1,$2,$3,$4,$5,'pending',$6)", [
      id,
      siteId,
      kind,
      ref,
      JSON.stringify(payload),
      new Date(this.now()).toISOString(),
    ]);
    return id;
  }

  /** Run due jobs whose handler is registered. */
  async run(limit = 3): Promise<number> {
    const kinds = [...this.handlers.keys()];
    if (!kinds.length) return 0;
    const due = await this.db.query<Row>(
      `SELECT id, site_id, kind, ref, payload_json, status, result_json, error, attempts, updated_at::text AS updated_at FROM chain_jobs
       WHERE status = 'pending' AND kind = ANY($1) AND next_try_at <= $2 ORDER BY next_try_at LIMIT ${limit}`,
      [kinds, new Date(this.now()).toISOString()],
    );
    for (const j of due.rows) {
      try {
        const result = await this.handlers.get(j.kind)!(JSON.parse(j.payload_json), { id: j.id, siteId: j.site_id, ref: j.ref });
        await this.db.query("UPDATE chain_jobs SET status = 'done', result_json = $1, error = NULL, attempts = attempts + 1, updated_at = now() WHERE id = $2", [JSON.stringify(result), j.id]);
      } catch (e) {
        const attempts = Number(j.attempts) + 1;
        const giveUp = attempts >= MAX_ATTEMPTS;
        await this.db.query("UPDATE chain_jobs SET status = $1, error = $2, attempts = $3, next_try_at = $4, updated_at = now() WHERE id = $5", [
          giveUp ? "failed" : "pending",
          chainErrorMessage(e),
          attempts,
          new Date(this.now() + 60_000 * 2 ** (attempts - 1)).toISOString(),
          j.id,
        ]);
      }
    }
    return due.rows.length;
  }

  /** The latest job of a kind for a ref. */
  async latest(kind: string, ref: string): Promise<JobView | null> {
    const r = await this.db.query<Row>(
      "SELECT id, site_id, kind, ref, payload_json, status, result_json, error, attempts, updated_at::text AS updated_at FROM chain_jobs WHERE kind = $1 AND ref = $2 ORDER BY created_at DESC LIMIT 1",
      [kind, ref],
    );
    return r.rows[0] ? view(r.rows[0]) : null;
  }

  /** Latest job per ref for a kind, for a set of refs. */
  async latestMany(kind: string, refs: string[]): Promise<Map<string, JobView>> {
    if (!refs.length) return new Map();
    const r = await this.db.query<Row>(
      "SELECT id, site_id, kind, ref, payload_json, status, result_json, error, attempts, updated_at::text AS updated_at FROM chain_jobs WHERE kind = $1 AND ref = ANY($2) ORDER BY created_at",
      [kind, refs],
    );
    return new Map(r.rows.map((x) => [x.ref, view(x)]));
  }

  /** Put a failed job back in the queue. */
  async retry(kind: string, ref: string): Promise<JobView | null> {
    await this.db.query("UPDATE chain_jobs SET status = 'pending', attempts = 0, next_try_at = $1, updated_at = now() WHERE kind = $2 AND ref = $3 AND status = 'failed'", [new Date(this.now()).toISOString(), kind, ref]);
    return this.latest(kind, ref);
  }
}
