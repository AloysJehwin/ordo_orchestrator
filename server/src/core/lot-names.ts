import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, hexToBytes, parseAbi, type Address, type Hex } from "viem";
import type { ReleaseTyped } from "../auth/auth.js";
import { chainErrorMessage } from "../chain/errors.js";
import { toLabel, type TxState } from "../chain/ensv2.js";
import { releaseSigArg, type ReleaseLot, type ReleaseSigArg } from "../chain/trust.js";
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { personLabel } from "./names.js";
import type { Passports } from "./passports.js";
import type { Recorder } from "./recorder.js";
import type { StageProofArg } from "./stage-proofs.js";
import type { ParamProofArg } from "./spec-proofs.js";

/** What LotNames needs from ENSv2 and Ordo's two ENS contracts (EnsV2 in production). */
export interface LotRail {
  readonly owner: Address;
  readonly cfg: { parentName: string; parentRegistry: Address; lotResolver?: Address; credentials?: Address };
  linkedLabel(siteId: string): Promise<string>;
  sendLinkSite(siteId: string, label: string): Promise<Hex>;
  resolverOf(registry: Address, label: string): Promise<Address>;
  sendUseLotResolver(label: string): Promise<Hex>;
  rolesOf(siteId: string, label: string, account: Address): Promise<number>;
  sendRecordRelease(i: { lot: ReleaseLot; sigs: ReleaseSigArg[]; proofs: StageProofArg[]; params: ParamProofArg[] }): Promise<Hex>;
  signAnswer(request: Hex, result: Hex, expires: bigint): Promise<Hex>;
  check(hashes: Hex[]): Promise<TxState>;
  txUrl(hash: string): string | null;
  appUrl(name: string): string;
}

type Kind = "site" | "lot" | "release";
type Status = "pending" | "done" | "failed";
interface Row {
  id: string;
  site_id: string;
  kind: Kind;
  ref: string;
  label: string;
  name: string;
  status: Status;
  payload_json: string | null;
  pending_txs: string | null;
  sent_at: string | null;
  tx_hash: string | null;
  error: string | null;
  attempts: number;
}
interface ReleasePayload {
  lot: ReleaseLot;
  sigs: ReleaseSigArg[];
  proofs: StageProofArg[];
  /** source-signed parameter proofs, folded after the stages (absent on releases recorded before they existed) */
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
  /** the release recorded on Sepolia against the signers' ENS credentials */
  releases: { packageId: string; status: Status; txUrl: string | null; error: string | null }[];
}

const MAX_ATTEMPTS = 6;
const STUCK_MS = 10 * 60_000;
const ANSWER_TTL_S = 300n;
/** OrdoEnsRoles role bits each release signer needs: any role, VALIDATOR, VALIDATOR + PLANT_MANAGER */
const NEEDS: Record<string, { bits: number; label: string }> = { performed: { bits: 0, label: "a role" }, reviewed: { bits: 4, label: "the validator role" }, approved: { bits: 12, label: "the validator and plant manager roles" } };
const COLS = "id, site_id, kind, ref, label, name, status, payload_json, pending_txs, sent_at::text AS sent_at, tx_hash, error, attempts";

const RESOLVE_ABI = parseAbi(["function resolve(bytes name, bytes data) view returns (bytes)"]);
const RECORD_ABI = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function contenthash(bytes32 node) view returns (bytes)",
]);

/**
 * ENS as Ordo's access layer, on top of the names Names issues:
 *  - each site name is linked in OrdoEnsRoles, so contracts read people's roles from their member names, and points
 *    at OrdoLotResolver, which answers `lot-<order>.<site>.<parent>` for every lot with no registration;
 *  - a released validation package is recorded in OrdoLotResolver with its three release statements, which the
 *    contract accepts only from people whose ENS names carry the right roles, and with each stage's signed reading
 *    and zero-knowledge proof, which it verifies and folds into the proof root those three signed;
 *  - the lot names' other records come from this gateway (CCIP-Read), signed with the ENS owner key.
 */
export class LotNames {
  constructor(
    private db: Db,
    private rec: Recorder,
    private rail: LotRail | null,
    private engine: RunEngine,
    private passports: Passports,
    private now: () => number,
  ) {}

  get live() {
    return Boolean(this.rail);
  }

  // ---------------------------------------------------------------- engine cycle
  async reconcile(limit = 2): Promise<number> {
    if (!this.rail) return 0;
    const sites = await this.db.query<{ site_id: string; label: string; name: string }>("SELECT site_id, label, name FROM ens_names WHERE kind = 'site' AND have_json IS NOT NULL");
    for (const s of sites.rows) {
      await this.db.query("INSERT INTO ens_lots (id, site_id, kind, ref, label, name, status, next_try_at) VALUES ($1,$2,'site',$2,$3,$4,'pending',$5) ON CONFLICT DO NOTHING", [`enslot:site:${s.site_id}`, s.site_id, s.label, s.name, this.iso()]);
      const runs = await this.db.query<{ id: string; order_ref: string }>("SELECT r.id, r.order_ref FROM runs r LEFT JOIN ens_lots l ON l.kind = 'lot' AND l.ref = r.id WHERE r.site_id = $1 AND l.id IS NULL", [s.site_id]);
      for (const r of runs.rows) await this.insertLot(s.site_id, r.id, `lot-${toLabel(r.order_ref)}`, s.name);
    }
    return this.work(limit);
  }

  /** A lot's name, adding -2, -3… when another lot at the site has the same order reference. */
  private async insertLot(siteId: string, runId: string, label: string, siteName: string) {
    for (let n = 1; n < 100; n++) {
      const l = n === 1 ? label : `${label}-${n}`;
      const r = await this.db.query("INSERT INTO ens_lots (id, site_id, kind, ref, run_id, label, name, status) VALUES ($1,$2,'lot',$3,$3,$4,$5,'done') ON CONFLICT DO NOTHING RETURNING id", [`enslot:lot:${runId}`, siteId, runId, l, `${l}.${siteName}`]);
      if (r.rows.length) return;
      if ((await this.db.query("SELECT 1 FROM ens_lots WHERE kind = 'lot' AND ref = $1", [runId])).rows.length) return;
    }
  }

  /** The lot's ENS label, naming it now when the site's name exists, so release signatures can state it. */
  async labelFor(siteId: string, runId: string): Promise<string | null> {
    const have = await this.row("lot", runId);
    if (have) return have.label;
    if (!this.rail) return null;
    const site = (await this.db.query<{ name: string }>("SELECT name FROM ens_names WHERE kind = 'site' AND site_id = $1 AND have_json IS NOT NULL", [siteId])).rows[0];
    const run = (await this.db.query<{ order_ref: string }>("SELECT order_ref FROM runs WHERE id = $1", [runId])).rows[0];
    if (!site || !run) return null;
    await this.insertLot(siteId, runId, `lot-${toLabel(run.order_ref)}`, site.name);
    return (await this.row("lot", runId))?.label ?? null;
  }

  /** Queue a released package to be recorded against the signers' ENS credentials, with its stage proofs. */
  async release(siteId: string, lot: ReleaseLot, proofs: StageProofArg[], params: ParamProofArg[] = []) {
    if (!this.rail || !lot.runId) return;
    const packageId = lot.packageId;
    const rows = await this.db.query<{ meaning: string; address: string; typed_data: string; signature: string }>(
      "SELECT ps.meaning, ps.address, s.typed_data, s.signature FROM package_signatures ps JOIN signatures s ON s.id = ps.signature_id WHERE ps.package_id = $1 AND ps.cleared_at IS NULL",
      [packageId],
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
    await this.db.query("INSERT INTO ens_lots (id, site_id, kind, ref, run_id, label, name, status, payload_json, next_try_at) VALUES ($1,$2,'release',$3,$4,'','','pending',$5,$6) ON CONFLICT DO NOTHING", [
      `enslot:release:${packageId}`,
      siteId,
      packageId,
      lot.runId,
      toJson(payload),
      this.iso(),
    ]);
  }

  private async work(limit: number): Promise<number> {
    const due = await this.db.query<Row>(`SELECT ${COLS} FROM ens_lots WHERE status = 'pending' AND kind <> 'lot' AND next_try_at <= $1 ORDER BY CASE kind WHEN 'site' THEN 0 ELSE 1 END, created_at LIMIT ${limit}`, [this.iso()]);
    for (const r of due.rows) {
      try {
        if (r.pending_txs) await this.confirm(r);
        else if (r.kind === "site") await this.linkSite(r);
        else await this.recordRelease(r);
      } catch (e) {
        const attempts = Number(r.attempts) + 1;
        await this.db.query("UPDATE ens_lots SET status = $1, error = $2, attempts = $3, next_try_at = $4, pending_txs = NULL, updated_at = now() WHERE id = $5", [
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

  /** Link the site in OrdoEnsRoles and point its name at the lot resolver, whichever is not done yet. */
  private async linkSite(r: Row) {
    const rail = this.rail!;
    const hashes: Hex[] = [];
    if ((await rail.linkedLabel(r.site_id)) !== r.label) hashes.push(await rail.sendLinkSite(r.site_id, r.label));
    if ((await rail.resolverOf(rail.cfg.parentRegistry, r.label)).toLowerCase() !== rail.cfg.lotResolver!.toLowerCase()) hashes.push(await rail.sendUseLotResolver(r.label));
    if (!hashes.length) return this.done(r, null);
    await this.sent(r, hashes);
  }

  private async recordRelease(r: Row) {
    const rail = this.rail!;
    const p = fromJson<ReleasePayload>(r.payload_json!);
    const site = await this.row("site", r.site_id);
    const lot = await this.row("lot", p.lot.runId);
    // wait for the site's link and the lot's name without counting it as a failure
    if (site?.status !== "done" || !lot) return;
    // say who lacks which credential, instead of a bare revert
    for (const s of p.signers) {
      const need = NEEDS[s.meaning]!;
      const bits = await rail.rolesOf(r.site_id, personLabel(s.address), s.address);
      if (need.bits === 0 ? bits === 0 : (bits & need.bits) !== need.bits) throw new Error(`${s.address} (${s.meaning}) does not hold ${need.label} through an ENS member name at this site yet`);
    }
    if (lot.label !== p.lot.lotLabel) throw new Error(`The release was signed for ${p.lot.lotLabel}, but the lot's ENS name is ${lot.name}`);
    const hash = await rail.sendRecordRelease({ lot: p.lot, sigs: p.sigs, proofs: p.proofs, params: p.params ?? [] });
    await this.db.query("UPDATE ens_lots SET label = $1, name = $2 WHERE id = $3", [lot.label, lot.name, r.id]);
    await this.sent(r, [hash]);
  }

  private async sent(r: Row, hashes: Hex[]) {
    await this.db.query("UPDATE ens_lots SET pending_txs = $1, sent_at = $2, updated_at = now() WHERE id = $3", [JSON.stringify(hashes), this.iso(), r.id]);
  }

  private async confirm(r: Row) {
    const hashes = JSON.parse(r.pending_txs!) as Hex[];
    const st = await this.rail!.check(hashes);
    if (st.state === "pending") {
      if (this.now() - Date.parse(r.sent_at!) > STUCK_MS) throw new Error("Not mined in 10 minutes; sending again");
      return;
    }
    if (st.state === "reverted") throw new Error(`Transaction reverted: ${st.hash}`);
    const last = hashes[hashes.length - 1]!;
    await this.done(r, last);
    if (r.kind === "site")
      await this.rec.decide(r.site_id, { agent: "system:ens", kind: "ens.site_linked", summary: `${r.name} now carries the site's credentials and its lot names`, data: { name: r.name, tx: last } });
    else {
      const p = fromJson<ReleasePayload>(r.payload_json!);
      const lot = await this.row("lot", p.lot.runId);
      const nParams = p.params?.length ?? 0;
      const proven = p.proofs.length || nParams ? ` and ${p.proofs.length} stage proof${p.proofs.length === 1 ? "" : "s"}${nParams ? ` and ${nParams} parameter proof${nParams === 1 ? "" : "s"}` : ""} verified on-chain` : "";
      await this.rec.decide(r.site_id, { agent: "system:ens", kind: "ens.lot_released", runId: p.lot.runId, summary: `Recorded the release on ${lot?.name ?? "the lot's ENS name"}, checked against the signers' ENS credentials${proven}`, data: { name: lot?.name ?? null, packageId: r.ref, proofRoot: p.lot.proofRoot, stagesProven: p.proofs.length, paramsProven: nParams, tx: last } });
    }
  }

  private async done(r: Row, tx: Hex | null) {
    await this.db.query("UPDATE ens_lots SET status = 'done', tx_hash = COALESCE($1, tx_hash), pending_txs = NULL, error = NULL, attempts = 0, updated_at = now() WHERE id = $2", [tx, r.id]);
  }

  async retry(siteId: string, kind: string, ref: string) {
    await this.db.query("UPDATE ens_lots SET status = 'pending', attempts = 0, next_try_at = $1, updated_at = now() WHERE site_id = $2 AND kind = $3 AND ref = $4 AND status = 'failed'", [this.iso(), siteId, kind, ref]);
  }

  // ---------------------------------------------------------------- reads
  private iso(plus = 0) {
    return new Date(this.now() + plus).toISOString();
  }
  private async row(kind: Kind, ref: string): Promise<Row | null> {
    return (await this.db.query<Row>(`SELECT ${COLS} FROM ens_lots WHERE kind = $1 AND ref = $2`, [kind, ref])).rows[0] ?? null;
  }

  /** A lot's ENS name and its releases on Sepolia, or null when names are off or not issued yet. */
  async ofLot(runId: string): Promise<LotNameView | null> {
    if (!this.rail) return null;
    const lot = await this.row("lot", runId);
    if (!lot) return null;
    const rel = await this.db.query<Row>(`SELECT ${COLS} FROM ens_lots WHERE kind = 'release' AND run_id = $1 ORDER BY created_at`, [runId]);
    return {
      name: lot.name,
      url: this.rail.appUrl(lot.name),
      releases: rel.rows.map((r) => ({ packageId: r.ref, status: r.status, txUrl: r.tx_hash ? this.rail!.txUrl(r.tx_hash) : null, error: r.error })),
    };
  }

  /**
   * The CCIP-Read gateway (EIP-3668) for lot names: decode `resolve(name, data)`, answer from Ordo's records and sign
   * the answer for OrdoLotResolver.resolveWithProof. Unknown names and records get empty answers, still signed.
   */
  async answer(sender: string, callData: Hex): Promise<Hex> {
    const rail = this.rail;
    if (!rail?.cfg.lotResolver || sender.toLowerCase() !== rail.cfg.lotResolver.toLowerCase()) throw new HttpError(404, "Unknown resolver");
    const { args } = decodeFunctionData({ abi: RESOLVE_ABI, data: callData });
    const [dnsName, data] = args as [Hex, Hex];
    const name = decodeDns(dnsName).toLowerCase();
    const lot = (await this.db.query<Row>(`SELECT ${COLS} FROM ens_lots WHERE kind = 'lot' AND name = $1`, [name])).rows[0];
    const call = decodeFunctionData({ abi: RECORD_ABI, data });
    let result: Hex;
    if (call.functionName === "text") {
      const key = (call.args as [Hex, string])[1];
      const texts = lot ? await this.texts(lot) : {};
      result = encodeFunctionResult({ abi: RECORD_ABI, functionName: "text", result: texts[key] ?? "" });
    } else if (call.functionName === "addr" && call.args.length === 1) {
      result = encodeFunctionResult({ abi: RECORD_ABI, functionName: "addr", args: call.args, result: "0x0000000000000000000000000000000000000000" } as never);
    } else {
      result = encodeAbiParameters([{ type: "bytes" }], ["0x"]);
    }
    const expires = BigInt(Math.floor(this.now() / 1000)) + ANSWER_TTL_S;
    const sig = await rail.signAnswer(callData, result, expires);
    return encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], [result, expires, sig]);
  }

  /** A lot name's text records: where its passport is and what it says. */
  private async texts(lot: Row): Promise<Record<string, string>> {
    const [run, passport, site] = await Promise.all([
      this.engine.view(lot.site_id, lot.ref),
      this.passports.get(lot.site_id, lot.ref).catch(() => null),
      this.db.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [lot.site_id]).then((r) => r.rows[0]?.name ?? ""),
    ]);
    const product = `${run.templateName} v${run.templateVersion}`;
    const out: Record<string, string> = {
      "com.ordo.type": "lot",
      "com.ordo.site": site,
      "com.ordo.order": run.orderRef,
      "com.ordo.product": product,
      "com.ordo.quantity": String(run.quantity),
      "com.ordo.status": passport?.status ?? run.status,
      "com.ordo.passport": this.passports.metadata(lot.ref, "in_production"),
      description: `Lot ${run.orderRef}: ${run.quantity} units of ${product}, made at ${site}`,
    };
    if (passport) out.url = passport.pageUrl;
    if (passport?.nft?.serial != null) out["com.ordo.nft"] = `${passport.nft.tokenId}/${passport.nft.serial}`;
    return out;
  }
}

/** DNS wire format → "a.b.eth" */
export function decodeDns(name: Hex): string {
  const b = hexToBytes(name);
  const labels: string[] = [];
  for (let i = 0; i < b.length && b[i] !== 0; i += b[i]! + 1) labels.push(new TextDecoder().decode(b.slice(i + 1, i + 1 + b[i]!)));
  return labels.join(".");
}
