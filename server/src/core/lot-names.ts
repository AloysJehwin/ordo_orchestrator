import type { Address, Hex } from "viem";
import type { ReleaseTyped } from "../auth/auth.js";
import { chainErrorMessage } from "../chain/errors.js";
import type { TxState } from "../chain/ensv2.js";
import { releaseSigArg, type ReleaseLot, type ReleaseSigArg } from "../chain/trust.js";
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import type { Names } from "./names.js";
import type { Recorder } from "./recorder.js";
import type { StageProofArg } from "./stage-proofs.js";
import type { ParamProofArg } from "./spec-proofs.js";

/** What LotNames needs from ENSv2 (EnsV2 in production): OrdoNames' roles and OrdoRunResolver's releases. */
export interface ReleaseRail {
  roles(siteId: string, account: Address): Promise<number>;
  sendRecordRelease(i: { lot: ReleaseLot; sigs: ReleaseSigArg[]; proofs: StageProofArg[]; params: ParamProofArg[] }): Promise<Hex>;
  check(hashes: Hex[]): Promise<TxState>;
  txUrl(hash: string): string | null;
  appUrl(name: string): string;
}

type Status = "pending" | "done" | "failed" | "legacy";
interface Row {
  id: string;
  site_id: string;
  run_id: string;
  package_id: string;
  name: string | null;
  status: Status;
  payload_json: string;
  pending_tx: string | null;
  sent_at: string | null;
  tx_hash: string | null;
  error: string | null;
  attempts: number;
}
interface ReleasePayload {
  lot: ReleaseLot;
  sigs: ReleaseSigArg[];
  proofs: StageProofArg[];
  params?: ParamProofArg[];
  signers: { meaning: string; address: Address }[];
}
// payloads carry uint64/uint256 values: keep them exact through JSON
const BIG = "\u0000n:";
const toJson = (v: unknown) => JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? `${BIG}${x}` : x));
const fromJson = <T>(s: string): T => JSON.parse(s, (_, x: unknown) => (typeof x === "string" && x.startsWith(BIG) ? BigInt(x.slice(BIG.length)) : x)) as T;

export interface LotNameView {
  name: string;
  url: string;
  status: string;
  /** the releases recorded on Sepolia against the signers' role names */
  releases: { packageId: string; status: Status; txUrl: string | null; error: string | null }[];
}

const MAX_ATTEMPTS = 6;
const STUCK_MS = 10 * 60_000;
/** OrdoNames role bits each release signer needs: any role, VALIDATOR, VALIDATOR and PLANT_MANAGER (a manager) */
const NEEDS: Record<string, { bits: number; label: string }> = {
  performed: { bits: 0, label: "a role" },
  reviewed: { bits: 4, label: "the validator role" },
  approved: { bits: 12, label: "the manager role" },
};
const COLS = "id, site_id, run_id, package_id, name, status, payload_json, pending_tx, sent_at::text AS sent_at, tx_hash, error, attempts";

/**
 * Releases on run names. A run's name (so-7781.runs.acme.ordo.eth) is what the three release statements sign as the
 * lot, and once the package is released OrdoRunResolver records it there: only with signatures from people whose names
 * give them the roles, and only if every stage and parameter proof verifies and they fold to the root the three signed.
 * The run name then answers the com.ordo.release* records from the contract, beside the records Names writes.
 */
export class LotNames {
  constructor(
    private db: Db,
    private rec: Recorder,
    private rail: ReleaseRail | null,
    private names: Names,
    private now: () => number,
  ) {}

  get live() {
    return Boolean(this.rail);
  }

  /** The run's full ENS name, which release statements name as the lot (null when names are off). */
  async lotNameFor(siteId: string, runId: string): Promise<string | null> {
    return this.names.ensure(siteId, "run", runId);
  }

  /** Queue a released package to be recorded on its run's name, with its stage and parameter proofs. */
  async release(siteId: string, lot: ReleaseLot, proofs: StageProofArg[], params: ParamProofArg[] = []) {
    if (!this.rail || !lot.runId) return;
    const rows = await this.db.query<{ meaning: string; address: string; typed_data: string; signature: string }>(
      "SELECT ps.meaning, ps.address, s.typed_data, s.signature FROM package_signatures ps JOIN signatures s ON s.id = ps.signature_id WHERE ps.package_id = $1 AND ps.cleared_at IS NULL",
      [lot.packageId],
    );
    const by = (m: string) => {
      const r = rows.rows.find((x) => x.meaning === m);
      if (!r) throw new HttpError(409, `Missing the ${m} signature`);
      return r;
    };
    const ordered = ["performed", "reviewed", "approved"].map(by);
    const payload: ReleasePayload = {
      lot,
      sigs: ordered.map((r) => releaseSigArg(JSON.parse(r.typed_data) as ReleaseTyped, r.signature)),
      proofs,
      params,
      signers: ordered.map((r) => ({ meaning: r.meaning, address: r.address as Address })),
    };
    // a package signed before runs had names named its lot lot-<order>: there is no such name to record it on
    const legacy = !lot.lotLabel.includes(".");
    await this.db.query("INSERT INTO ens_releases (id, site_id, run_id, package_id, name, status, payload_json, error, next_try_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING", [
      `ensrel:${lot.packageId}`,
      siteId,
      lot.runId,
      lot.packageId,
      legacy ? null : lot.lotLabel,
      legacy ? "legacy" : "pending",
      toJson(payload),
      legacy ? "Signed before runs had ENS names" : null,
      this.iso(),
    ]);
  }

  // ---------------------------------------------------------------- engine cycle
  async reconcile(limit = 2): Promise<number> {
    if (!this.rail) return 0;
    const due = await this.db.query<Row>(`SELECT ${COLS} FROM ens_releases WHERE status = 'pending' AND next_try_at <= $1 ORDER BY created_at LIMIT ${limit}`, [this.iso()]);
    for (const r of due.rows) {
      try {
        if (r.pending_tx) await this.confirm(r);
        else await this.record(r);
      } catch (e) {
        const attempts = Number(r.attempts) + 1;
        await this.db.query("UPDATE ens_releases SET status = $1, error = $2, attempts = $3, next_try_at = $4, pending_tx = NULL, updated_at = now() WHERE id = $5", [
          attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          chainErrorMessage(e),
          attempts,
          this.iso(60_000 * 2 ** (attempts - 1)),
          r.id,
        ]);
      }
    }
    return due.rows.length;
  }

  private async record(r: Row) {
    const rail = this.rail!;
    const p = fromJson<ReleasePayload>(r.payload_json);
    // wait for the run's name to be on-chain, without counting it as a failure
    if (!(await this.names.onChain(r.site_id, "run", r.run_id))) return;
    const name = await this.names.nameOf(r.site_id, "run", r.run_id);
    if (name !== p.lot.lotLabel) throw new Error(`The release was signed for ${p.lot.lotLabel}, but the run's name is ${name}`);
    // say who lacks which role, instead of a bare revert
    for (const s of p.signers) {
      const need = NEEDS[s.meaning]!;
      const bits = await rail.roles(r.site_id, s.address);
      const ok = need.bits === 0 ? bits !== 0 : (bits & need.bits) === need.bits;
      if (!ok) throw new Error(`${s.address} (${s.meaning}) does not hold ${need.label} through a name at this org yet`);
    }
    const hash = await rail.sendRecordRelease({ lot: p.lot, sigs: p.sigs, proofs: p.proofs, params: p.params ?? [] });
    await this.db.query("UPDATE ens_releases SET pending_tx = $1, sent_at = $2, name = $3, updated_at = now() WHERE id = $4", [hash, this.iso(), name, r.id]);
  }

  private async confirm(r: Row) {
    const hash = r.pending_tx as Hex;
    const st = await this.rail!.check([hash]);
    if (st.state === "pending") {
      if (this.now() - Date.parse(r.sent_at!) > STUCK_MS) throw new Error("Not mined in 10 minutes; sending again");
      return;
    }
    if (st.state === "reverted") throw new Error(`Transaction reverted: ${st.hash}`);
    await this.db.query("UPDATE ens_releases SET status = 'done', tx_hash = $1, pending_tx = NULL, error = NULL, attempts = 0, updated_at = now() WHERE id = $2", [hash, r.id]);
    const p = fromJson<ReleasePayload>(r.payload_json);
    const nParams = p.params?.length ?? 0;
    const proven = p.proofs.length || nParams ? ` and ${p.proofs.length} stage proof${p.proofs.length === 1 ? "" : "s"}${nParams ? ` and ${nParams} parameter proof${nParams === 1 ? "" : "s"}` : ""} verified on-chain` : "";
    await this.rec.decide(r.site_id, {
      agent: "system:ens",
      kind: "ens.lot_released",
      runId: r.run_id,
      summary: `Recorded the release on ${r.name}, checked against the signers' role names${proven}`,
      data: { name: r.name, packageId: r.package_id, proofRoot: p.lot.proofRoot, stagesProven: p.proofs.length, paramsProven: nParams, tx: hash },
    });
  }

  async retry(siteId: string, ref: string) {
    await this.db.query("UPDATE ens_releases SET status = 'pending', attempts = 0, next_try_at = $1, updated_at = now() WHERE site_id = $2 AND (package_id = $3 OR run_id = $3) AND status = 'failed'", [this.iso(), siteId, ref]);
  }

  // ---------------------------------------------------------------- reads
  private iso(plus = 0) {
    return new Date(this.now() + plus).toISOString();
  }

  /** A run's ENS name and the releases recorded on it, or null when names are off or it has none yet. */
  async ofLot(runId: string): Promise<LotNameView | null> {
    const run = (await this.db.query<{ site_id: string }>("SELECT site_id FROM runs WHERE id = $1", [runId])).rows[0];
    if (!run || !this.names.live) return null;
    const name = await this.names.nameOf(run.site_id, "run", runId);
    if (!name) return null;
    const rel = await this.db.query<Row>(`SELECT ${COLS} FROM ens_releases WHERE run_id = $1 ORDER BY created_at`, [runId]);
    return {
      name,
      url: this.rail?.appUrl(name) ?? `https://sepolia.app.ens.domains/${name}`,
      status: (await this.names.onChain(run.site_id, "run", runId)) ? "issued" : "pending",
      releases: rel.rows.map((r) => ({ packageId: r.package_id, status: r.status, txUrl: r.tx_hash ? this.rail!.txUrl(r.tx_hash) : null, error: r.error })),
    };
  }
}
