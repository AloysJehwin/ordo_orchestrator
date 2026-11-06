import type { Hex } from "viem";
import type { Signatures, User } from "../auth/auth.js";
import type { PassportRail } from "../chain/passport.js";
import { chainErrorMessage } from "../chain/errors.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import type { Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import type { Proof } from "./proof.js";
import type { Recorder } from "./recorder.js";
import type { LotNames, LotNameView } from "./lot-names.js";
import type { Names } from "./names.js";
import type { SpecProofs } from "./spec-proofs.js";
import type { StageProofs } from "./stage-proofs.js";
import type { Trust } from "./trust.js";

export type PassportStatus = "in_production" | "held" | "completed" | "aborted" | "shipped";

interface Row {
  run_id: string;
  site_id: string;
  status: PassportStatus;
  token_id: string | null;
  serial: number | null;
  onchain_status: string | null;
  mint_tx: string | null;
  last_tx: string | null;
  error: string | null;
  shipped_to: string | null;
  shipped_at: string | null;
  ship_tx: string | null;
  ship_pending: boolean | null;
  created_at: string;
}

/** The ledger re-walked for a lot, and the anchor that covers its last entry */
export interface LotProof {
  chainIntact: boolean;
  headSeq: number | null;
  entries: number;
  lastSeq: number;
  anchor: { kind: string; ref: string; url: string | null; toSeq: number; at: string; matchesChain: boolean | null; external: unknown } | null;
  checkedAt: string;
}

export interface PassportView {
  runId: string;
  status: PassportStatus;
  /** the page a QR code opens */
  pageUrl: string;
  nft: { tokenId: string; serial: number | null; url: string | null; onchainStatus: string | null; mintTxUrl: string | null; error: string | null } | null;
  shipment: { to: string; at: string; txUrl: string | null; pending: boolean | null } | null;
  /** the lot's ENS name (lot-<order>.<site>.<parent>) and its releases recorded there */
  ens?: LotNameView | null;
}

/** The status a lot's passport shows, computed from the run and its stages. */
const STATUS_SQL = `CASE WHEN p.shipped_at IS NOT NULL THEN 'shipped'
  WHEN r.status = 'aborted' THEN 'aborted'
  WHEN EXISTS (SELECT 1 FROM stage_runs s WHERE s.run_id = r.id AND s.state = 'held') THEN 'held'
  WHEN r.status = 'completed' THEN 'completed' ELSE 'in_production' END`;
const ACCOUNT = /^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/;
const PROOF_TTL_MS = 60_000;

/**
 * A digital passport for every production lot (run): what was made, from which template version, stage by stage,
 * who signed which gate, which validation packages released it and with whose stake, and the ledger anchor that
 * proves the record. With an HTS collection configured each passport is an NFT that follows the lot: minted at
 * start, its metadata updated when the lot is held, completed or shipped, and airdropped to the customer.
 */
export class Passports {
  private proofCache = new Map<string, { at: number; value: LotProof }>();

  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private engine: RunEngine,
    private trust: Trust,
    private proof: Proof,
    readonly rail: PassportRail | null,
    private base: string | null,
    private chainId: number,
    private now: () => number,
  ) {}
  /** ENS names of the site's people, when names are issued */
  names: Names | null = null;
  /** The lot's own ENS name, when lot names are on */
  lots: LotNames | null = null;
  /** zero-knowledge proofs that the lot met its criteria, shown on the public page in place of the measurements */
  specs: SpecProofs | null = null;
  /** proof of work: each stage's counts signed at the source, and a zero-knowledge proof that they meet its criteria */
  stages: StageProofs | null = null;

  /** The public page for a lot; relative when the deployment does not know its own URL. */
  pageUrl(runId: string) {
    return `${this.base ?? ""}/#/passport/${runId}`;
  }
  /** NFT metadata (≤ 100 bytes): the HIP-412 JSON URL, with the status once it moves on, so HashScan shows the history. */
  metadata(runId: string, status: PassportStatus) {
    const suffix = status === "in_production" ? "" : `?s=${status}`;
    return this.base ? `${this.base}/v1/public/passports/${runId}${suffix}` : `ordo:passport:${runId}${suffix}`;
  }

  // ---------------------------------------------------------------- engine cycle
  /** Give new runs a passport, follow status changes, and mint or update NFTs (a few per cycle, with back-off). */
  async reconcile(limit = 3): Promise<void> {
    await this.db.query("INSERT INTO passports (run_id, site_id, status, token_id) SELECT r.id, r.site_id, 'in_production', $1 FROM runs r LEFT JOIN passports p ON p.run_id = r.id WHERE p.run_id IS NULL", [this.rail?.tokenId ?? null]);
    await this.db.query(`UPDATE passports p SET status = ${STATUS_SQL}, updated_at = now() FROM runs r WHERE r.id = p.run_id AND p.status <> ${STATUS_SQL}`);
    if (limit > 0) await this.specs?.reconcile();
    if (!this.rail) return;
    const due = await this.db.query<Row>(
      `SELECT * FROM passports WHERE token_id = $1 AND (serial IS NULL OR onchain_status IS DISTINCT FROM status) AND status <> 'shipped'
       AND (next_try_at IS NULL OR next_try_at <= $2) ORDER BY created_at LIMIT ${limit}`,
      [this.rail.tokenId, new Date(this.now()).toISOString()],
    );
    for (const p of due.rows) await this.push(p);
  }

  private async push(p: Row) {
    const rail = this.rail!;
    try {
      if (p.serial === null) {
        const r = await rail.mint(this.metadata(p.run_id, p.status));
        await this.db.query("UPDATE passports SET serial = $1, onchain_status = $2, mint_tx = $3, last_tx = $3, error = NULL, next_try_at = NULL, updated_at = now() WHERE run_id = $4", [r.serial, p.status, r.txId, p.run_id]);
        await this.rec.event("system:passport", "passport.minted", p.run_id, { site: p.site_id, tokenId: rail.tokenId, serial: r.serial, txId: r.txId, status: p.status });
      } else {
        const r = await rail.update(p.serial, this.metadata(p.run_id, p.status));
        await this.db.query("UPDATE passports SET onchain_status = $1, last_tx = $2, error = NULL, next_try_at = NULL, updated_at = now() WHERE run_id = $3", [p.status, r.txId, p.run_id]);
        await this.rec.event("system:passport", "passport.updated", p.run_id, { site: p.site_id, tokenId: rail.tokenId, serial: p.serial, txId: r.txId, status: p.status });
      }
    } catch (e) {
      await this.db.query("UPDATE passports SET error = $1, next_try_at = $2, updated_at = now() WHERE run_id = $3", [chainErrorMessage(e), new Date(this.now() + 60_000).toISOString(), p.run_id]);
    }
  }

  // ---------------------------------------------------------------- shipping (signed)
  private async shippable(siteId: string, roles: Role[], runId: string, to: string) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager ships a lot");
    if (!ACCOUNT.test(to)) throw new HttpError(400, "Ship to a Hedera account id (0.0.x) or an EVM address");
    await this.reconcile(0);
    const p = await this.row(siteId, runId);
    if (p.status === "shipped") throw new HttpError(409, "This lot has shipped");
    if (p.status !== "completed") throw new HttpError(409, "Only a completed lot ships");
    if (this.rail && p.serial === null) throw new HttpError(409, "The passport NFT is not minted yet; try again in a minute");
    return p;
  }
  async shipRequest(siteId: string, user: User, roles: Role[], runId: string, to: string) {
    await this.shippable(siteId, roles, runId, to);
    const run = await this.engine.view(siteId, runId);
    return this.sigs.request(user, { action: "lot.ship", entity: `${runId}#${to}`, meaning: `Ship lot ${run.orderRef} (${run.quantity} units) to ${to}`, comment: "", site: siteId, chainId: this.chainId });
  }
  async ship(siteId: string, user: User, roles: Role[], runId: string, i: { to: string; nonce: string; signature: Hex }) {
    const p = await this.shippable(siteId, roles, runId, i.to);
    const sig = await this.db.tx((q) => this.sigs.consume(q, user, { action: "lot.ship", entity: `${runId}#${i.to}` }, i));
    let txId: string | null = null;
    let pending: boolean | null = null;
    if (this.rail && p.serial !== null) {
      try {
        await this.rail.update(p.serial, this.metadata(runId, "shipped"));
        const r = await this.rail.ship(p.serial, i.to);
        txId = r.txId;
        pending = r.pending;
      } catch (e) {
        throw new HttpError(502, `The NFT could not be sent: ${chainErrorMessage(e)}`);
      }
    }
    await this.db.query("UPDATE passports SET status = 'shipped', onchain_status = $1, shipped_to = $2, shipped_at = now(), ship_tx = $3, ship_pending = $4, updated_at = now() WHERE run_id = $5", [
      this.rail ? "shipped" : null,
      i.to,
      txId,
      pending,
      runId,
    ]);
    await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "lot.shipped",
      runId,
      summary: `Lot shipped to ${i.to}${txId ? (pending ? "; passport NFT awaits the customer's claim" : "; passport NFT delivered") : ""}`,
      data: { to: i.to, signatureId: sig.id, txId, pending },
    });
    return this.get(siteId, runId);
  }

  // ---------------------------------------------------------------- reads
  private async row(siteId: string | null, runId: string): Promise<Row> {
    const r = (await this.db.query<Row>(`SELECT *, created_at::text AS created_at, shipped_at::text AS shipped_at FROM passports WHERE run_id = $1 ${siteId ? "AND site_id = $2" : ""}`, siteId ? [runId, siteId] : [runId])).rows[0];
    if (!r) throw new HttpError(404, "No passport for this lot");
    return r;
  }
  private view(p: Row): PassportView {
    const rail = this.rail;
    return {
      runId: p.run_id,
      status: p.status,
      pageUrl: this.pageUrl(p.run_id),
      nft: p.token_id
        ? {
            tokenId: p.token_id,
            serial: p.serial,
            url: rail && p.serial !== null ? rail.nftUrl(p.serial) : null,
            onchainStatus: p.onchain_status,
            mintTxUrl: rail && p.mint_tx ? rail.txUrl(p.mint_tx) : null,
            error: p.error,
          }
        : null,
      shipment: p.shipped_at ? { to: p.shipped_to!, at: new Date(p.shipped_at).toISOString(), txUrl: rail && p.ship_tx ? rail.txUrl(p.ship_tx) : null, pending: p.ship_pending } : null,
    };
  }
  async get(siteId: string, runId: string): Promise<PassportView> {
    await this.reconcile(0);
    return { ...this.view(await this.row(siteId, runId)), ens: (await this.lots?.ofLot(runId)) ?? null };
  }

  /**
   * What anyone holding the lot (or scanning its QR code) may see, without signing in: HIP-412 NFT metadata plus
   * the evidence. People appear by wallet address and role, and by the ENS name the site issued them, never by
   * their account name. Process numbers (measurements, unit counts, yield) stay private: each criterion shows whether
   * it was met and, where it was, a zero-knowledge proof of that against a commitment in the ledger.
   */
  async publicView(runId: string) {
    const p = await this.row(null, runId);
    const ens = (await this.names?.ofPeople(p.site_id)) ?? new Map<string, string>();
    const run = await this.engine.view(p.site_id, runId);
    const site = (await this.db.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [p.site_id])).rows[0];
    const decisions = await this.rec.decisions(p.site_id, { runId, limit: 200 });
    const signed = decisions
      .filter((d) => d.agent.startsWith("user:") && typeof (d.data as { signatureId?: unknown }).signatureId === "string")
      .map((d) => ({ kind: d.kind, summary: d.summary, stageCode: d.stageCode, by: d.agent.slice(5), ens: ens.get(d.agent.slice(5).toLowerCase()) ?? null, at: d.ts, ledgerSeq: d.ledgerSeq }));
    const agents = decisions.filter((d) => !d.agent.startsWith("user:")).length;
    const releases = await this.releases(p.site_id, runId, ens);
    const zk = (await this.specs?.forRun(runId)) ?? new Map();
    // a parameter proof names who committed to the value: the instrument's gateway, the operator, or Ordo
    const zkView = (key: string) => {
      const v = zk.get(key);
      return v ? { ...v, signerEns: v.signer ? ens.get(v.signer.toLowerCase()) ?? null : null } : null;
    };
    const work = (await this.stages?.forRun(runId)) ?? new Map();
    const lastSeq = Math.max(0, ...decisions.map((d) => d.ledgerSeq ?? 0), ...[...zk.values()].map((z) => z.ledgerSeq ?? 0));
    const view = { ...this.view(p), ens: (await this.lots?.ofLot(runId)) ?? null };
    const name = `Lot ${run.orderRef}`;
    // every part of the lot by its ENS name: the run (the lot), its org, each stage and the machine that ran it
    const want: Record<string, ["stage" | "machine" | "run" | "org", string | null]> = { run: ["run", runId], org: ["org", p.site_id] };
    for (const s of run.stages) {
      want[`stage:${s.code}`] = ["stage", `${runId}:${s.code}`];
      want[`machine:${s.code}`] = ["machine", s.assetId ?? null];
    }
    const named = (await this.names?.many(p.site_id, want).catch(() => null)) ?? {};
    return {
      // HIP-412 fields, so wallets and explorers render the NFT
      name,
      creator: site?.name ?? "Ordo",
      description: `${run.quantity} units of ${run.templateName} v${run.templateVersion}, made at ${site?.name ?? "an Ordo site"}. Every stage, signature and release is in Ordo's hash-chained ledger.`,
      image: this.base ? `${this.base}/favicon.svg` : undefined,
      type: "image/svg+xml",
      properties: {
        runId,
        status: p.status,
        orderRef: run.orderRef,
        quantity: run.quantity,
        product: `${run.templateName} v${run.templateVersion}`,
        ...(named.run ? { ens: named.run } : {}),
        ...(named.org ? { org: named.org } : {}),
      },
      // the passport
      passport: {
        ...view,
        site: site?.name ?? null,
        orderRef: run.orderRef,
        quantity: run.quantity,
        product: { name: run.templateName, category: run.templateCategory, version: run.templateVersion },
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        stages: run.stages.map((s) => ({
          code: s.code,
          name: s.name,
          ens: named[`stage:${s.code}`] ?? null,
          machineEns: named[`machine:${s.code}`] ?? null,
          state: s.state,
          mode: s.mode,
          resource: s.assetName ?? s.resourceKind,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          // the target and whether it was met; the value stays private. A range proves twice: its lower bound, and its upper under `#max`
          criteria: s.criteriaResults.map((c) => ({ label: c.label, target: c.target, ok: c.ok, band: c.band ?? { lo: null, hi: null }, unit: c.unit ?? "", zk: zkView(`${s.code}|${c.label}`), zkMax: zkView(`${s.code}|${c.label}#max`) })),
          deviation: s.deviation,
          // who signed the stage's counts where they were made, and the proof they meet its criteria; never the counts
          work: work.has(s.code) ? { ...work.get(s.code)!, signerEns: ens.get(work.get(s.code)!.signer.toLowerCase()) ?? null } : null,
        })),
        signed,
        agentDecisions: agents,
        releases,
        proof: await this.proofFor(runId, lastSeq),
      },
    };
  }

  /** Validation packages that released this lot: who signed, whether it is on-chain, and the signers' stake now. */
  private async releases(siteId: string, runId: string, ens: Map<string, string>) {
    const pkgs = await this.db.query<{ id: string; number: number; type: string; title: string; updated_at: string; release_json: string | null }>(
      "SELECT id, number, type, title, updated_at::text AS updated_at, release_json FROM validation_packages WHERE site_id = $1 AND run_id = $2 AND status = 'released' ORDER BY number",
      [siteId, runId],
    );
    const chain = this.trust.chain;
    return Promise.all(
      pkgs.rows.map(async (v) => {
        const sigs = await this.db.query<{ meaning: string; address: string }>(
          "SELECT meaning, address FROM package_signatures WHERE package_id = $1 AND cleared_at IS NULL ORDER BY created_at",
          [v.id],
        );
        const signers = await Promise.all(
          sigs.rows.map(async (s) => ({
            meaning: s.meaning,
            address: s.address,
            ens: ens.get(s.address.toLowerCase()) ?? null,
            stake:
              chain && s.meaning !== "performed"
                ? await Promise.all([chain.stakeOf(siteId, s.address), chain.isActiveValidator(siteId, s.address)])
                    .then(([st, active]) => ({ amount: st.amount, active, symbol: chain.cfg.symbol, decimals: chain.cfg.decimals }))
                    .catch(() => null)
                : null,
          })),
        );
        const relay = await this.trust.relayOf(siteId, v.id);
        // what the three signed: the lot, the content hash and the root of its stage proofs
        const st = v.release_json ? (JSON.parse(v.release_json) as { lot: string; contentHash: string; proofRoot: string; stages: string[] }) : null;
        const statement = st ? { lot: st.lot, contentHash: st.contentHash, proofRoot: st.proofRoot, stagesProven: st.stages } : null;
        return { id: v.id, number: v.number, type: v.type, title: v.title, releasedAt: new Date(v.updated_at).toISOString(), signers, statement, onchain: relay?.status === "done" ? { txUrl: relay.txUrl, contract: chain?.cfg.address ?? null } : null };
      }),
    );
  }

  /** The ledger re-walked and the anchor that covers this lot's last entry, cached briefly (it re-reads the chain). */
  private async proofFor(runId: string, lastSeq: number): Promise<LotProof> {
    const hit = this.proofCache.get(runId);
    if (hit && this.now() - hit.at < PROOF_TTL_MS) return hit.value;
    const v = await this.proof.verify(runId);
    const anchor = lastSeq ? await this.proof.covering(lastSeq) : null;
    const value = {
      chainIntact: v.ok,
      headSeq: v.headSeq,
      entries: v.subject?.entries.length ?? 0,
      lastSeq,
      anchor: anchor ? { kind: anchor.kind, ref: anchor.ref, url: anchor.url, toSeq: anchor.toSeq, at: anchor.ts, matchesChain: anchor.matchesChain, external: anchor.external } : null,
      checkedAt: new Date(this.now()).toISOString(),
    };
    this.proofCache.set(runId, { at: this.now(), value });
    return value;
  }
}
