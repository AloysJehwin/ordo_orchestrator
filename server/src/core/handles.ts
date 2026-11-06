/**
 * People's handles: the label of their ENS name in each org they belong to (priya → priya.acme.ordo.eth, and
 * priya.validators.acme.ordo.eth while they validate there). One handle per wallet, unique across Ordo, chosen by the
 * person. Someone who never chose one gets member-<six hex of their wallet>, so names never wait on a choice. A handle
 * is public on-chain for good once issued.
 */
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import { handleProblem, suggestHandle } from "./name-scheme.js";

export interface HandleCheck {
  handle: string;
  available: boolean;
  /** why it cannot be used, when it cannot */
  reason: string | null;
  /** a free handle close to it */
  suggestion: string | null;
}

export class Handles {
  /** called after a handle changes, so the person's names are reissued */
  onChange?: (userId: string) => void;

  constructor(private readonly db: Db) {}

  async of(userId: string): Promise<string | null> {
    return (await this.db.query<{ handle: string | null }>("SELECT handle FROM users WHERE id = $1", [userId])).rows[0]?.handle ?? null;
  }

  private async holder(h: string): Promise<string | null> {
    return (await this.db.query<{ id: string }>("SELECT id FROM users WHERE handle = $1", [h])).rows[0]?.id ?? null;
  }

  /** The first of h, h-2, h-3… that is free (or held by userId). */
  private async free(h: string, userId?: string): Promise<string | null> {
    for (let n = 1; n <= 50; n++) {
      const c = n === 1 ? h : `${h.slice(0, 32 - String(n).length - 1).replace(/-+$/, "")}-${n}`;
      if (handleProblem(c)) continue;
      const who = await this.holder(c);
      if (!who || who === userId) return c;
    }
    return null;
  }

  async check(input: string, userId?: string): Promise<HandleCheck> {
    const handle = input.trim().toLowerCase();
    const problem = handleProblem(handle);
    if (problem) return { handle, available: false, reason: problem, suggestion: await this.free(suggestHandle(handle) ?? "", userId).catch(() => null) };
    const who = await this.holder(handle);
    if (who && who !== userId) return { handle, available: false, reason: "Someone already has that handle", suggestion: await this.free(handle, userId) };
    return { handle, available: true, reason: null, suggestion: null };
  }

  /** Choose or change a handle. */
  async set(userId: string, input: string): Promise<string> {
    const c = await this.check(input, userId);
    if (!c.available) throw new HttpError(c.reason === "Someone already has that handle" ? 409 : 400, c.reason ?? "That handle cannot be used");
    const before = await this.of(userId);
    if (before === c.handle) return c.handle;
    try {
      await this.db.query("UPDATE users SET handle = $1 WHERE id = $2", [c.handle, userId]);
    } catch {
      throw new HttpError(409, "Someone already has that handle");
    }
    this.onChange?.(userId);
    return c.handle;
  }

  /**
   * The person's handle, assigning member-<hex of their wallet> if they have none. Nothing personal is assigned for
   * them: a handle from their display name is only ever a suggestion they accept.
   */
  async ensure(userId: string): Promise<string> {
    const row = (await this.db.query<{ handle: string | null; address: string }>("SELECT handle, address FROM users WHERE id = $1", [userId])).rows[0];
    if (!row) throw new HttpError(404, "No such user");
    if (row.handle) return row.handle;
    const hex = row.address.toLowerCase().replace(/^0x/, "");
    for (const n of [6, 8, 12, 40]) {
      const h = `member-${hex.slice(0, n)}`;
      const r = await this.db
        .query<{ id: string }>("UPDATE users SET handle = $1 WHERE id = $2 AND handle IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE handle = $1) RETURNING id", [h, userId])
        .catch(() => ({ rows: [] as { id: string }[] }));
      if (r.rows.length) return h;
      const now = await this.of(userId);
      if (now) return now;
    }
    throw new HttpError(503, "Could not assign a handle");
  }

  /** A handle to offer someone choosing one: from their display name, made free. */
  async suggestion(userId: string): Promise<string | null> {
    const row = (await this.db.query<{ display_name: string | null }>("SELECT display_name FROM users WHERE id = $1", [userId])).rows[0];
    const base = suggestHandle(row?.display_name);
    return base ? this.free(base, userId) : null;
  }
}
