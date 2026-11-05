import type { Db } from "../db/db.js";
import { hashOf } from "../domain/canonical.js";
import { HttpError } from "../engine/errors.js";
import { TemplateSpec, type AgentKey, type Criterion, type StageSpec, type TemplateView } from "../domain/types.js";
import library from "../library/templates.json" with { type: "json" };
import { validateSpec } from "../pipelines/graph.js";
import { newId } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";

export const CRITERIA_BY_AGENT = library.criteriaByAgent as Record<AgentKey, Criterion[]>;
export const CATEGORIES = [...new Set(library.templates.map((t) => t.category))];

interface Row {
  id: string;
  key: string;
  name: string;
  category: string;
  description: string;
  origin: "library" | "custom";
  based_on: string | null;
  version: number;
  version_id: string;
  spec_json: string;
  published_at: string;
  published_by: string | null;
}
const toView = (r: Row): TemplateView => ({
  id: r.id,
  key: r.key,
  name: r.name,
  category: r.category,
  description: r.description,
  origin: r.origin,
  basedOn: r.based_on,
  version: Number(r.version),
  versionId: r.version_id,
  spec: JSON.parse(r.spec_json) as TemplateSpec,
  publishedAt: new Date(r.published_at).toISOString(),
  publishedBy: r.published_by,
});

const LATEST = `SELECT t.id, t.key, t.name, t.category, t.description, t.origin, t.based_on, v.version, v.id AS version_id, v.spec_json, v.published_at::text, v.published_by
  FROM templates t JOIN template_versions v ON v.template_id = t.id
  WHERE v.version = (SELECT MAX(version) FROM template_versions WHERE template_id = t.id)`;

export class Templates {
  constructor(
    private db: Db,
    private rec: Recorder,
  ) {}

  /** The 15 templates from the design ship as a read-only library; sites customize copies. */
  async ensureLibrary(): Promise<void> {
    for (const t of library.templates) {
      const id = `tpl_${t.key}`;
      const exists = await this.db.query("SELECT 1 FROM templates WHERE id = $1", [id]);
      if (exists.rows.length) continue;
      // a stage may carry its own criteria (the lab templates do); otherwise it takes its agent's
      const stages: StageSpec[] = t.stages.map((s) => ({ ...(s as Omit<StageSpec, "criteria">), criteria: (s as { criteria?: Criterion[] }).criteria ?? CRITERIA_BY_AGENT[s.agent as AgentKey] ?? [] }));
      const spec = TemplateSpec.parse({ stages, rework: t.rework });
      await this.db.tx(async (q) => {
        await q.query("INSERT INTO templates (id, site_id, key, name, category, description, origin) VALUES ($1, NULL, $2, $3, $4, $5, 'library')", [id, t.key, t.name, t.category, t.description]);
        await q.query("INSERT INTO template_versions (id, template_id, version, spec_json, note) VALUES ($1, $2, 1, $3, 'Library version')", [`${id}_v1`, id, JSON.stringify(spec)]);
      });
    }
  }

  async list(siteId: string): Promise<TemplateView[]> {
    const r = await this.db.query<Row>(`${LATEST} AND t.archived_at IS NULL AND (t.site_id IS NULL OR t.site_id = $1) ORDER BY t.origin DESC, t.created_at`, [siteId]);
    return r.rows.map(toView);
  }

  async get(siteId: string, templateId: string): Promise<TemplateView & { versions: { id: string; version: number; note: string | null; publishedAt: string }[] }> {
    const r = await this.db.query<Row>(`${LATEST} AND t.id = $1 AND (t.site_id IS NULL OR t.site_id = $2)`, [templateId, siteId]);
    if (!r.rows[0]) throw new HttpError(404, "Template not found");
    const v = await this.db.query<{ id: string; version: number; note: string | null; published_at: string }>(
      "SELECT id, version, note, published_at::text FROM template_versions WHERE template_id = $1 ORDER BY version DESC",
      [templateId],
    );
    return { ...toView(r.rows[0]), versions: v.rows.map((x) => ({ id: x.id, version: Number(x.version), note: x.note, publishedAt: new Date(x.published_at).toISOString() })) };
  }

  async version(versionId: string): Promise<TemplateView> {
    const r = await this.db.query<Row>(
      `SELECT t.id, t.key, t.name, t.category, t.description, t.origin, t.based_on, v.version, v.id AS version_id, v.spec_json, v.published_at::text, v.published_by
       FROM template_versions v JOIN templates t ON t.id = v.template_id WHERE v.id = $1`,
      [versionId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Template version not found");
    return toView(r.rows[0]);
  }

  /**
   * Publish from the builder. Editing a site template adds a version; editing a library template
   * creates the site's own copy (based on the library one).
   */
  async publish(siteId: string, by: string, input: { templateId?: string; name: string; category: string; description: string; spec: TemplateSpec; note?: string }): Promise<TemplateView> {
    const spec = TemplateSpec.parse(input.spec);
    const errors = validateSpec(spec.stages, spec.rework);
    if (errors.length) throw new HttpError(400, errors.join("; "));
    let templateId = input.templateId ?? null;
    let basedOn: string | null = null;
    if (templateId) {
      const t = (await this.db.query<{ origin: string; site_id: string | null }>("SELECT origin, site_id FROM templates WHERE id = $1", [templateId])).rows[0];
      if (!t) throw new HttpError(404, "Template not found");
      if (t.origin === "library" || t.site_id !== siteId) {
        basedOn = templateId;
        templateId = null;
      }
    }
    const versionId = newId("tv");
    let version = 1;
    await this.db.tx(async (q) => {
      if (!templateId) {
        templateId = newId("tpl");
        const key = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        await q.query("INSERT INTO templates (id, site_id, key, name, category, description, origin, based_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,'custom',$7,$8)", [templateId, siteId, key, input.name, input.category, input.description, basedOn, by]);
      } else {
        await q.query("UPDATE templates SET name = $1, category = $2, description = $3 WHERE id = $4", [input.name, input.category, input.description, templateId]);
        version = Number((await q.query<{ v: number }>("SELECT MAX(version) AS v FROM template_versions WHERE template_id = $1", [templateId])).rows[0]!.v) + 1;
      }
      await q.query("INSERT INTO template_versions (id, template_id, version, spec_json, note, published_by) VALUES ($1,$2,$3,$4,$5,$6)", [versionId, templateId, version, JSON.stringify(spec), input.note ?? null, by]);
    });
    await this.rec.event(by, "template.published", templateId, { templateId, version, versionId, specHash: hashOf(spec), basedOn, name: input.name });
    return this.version(versionId);
  }

  async archive(siteId: string, templateId: string) {
    await this.db.query("UPDATE templates SET archived_at = now() WHERE id = $1 AND site_id = $2 AND origin = 'custom'", [templateId, siteId]);
  }
}
