import type { Db } from "../db/db.js";
import { AGENT_INFO, ASSET_KIND_LABEL, ROLE_LABEL, type Role, type RunView } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { CHAIN, PACKAGE_LABEL } from "./validation.js";

/** A role someone can take in a pipeline, and why the pipeline needs it. Anyone joins as a contributor; a manager promotes. */
export interface OpenRole {
  role: Role;
  label: string;
  why: string[];
  /** how many people hold it at the site now (a count, never who) */
  holders: number;
}

const STEP_SIGNER: Record<string, string> = { draft: "performed", qe_review: "reviewed", approval: "approved" };

/**
 * Running pipelines anyone can browse without an account, so a newcomer can see what an org makes, which
 * people it needs, and join it. It shows the pipeline and its progress only: no order references,
 * machine names, wallet addresses or people's names. A site's administrator can take its pipelines off the list.
 */
export class Openings {
  constructor(
    private db: Db,
    private engine: RunEngine,
  ) {}

  async list() {
    const r = await this.db.query<{ id: string; site_id: string; site_name: string }>(
      "SELECT r.id, r.site_id, s.name AS site_name FROM runs r JOIN sites s ON s.id = r.site_id WHERE r.status = 'running' AND s.public_pipelines ORDER BY r.started_at DESC LIMIT 100",
    );
    const holders = new Map<string, Awaited<ReturnType<Openings["holders"]>>>();
    const out = [];
    for (const x of r.rows) {
      if (!holders.has(x.site_id)) holders.set(x.site_id, await this.holders(x.site_id));
      out.push(await this.view(x.site_id, x.site_name, await this.engine.view(x.site_id, x.id), holders.get(x.site_id)!));
    }
    return out;
  }

  async get(siteId: string, runId: string) {
    const s = (await this.db.query<{ name: string; public_pipelines: boolean }>("SELECT name, public_pipelines FROM sites WHERE id = $1", [siteId])).rows[0];
    if (!s?.public_pipelines) throw new HttpError(404, "No public pipeline here");
    const run = await this.engine.view(siteId, runId).catch(() => null);
    if (!run) throw new HttpError(404, "No public pipeline here");
    const validation = await this.db.query<{ number: number; type: string; status: string; step: string; stage_code: string | null }>(
      "SELECT number, type, status, step, stage_code FROM validation_packages WHERE site_id = $1 AND run_id = $2 AND status <> 'rejected' ORDER BY number",
      [siteId, runId],
    );
    return {
      ...(await this.view(siteId, s.name, run, await this.holders(siteId))),
      validation: validation.rows.map((p) => {
        const waiting = p.status === "released" ? null : CHAIN.find((c) => c.meaning === STEP_SIGNER[p.step]) ?? null;
        return {
          ref: `VP-${p.number}`,
          type: PACKAGE_LABEL[p.type as keyof typeof PACKAGE_LABEL] ?? p.type,
          status: p.status,
          stageCode: p.stage_code,
          waitingFor: waiting ? { meaning: waiting.meaning, label: waiting.label, role: waiting.role, roleLabel: ROLE_LABEL[waiting.role] } : null,
        };
      }),
    };
  }

  private async holders(siteId: string) {
    const m = await this.db.query<{ role: Role; n: string }>("SELECT role, COUNT(*)::text n FROM memberships WHERE site_id = $1 GROUP BY role", [siteId]);
    return { roles: new Map(m.rows.map((x) => [x.role, Number(x.n)])) };
  }

  /** The roles a pipeline needs: who contributes proof of work, who selects it, and who tests the result. */
  private roles(run: RunView, h: Awaited<ReturnType<Openings["holders"]>>): OpenRole[] {
    const live = run.stages.filter((s) => s.state === "running" || s.state === "queued").length;
    const gates = run.stages.filter((s) => s.mode === "approve").map((s) => `${s.code} ${s.name}`);
    const out: { role: Role; why: string[] }[] = [
      { role: "contributor", why: [`Submits proof of work for the stages as they run${live ? ` (${live} open now)` : ""}`, "Joins openly: no application"] },
      { role: "validator", why: ["Stakes, and selects the valid contribution for each stage", "Signs Reviewed by on the validation that releases the lot"] },
      { role: "tester", why: ["Stakes, investigates stages that go wrong, and opens cases against the validator who selected them"] },
      { role: "manager", why: [gates.length ? `Signs the gates at ${gates.join(", ")}` : "Decides when a stage misses its criteria", "Approves the release, funds rewards and decides cases"] },
    ];
    return out.map((r) => ({ ...r, label: ROLE_LABEL[r.role], holders: h.roles.get(r.role) ?? 0 }));
  }

  private async view(siteId: string, siteName: string, run: RunView, h: Awaited<ReturnType<Openings["holders"]>>) {
    return {
      siteId,
      site: siteName,
      runId: run.id,
      pipeline: { name: run.templateName, category: run.templateCategory, description: run.templateDescription, version: run.templateVersion },
      status: run.status,
      quantity: run.quantity,
      startedAt: run.startedAt,
      dueAt: run.dueAt,
      metrics: { completed: run.metrics.completed, total: run.metrics.total, gatesPending: run.metrics.gatesPending, rolledYield: run.metrics.rolledYield, onTrack: run.metrics.onTrack },
      stages: run.stages.map((s) => ({
        code: s.code,
        column: s.column,
        name: s.name,
        state: s.state,
        mode: s.mode,
        agent: AGENT_INFO[s.agent].label,
        resource: ASSET_KIND_LABEL[s.resourceKind],
        gateRole: ROLE_LABEL[s.escalationRole],
        progress: s.progress,
      })),
      roles: this.roles(run, h),
    };
  }
}
