import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { Signatures, TypedSignature, User } from "../auth/auth.js";
import { sigArg } from "../chain/trust.js";
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { newId } from "../plant/plant.js";
import type { Contributions, SealedRecord } from "./contributions.js";
import type { Recorder } from "./recorder.js";
import type { Selection } from "./selection.js";
import type { RelayView, Trust } from "./trust.js";

export type CaseStatus = "open" | "responded" | "upheld" | "rejected";
const hash32 = (text: string) => `0x${createHash("sha256").update(text, "utf8").digest("hex")}` as Hex;

export interface CaseView {
  id: string;
  contributionId: string;
  runId: string;
  stageCode: string;
  tester: { address: string; name: string | null };
  validator: { address: string; name: string | null };
  bps: number;
  evidence: string;
  evidenceHash: string;
  response: string | null;
  responseHash: string | null;
  status: CaseStatus;
  respondBy: string;
  createdAt: string;
  respondedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** the relays of open, respond and decide, when OrdoTrust v3 holds the case */
  chain: { open: RelayView | null; respond: RelayView | null; decide: RelayView | null };
  /** what the caller may do now */
  can: { respond: boolean; decide: boolean; readRecord: boolean };
}
interface Row {
  id: string;
  site_id: string;
  contribution_id: string;
  run_id: string;
  stage_code: string;
  tester_id: string;
  tester: string;
  tester_name: string | null;
  validator_id: string | null;
  validator: string;
  validator_name: string | null;
  bps: number;
  evidence: string;
  evidence_hash: string;
  response: string | null;
  response_hash: string | null;
  status: CaseStatus;
  respond_by: string;
  created_at: string;
  responded_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
}
const SELECT = `SELECT k.*, k.respond_by::text, k.created_at::text, k.responded_at::text, k.decided_at::text, t.display_name AS tester_name, v.display_name AS validator_name
  FROM cases k JOIN users t ON t.id = k.tester_id LEFT JOIN users v ON v.id = k.validator_id`;

/**
 * Slashing cases. A tester with an active stake opens a case against the validator who selected a stage's proof of work,
 * with evidence and a proposed share of the validator's stake (`case.open`). The validator answers within the response
 * window (`case.respond`). The manager then upholds or rejects it (`case.decide`), once the validator answered or the
 * window closed. Every step is signed; with OrdoTrust v3 each is relayed and the contract moves the money: upheld, the
 * validator's stake is cut and half (the bounty) goes to the tester; rejected, part of the tester's stake goes to the
 * validator. The case freezes the acceptance's reward and fee until it is decided.
 */
export class Cases {
  constructor(
    private db: Db,
    private engine: RunEngine,
    private rec: Recorder,
    private sigs: Signatures,
    private trust: Trust,
    private selection: Selection,
    private contributions: Contributions,
    private now: () => number,
  ) {
    trust.onRetry("case.open", (siteId, _r, p) => this.trust.chain!.openCase(siteId, p.caseId, p.validator, p.bps, p.evidenceHash, p.acceptanceId, p.sig));
    trust.onRetry("case.respond", (siteId, _r, p) => this.trust.chain!.respond(siteId, p.caseId, p.responseHash, p.sig));
    trust.onRetry("case.decide", (siteId, _r, p) => this.trust.chain!.decideCase(siteId, p.caseId, p.uphold, p.sig));
  }

  private async row(siteId: string, id: string): Promise<Row> {
    const r = await this.db.query<Row>(`${SELECT} WHERE k.id = $1 AND k.site_id = $2`, [id, siteId]);
    if (!r.rows[0]) throw new HttpError(404, "Case not found");
    return r.rows[0];
  }

  private async view(r: Row, viewer: User, isManager: boolean): Promise<CaseView> {
    const live = r.status === "open" || r.status === "responded";
    const pastWindow = Date.parse(r.respond_by) <= this.now();
    const [open, respond, decide] = await Promise.all([this.trust.relayOf(r.site_id, `case_${r.id}_open`), this.trust.relayOf(r.site_id, `case_${r.id}_respond`), this.trust.relayOf(r.site_id, `case_${r.id}_decide`)]);
    return {
      id: r.id,
      contributionId: r.contribution_id,
      runId: r.run_id,
      stageCode: r.stage_code,
      tester: { address: r.tester, name: r.tester_name },
      validator: { address: r.validator, name: r.validator_name },
      bps: r.bps,
      evidence: r.evidence,
      evidenceHash: r.evidence_hash,
      response: r.response,
      responseHash: r.response_hash,
      status: r.status,
      respondBy: new Date(r.respond_by).toISOString(),
      createdAt: new Date(r.created_at).toISOString(),
      respondedAt: r.responded_at ? new Date(r.responded_at).toISOString() : null,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      chain: { open, respond, decide },
      can: {
        respond: r.status === "open" && !pastWindow && r.validator === viewer.address.toLowerCase(),
        decide: live && isManager && (r.status === "responded" || pastWindow) && r.tester !== viewer.address.toLowerCase() && r.validator !== viewer.address.toLowerCase(),
        readRecord: live && (isManager || r.tester_id === viewer.id),
      },
    };
  }

  /** The manager sees every case; others see the cases they opened or that are against them. */
  async list(siteId: string, viewer: User, isManager: boolean) {
    const r = await this.db.query<Row>(`${SELECT} WHERE k.site_id = $1 AND ($2 OR k.tester_id = $3 OR k.validator = $4) ORDER BY k.created_at DESC LIMIT 200`, [siteId, isManager, viewer.id, viewer.address.toLowerCase()]);
    return Promise.all(r.rows.map((x) => this.view(x, viewer, isManager)));
  }
  /** Cases waiting on this person: an answer they owe as the accused validator, or a decision as a manager. */
  async due(siteId: string, viewer: User, isManager: boolean): Promise<number> {
    const me = viewer.address.toLowerCase();
    const r = await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::text n FROM cases WHERE site_id = $1 AND (
         (validator = $2 AND status = 'open' AND respond_by > now())
         OR ($3 AND tester <> $2 AND validator <> $2 AND (status = 'responded' OR (status = 'open' AND respond_by <= now()))))`,
      [siteId, me, isManager],
    );
    return Number(r.rows[0]!.n);
  }
  async get(siteId: string, id: string, viewer: User, isManager: boolean) {
    const r = await this.row(siteId, id);
    if (!isManager && r.tester_id !== viewer.id && r.validator !== viewer.address.toLowerCase()) throw new HttpError(404, "Case not found");
    return this.view(r, viewer, isManager);
  }

  /**
   * Selected proofs of work a tester can examine, the ones whose stage went wrong first: it closed with a deviation,
   * is held, or missed a criterion.
   */
  async candidates(siteId: string) {
    const rows = await this.db.query<{ id: string; run_id: string; stage_code: string; address: string; name: string | null; selected_by: string; selected_by_name: string | null; selected_at: string; validator_id: string | null; open_case: string | null }>(
      `SELECT c.id, c.run_id, c.stage_code, c.address, u.display_name AS name, c.selected_by, s.display_name AS selected_by_name, s.id AS validator_id, c.selected_at::text,
         (SELECT k.id FROM cases k WHERE k.contribution_id = c.id AND k.status IN ('open','responded') LIMIT 1) AS open_case
       FROM contributions c JOIN users u ON u.id = c.user_id LEFT JOIN users s ON s.address = c.selected_by
       WHERE c.site_id = $1 AND c.status = 'selected' ORDER BY c.selected_at DESC LIMIT 100`,
      [siteId],
    );
    const runs = new Map<string, Awaited<ReturnType<RunEngine["view"]>>>();
    const out = [];
    for (const r of rows.rows) {
      if (!runs.has(r.run_id)) runs.set(r.run_id, await this.engine.view(siteId, r.run_id));
      const run = runs.get(r.run_id)!;
      const st = run.stages.find((s) => s.code === r.stage_code);
      const failed = st?.criteriaResults.filter((c) => c.ok === false).map((c) => c.label) ?? [];
      const reasons = [st?.deviation || st?.state === "done_deviation" ? "closed with a deviation" : null, st?.state === "held" ? "held" : null, failed.length ? `missed ${failed.join(", ")}` : null].filter((x): x is string => Boolean(x));
      out.push({
        contributionId: r.id,
        runId: r.run_id,
        orderRef: run.orderRef,
        stageCode: r.stage_code,
        stageName: st?.name ?? r.stage_code,
        stageState: st?.state ?? null,
        contributor: { address: r.address, name: r.name },
        validator: { address: r.selected_by, name: r.selected_by_name },
        selectedAt: new Date(r.selected_at).toISOString(),
        wentWrong: reasons,
        openCase: r.open_case,
      });
    }
    return out.sort((a, b) => Number(b.wentWrong.length > 0) - Number(a.wentWrong.length > 0) || b.selectedAt.localeCompare(a.selectedAt));
  }

  // ---------------------------------------------------------------- open (tester)

  private async target(siteId: string, contributionId: string) {
    const r = await this.db.query<{ status: string; run_id: string; stage_code: string; selected_by: string | null; user_id: string; validator_id: string | null }>(
      "SELECT c.status, c.run_id, c.stage_code, c.selected_by, c.user_id, s.id AS validator_id FROM contributions c LEFT JOIN users s ON s.address = c.selected_by WHERE c.id = $1 AND c.site_id = $2",
      [contributionId, siteId],
    );
    const c = r.rows[0];
    if (!c) throw new HttpError(404, "Proof of work not found");
    if (c.status !== "selected" || !c.selected_by) throw new HttpError(409, "A case is about a selected proof of work and the validator who selected it");
    const open = await this.db.query("SELECT 1 FROM cases WHERE contribution_id = $1 AND status IN ('open','responded')", [contributionId]);
    if (open.rows.length) throw new HttpError(409, "There is already an open case on this proof of work");
    return c as typeof c & { selected_by: string };
  }

  /**
   * On a v3 OrdoTrust the contract takes a case only against an acceptance it holds, unsettled, unfrozen and still in
   * its challenge window; check that first, so a case never opens in Ordo that the chain would refuse.
   */
  private async assertChallengeable(siteId: string, contributionId: string) {
    if (!(await this.selection.v3())) return;
    const a = await this.trust.chain!.acceptance(siteId, contributionId).catch(() => undefined);
    if (a === undefined) throw new HttpError(502, "Could not reach the trust contract to check this selection. Try again.");
    if (!a) throw new HttpError(409, "This selection is not recorded on-chain yet, so the contract would refuse a case. A manager can retry it from Rewards.");
    if (a.settled) throw new HttpError(409, "This selection's reward is already paid out: its challenge window has passed.");
    if (a.frozen) throw new HttpError(409, "Another case already froze this selection.");
    if (a.vestAt * 1000 <= this.now()) throw new HttpError(409, "The challenge window for this selection has closed.");
  }

  async openRequest(siteId: string, tester: User, input: { contributionId: string; bps: number; evidence: string; chainId?: number }): Promise<{ caseId: string; typed: TypedSignature }> {
    await this.trust.requireTester(siteId, tester);
    const c = await this.target(siteId, input.contributionId);
    if (c.selected_by === tester.address.toLowerCase()) throw new HttpError(403, "You selected this proof of work: another tester opens a case");
    await this.assertChallengeable(siteId, input.contributionId);
    const { settings } = await this.selection.settings(siteId);
    if (input.bps < 1 || input.bps > settings.maxSlashBps) throw new HttpError(400, `Propose between 0.01% and ${settings.maxSlashBps / 100}% of the validator's stake`);
    const caseId = newId("case");
    const typed = await this.sigs.request(tester, {
      action: "case.open",
      entity: `${c.selected_by}#${input.bps}#${caseId}#${hash32(input.evidence)}`,
      meaning: `Open a case against ${c.selected_by} for selecting proof of work ${input.contributionId} on stage ${c.stage_code}, proposing ${input.bps / 100}% of their stake`,
      comment: "",
      site: siteId,
      ...this.trust.contractDomain(await this.selection.v3(), input.chainId),
    });
    return { caseId, typed };
  }

  async open(siteId: string, tester: User, input: { caseId: string; contributionId: string; bps: number; evidence: string; nonce: string; signature: Hex }) {
    await this.trust.requireTester(siteId, tester);
    const c = await this.target(siteId, input.contributionId);
    if (!/^case_[\w-]{4,40}$/.test(input.caseId)) throw new HttpError(400, "Bad case id");
    await this.assertChallengeable(siteId, input.contributionId);
    const evidenceHash = hash32(input.evidence);
    const { settings } = await this.selection.settings(siteId);
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, tester, { action: "case.open", entity: `${c.selected_by}#${input.bps}#${input.caseId}#${evidenceHash}` }, input);
      await q.query(
        `INSERT INTO cases (id, site_id, contribution_id, run_id, stage_code, tester_id, tester, validator_id, validator, bps, evidence, evidence_hash, respond_by, open_signature_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [input.caseId, siteId, input.contributionId, c.run_id, c.stage_code, tester.id, tester.address.toLowerCase(), c.validator_id, c.selected_by, input.bps, input.evidence, evidenceHash, new Date(this.now() + settings.responseWindow * 1000), s.id],
      );
      return s;
    });
    const d = await this.rec.decide(siteId, {
      agent: `user:${tester.address}`,
      kind: "case.opened",
      runId: c.run_id,
      stageCode: c.stage_code,
      summary: `Case opened against ${c.selected_by} for the proof of work selected on ${c.stage_code}, proposing ${input.bps / 100}% of their stake`,
      data: { caseId: input.caseId, contributionId: input.contributionId, validator: c.selected_by, bps: input.bps, evidenceHash, signatureId: sig.id },
    });
    await this.db.query("UPDATE cases SET ledger_seq = $2 WHERE id = $1", [input.caseId, d.ledgerSeq ?? null]);
    if (await this.selection.v3()) {
      const arg = sigArg(sig.typed, input.signature);
      const p = { caseId: input.caseId, validator: c.selected_by, bps: input.bps, evidenceHash, acceptanceId: input.contributionId, sig: arg };
      await this.trust.relay(siteId, "case.open", `case_${input.caseId}_open`, p, () => this.trust.chain!.openCase(siteId, p.caseId, p.validator, p.bps, p.evidenceHash, p.acceptanceId, arg));
    }
    return this.get(siteId, input.caseId, tester, false);
  }

  // ---------------------------------------------------------------- respond (the accused validator)

  async respondRequest(siteId: string, validator: User, caseId: string, response: string, chainId?: number) {
    const k = await this.row(siteId, caseId);
    this.assertCanRespond(k, validator);
    return this.sigs.request(validator, {
      action: "case.respond",
      entity: `${caseId}#${hash32(response)}`,
      meaning: `Answer case ${caseId} about the proof of work you selected on stage ${k.stage_code}`,
      comment: "",
      site: siteId,
      ...this.trust.contractDomain(await this.selection.v3(), chainId),
    });
  }
  private assertCanRespond(k: Row, validator: User) {
    if (k.validator !== validator.address.toLowerCase()) throw new HttpError(403, "Only the validator the case is against answers it");
    if (k.status !== "open") throw new HttpError(409, "This case is no longer waiting for an answer");
    if (Date.parse(k.respond_by) <= this.now()) throw new HttpError(409, "The response window has closed");
  }

  async respond(siteId: string, validator: User, caseId: string, input: { response: string; nonce: string; signature: Hex }) {
    const k = await this.row(siteId, caseId);
    this.assertCanRespond(k, validator);
    const responseHash = hash32(input.response);
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, validator, { action: "case.respond", entity: `${caseId}#${responseHash}` }, input);
      const u = await q.query("UPDATE cases SET status = 'responded', response = $2, response_hash = $3, respond_signature_id = $4, responded_at = now() WHERE id = $1 AND status = 'open' RETURNING id", [caseId, input.response, responseHash, s.id]);
      if (!u.rows.length) throw new HttpError(409, "This case is no longer waiting for an answer");
      return s;
    });
    await this.rec.decide(siteId, { agent: `user:${validator.address}`, kind: "case.responded", runId: k.run_id, stageCode: k.stage_code, summary: `The validator answered case ${caseId}`, data: { caseId, responseHash, signatureId: sig.id } });
    if (await this.selection.v3()) {
      const arg = sigArg(sig.typed, input.signature);
      await this.trust.relay(siteId, "case.respond", `case_${caseId}_respond`, { caseId, responseHash, sig: arg }, () => this.trust.chain!.respond(siteId, caseId, responseHash, arg));
    }
    return this.get(siteId, caseId, validator, false);
  }

  // ---------------------------------------------------------------- decide (the manager)

  private assertCanDecide(k: Row, manager: User) {
    if (k.status !== "open" && k.status !== "responded") throw new HttpError(409, "This case is already decided");
    if (k.tester === manager.address.toLowerCase() || k.validator === manager.address.toLowerCase()) throw new HttpError(403, "A manager who is a party to the case cannot decide it");
    if (k.status === "open" && Date.parse(k.respond_by) > this.now()) throw new HttpError(409, `The validator can still answer until ${new Date(k.respond_by).toISOString()}`);
  }

  async decideRequest(siteId: string, manager: User, caseId: string, uphold: boolean, comment: string, chainId?: number) {
    const k = await this.row(siteId, caseId);
    this.assertCanDecide(k, manager);
    return this.sigs.request(manager, {
      action: "case.decide",
      entity: `${caseId}#${uphold ? "uphold" : "reject"}`,
      meaning: uphold ? `Uphold case ${caseId}: cut ${k.bps / 100}% of ${k.validator}'s stake` : `Reject case ${caseId}: the tester's claim was not borne out`,
      comment,
      site: siteId,
      ...this.trust.contractDomain(await this.selection.v3(), chainId),
    });
  }

  async decide(siteId: string, manager: User, caseId: string, input: { uphold: boolean; comment: string; nonce: string; signature: Hex }) {
    const k = await this.row(siteId, caseId);
    this.assertCanDecide(k, manager);
    const status: CaseStatus = input.uphold ? "upheld" : "rejected";
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, manager, { action: "case.decide", entity: `${caseId}#${input.uphold ? "uphold" : "reject"}` }, input);
      const u = await q.query("UPDATE cases SET status = $2, decide_signature_id = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status IN ('open','responded') RETURNING id", [caseId, status, s.id, manager.address.toLowerCase()]);
      if (!u.rows.length) throw new HttpError(409, "This case is already decided");
      return s;
    });
    await this.rec.decide(siteId, {
      agent: `user:${manager.address}`,
      kind: input.uphold ? "case.upheld" : "case.rejected",
      runId: k.run_id,
      stageCode: k.stage_code,
      summary: input.uphold ? `Case ${caseId} upheld: ${k.bps / 100}% of the validator's stake is cut` : `Case ${caseId} rejected`,
      reason: input.comment || null,
      data: { caseId, uphold: input.uphold, signatureId: sig.id },
    });
    if (await this.selection.v3()) {
      const arg = sigArg(sig.typed, input.signature);
      await this.trust.relay(siteId, "case.decide", `case_${caseId}_decide`, { caseId, uphold: input.uphold, sig: arg }, () => this.trust.chain!.decideCase(siteId, caseId, input.uphold, arg));
    }
    return this.get(siteId, caseId, manager, true);
  }

  /** The proof of work's sealed record, for the case's tester and the manager while the case is open. */
  async record(siteId: string, caseId: string, viewer: User, isManager: boolean): Promise<SealedRecord> {
    const k = await this.row(siteId, caseId);
    if (!isManager && k.tester_id !== viewer.id) throw new HttpError(403, "Only the case's tester and the manager read the sealed record");
    if (!isManager && k.status !== "open" && k.status !== "responded") throw new HttpError(409, "The case is decided");
    return this.contributions.sealedRecord(siteId, k.contribution_id);
  }
}
