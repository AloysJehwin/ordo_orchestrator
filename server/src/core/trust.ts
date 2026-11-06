import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { ReleaseTyped, Signatures, TypedSignature, User } from "../auth/auth.js";
import { chainErrorMessage } from "../chain/errors.js";
import { CHAIN_ROLE, releaseSigArg, sigArg, type ChainRole, type ReleaseLot, type ReleaseSigArg, type TrustChain } from "../chain/trust.js";
import type { Db, Queryable } from "../db/db.js";
import { hashOf } from "../domain/canonical.js";
import { canApproveAny } from "../domain/policy.js";
import { ROLE_LABEL, ROLES, type Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { within } from "../adapters/keep-alive.js";
import { newId } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";
import type { Schedules } from "./schedules.js";

/** The on-chain credential each org role holds in OrdoTrust. Contributors hold none: their work is proven by their own signatures. */
export const ROLE_CHAIN: Partial<Record<Role, ChainRole>> = { manager: "MANAGER", validator: "VALIDATOR", tester: "TESTER" };
const hasBits = (bits: number, role: ChainRole) => (bits & CHAIN_ROLE[role]) === CHAIN_ROLE[role];
/** The OrdoTrust credentials a set of role bits stands for: a manager's (ADMIN) covers validating. */
const credsOf = (bits: number): ChainRole[] => {
  const out: ChainRole[] = [];
  if (bits & CHAIN_ROLE.ADMIN) out.push("MANAGER");
  else if (bits & CHAIN_ROLE.VALIDATOR) out.push("VALIDATOR");
  if (bits & CHAIN_ROLE.TESTER) out.push("TESTER");
  if (bits & CHAIN_ROLE.VENDOR) out.push("VENDOR");
  return out;
};
export interface RelayView {
  kind: string;
  /** waiting_ens: a promotion's grant goes to OrdoTrust once its role name is on ENS, where roles are decided */
  status: "pending" | "done" | "failed" | "waiting_site" | "waiting_ens" | "superseded";
  txHash: string | null;
  txUrl: string | null;
  error: string | null;
}

const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);
// relay payloads are stored as JSON, where a bigint deadline is a string
const jsonSafe = (s: ReleaseSigArg) => ({ ...s, deadline: s.deadline.toString() });
const fromJsonSafe = (s: ReturnType<typeof jsonSafe>): ReleaseSigArg => ({ ...s, deadline: BigInt(s.deadline) });

/**
 * Who may do what, and the proof of it. Roles beyond contributor are given and taken with a manager's EIP-712
 * signature; validators and testers, when the trust contract is configured, also hold an active stake on-chain. Every grant, release and slash the contract can verify is relayed to it with
 * the original signatures.
 */
export class Trust {
  /** Set when Hedera's Schedule Service returns stakes at the end of the unstake cooldown */
  schedules: Schedules | null = null;
  /** Are roles decided by ENS names right now (set by wiring)? Then a promotion waits for its role name. */
  private ensLive: () => boolean = () => false;
  /** the role bits a wallet holds through its ENS names (OrdoNames.roles), when names are on */
  private ensBits: ((siteId: string, address: string) => Promise<number>) | null = null;
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    readonly chain: TrustChain | null,
    private defaultChainId: number,
  ) {}

  /** Chain id for signatures the contract will verify; otherwise the wallet's own. */
  chainIdFor(contractChecked: boolean, client?: number): number {
    if (contractChecked && this.chain) return this.chain.cfg.chainId;
    return client ?? this.defaultChainId;
  }
  /** The domain for a signature OrdoTrust verifies: its chain and its address, so it cannot be replayed on another deployment. */
  contractDomain(contractChecked: boolean, client?: number): { chainId: number; verifyingContract?: Hex } {
    if (contractChecked && this.chain) return { chainId: this.chain.cfg.chainId, verifyingContract: this.chain.cfg.address };
    return { chainId: client ?? this.defaultChainId };
  }

  /** Roles are decided by ENS names: a promotion is pending until its role name is on-chain, and only then goes to OrdoTrust. */
  useEns(live: () => boolean, bits?: (siteId: string, address: string) => Promise<number>) {
    this.ensLive = live;
    this.ensBits = bits ?? null;
  }

  // ---------------------------------------------------------------- roles: promotions and removals
  private async member(siteId: string, userId: string) {
    const r = await this.db.query<{ address: string; display_name: string | null; role: string; state: string }>(
      "SELECT u.address, u.display_name, m.role, m.state FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 AND m.user_id = $2",
      [siteId, userId],
    );
    if (!r.rows.length) throw new HttpError(404, "Not a member of this org");
    const of = (state: string) => r.rows.filter((x) => x.state === state).map((x) => x.role as Role);
    return { address: r.rows[0]!.address, name: r.rows[0]!.display_name, roles: of("held"), pending: of("pending") };
  }
  private roleEntity(address: string, role: Role) {
    return `${address.toLowerCase()}#${ROLE_CHAIN[role] ?? role.toUpperCase()}`;
  }

  /**
   * What a manager signs to give someone a role or take it away: "role.grant" or "role.revoke" for
   * `<0xaddress>#<CREDENTIAL>`, the statement OrdoTrust checks before it changes the credential on-chain.
   */
  async roleRequest(siteId: string, manager: User, userId: string, role: Role, grant: boolean, comment: string, clientChainId?: number): Promise<TypedSignature> {
    const m = await this.member(siteId, userId);
    if (grant && m.roles.includes(role)) throw new HttpError(409, `${m.name ?? m.address} is already a ${ROLE_LABEL[role]}`);
    if (grant && m.pending.includes(role)) throw new HttpError(409, `${m.name ?? m.address} is already being made a ${ROLE_LABEL[role]}: the role name is on its way to ENS`);
    if (!grant && !m.roles.includes(role) && !m.pending.includes(role)) throw new HttpError(409, `${m.name ?? m.address} is not a ${ROLE_LABEL[role]}`);
    if (!grant && userId === manager.id && role === "manager") throw new HttpError(409, "Ask another manager to remove your manager role");
    return this.sigs.request(manager, {
      action: grant ? "role.grant" : "role.revoke",
      entity: this.roleEntity(m.address, role),
      meaning: `${grant ? "Make" : "Remove"} ${m.name ?? m.address} (${m.address}) ${grant ? "a" : "as"} ${ROLE_LABEL[role]}`,
      comment,
      site: siteId,
      ...this.contractDomain(ROLE_CHAIN[role] !== undefined, clientChainId),
    });
  }

  async setRole(siteId: string, manager: User, userId: string, role: Role, grant: boolean, input: { comment: string; nonce: string; signature: Hex }) {
    const m = await this.member(siteId, userId);
    const action = grant ? "role.grant" : "role.revoke";
    // with ENS names on, a promotion counts once its role name is on-chain; a removal counts at once
    const viaEns = this.ensLive();
    const wasPending = !grant && m.pending.includes(role) && !m.roles.includes(role);
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, manager, { action, entity: this.roleEntity(m.address, role) }, { nonce: input.nonce, signature: input.signature });
      if (grant)
        await q.query("INSERT INTO memberships (site_id, user_id, role, created_by, state) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [siteId, userId, role, manager.id, viaEns ? "pending" : "held"]);
      else {
        if (role === "manager" && !wasPending) {
          const others = await q.query<{ n: string }>("SELECT COUNT(*)::text n FROM memberships WHERE site_id = $1 AND role = 'manager' AND state = 'held' AND user_id <> $2", [siteId, userId]);
          if (Number(others.rows[0]!.n) < 1) throw new HttpError(409, "An org needs at least one manager");
        }
        await q.query("DELETE FROM memberships WHERE site_id = $1 AND user_id = $2 AND role = $3", [siteId, userId, role]);
        // a grant still waiting for ENS never reaches OrdoTrust
        await q.query("UPDATE chain_relays SET status = 'superseded', updated_at = now() WHERE site_id = $1 AND status = 'waiting_ens' AND ref LIKE $2", [siteId, `role\\_${userId}\\_${role}\\_%`]);
        // nobody is left without a role: someone who loses their last one is a contributor again
        const left = await q.query("SELECT 1 FROM memberships WHERE site_id = $1 AND user_id = $2 AND state = 'held'", [siteId, userId]);
        if (!left.rows.length) await q.query("INSERT INTO memberships (site_id, user_id, role, created_by) VALUES ($1,$2,'contributor',$3) ON CONFLICT DO NOTHING", [siteId, userId, manager.id]);
      }
      return s;
    });
    const d = await this.rec.decide(siteId, {
      agent: `user:${manager.address}`,
      kind: grant ? "team.role_granted" : "team.role_revoked",
      summary: `${grant ? "Made" : "Removed"} ${m.name ?? m.address} ${grant ? "a" : "as"} ${ROLE_LABEL[role]}`,
      reason: input.comment || null,
      data: { userId, address: m.address, role, signatureId: sig.id, typedData: sig.typed, signature: input.signature },
    });
    await this.db.query("UPDATE signatures SET ledger_seq = $1 WHERE id = $2", [d.ledgerSeq, sig.id]);
    const chainRole = ROLE_CHAIN[role];
    const pending = grant && viaEns;
    // a promotion that never reached ENS never reached OrdoTrust either: there is nothing to take back there
    if (!chainRole || !this.chain || wasPending) return pending ? { chain: null, pending } : { chain: null };
    const ref = `role_${userId}_${role}_${sig.id}`;
    const arg = sigArg(sig.typed, input.signature);
    // Hedera follows ENS: the grant waits until the role name is on-chain, then goes out with this same signature
    const relay = pending ? await this.park(siteId, "grant", ref, { address: m.address, role: chainRole, sig: arg }, "waiting_ens") : grant ? await this.relayGrant(siteId, ref, m.address, chainRole, arg) : await this.relayRevoke(siteId, ref, m.address, chainRole, arg);
    // OrdoTrust's MANAGER value includes the VALIDATOR bit: a manager who stays a validator needs that credential again,
    // signed by a manager (POST /chain/credentials/grant). The console asks for it straight away.
    let reissue: ChainRole[] = [];
    if (!grant && role === "manager" && relay.status === "done") {
      const kept = await this.db.query<{ role: Role }>("SELECT role FROM memberships WHERE site_id = $1 AND user_id = $2 AND state = 'held'", [siteId, userId]);
      reissue = kept.rows.map((r) => ROLE_CHAIN[r.role]).filter((x): x is ChainRole => x !== undefined && x !== "MANAGER" && (CHAIN_ROLE[x] & CHAIN_ROLE.MANAGER) !== 0);
    }
    return pending ? { chain: relay, reissue, pending } : { chain: relay, reissue };
  }

  /** A promotion's role name is on ENS: its OrdoTrust grant, signed when it was made, goes out now. */
  async releaseWaitingEns(siteId: string, userId: string, role: Role) {
    if (!this.chain) return;
    const waiting = await this.db.query<{ ref: string }>("SELECT DISTINCT ref FROM chain_relays WHERE site_id = $1 AND status = 'waiting_ens' AND ref LIKE $2", [siteId, `role\\_${userId}\\_${role}\\_%`]);
    for (const w of waiting.rows) await this.retry(siteId, w.ref).catch((e) => console.error(`[ordo] trust relay ${w.ref}`, e));
  }

  /** The latest relay of each person's role changes, so Team can show what OrdoTrust holds and retry a failure. */
  async roleRelays(siteId: string): Promise<Record<string, RelayView>> {
    const r = await this.db.query<{ ref: string; kind: string; status: string; tx_hash: string | null; error: string | null }>(
      // oldest first, so a person's later change of a role (a revoke after a grant) is the one kept below
      "SELECT ref, kind, status, tx_hash, error FROM (SELECT DISTINCT ON (ref) ref, kind, status, tx_hash, error, created_at FROM chain_relays WHERE site_id = $1 AND ref LIKE 'role\\_%' ORDER BY ref, created_at DESC) r ORDER BY created_at",
      [siteId],
    );
    const out: Record<string, RelayView> = {};
    for (const x of r.rows) {
      // role_<userId: usr_xxxx>_<role>_<signature id>
      const parts = x.ref.split("_");
      if (parts.length >= 4) out[`${parts[1]}_${parts[2]}:${parts[3]}`] = this.relayView(x);
    }
    return out;
  }

  // ---------------------------------------------------------------- chain relays
  private retryers = new Map<string, (siteId: string, ref: string, payload: any) => Promise<Hex>>();
  /** Let another module's relays be retried: `run` re-sends a relay of this kind from its stored payload. */
  onRetry(kind: string, run: (siteId: string, ref: string, payload: any) => Promise<Hex>) {
    this.retryers.set(kind, run);
  }

  /** Keep a signed authorisation to send later (waiting for the site's registration, or for ENS). */
  private async park(siteId: string, kind: string, ref: string, payload: unknown, status: "waiting_site" | "waiting_ens"): Promise<RelayView> {
    await this.db.query("INSERT INTO chain_relays (id, site_id, kind, ref, payload_json, status) VALUES ($1,$2,$3,$4,$5,$6)", [newId("rly"), siteId, kind, ref, JSON.stringify(payload), status]);
    return this.relayView({ kind, status, tx_hash: null, error: null });
  }

  /** Send a signed authorisation to a contract and record the outcome (pending → done | failed | waiting_site). */
  /**
   * Send a signed action to the trust chain. The request waits for the receipt for at most `wait` ms (RELAY_WAIT_MS by
   * default): past that it answers `pending` and the transaction finishes in the background, so a slow chain never
   * holds the person's signature dialog until the function times out. `then` runs once it settles, however long that takes.
   */
  async relay(
    siteId: string,
    kind: string,
    ref: string,
    payload: unknown,
    run: () => Promise<Hex>,
    waitForSite = true,
    contract?: string,
    opts: { wait?: number; then?: (v: RelayView) => Promise<void> } = {},
  ): Promise<RelayView> {
    const id = newId("rly");
    const registered = !waitForSite || (await this.siteRegistered(siteId));
    await this.db.query("INSERT INTO chain_relays (id, site_id, kind, ref, payload_json, status) VALUES ($1,$2,$3,$4,$5,$6)", [id, siteId, kind, ref, JSON.stringify(payload), registered ? "pending" : "waiting_site"]);
    if (!registered) return this.relayView({ kind, status: "waiting_site", tx_hash: null, error: null });
    const work = (async () => {
      let v: RelayView;
      try {
        const tx = await run();
        await this.db.query("UPDATE chain_relays SET status = 'done', tx_hash = $1, updated_at = now() WHERE id = $2", [tx, id]);
        await this.rec.event("system:relayer", `chain.${kind}`, ref, { site: siteId, txHash: tx, chainId: this.chain!.cfg.chainId, contract: contract ?? this.chain!.cfg.address });
        v = this.relayView({ kind, status: "done", tx_hash: tx, error: null });
      } catch (e) {
        const msg = chainErrorMessage(e);
        await this.db.query("UPDATE chain_relays SET status = 'failed', error = $1, updated_at = now() WHERE id = $2", [msg, id]);
        v = this.relayView({ kind, status: "failed", tx_hash: null, error: msg });
      }
      await opts.then?.(v).catch((e: unknown) => console.error(`[ordo] after relay ${kind}`, e));
      return v;
    })();
    return (await within(work, opts.wait ?? this.relayWait)) ?? this.relayView({ kind, status: "pending", tx_hash: null, error: null });
  }
  /** How long a request waits for a relay's receipt before answering `pending` (the work goes on). */
  relayWait = 8_000;
  private relayView(r: { kind: string; status: string; tx_hash: string | null; error: string | null }): RelayView {
    return { kind: r.kind, status: r.status as RelayView["status"], txHash: r.tx_hash, txUrl: r.tx_hash && this.chain ? this.chain.txUrl(r.tx_hash) : null, error: r.error };
  }
  async relayOf(siteId: string, ref: string): Promise<RelayView | null> {
    const r = (await this.db.query<{ kind: string; status: string; tx_hash: string | null; error: string | null }>("SELECT kind, status, tx_hash, error FROM chain_relays WHERE site_id = $1 AND ref = $2 ORDER BY created_at DESC LIMIT 1", [siteId, ref])).rows[0];
    return r ? this.relayView(r) : null;
  }
  private relayGrant(siteId: string, ref: string, address: string, role: ChainRole, sig: ReturnType<typeof sigArg>) {
    return this.relay(siteId, "grant", ref, { address, role, sig }, () => this.chain!.grantRole(siteId, address, role, sig));
  }
  private relayRevoke(siteId: string, ref: string, address: string, role: ChainRole, sig: ReturnType<typeof sigArg>) {
    return this.relay(siteId, "revoke", ref, { address, role, sig }, () => this.chain!.revokeRole(siteId, address, role, sig));
  }
  /** Retry a failed relay, or one that waited for the site's registration. */
  async retry(siteId: string, ref: string): Promise<RelayView | null> {
    if (!this.chain) throw new HttpError(409, "No trust contract is configured");
    const r = (await this.db.query<{ id: string; kind: string; payload_json: string; status: string; fresh: boolean }>(
      "SELECT id, kind, payload_json, status, updated_at > now() - interval '5 minutes' AS fresh FROM chain_relays WHERE site_id = $1 AND ref = $2 ORDER BY created_at DESC LIMIT 1",
      [siteId, ref],
    )).rows[0];
    // done, or still in flight (its receipt is awaited in the background): sending it again would send it twice
    if (!r || r.status === "done" || (r.status === "pending" && r.fresh)) return r ? this.relayOf(siteId, ref) : null;
    const p = JSON.parse(r.payload_json);
    await this.db.query("UPDATE chain_relays SET status = 'superseded' WHERE id = $1", [r.id]);
    if (r.kind === "grant") return this.relayGrant(siteId, ref, p.address, p.role, p.sig);
    if (r.kind === "revoke") return this.relayRevoke(siteId, ref, p.address, p.role, p.sig);
    if (r.kind === "release") return this.relay(siteId, "release", ref, p, () => this.chain!.recordRelease(p.lot, p.sigs.map(fromJsonSafe)));
    const other = this.retryers.get(r.kind);
    if (other) return this.relay(siteId, r.kind, ref, p, () => other(siteId, ref, p));
    return null;
  }

  // ---------------------------------------------------------------- site registration
  async siteRegistered(siteId: string): Promise<boolean> {
    // registered with the contract this deployment uses: after a redeploy every site registers again
    if (!this.chain) return false;
    return (await this.db.query("SELECT 1 FROM chain_sites WHERE site_id = $1 AND lower(contract) = lower($2)", [siteId, this.chain.cfg.address])).rows.length > 0;
  }
  async chainStatus(siteId: string) {
    if (!this.chain) return { configured: false as const };
    const reg = (await this.db.query<{ tx_hash: string; registered_at: string }>("SELECT tx_hash, registered_at::text FROM chain_sites WHERE site_id = $1 AND lower(contract) = lower($2)", [siteId, this.chain.cfg.address])).rows[0];
    const info = await this.chain.info().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return { configured: true as const, info, registered: Boolean(reg), txHash: reg?.tx_hash ?? null, txUrl: reg ? this.chain.txUrl(reg.tx_hash) : null, registeredAt: iso(reg?.registered_at ?? null) };
  }
  async registerRequest(siteId: string, admin: User, name: string) {
    if (!this.chain) throw new HttpError(409, "No trust contract is configured");
    if (await this.siteRegistered(siteId)) throw new HttpError(409, "This site is already registered on-chain");
    // the admin is also the site's quality fund until a treasury is set; the contract checks both were signed
    return this.sigs.request(admin, {
      action: "site.register",
      entity: `${siteId}#${admin.address.toLowerCase()}`,
      meaning: `Register ${name} in OrdoTrust with you as its first administrator and your wallet as its quality fund`,
      comment: "",
      site: siteId,
      ...this.contractDomain(true),
    });
  }
  async register(siteId: string, admin: User, proof: { nonce: string; signature: Hex }) {
    if (!this.chain) throw new HttpError(409, "No trust contract is configured");
    const sig = await this.db.tx((q) => this.sigs.consume(q, admin, { action: "site.register", entity: `${siteId}#${admin.address.toLowerCase()}` }, proof));
    const tx = await this.chain.registerSite(siteId, admin.address, sigArg(sig.typed, proof.signature)).catch((e: unknown) => {
      throw new HttpError(502, `The contract refused the registration: ${e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : e}`);
    });
    await this.db.query(
      "INSERT INTO chain_sites (site_id, chain_id, contract, tx_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (site_id) DO UPDATE SET chain_id = EXCLUDED.chain_id, contract = EXCLUDED.contract, tx_hash = EXCLUDED.tx_hash, registered_at = now()",
      [siteId, this.chain.cfg.chainId, this.chain.cfg.address, tx],
    );
    await this.rec.decide(siteId, { agent: `user:${admin.address}`, kind: "chain.site_registered", summary: `Registered the site in OrdoTrust`, data: { txHash: tx, chainId: this.chain.cfg.chainId, contract: this.chain.cfg.address, signatureId: sig.id } });
    // grants approved before registration go out now
    const waiting = await this.db.query<{ ref: string }>("SELECT DISTINCT ref FROM chain_relays WHERE site_id = $1 AND status = 'waiting_site'", [siteId]);
    for (const w of waiting.rows) await this.retry(siteId, w.ref);
    return this.chainStatus(siteId);
  }

  // ---------------------------------------------------------------- validators and testers
  /** A validator (or a manager, who holds every right); with the trust contract, also credentialed and staked on-chain right now. */
  async isValidator(siteId: string, user: User): Promise<{ ok: boolean; reason: string | null }> {
    const roles = await this.rolesOf(siteId, user.id);
    if (!roles.includes("validator") && !roles.includes("manager")) return { ok: false, reason: "Only a validator or a manager can sign this. A manager can make you a validator from Team." };
    if (!this.chain) return { ok: true, reason: null };
    const active = await this.chain.isActiveValidator(siteId, user.address).catch(() => null);
    if (active === null) return { ok: false, reason: "Could not reach the trust contract to check your stake. Try again." };
    const bits = active ? null : await this.chain.roles(siteId, user.address).catch(() => null);
    if (bits !== null && (bits & CHAIN_ROLE.VALIDATOR) === 0)
      return { ok: false, reason: "Your credential is not in OrdoTrust yet, so the contract refuses your stake. A manager can retry it from Team." };
    if (!active) return { ok: false, reason: "Your stake is not active on-chain: stake at least the minimum (Stakes), and make sure you have not requested to unstake." };
    return { ok: true, reason: null };
  }
  async requireValidator(siteId: string, user: User) {
    const r = await this.isValidator(siteId, user);
    if (!r.ok) throw new HttpError(403, r.reason!);
  }
  /** A tester; with the trust contract, also credentialed and staked on-chain right now. */
  async isTester(siteId: string, user: User): Promise<{ ok: boolean; reason: string | null }> {
    const roles = await this.rolesOf(siteId, user.id);
    if (!roles.includes("tester")) return { ok: false, reason: "Only a tester opens a case. A manager can make you a tester from Team." };
    if (!this.chain) return { ok: true, reason: null };
    if (!(await this.chain.hasFunction("isActiveTester(string,address)").catch(() => false))) return { ok: false, reason: "The trust contract on this deployment predates testers: it needs the v3 contracts." };
    const active = await this.chain.isActiveTester(siteId, user.address).catch(() => null);
    if (active === null) return { ok: false, reason: "Could not reach the trust contract to check your stake. Try again." };
    if (!active) return { ok: false, reason: "Your tester stake is not active on-chain: stake at least the minimum (Stakes)." };
    return { ok: true, reason: null };
  }
  async requireTester(siteId: string, user: User) {
    const r = await this.isTester(siteId, user);
    if (!r.ok) throw new HttpError(403, r.reason!);
  }
  async rolesOf(siteId: string, userId: string): Promise<Role[]> {
    return (await this.db.query<{ role: Role }>("SELECT role FROM memberships WHERE site_id = $1 AND user_id = $2 AND state = 'held'", [siteId, userId])).rows.map((r) => r.role);
  }

  // ---------------------------------------------------------------- credentials on-chain: what OrdoTrust should hold
  /**
   * The credentials OrdoTrust should hold for this org, with what the contract has now: `missing` ones to grant and
   * `extra` ones to take back. With ENS names on, roles are decided by the names people hold, so OrdoTrust follows
   * those; without, it follows Ordo's own records (managers, validators, testers, vendors). Needed after a redeploy,
   * or when a relay failed.
   */
  async credentials(siteId: string) {
    type Cred = { userId: string; address: string; name: string | null; role: ChainRole; label: string };
    if (!this.chain) return { configured: false as const, registered: false, admins: [] as string[], missing: [] as Cred[], extra: [] as Cred[], source: "db" as const };
    type Row = { user_id: string; address: string; display_name: string | null };
    const members = (await this.db.query<Row & { role: Role }>("SELECT m.user_id, m.role, u.address, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 AND m.state = 'held'", [siteId])).rows;
    const vendors = (await this.db.query<Row>("SELECT v.user_id, v.address, u.display_name FROM vendors v LEFT JOIN users u ON u.id = v.user_id WHERE v.site_id = $1 AND v.status = 'approved'", [siteId])).rows;
    const who = new Map<string, { userId: string; name: string | null }>();
    for (const r of [...members, ...vendors]) if (!who.has(r.address.toLowerCase())) who.set(r.address.toLowerCase(), { userId: r.user_id ?? "", name: r.display_name });
    const label = (role: ChainRole) => (role === "MANAGER" ? ROLE_LABEL.manager : role === "VALIDATOR" ? ROLE_LABEL.validator : role === "TESTER" ? ROLE_LABEL.tester : role === "VENDOR" ? "Maintenance vendor" : role);
    const cred = (address: string, role: ChainRole): Cred => ({ userId: who.get(address)?.userId ?? "", address, name: who.get(address)?.name ?? null, role, label: label(role) });

    // what each wallet should hold
    const want = new Map<string, Set<ChainRole>>();
    const ens = this.ensLive() && this.ensBits !== null;
    let settling = new Set<string>();
    if (ens) {
      // a wallet whose name is still on its way to ENS is left alone until it lands
      const named = await this.db.query<{ address: string; have_json: string | null; status: string }>(
        "SELECT lower(address) AS address, have_json, status FROM ens_names WHERE site_id = $1 AND kind IN ('person','vendor') AND address IS NOT NULL AND id NOT LIKE '%:was:%'",
        [siteId],
      );
      const onChain = new Set(named.rows.filter((n) => n.have_json && !(JSON.parse(n.have_json) as { revoke?: boolean }).revoke).map((n) => n.address));
      settling = new Set(named.rows.filter((n) => !n.have_json && n.status !== "revoked" && !onChain.has(n.address)).map((n) => n.address));
      // past grant targets too, so a credential left on OrdoTrust after someone left is found
      const granted = await this.db.query<{ payload_json: string }>("SELECT payload_json FROM chain_relays WHERE site_id = $1 AND kind = 'grant' AND status = 'done'", [siteId]);
      const wallets = new Set([...who.keys(), ...granted.rows.map((g) => String((JSON.parse(g.payload_json) as { address?: string }).address ?? "").toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a))]);
      for (const a of wallets) {
        if (settling.has(a)) continue;
        const bits = await this.ensBits!(siteId, a).catch(() => null);
        if (bits !== null) want.set(a, new Set(credsOf(bits)));
      }
    } else {
      for (const m of members) {
        const role = ROLE_CHAIN[m.role];
        if (role) want.set(m.address.toLowerCase(), new Set([...(want.get(m.address.toLowerCase()) ?? []), role]));
      }
      for (const v of vendors) want.set(v.address.toLowerCase(), new Set([...(want.get(v.address.toLowerCase()) ?? []), "VENDOR" as ChainRole]));
    }

    const have = new Map(await Promise.all([...want.keys()].map(async (a) => [a, await this.chain!.roles(siteId, a).catch(() => null)] as const)));
    const missing: Cred[] = [];
    const extra: Cred[] = [];
    for (const [a, roles] of want) {
      const bits = have.get(a);
      if (bits === null || bits === undefined) continue;
      for (const r of roles) if (!hasBits(bits, r)) missing.push(cred(a, r));
      // with ENS deciding, a credential no name backs is taken back (one another wanted credential covers is not)
      if (ens) for (const r of credsOf(bits)) if (![...roles].some((w) => (CHAIN_ROLE[w] & CHAIN_ROLE[r]) === CHAIN_ROLE[r])) extra.push(cred(a, r));
    }
    const admins = [...have].filter(([, bits]) => bits !== null && (bits & CHAIN_ROLE.ADMIN) !== 0).map(([a]) => a);
    return { configured: true as const, registered: await this.siteRegistered(siteId), admins, missing, extra, source: ens ? ("ens" as const) : ("db" as const) };
  }
  private async assertChainAdmin(siteId: string, admin: User) {
    if (!this.chain) throw new HttpError(409, "No trust contract is configured");
    if (!(await this.siteRegistered(siteId))) throw new HttpError(409, "Register the org on-chain first (Settings)");
    const bits = await this.chain.roles(siteId, admin.address).catch(() => null);
    if (bits === null) throw new HttpError(502, "Could not reach the trust contract. Try again.");
    if ((bits & CHAIN_ROLE.ADMIN) === 0) {
      const { admins } = await this.credentials(siteId);
      throw new HttpError(409, `Your wallet ${admin.address} is not a manager in OrdoTrust for this org, so the contract would refuse your signature.${admins.length ? ` Sign in with ${admins.join(" or ")}.` : ""}`);
    }
  }
  /** A fresh "role.grant" for a credential Ordo already gave, signed by a manager OrdoTrust knows. */
  async credentialRequest(siteId: string, admin: User, address: string, role: ChainRole): Promise<TypedSignature> {
    await this.assertChainAdmin(siteId, admin);
    const m = (await this.credentials(siteId)).missing.find((x) => x.address === address.toLowerCase() && x.role === role);
    if (!m) throw new HttpError(409, "That credential is not missing");
    return this.sigs.request(admin, { action: "role.grant", entity: `${m.address}#${role}`, meaning: `Record ${m.name ?? m.address} (${m.address}) as ${m.label} in OrdoTrust`, comment: "", site: siteId, ...this.contractDomain(true) });
  }
  /** A "role.revoke" for a credential OrdoTrust holds that no ENS name backs, signed by a manager OrdoTrust knows. */
  async credentialRevokeRequest(siteId: string, admin: User, address: string, role: ChainRole): Promise<TypedSignature> {
    await this.assertChainAdmin(siteId, admin);
    const m = (await this.credentials(siteId)).extra.find((x) => x.address === address.toLowerCase() && x.role === role);
    if (!m) throw new HttpError(409, "OrdoTrust does not hold that credential beyond what ENS says");
    return this.sigs.request(admin, { action: "role.revoke", entity: `${m.address}#${role}`, meaning: `Take back ${m.name ?? m.address}'s ${m.label} credential in OrdoTrust: no ENS name holds it`, comment: "", site: siteId, ...this.contractDomain(true) });
  }
  async revokeCredential(siteId: string, admin: User, address: string, role: ChainRole, proof: { nonce: string; signature: Hex }): Promise<RelayView> {
    await this.assertChainAdmin(siteId, admin);
    const a = address.toLowerCase();
    const sig = await this.db.tx((q) => this.sigs.consume(q, admin, { action: "role.revoke", entity: `${a}#${role}` }, proof));
    await this.rec.decide(siteId, { agent: `user:${admin.address}`, kind: "chain.credential_revoked", summary: `Signed taking back ${a}'s ${role} credential in OrdoTrust`, data: { address: a, role, signatureId: sig.id } });
    return this.relayRevoke(siteId, `credrev_${a}_${role}`, a, role, sigArg(sig.typed, proof.signature));
  }
  async grantCredential(siteId: string, admin: User, address: string, role: ChainRole, proof: { nonce: string; signature: Hex }): Promise<RelayView> {
    await this.assertChainAdmin(siteId, admin);
    const a = address.toLowerCase();
    const sig = await this.db.tx((q) => this.sigs.consume(q, admin, { action: "role.grant", entity: `${a}#${role}` }, proof));
    await this.rec.decide(siteId, { agent: `user:${admin.address}`, kind: "chain.credential_signed", summary: `Signed ${a}'s ${role} credential for OrdoTrust`, data: { address: a, role, signatureId: sig.id } });
    return this.relayGrant(siteId, `cred_${a}_${role}`, a, role, sigArg(sig.typed, proof.signature));
  }

  /** The org's validators and testers, with their stakes on-chain. */
  async stakers(siteId: string) {
    const rows = await this.db.query<{ user_id: string; role: Role; created_at: string; address: string; display_name: string | null }>(
      "SELECT m.user_id, m.role, m.created_at::text, u.address, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 AND m.role IN ('validator','tester','manager') AND m.state = 'held' ORDER BY m.created_at",
      [siteId],
    );
    const tester = this.chain ? await this.chain.hasFunction("isActiveTester(string,address)").catch(() => false) : false;
    const by = new Map<string, { userId: string; address: string; name: string | null; roles: Role[]; since: string }>();
    for (const r of rows.rows) {
      const p = by.get(r.user_id) ?? { userId: r.user_id, address: r.address, name: r.display_name, roles: [], since: new Date(r.created_at).toISOString() };
      p.roles.push(r.role);
      by.set(r.user_id, p);
    }
    return Promise.all(
      [...by.values()].map(async (p) => {
        const onchain = this.chain
          ? await Promise.all([
              this.chain.stakeOf(siteId, p.address),
              this.chain.isActiveValidator(siteId, p.address),
              tester ? this.chain.isActiveTester(siteId, p.address) : Promise.resolve(false),
              this.schedules?.stakeSchedule(siteId, p.address) ?? null,
              this.chain.roles(siteId, p.address),
            ])
              .then(([s, v, t, payout, bits]) => ({ stake: s.amount, unlockAt: s.unlockAt, activeValidator: v, activeTester: t, payout, bits, credentials: (Object.keys(ROLE_CHAIN) as Role[]).filter((r) => p.roles.includes(r) && hasBits(bits, ROLE_CHAIN[r]!)) }))
              .catch(() => null)
          : null;
        return { ...p, onchain };
      }),
    );
  }

  /** A manager adds a maintenance vendor (the payee of work orders): a "role.grant" for VENDOR, relayed to OrdoTrust. */
  async vendorRequest(siteId: string, manager: User, v: { address: string; company: string }, clientChainId?: number): Promise<TypedSignature> {
    const a = v.address.toLowerCase();
    const dup = await this.db.query("SELECT 1 FROM vendors WHERE site_id = $1 AND address = $2 AND status = 'approved'", [siteId, a]);
    if (dup.rows.length) throw new HttpError(409, "That wallet is already a vendor here");
    return this.sigs.request(manager, { action: "role.grant", entity: `${a}#VENDOR`, meaning: `Add ${v.company} (${a}) as a maintenance vendor`, comment: "", site: siteId, ...this.contractDomain(true, clientChainId) });
  }
  async addVendor(siteId: string, manager: User, v: { address: string; company: string; categories: string; hourlyRate: string | null; responseMinutes: number | null; nonce: string; signature: Hex }) {
    const a = v.address.toLowerCase();
    const id = newId("vnd");
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, manager, { action: "role.grant", entity: `${a}#VENDOR` }, { nonce: v.nonce, signature: v.signature });
      const user = (await q.query<{ id: string }>("SELECT id FROM users WHERE address = $1", [a])).rows[0];
      await q.query("INSERT INTO vendors (id, site_id, user_id, address, company, categories, hourly_rate, response_minutes, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        id,
        siteId,
        user?.id ?? null,
        a,
        v.company,
        v.categories,
        v.hourlyRate,
        v.responseMinutes,
        id,
      ]);
      return s;
    });
    await this.rec.decide(siteId, { agent: `user:${manager.address}`, kind: "vendor.added", summary: `Added ${v.company} as a maintenance vendor`, data: { vendorId: id, address: a, signatureId: sig.id } });
    const chain = this.chain ? await this.relayGrant(siteId, id, a, "VENDOR", sigArg(sig.typed, v.signature)) : null;
    return { id, chain };
  }

  async vendors(siteId: string) {
    const r = await this.db.query<{ id: string; address: string; company: string; categories: string; hourly_rate: string | null; response_minutes: number | null; status: string; created_at: string }>(
      "SELECT id, address, company, categories, hourly_rate, response_minutes, status, created_at::text FROM vendors WHERE site_id = $1 ORDER BY created_at",
      [siteId],
    );
    return r.rows.map((v) => ({ id: v.id, address: v.address, company: v.company, categories: v.categories, hourlyRate: v.hourly_rate, responseMinutes: v.response_minutes, status: v.status, createdAt: new Date(v.created_at).toISOString() }));
  }

  // ---------------------------------------------------------------- releases on-chain
  /** Relay a released validation package's three release statements to the contract. */
  async recordRelease(siteId: string, lot: ReleaseLot, then?: (v: RelayView) => Promise<void>): Promise<RelayView | null> {
    if (!this.chain) return null;
    const sigs = await this.releaseSigs(lot.packageId);
    return this.relay(siteId, "release", lot.packageId, { lot, sigs: sigs.map(jsonSafe) }, () => this.chain!.recordRelease(lot, sigs), true, undefined, { then });
  }

  /** The package's three current release statements, [performed, reviewed, approved], as the contracts take them. */
  async releaseSigs(packageId: string): Promise<[ReleaseSigArg, ReleaseSigArg, ReleaseSigArg]> {
    const rows = await this.db.query<{ meaning: string; typed_data: string; signature: string }>(
      "SELECT ps.meaning, s.typed_data, s.signature FROM package_signatures ps JOIN signatures s ON s.id = ps.signature_id WHERE ps.package_id = $1 AND ps.cleared_at IS NULL",
      [packageId],
    );
    const by = (m: string) => {
      const r = rows.rows.find((x) => x.meaning === m);
      if (!r) throw new HttpError(409, `Missing the ${m} signature`);
      const typed = JSON.parse(r.typed_data) as ReleaseTyped | TypedSignature;
      if (typed.primaryType !== "OrdoRelease") throw new HttpError(409, `The ${m} signature predates release statements: return the package and sign it again`);
      return releaseSigArg(typed, r.signature);
    };
    return [by("performed"), by("reviewed"), by("approved")];
  }
}
