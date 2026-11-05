import type { Hex } from "viem";
import type { Signatures, TypedSignature, User } from "../auth/auth.js";
import { settingsEntity, sigArg, type OnchainAcceptance, type RewardSettings } from "../chain/trust.js";
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { GOOD, SCRAP, type Contributions, type SealedRecord } from "./contributions.js";
import type { Recorder } from "./recorder.js";
import type { RelayView, Trust } from "./trust.js";

/** Defaults Ordo uses when no v3 OrdoTrust holds the org's settings (they match the contract's defaults) */
export const DEFAULT_SETTINGS: RewardSettings = {
  reward: "100000000",
  fee: "20000000",
  challengeWindow: 3 * 86_400,
  responseWindow: 48 * 3600,
  defaultSlashBps: 3000,
  maxSlashBps: 5000,
  bountyBps: 5000,
  falseClaimBps: 1000,
};


export interface AcceptanceView {
  contributionId: string;
  runId: string;
  stageCode: string;
  contributor: { address: string; name: string | null };
  validator: { address: string; name: string | null };
  selectedAt: string;
  onchain: OnchainAcceptance | null;
  relay: RelayView | null;
  openCase: string | null;
}

/**
 * A validator selects the valid proof of work for a stage. The selection is signed (`contribution.select`, entity
 * `<contributionId>#<contributor>`), the others on the stage become "not selected", and the stage closes from the
 * selected record: Ordo records its counts and measured parameters, commits them itself (a person's report is not a
 * device-signed reading; the machine's outputs are), and its criteria are proven in zero knowledge over that
 * commitment. With a v3 OrdoTrust the same
 * signature records the acceptance on-chain: the contributor's reward and the validator's fee vest after the challenge
 * window, unless a tester's case freezes them.
 */
export class Selection {
  private v3cache: boolean | null = null;

  constructor(
    private db: Db,
    private engine: RunEngine,
    private rec: Recorder,
    private sigs: Signatures,
    private trust: Trust,
    private contributions: Contributions,
    private now: () => number,
  ) {
    trust.onRetry("acceptance", (siteId, _ref, p: { contributionId: string; contributor: string; sig: ReturnType<typeof sigArg> }) => this.trust.chain!.recordAcceptance(siteId, p.contributionId, p.contributor, p.sig));
    trust.onRetry("settings", (siteId, _ref, p: { settings: RewardSettings; sig: ReturnType<typeof sigArg> }) => this.trust.chain!.setSettings(siteId, p.settings, p.sig));
  }

  /** Whether the deployed OrdoTrust has rewards and cases (v3). */
  async v3(): Promise<boolean> {
    if (!this.trust.chain) return false;
    this.v3cache ??= await this.trust.chain.hasFunction("isActiveTester(string,address)").catch(() => false);
    return this.v3cache;
  }

  private async contribution(siteId: string, id: string) {
    const r = await this.db.query<{ id: string; status: string; user_id: string; address: string; name: string | null; run_id: string; stage_code: string; signature_id: string | null; signed_at: string | null }>(
      "SELECT c.id, c.status, c.user_id, c.address, u.display_name AS name, c.run_id, c.stage_code, c.signature_id, c.signed_at::text FROM contributions c JOIN users u ON u.id = c.user_id WHERE c.id = $1 AND c.site_id = $2",
      [id, siteId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Proof of work not found");
    return r.rows[0];
  }

  /**
   * A validator with an active stake (when stakes are on). A manager selects without one, except on a v3 OrdoTrust:
   * there the selection is the on-chain acceptance, which the contract takes only from a staked validator.
   */
  private async canSelect(siteId: string, user: User) {
    const roles = await this.trust.rolesOf(siteId, user.id);
    if (roles.includes("manager") && !(await this.v3())) return;
    await this.trust.requireValidator(siteId, user);
  }

  async selectRequest(siteId: string, user: User, id: string, comment: string, chainId?: number): Promise<TypedSignature> {
    const c = await this.contribution(siteId, id);
    if (c.status === "selected") throw new HttpError(409, "Already selected");
    if (c.status !== "signed") throw new HttpError(409, "Only a signed proof of work can be selected");
    if (c.user_id === user.id) throw new HttpError(403, "You cannot select your own proof of work");
    await this.canSelect(siteId, user);
    await this.assertStageOpen(siteId, c.run_id, c.stage_code, id);
    return this.sigs.request(user, {
      action: "contribution.select",
      entity: `${id}#${c.address.toLowerCase()}`,
      meaning: `Select ${c.name ?? c.address}'s proof of work as the valid one for stage ${c.stage_code} of run ${c.run_id}`,
      comment,
      site: siteId,
      ...this.trust.contractDomain(await this.v3(), chainId),
    });
  }

  private async assertStageOpen(siteId: string, runId: string, stage: string, except: string) {
    const r = await this.db.query("SELECT 1 FROM contributions WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 AND status = 'selected' AND id <> $4", [siteId, runId, stage, except]);
    if (r.rows.length) throw new HttpError(409, `Stage ${stage} already has a selected proof of work`);
  }

  async select(siteId: string, user: User, id: string, input: { comment: string; nonce: string; signature: Hex }) {
    const c = await this.contribution(siteId, id);
    if (c.user_id === user.id) throw new HttpError(403, "You cannot select your own proof of work");
    await this.canSelect(siteId, user);
    const record = await this.contributions.sealedRecord(siteId, id);
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "contribution.select", entity: `${id}#${c.address.toLowerCase()}` }, input);
      const other = await q.query("SELECT 1 FROM contributions WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 AND status = 'selected'", [siteId, c.run_id, c.stage_code]);
      if (other.rows.length) throw new HttpError(409, `Stage ${c.stage_code} already has a selected proof of work`);
      const upd = await q.query(
        "UPDATE contributions SET status = 'selected', selected_by = $2, selected_at = now(), select_signature_id = $3, select_comment = $4 WHERE id = $1 AND status = 'signed' RETURNING id",
        [id, user.address.toLowerCase(), s.id, input.comment || null],
      );
      if (!upd.rows.length) throw new HttpError(409, "Only a signed proof of work can be selected");
      await q.query("UPDATE contributions SET status = 'not_selected' WHERE site_id = $1 AND run_id = $2 AND stage_code = $3 AND id <> $4 AND status = 'signed'", [siteId, c.run_id, c.stage_code, id]);
      return s;
    });
    await this.contributions.closeStageSessions(siteId, c.run_id, c.stage_code);

    // the stage closes from the selected record
    const before = await this.engine.view(siteId, c.run_id);
    const st = before.stages.find((s) => s.code === c.stage_code);
    const good = record.measurements.find((m) => m.label === GOOD)?.value;
    const scrap = record.measurements.find((m) => m.label === SCRAP)?.value ?? 0;
    let closed = false;
    if (st?.state === "running" && good !== undefined) {
      const readings = record.measurements.flatMap((m) => {
        const crit = st.criteria.find((x) => x.label === m.label);
        return crit?.signal ? [{ signal: crit.signal, value: m.value }] : [];
      });
      await this.engine.record(siteId, `user:${user.address}`, c.run_id, c.stage_code, { good, scrap, complete: true, note: `From proof of work ${id} by ${c.name ?? c.address}`, readings });
      closed = true;
    } else if (st?.state === "awaiting_approval" && st.mode !== "approve" && !st.criteriaResults.some((x) => x.ok === false)) {
      // the machine finished and every criterion it measured passed; the stage waits only for a person to confirm it
      // (a line at L1 or L2), and selecting a proof of work for it is that confirmation. A failed criterion, or a release
      // stage, stays with whoever its gate names.
      const reason = `Confirmed by the proof of work ${id} of ${c.name ?? c.address}, selected by ${user.address}`;
      if (st.gateItemId)
        await this.db.query("UPDATE inbox_items SET status = 'approved', reason = $1, decided_by = $2, decided_at = now() WHERE id = $3 AND status = 'pending'", [reason, user.address, st.gateItemId]);
      await this.engine.release(siteId, c.run_id, c.stage_code);
      await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "gate.released", runId: c.run_id, stageCode: c.stage_code, summary: `Released gate ${c.stage_code} ${st.name}`, reason, data: { contributionId: id, signatureId: sig.id } });
      await this.engine.tickRun(siteId, c.run_id);
      closed = true;
    }

    const d = await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "contribution.selected",
      runId: c.run_id,
      stageCode: c.stage_code,
      summary: `Selected ${c.name ?? c.address}'s proof of work for ${c.stage_code}${closed ? "; the stage closed from it" : ""}`,
      reason: input.comment || null,
      data: { contributionId: id, contributor: c.address, validator: user.address, signatureId: sig.id },
    });
    await this.db.query("UPDATE contributions SET acceptance_json = $2 WHERE id = $1", [id, JSON.stringify({ ledgerSeq: d.ledgerSeq ?? null })]);
    let chain: RelayView | null = null;
    if (await this.v3()) {
      const arg = sigArg(sig.typed, input.signature);
      chain = await this.trust.relay(siteId, "acceptance", `acc_${id}`, { contributionId: id, contributor: c.address.toLowerCase(), sig: arg }, () => this.trust.chain!.recordAcceptance(siteId, id, c.address.toLowerCase(), arg));
    }
    return { contributionId: id, stageClosed: closed, chain };
  }

  // ---------------------------------------------------------------- rewards

  async settings(siteId: string): Promise<{ settings: RewardSettings; onchain: boolean }> {
    if (await this.v3()) {
      const s = await this.trust.chain!.settings(siteId).catch(() => null);
      if (s && (s.maxSlashBps > 0 || s.responseWindow > 0)) return { settings: s, onchain: true };
    }
    return { settings: DEFAULT_SETTINGS, onchain: false };
  }

  async settingsRequest(siteId: string, manager: User, s: RewardSettings, chainId?: number) {
    if (!(await this.v3())) throw new HttpError(409, "Rewards need the v3 OrdoTrust contract on this deployment");
    return this.sigs.request(manager, { action: "site.settings", entity: settingsEntity(s), meaning: "Change this org's rewards and slashing settings", comment: "", site: siteId, ...this.trust.contractDomain(true, chainId) });
  }

  async setSettings(siteId: string, manager: User, s: RewardSettings, proof: { nonce: string; signature: Hex }) {
    if (!(await this.v3())) throw new HttpError(409, "Rewards need the v3 OrdoTrust contract on this deployment");
    const sig = await this.db.tx((q) => this.sigs.consume(q, manager, { action: "site.settings", entity: settingsEntity(s) }, proof));
    const arg = sigArg(sig.typed, proof.signature);
    await this.rec.decide(siteId, { agent: `user:${manager.address}`, kind: "rewards.settings_changed", summary: "Changed the rewards and slashing settings", data: { settings: s, signatureId: sig.id } });
    return this.trust.relay(siteId, "settings", `settings_${sig.id}`, { settings: s, sig: arg }, () => this.trust.chain!.setSettings(siteId, s, arg));
  }

  /** The org's reward pool, my claimable balance, and every selected proof of work with its on-chain acceptance. */
  async rewards(siteId: string, me: User) {
    const v3 = await this.v3();
    const chain = this.trust.chain;
    const info = chain ? await chain.info().catch(() => null) : null;
    const { settings, onchain } = await this.settings(siteId);
    const rows = await this.db.query<{ id: string; run_id: string; stage_code: string; address: string; name: string | null; selected_by: string; selected_by_name: string | null; selected_at: string; open_case: string | null }>(
      `SELECT c.id, c.run_id, c.stage_code, c.address, u.display_name AS name, c.selected_by, s.display_name AS selected_by_name, c.selected_at::text,
         (SELECT k.id FROM cases k WHERE k.contribution_id = c.id AND k.status IN ('open','responded') LIMIT 1) AS open_case
       FROM contributions c JOIN users u ON u.id = c.user_id LEFT JOIN users s ON s.address = c.selected_by
       WHERE c.site_id = $1 AND c.status = 'selected' ORDER BY c.selected_at DESC LIMIT 100`,
      [siteId],
    );
    const acceptances: AcceptanceView[] = [];
    for (const r of rows.rows) {
      acceptances.push({
        contributionId: r.id,
        runId: r.run_id,
        stageCode: r.stage_code,
        contributor: { address: r.address, name: r.name },
        validator: { address: r.selected_by, name: r.selected_by_name },
        selectedAt: new Date(r.selected_at).toISOString(),
        onchain: v3 ? await chain!.acceptance(siteId, r.id).catch(() => null) : null,
        relay: v3 ? await this.trust.relayOf(siteId, `acc_${r.id}`) : null,
        openCase: r.open_case,
      });
    }
    return {
      configured: Boolean(chain),
      v3,
      symbol: info?.symbol ?? "HBAR",
      decimals: info?.decimals ?? 8,
      settings,
      settingsOnchain: onchain,
      pool: v3 ? await chain!.rewardPool(siteId).catch(() => null) : null,
      claimable: v3 ? await chain!.claimable(siteId, me.address).catch(() => null) : null,
      acceptances,
    };
  }

  /** Credit a vested acceptance to the contributor and validator (anyone may ask; Ordo's relayer pays the gas). */
  async settle(siteId: string, contributionId: string) {
    if (!(await this.v3())) throw new HttpError(409, "Rewards need the v3 OrdoTrust contract on this deployment");
    const a = await this.trust.chain!.acceptance(siteId, contributionId);
    if (!a) throw new HttpError(404, "No acceptance on-chain for this proof of work yet");
    if (a.settled) throw new HttpError(409, "Already settled");
    if (a.frozen) throw new HttpError(409, "A case froze this acceptance");
    if (a.vestAt * 1000 > this.now()) throw new HttpError(409, `It vests ${new Date(a.vestAt * 1000).toISOString()}`);
    return this.trust.relay(siteId, "settle", `settle_${contributionId}`, { contributionId }, () => this.trust.chain!.settle(siteId, contributionId), false);
  }

  /** Pay my claimable rewards to my own wallet; Ordo's relayer pays the gas. */
  async claim(siteId: string, me: User) {
    if (!(await this.v3())) throw new HttpError(409, "Rewards need the v3 OrdoTrust contract on this deployment");
    const amount = await this.trust.chain!.claimable(siteId, me.address);
    if (BigInt(amount) === 0n) throw new HttpError(409, "Nothing to claim yet");
    return this.trust.relay(siteId, "claim", `claim_${me.address}_${Date.now()}`, { account: me.address }, () => this.trust.chain!.claimFor(siteId, me.address), false);
  }

  /** Settle acceptances whose challenge window has passed. */
  async reconcile() {
    if (!(await this.v3())) return;
    const rows = await this.db.query<{ id: string; site_id: string }>(
      `SELECT c.id, c.site_id FROM contributions c WHERE c.status = 'selected' AND c.selected_at < now() - interval '1 hour'
         AND NOT EXISTS (SELECT 1 FROM chain_relays r WHERE r.site_id = c.site_id AND r.ref = 'settle_' || c.id AND r.status = 'done') LIMIT 10`,
    );
    for (const r of rows.rows) {
      const a = await this.trust.chain!.acceptance(r.site_id, r.id).catch(() => null);
      if (a && !a.settled && !a.frozen && a.vestAt * 1000 <= this.now()) await this.settle(r.site_id, r.id).catch((e) => console.error("[ordo] settle", e));
    }
  }
}
