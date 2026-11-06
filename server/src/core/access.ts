import type { Db } from "../db/db.js";
import { AccessScope, ACCESS_LEVELS, DEFAULT_LEVEL, ROLES, type AccessLevel, type CriterionResult, type Role, type RunView, type StageRunView } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";

/**
 * What a member of an org may see: a level (1 stages and status, 2 plus outcomes, 3 plus proofs, measurements and
 * contributions, 4 everything) and a scope (all lines and stages, or chosen ones). The manager sets a default per role
 * and may override it per person. A manager always sees everything. The API enforces this: routes have a minimum level,
 * and run and stage payloads are redacted to the caller's level and scope before they leave the server.
 */
export interface Access {
  level: AccessLevel;
  scope: AccessScope;
  /** where it comes from: the manager role, a per-person override, or the role defaults */
  source: "manager" | "member" | "role";
}

export interface AccessConfig {
  roles: { role: Role; level: AccessLevel; scope: AccessScope; fixed: boolean }[];
  members: { userId: string; level: AccessLevel; scope: AccessScope }[];
}

const ALL: AccessScope = { lines: null, stages: null };
const parseScope = (s: string | null | undefined): AccessScope => {
  try {
    return AccessScope.parse(JSON.parse(s ?? "{}"));
  } catch {
    return ALL;
  }
};
const clampLevel = (n: number): AccessLevel => (ACCESS_LEVELS.includes(n as AccessLevel) ? (n as AccessLevel) : 1);
/** Two scopes together: everything either allows. */
const union = (a: AccessScope, b: AccessScope): AccessScope => ({
  lines: a.lines === null || b.lines === null ? null : [...new Set([...a.lines, ...b.lines])],
  stages: a.stages === null || b.stages === null ? null : [...new Set([...a.stages, ...b.stages])],
});

export class AccessControl {
  constructor(private db: Db) {}

  /** The access of one member, from their roles, the org's role defaults and any override the manager set for them. */
  async of(siteId: string, userId: string, roles: Role[]): Promise<Access> {
    if (roles.includes("manager")) return { level: 4, scope: ALL, source: "manager" };
    const own = (await this.db.query<{ level: number; scope_json: string }>("SELECT level, scope_json FROM member_access WHERE site_id = $1 AND user_id = $2", [siteId, userId])).rows[0];
    if (own) return { level: clampLevel(own.level), scope: parseScope(own.scope_json), source: "member" };
    const defaults = await this.roleDefaults(siteId);
    let level: AccessLevel = 1;
    let scope: AccessScope | null = null;
    for (const r of roles) {
      const d = defaults.get(r)!;
      if (d.level > level) level = d.level;
      scope = scope ? union(scope, d.scope) : d.scope;
    }
    return { level, scope: scope ?? ALL, source: "role" };
  }

  private async roleDefaults(siteId: string): Promise<Map<Role, { level: AccessLevel; scope: AccessScope }>> {
    const rows = (await this.db.query<{ role: string; level: number; scope_json: string }>("SELECT role, level, scope_json FROM role_access WHERE site_id = $1", [siteId])).rows;
    const m = new Map<Role, { level: AccessLevel; scope: AccessScope }>();
    for (const r of ROLES) {
      const row = rows.find((x) => x.role === r);
      m.set(r, row && r !== "manager" ? { level: clampLevel(row.level), scope: parseScope(row.scope_json) } : { level: DEFAULT_LEVEL[r], scope: ALL });
    }
    return m;
  }

  async config(siteId: string): Promise<AccessConfig> {
    const defaults = await this.roleDefaults(siteId);
    const members = (await this.db.query<{ user_id: string; level: number; scope_json: string }>("SELECT user_id, level, scope_json FROM member_access WHERE site_id = $1", [siteId])).rows;
    return {
      roles: ROLES.map((role) => ({ role, ...defaults.get(role)!, fixed: role === "manager" })),
      members: members.map((m) => ({ userId: m.user_id, level: clampLevel(m.level), scope: parseScope(m.scope_json) })),
    };
  }

  async setRole(siteId: string, by: string, role: Role, level: AccessLevel, scope: AccessScope) {
    if (role === "manager") throw new HttpError(400, "A manager always sees everything");
    await this.checkScope(siteId, scope);
    await this.db.query(
      "INSERT INTO role_access (site_id, role, level, scope_json, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (site_id, role) DO UPDATE SET level = EXCLUDED.level, scope_json = EXCLUDED.scope_json, updated_by = EXCLUDED.updated_by, updated_at = now()",
      [siteId, role, level, JSON.stringify(scope), by],
    );
  }

  /** A per-person override; `null` returns the person to their roles' defaults. */
  async setMember(siteId: string, by: string, userId: string, v: { level: AccessLevel; scope: AccessScope } | null) {
    const member = await this.db.query("SELECT 1 FROM memberships WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
    if (!member.rows.length) throw new HttpError(404, "Not a member of this org");
    if (!v) {
      await this.db.query("DELETE FROM member_access WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
      return;
    }
    await this.checkScope(siteId, v.scope);
    await this.db.query(
      "INSERT INTO member_access (site_id, user_id, level, scope_json, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (site_id, user_id) DO UPDATE SET level = EXCLUDED.level, scope_json = EXCLUDED.scope_json, updated_by = EXCLUDED.updated_by, updated_at = now()",
      [siteId, userId, v.level, JSON.stringify(v.scope), by],
    );
  }

  private async checkScope(siteId: string, scope: AccessScope) {
    if (!scope.lines) return;
    const lines = new Set((await this.db.query<{ id: string }>("SELECT id FROM lines WHERE site_id = $1", [siteId])).rows.map((r) => r.id));
    const bad = scope.lines.find((l) => !lines.has(l));
    if (bad) throw new HttpError(400, `No line ${bad} in this org`);
  }
}

// ---------------------------------------------------------------- enforcement helpers

export const needLevel = (a: Access, min: AccessLevel, what = "this") => {
  if (a.level < min) throw new HttpError(403, `Your access level (${a.level}) does not include ${what}. A manager can raise it.`);
};
export const lineInScope = (a: Access, lineId: string | null) => a.scope.lines === null || (lineId !== null && a.scope.lines.includes(lineId));
export const stageInScope = (a: Access, lineId: string | null, code: string) => lineInScope(a, lineId) && (a.scope.stages === null || a.scope.stages.includes(code));

const bareCriterion = (c: CriterionResult): CriterionResult => ({ label: c.label, kind: c.kind, unit: c.unit, target: c.target, actual: null, ok: null, band: c.band });
const outcomeCriterion = (c: CriterionResult): CriterionResult => ({ ...bareCriterion(c), ok: c.ok });
/** A stage's judged criteria at this level: at 3 and up as measured, at 2 pass or fail only, at 1 neither. */
export const redactCriteria = (cs: CriterionResult[], level: AccessLevel): CriterionResult[] => (level >= 3 ? cs : cs.map(level === 2 ? outcomeCriterion : bareCriterion));

/** A stage as a member at this level may see it: at 1 its state only, at 2 its counts and pass/fail, at 3 and up its measured values. */
export function redactStage(s: StageRunView, level: AccessLevel): StageRunView {
  if (level >= 3) return s;
  if (level === 2) return { ...s, criteriaResults: s.criteriaResults.map(outcomeCriterion) };
  return {
    ...s,
    unitsGood: 0,
    unitsScrap: 0,
    yieldPct: null,
    throughputPerHour: null,
    reworkUnits: 0,
    outcome: null,
    deviation: false,
    criteriaResults: s.criteriaResults.map(bareCriterion),
    decisions: 0,
  };
}

/** A run as this member may see it, or null when its line is out of their scope. Stages out of scope keep only their state. */
export function redactRun(r: RunView, a: Access): RunView | null {
  if (a.level >= 4) return r;
  if (!lineInScope(a, r.lineId)) return null;
  const stages = r.stages.map((s) => redactStage(s, stageInScope(a, r.lineId, s.code) ? a.level : 1));
  const metrics = a.level >= 2 ? r.metrics : { ...r.metrics, rolledYield: null, throughputPerHour: null, decisions: 0, escalated: 0 };
  return { ...r, stages, metrics };
}

export const redactRuns = (runs: RunView[], a: Access): RunView[] => runs.map((r) => redactRun(r, a)).filter((r): r is RunView => r !== null);
