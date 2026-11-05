import type { Db } from "../db/db.js";
import type { LedgerStore } from "../db/ledger-store.js";
import type { LedgerEntry } from "../domain/ledger.js";
import type { DecisionView } from "../domain/types.js";
import { newId } from "../plant/plant.js";

export interface DecisionInput {
  agent: string; // "agent:scheduler", "user:0x…", "guard:policy"
  kind: string;
  summary: string;
  reason?: string | null;
  data?: unknown;
  confidence?: number | null;
  modelId?: string | null;
  runId?: string | null;
  stageCode?: string | null;
  incidentId?: string | null;
  assetId?: string | null;
}

interface Row {
  id: string;
  agent: string;
  kind: string;
  summary: string;
  reason: string | null;
  data_json: string;
  confidence: number | null;
  model_id: string | null;
  run_id: string | null;
  stage_code: string | null;
  incident_id: string | null;
  asset_id: string | null;
  ledger_seq: number | null;
  ts: string;
}
const toView = (r: Row): DecisionView => ({
  id: r.id,
  agent: r.agent,
  kind: r.kind,
  summary: r.summary,
  reason: r.reason,
  confidence: r.confidence === null ? null : Number(r.confidence),
  runId: r.run_id,
  stageCode: r.stage_code,
  assetId: r.asset_id,
  incidentId: r.incident_id,
  modelId: r.model_id,
  ledgerSeq: r.ledger_seq === null ? null : Number(r.ledger_seq),
  ts: new Date(r.ts).toISOString(),
  data: JSON.parse(r.data_json),
});

/** Every decision is a ledger entry first; the decisions table is a queryable index of the ledger. */
export class Recorder {
  constructor(
    private db: Db,
    readonly ledger: LedgerStore,
  ) {}

  event(actor: string, type: string, subject: string | null, payload: unknown): Promise<LedgerEntry> {
    return this.ledger.append({ ts: new Date().toISOString(), actor, type, subject, payload });
  }

  /** Hash of the newest ledger entry (what a payment cites as its justification). */
  async headHash(): Promise<string | null> {
    return (await this.ledger.head())?.entryHash ?? null;
  }

  async decide(siteId: string, d: DecisionInput): Promise<DecisionView> {
    const subject = d.runId ? `${d.runId}${d.stageCode ? `/${d.stageCode}` : ""}` : d.incidentId ?? d.assetId ?? null;
    const entry = await this.event(d.agent, `decision.${d.kind}`, subject, { summary: d.summary, reason: d.reason ?? null, confidence: d.confidence ?? null, modelId: d.modelId ?? null, data: d.data ?? null });
    const id = newId("dec");
    await this.db.query(
      "INSERT INTO decisions (id, site_id, run_id, stage_code, incident_id, asset_id, agent, kind, summary, reason, data_json, confidence, model_id, ledger_seq, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [id, siteId, d.runId ?? null, d.stageCode ?? null, d.incidentId ?? null, d.assetId ?? null, d.agent, d.kind, d.summary, d.reason ?? null, JSON.stringify(d.data ?? {}), d.confidence ?? null, d.modelId ?? null, entry.seq, entry.ts],
    );
    return { id, agent: d.agent, kind: d.kind, summary: d.summary, reason: d.reason ?? null, confidence: d.confidence ?? null, runId: d.runId ?? null, stageCode: d.stageCode ?? null, assetId: d.assetId ?? null, incidentId: d.incidentId ?? null, modelId: d.modelId ?? null, ledgerSeq: entry.seq, ts: entry.ts, data: d.data ?? {} };
  }

  async decisions(siteId: string, f: { runId?: string; incidentId?: string; afterSeq?: number; limit?: number } = {}): Promise<DecisionView[]> {
    const where = ["site_id = $1"];
    const params: unknown[] = [siteId];
    if (f.runId) where.push(`run_id = $${params.push(f.runId)}`);
    if (f.incidentId) where.push(`incident_id = $${params.push(f.incidentId)}`);
    if (f.afterSeq) where.push(`ledger_seq > $${params.push(f.afterSeq)}`);
    const r = await this.db.query<Row>(`SELECT id, agent, kind, summary, reason, data_json, confidence, model_id, run_id, stage_code, incident_id, asset_id, ledger_seq, ts::text AS ts FROM decisions WHERE ${where.join(" AND ")} ORDER BY ts DESC, ledger_seq DESC LIMIT ${Math.min(500, f.limit ?? 50)}`, params);
    return r.rows.map(toView);
  }
}
