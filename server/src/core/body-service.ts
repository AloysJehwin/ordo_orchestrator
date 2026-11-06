import { createHash, randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { User } from "../auth/auth.js";
import type { Router } from "../chain/zg-router.js";
import type { Db } from "../db/db.js";
import { ASSET_KIND_LABEL, AssetKind, type Role } from "../domain/types.js";
import { BODY_PROFILES, hasBody, profileLimits } from "../edge/profiles.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { predecessors } from "../pipelines/graph.js";
import { newId, type PlantService } from "../plant/plant.js";
import type { BodyAnswer, BodyEnv, BodyRunner, BodyRuntime, BodyService, BodyState, BodyStatus } from "./bodies.js";
import { KeyBox } from "./keybox.js";
import type { Machines } from "./machines.js";
import type { Readings } from "./readings.js";
import type { Names } from "./names.js";
import type { Recorder } from "./recorder.js";
import type { Replicas } from "./replicas.js";

/** How long a body's 0G Router key lives; each start mints a new one and revokes the old */
const ROUTER_KEY_TTL_MS = 7 * 86_400_000;
/** look-ahead and housekeeping run at most this often */
const RECONCILE_MS = 15_000;
/** a running episode log is copied to 0G Storage at most this often; a stage's final log always is */
const REPLICA_EVERY_MS = 5 * 60_000;
/** the largest episode log a body may post */
export const MAX_EPISODE_BYTES = 2 * 1024 * 1024;
/** what a new virtual machine may spend from its own Hedera account, when machine wallets are on (tinybars) */
const WALLET = { dailyBudget: "200000000", perCall: "50000000" };
const ACTIVE = ["running", "awaiting_approval", "held"];

export const BodyCreate = z.object({
  name: z.string().trim().min(1).max(60),
  kind: AssetKind.refine((k) => k !== "system", "A business-system stage needs no machine"),
  zoneId: z.string().min(1).max(64).nullable().default(null),
  /** start its body now (when a runtime is configured) */
  start: z.boolean().default(true),
});
/** What a body reports on its signed edge channel: its state, its brain and, when it has new entries, its episode log. */
export const BodyReport = z.object({
  assetId: z.string().min(1).max(64),
  state: z.enum(["running", "sleeping", "safe_stopped"]),
  brain: z.enum(["0g", "none"]),
  model: z.string().max(120).nullable().default(null),
  episode: z
    .object({
      runId: z.string().max(64).nullable(),
      stage: z.string().max(32).nullable(),
      /** the stage is over: this is the episode's last version */
      final: z.boolean().default(false),
      log: z.object({ version: z.number().int(), entries: z.array(z.record(z.string(), z.unknown())).max(5000) }).passthrough(),
    })
    .nullable()
    .default(null),
});
export type BodyReport = z.infer<typeof BodyReport>;
/** A body holds its stage: safely, when 0G is unreachable (it never decides without it), or because its agent decided to. */
export const BodyHold = z.object({
  runId: z.string().min(1).max(64),
  stage: z.string().min(1).max(32),
  reason: z.string().trim().min(1).max(500),
  kind: z.enum(["safe_stop", "agent"]),
});

interface Row {
  asset_id: string;
  site_id: string;
  runtime: BodyRuntime | null;
  profile: string;
  seed: string;
  key_enc: string;
  ask_token_enc: string;
  state: BodyState;
  auto_start: boolean;
  sandbox_id: string | null;
  ask_url: string | null;
  brain: "0g" | "none";
  router_key_id: string | null;
  started_at: string | null;
  error: string | null;
  episode_sha256: string | null;
  episode_root: string | null;
  episode_at: string | null;
  created_at: string;
}

/** A virtual machine as the console lists it: its body's status and what it is. */
export interface MachineBodyView extends BodyStatus {
  name: string;
  kind: AssetKind;
  zoneId: string | null;
  device: string;
  seed: string;
  autoStart: boolean;
  startedAt: string | null;
  createdAt: string;
  /** whether the runner sees the body alive right now */
  alive: boolean | null;
  /** the machine's own Hedera account, when it has one */
  account: string | null;
  episode: { sha256: string; at: string; entries: number; decisions: number; final: boolean; replica: { status: string; root: string | null; url: string | null } | null } | null;
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);

/**
 * Machine bodies: virtual machines, each run by its own body with its own agent. A virtual machine is an asset whose
 * data source is a gateway key Ordo generated and keeps sealed; its body holds that key and talks to Ordo only over the
 * signed edge channel, like a gateway beside a real machine. Runners start bodies on one runtime each (`local`
 * processes, `sandbox` microVMs); BODY_RUNTIME picks which one new starts use. Each start mints the body a private-mode
 * 0G Router key when the Router is configured, and hands it the machine's Hedera account when it has one.
 *
 * Bodies report their state and post their episode log (every perception and decision with its 0G request ID), which
 * Ordo keeps and copies to 0G Storage. A body that cannot reach 0G holds its stage and stops safely.
 */
export class Bodies implements BodyService {
  replicas: Replicas | null = null;
  /** ENS names: a body is started with its machine's name, which its logs use */
  names: Pick<Names, "ensure"> | null = null;
  private keys: KeyBox;
  private wallets: KeyBox;
  private lastReconcile = 0;
  /** when a run last wanted each body (look-ahead or its stage running), for the idle stop */
  private readonly lastWanted = new Map<string, number>();
  private lastReplica = new Map<string, number>();
  /** new machines get their own Hedera account (machine wallets are on) */
  get hasWallets() {
    return Boolean(this.machines.bank);
  }

  constructor(
    private db: Db,
    private rec: Recorder,
    private plant: PlantService,
    private engine: RunEngine,
    private readings: Readings,
    private machines: Machines,
    private router: Router,
    /** a runner per runtime; another runtime registers its own here */
    readonly runners: Map<BodyRuntime, BodyRunner>,
    /** where new starts run; null: bodies are off on this deployment */
    readonly runtime: BodyRuntime | null,
    private o: {
      /** where a body on this runtime reaches Ordo */
      ordoUrl: (runtime: BodyRuntime) => string | null;
      secret: string;
      /** where local bodies keep their episode logs */
      dataDir: (assetId: string) => string | null;
      stageS: number;
      tickS: number;
      decideS: number;
      buyS: number;
      hederaNetwork: string;
    },
    private now: () => number,
  ) {
    this.keys = new KeyBox("machine-bodies", o.secret);
    // the machine's Hedera key, sealed by Machines under its own label
    this.wallets = new KeyBox("machine-wallets", o.secret);
  }

  private async row(assetId: string, siteId?: string): Promise<Row> {
    const r = (await this.db.query<Row>("SELECT *, started_at::text AS started_at, episode_at::text AS episode_at, created_at::text AS created_at FROM machine_bodies WHERE asset_id = $1", [assetId])).rows[0];
    if (!r || (siteId && r.site_id !== siteId)) throw new HttpError(404, "No virtual machine with that id");
    return r;
  }
  private async setState(assetId: string, state: BodyState, error: string | null = null, extra: Record<string, unknown> = {}) {
    const cols = Object.keys(extra);
    await this.db.query(
      `UPDATE machine_bodies SET state = $2, error = $3, updated_at = now()${cols.map((c, i) => `, ${c} = $${i + 4}`).join("")} WHERE asset_id = $1`,
      [assetId, state, error, ...cols.map((c) => extra[c])],
    );
  }

  // ---------------------------------------------------------------- people create and run them
  /** A manager creates a virtual machine: an asset whose gateway key Ordo generates and seals, and (by default) starts its body. */
  async create(siteId: string, user: User, roles: Role[], b: z.infer<typeof BodyCreate>) {
    if (!hasBody(b.kind)) throw new HttpError(400, "A business-system stage needs no machine");
    const profile = BODY_PROFILES[b.kind];
    const key = generatePrivateKey();
    const device = privateKeyToAccount(key).address.toLowerCase();
    const assetId = await this.plant.createAsset(
      siteId,
      {
        zoneId: b.zoneId,
        name: b.name,
        kind: b.kind,
        description: "Virtual machine: a simulated machine run by its own body and agent",
        owningAgent: profile.agent,
        source: { type: "gateway", device },
        limits: profileLimits(b.kind),
        idealCycleS: profile.idealCycleS,
      },
      user.id,
    );
    const seed = randomBytes(8).toString("hex");
    await this.db.query("INSERT INTO machine_bodies (asset_id, site_id, runtime, profile, seed, key_enc, ask_token_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      assetId,
      siteId,
      this.runtime,
      b.kind,
      seed,
      this.keys.seal(key),
      this.keys.seal(randomBytes(24).toString("hex")),
      user.id,
    ]);
    await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "machine.virtual_created",
      assetId,
      summary: `Created virtual machine ${b.name} (${ASSET_KIND_LABEL[b.kind]}); its body signs as ${device}`,
      data: { device, profile: b.kind, seed, runtime: this.runtime },
    });
    // its own Hedera account, for buying what its stages consume, when machine wallets are on
    const warnings: string[] = [];
    if (this.machines.bank) await this.machines.enable(siteId, user, roles, assetId, WALLET).catch((e: Error) => warnings.push(`No Hedera account yet: ${e.message}`));
    if (b.start && this.runtime) await this.start(siteId, assetId, `user:${user.address}`).catch((e: Error) => warnings.push(`The body did not start: ${e.message}`));
    return { assetId, device, warnings, body: await this.view(siteId, assetId) };
  }

  /** Start (or wake) a machine's body on this deployment's runtime. */
  async start(siteId: string, assetId: string, actor: string, why?: string): Promise<MachineBodyView> {
    const row = await this.row(assetId, siteId);
    const runtime = this.runtime;
    const runner = runtime ? this.runners.get(runtime) : undefined;
    if (!runtime || !runner) throw new HttpError(409, "Machine bodies are off on this deployment: set BODY_RUNTIME (local or sandbox)");
    if (["running", "sleeping", "starting", "safe_stopped"].includes(row.state) && row.runtime === runtime && (await runner.alive(assetId)).alive) return this.view(siteId, assetId);
    const asset = await this.plant.asset(siteId, assetId);
    if (!hasBody(asset.kind)) throw new HttpError(400, "A business-system stage needs no machine");
    const ordoUrl = this.o.ordoUrl(runtime);
    if (!ordoUrl) throw new HttpError(409, "Set PUBLIC_URL or BODY_ORDO_URL: the body needs an address to reach Ordo at");
    await this.setState(assetId, "starting", null, { runtime, auto_start: true });

    // a fresh 0G Router key per start, in Ordo's trust mode; the previous one is revoked
    let routerKey: { keyId: string; key: string } | null = null;
    if (row.router_key_id) await this.router.revokeKey(row.router_key_id).catch(() => undefined);
    if (this.router.network !== "mock") {
      try {
        routerKey = await this.router.mintSessionKey(`ordo-body-${assetId}`, ROUTER_KEY_TTL_MS);
      } catch (e) {
        await this.setState(assetId, "failed", `Could not mint a 0G Router key: ${e instanceof Error ? e.message : e}`, { router_key_id: null });
        throw new HttpError(502, `Could not mint the body's 0G Router key: ${e instanceof Error ? e.message : e}`);
      }
    }
    const wallet = (
      await this.db.query<{ account_id: string | null; key_enc: string | null; status: string }>("SELECT account_id, key_enc, status FROM machine_wallets WHERE asset_id = $1", [assetId])
    ).rows[0];
    const name = await this.names?.ensure(siteId, "machine", assetId).catch(() => null);
    const env: BodyEnv = {
      ORDO_URL: ordoUrl,
      BODY_KEY: this.keys.unseal(row.key_enc) as Hex,
      BODY_ASSET: assetId,
      ...(name ? { BODY_NAME: name } : {}),
      BODY_PROFILE: asset.kind,
      BODY_SEED: row.seed,
      BODY_ASK_TOKEN: this.keys.unseal(row.ask_token_enc),
      BODY_STAGE_S: String(this.o.stageS),
      BODY_TICK_S: String(this.o.tickS),
      BODY_DECIDE_S: String(this.o.decideS),
      BODY_BUY_S: String(this.o.buyS),
      ...(this.o.dataDir(assetId) ? { BODY_DATA_DIR: this.o.dataDir(assetId)! } : {}),
      ...(routerKey
        ? { ZG_ROUTER_URL: this.router.baseUrl, ZG_ROUTER_KEY: routerKey.key, ZG_ROUTER_MODEL: this.router.model, ZG_ROUTER_TRUST_MODE: this.router.trustMode, ...(this.router.audioModel ? { ZG_ROUTER_AUDIO_MODEL: this.router.audioModel } : {}) }
        : {}),
      ...(wallet?.account_id && wallet.key_enc && wallet.status === "active"
        ? { HEDERA_NETWORK: this.o.hederaNetwork, MACHINE_ACCOUNT_ID: wallet.account_id, MACHINE_ACCOUNT_KEY: this.wallets.unseal(wallet.key_enc) }
        : {}),
    };
    try {
      const r = await runner.start({ siteId, assetId, profile: asset.kind, env });
      await this.setState(assetId, "running", null, { sandbox_id: r.sandboxId, ask_url: r.askUrl, brain: routerKey ? "0g" : "none", router_key_id: routerKey?.keyId ?? null, started_at: new Date(this.now()).toISOString() });
    } catch (e) {
      if (routerKey) await this.router.revokeKey(routerKey.keyId).catch(() => undefined);
      await this.setState(assetId, "failed", e instanceof Error ? e.message : String(e), { router_key_id: null });
      throw e;
    }
    await this.rec.decide(siteId, {
      agent: actor,
      kind: "machine.body_started",
      assetId,
      summary: `Started ${asset.name}'s body (${runtime}, ${routerKey ? `0G brain ${this.router.model}` : "no 0G brain"}${env.MACHINE_ACCOUNT_ID ? `, Hedera account ${env.MACHINE_ACCOUNT_ID}` : ""})`,
      reason: why ?? null,
      data: { runtime, brain: routerKey ? "0g" : "none", model: routerKey ? this.router.model : null, account: env.MACHINE_ACCOUNT_ID ?? null },
    });
    return this.view(siteId, assetId);
  }

  /** Stop a machine's body. Stopped by a person, it stays stopped until someone starts it again. */
  async stop(siteId: string, assetId: string, actor: string, reason?: string): Promise<MachineBodyView> {
    const row = await this.row(assetId, siteId);
    const runner = row.runtime ? this.runners.get(row.runtime) : undefined;
    await runner?.stop(assetId);
    if (row.router_key_id) await this.router.revokeKey(row.router_key_id).catch(() => undefined);
    await this.setState(assetId, "stopped", null, { ask_url: null, router_key_id: null, stopped_at: new Date(this.now()).toISOString(), auto_start: !actor.startsWith("user:") });
    const asset = await this.plant.asset(siteId, assetId).catch(() => null);
    await this.rec.decide(siteId, { agent: actor, kind: "machine.body_stopped", assetId, summary: `Stopped ${asset?.name ?? assetId}'s body`, reason: reason ?? null });
    return this.view(siteId, assetId);
  }

  // ---------------------------------------------------------------- what the console shows
  async status(siteId: string, assetId: string): Promise<BodyStatus | null> {
    const r = (await this.db.query<{ site_id: string }>("SELECT site_id FROM machine_bodies WHERE asset_id = $1", [assetId])).rows[0];
    if (!r || r.site_id !== siteId) return null;
    const v = await this.view(siteId, assetId);
    return { assetId: v.assetId, runtime: v.runtime, state: v.state, heartbeatAt: v.heartbeatAt, brain: v.brain, sandboxId: v.sandboxId, error: v.error, episodeRoot: v.episodeRoot };
  }

  async list(siteId: string): Promise<MachineBodyView[]> {
    const rows = await this.db.query<{ asset_id: string }>("SELECT b.asset_id FROM machine_bodies b JOIN assets a ON a.id = b.asset_id WHERE b.site_id = $1 AND a.archived_at IS NULL ORDER BY b.created_at", [siteId]);
    const out: MachineBodyView[] = [];
    for (const r of rows.rows) out.push(await this.view(siteId, r.asset_id));
    return out;
  }

  async view(siteId: string, assetId: string): Promise<MachineBodyView> {
    const row = await this.row(assetId, siteId);
    const asset = await this.plant.asset(siteId, assetId);
    const beat = (await this.db.query<{ last_ok_at: string | null }>("SELECT last_ok_at::text AS last_ok_at FROM source_state WHERE asset_id = $1", [assetId])).rows[0]?.last_ok_at ?? null;
    const runner = row.runtime ? this.runners.get(row.runtime) : undefined;
    const alive = runner && row.state !== "stopped" ? (await runner.alive(assetId)).alive : null;
    const account = (await this.db.query<{ account_id: string | null }>("SELECT account_id FROM machine_wallets WHERE asset_id = $1", [assetId])).rows[0]?.account_id ?? null;
    let episode: MachineBodyView["episode"] = null;
    if (row.episode_sha256) {
      const e = (
        await this.db.query<{ entries: number; decisions: number; final: boolean; created_at: string }>("SELECT entries, decisions, final, created_at::text AS created_at FROM body_episodes WHERE asset_id = $1 AND sha256 = $2 ORDER BY created_at DESC LIMIT 1", [assetId, row.episode_sha256])
      ).rows[0];
      const rep = this.replicas ? (await this.replicas.of([row.episode_sha256])).get(row.episode_sha256) : undefined;
      if (rep?.root && rep.root !== row.episode_root) await this.db.query("UPDATE machine_bodies SET episode_root = $2 WHERE asset_id = $1", [assetId, rep.root]);
      episode = e
        ? { sha256: row.episode_sha256, at: iso(e.created_at)!, entries: Number(e.entries), decisions: Number(e.decisions), final: Boolean(e.final), replica: rep ? { status: rep.status, root: rep.root, url: rep.url } : null }
        : null;
    }
    const error = row.error ?? (alive === false && ["running", "sleeping"].includes(row.state) ? "The body is not running on this host: start it again" : null);
    return {
      assetId,
      runtime: row.runtime ?? this.runtime ?? "local",
      state: row.state,
      heartbeatAt: iso(beat),
      brain: row.brain,
      sandboxId: row.sandbox_id,
      error,
      episodeRoot: episode?.replica?.root ?? row.episode_root,
      name: asset.name,
      kind: asset.kind,
      zoneId: asset.zoneId,
      device: asset.source.type === "gateway" ? asset.source.device : "",
      seed: row.seed,
      autoStart: Boolean(row.auto_start),
      startedAt: iso(row.started_at),
      createdAt: iso(row.created_at)!,
      alive,
      account,
      episode,
    };
  }

  /** The machine's episode log: the newest one, or a given version by its hash. */
  async episode(siteId: string, assetId: string, sha256?: string) {
    const row = await this.row(assetId, siteId);
    const hash = (sha256 ?? row.episode_sha256 ?? "").replace(/^sha256:/, "");
    if (!hash) throw new HttpError(404, "This machine has not posted an episode log yet");
    const known = (await this.db.query("SELECT 1 FROM body_episodes WHERE asset_id = $1 AND sha256 = $2", [assetId, `sha256:${hash}`])).rows.length > 0;
    const b = known ? (await this.db.query<{ bytes: Uint8Array }>("SELECT bytes FROM blobs WHERE sha256 = $1", [hash])).rows[0] : undefined;
    if (!b) throw new HttpError(404, "Episode log not found");
    return { sha256: `sha256:${hash}`, log: JSON.parse(Buffer.from(b.bytes).toString("utf8")) as unknown };
  }
  async episodes(siteId: string, assetId: string) {
    await this.row(assetId, siteId);
    const r = await this.db.query<{ id: string; run_id: string | null; stage_code: string | null; sha256: string; entries: number; decisions: number; final: boolean; ledger_seq: number | null; created_at: string }>(
      "SELECT id, run_id, stage_code, sha256, entries, decisions, final, ledger_seq, created_at::text AS created_at FROM body_episodes WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 50",
      [assetId],
    );
    return r.rows.map((e) => ({ id: e.id, runId: e.run_id, stage: e.stage_code, sha256: e.sha256, entries: Number(e.entries), decisions: Number(e.decisions), final: Boolean(e.final), ledgerSeq: e.ledger_seq === null ? null : Number(e.ledger_seq), at: iso(e.created_at)! }));
  }

  /** Ask a machine about its run: the body answers from its episode log, through 0G when it has a brain. */
  async ask(siteId: string, assetId: string, question: string): Promise<BodyAnswer> {
    const row = await this.row(assetId, siteId);
    if (!row.ask_url || !["running", "sleeping", "safe_stopped"].includes(row.state)) throw new HttpError(409, "The machine's body is not running: start it to ask it");
    const res = await fetch(`${row.ask_url.replace(/\/$/, "")}/ask?q=${encodeURIComponent(question.slice(0, 2000))}`, {
      headers: { authorization: `Bearer ${this.keys.unseal(row.ask_token_enc)}`, accept: "application/json" },
      signal: AbortSignal.timeout(90_000),
    }).catch((e: Error) => {
      throw new HttpError(502, `The machine's body did not answer: ${e.message}`);
    });
    const j = (await res.json().catch(() => ({}))) as Partial<BodyAnswer> & { error?: string };
    if (!res.ok || typeof j.answer !== "string") throw new HttpError(502, `The machine's body could not answer: ${j.error ?? res.status}`);
    return { answer: j.answer, requestId: j.requestId ?? null, model: j.model ?? null };
  }

  // ---------------------------------------------------------------- the body's signed edge channel
  /** The virtual machine whose key signed this request. */
  private async ownAsset(device: Address, assetId: string) {
    if (!(await this.readings.assetsOf(device)).some((a) => a.id === assetId)) throw new HttpError(403, "This key is not that machine's");
    return this.row(assetId);
  }

  /** A body holds its stage: it cannot reach 0G and stops safely, or its agent decided the stage must stop. */
  async hold(device: Address, b: z.infer<typeof BodyHold>) {
    const run = (await this.db.query<{ site_id: string }>("SELECT site_id FROM runs WHERE id = $1", [b.runId])).rows[0];
    if (!run) throw new HttpError(404, "Run not found");
    const st = (await this.engine.view(run.site_id, b.runId)).stages.find((s) => s.code === b.stage);
    if (!st?.assetId || !(await this.readings.assetsOf(device)).some((a) => a.id === st.assetId)) throw new HttpError(403, "This machine is not the one running that stage");
    const reason = `${b.kind === "safe_stop" ? "Safe stop" : "The machine's agent held the stage"}: ${b.reason}`;
    if (st.state !== "held") await this.engine.hold(run.site_id, `machine:${device}`, b.runId, b.stage, reason);
    if (b.kind === "safe_stop") await this.db.query("UPDATE machine_bodies SET state = 'safe_stopped', error = $2, updated_at = now() WHERE asset_id = $1 AND state <> 'stopped'", [st.assetId, b.reason]);
    return { held: true, already: st.state === "held" };
  }

  /** A body's report: its state, and its episode log when it has new entries (kept, put on the ledger, copied to 0G Storage). */
  async report(device: Address, b: BodyReport) {
    const row = await this.ownAsset(device, b.assetId);
    if (!["stopped", "failed"].includes(row.state)) {
      // a body that reports running again after a safe stop has 0G back; the hold stays until a person releases it
      const error = b.state === "safe_stopped" ? row.error : null;
      await this.setState(b.assetId, b.state, error, { brain: b.brain });
    }
    if (!b.episode) return { stored: false };
    const bytes = Buffer.from(JSON.stringify(b.episode.log));
    if (bytes.byteLength > MAX_EPISODE_BYTES) throw new HttpError(400, "An episode log is at most 2 MB");
    const hex = sha(bytes);
    await this.db.query("INSERT INTO blobs (sha256, mime, size, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING", [hex, "application/json", bytes.byteLength, bytes]);
    const entries = b.episode.log.entries;
    const decisions = entries.filter((e) => e.kind === "decision");
    const requestIds = entries.map((e) => e.requestId).filter((x): x is string => typeof x === "string");
    const e = await this.rec.event(`device:${device}`, "machine.episode_logged", b.assetId, {
      site: row.site_id,
      runId: b.episode.runId,
      stage: b.episode.stage,
      sha256: `sha256:${hex}`,
      entries: entries.length,
      decisions: decisions.length,
      brain: b.brain,
      model: b.model,
      final: b.episode.final,
      // every 0G request behind a perception or decision in the log
      requestIds: requestIds.slice(-50),
    });
    await this.db.query("INSERT INTO body_episodes (id, site_id, asset_id, run_id, stage_code, sha256, entries, decisions, final, ledger_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
      newId("ep"),
      row.site_id,
      b.assetId,
      b.episode.runId,
      b.episode.stage,
      `sha256:${hex}`,
      entries.length,
      decisions.length,
      b.episode.final,
      e.seq,
    ]);
    await this.db.query("UPDATE machine_bodies SET episode_sha256 = $2, episode_at = now() WHERE asset_id = $1", [b.assetId, `sha256:${hex}`]);
    const last = this.lastReplica.get(b.assetId) ?? 0;
    if (this.replicas && (b.episode.final || this.now() - last > REPLICA_EVERY_MS)) {
      this.lastReplica.set(b.assetId, this.now());
      await this.replicas.request(row.site_id, `sha256:${hex}`).catch((err: Error) => console.error("[ordo] episode replica", err.message));
    }
    return { stored: true, sha256: `sha256:${hex}`, ledgerSeq: e.seq };
  }

  // ---------------------------------------------------------------- keeping them running
  /** A runner's news about a body (a crash it gave up on, a restart). */
  async runnerReport(assetId: string, state: "running" | "failed", error: string | null) {
    await this.db.query("UPDATE machine_bodies SET state = $2, error = $3, updated_at = now() WHERE asset_id = $1 AND state NOT IN ('stopped')", [assetId, state, error]);
  }

  /** On boot: start again every body that was running when Ordo stopped. */
  async resume() {
    if (!this.runtime) return;
    const rows = await this.db.query<{ asset_id: string; site_id: string }>(
      "SELECT b.asset_id, b.site_id FROM machine_bodies b JOIN assets a ON a.id = b.asset_id WHERE a.archived_at IS NULL AND b.state IN ('running','starting','sleeping','safe_stopped') AND (b.runtime = $1 OR b.runtime IS NULL)",
      [this.runtime],
    );
    for (const r of rows.rows) await this.start(r.site_id, r.asset_id, "system:bodies", "Ordo restarted").catch((e: Error) => console.error(`[ordo] body ${r.asset_id}`, e.message));
  }

  /**
   * Look ahead: a body is started when a run reaches the stage before its machine's own (or its own stage is running and
   * it is not). A body a person stopped stays stopped. Archived machines' bodies are stopped.
   */
  async reconcile(force = false) {
    if (!this.runtime || (!force && this.now() - this.lastReconcile < RECONCILE_MS)) return;
    this.lastReconcile = this.now();
    const bodies = (
      await this.db.query<{ asset_id: string; site_id: string; state: BodyState; auto_start: boolean; profile: string; archived: boolean }>(
        "SELECT b.asset_id, b.site_id, b.state, b.auto_start, b.profile, (a.archived_at IS NOT NULL) AS archived FROM machine_bodies b JOIN assets a ON a.id = b.asset_id",
      )
    ).rows;
    if (!bodies.length) return;
    for (const b of bodies.filter((x) => x.archived && x.state !== "stopped")) await this.stop(b.site_id, b.asset_id, "system:bodies", "The machine was archived").catch(() => undefined);
    const wanted = new Map<string, string>();
    const runs = await this.db.query<{ id: string; site_id: string }>("SELECT id, site_id FROM runs WHERE status = 'running'");
    for (const r of runs.rows) {
      const view = await this.engine.view(r.site_id, r.id, undefined, false).catch(() => null);
      if (!view) continue;
      const preds = predecessors(view.stages);
      const state = new Map(view.stages.map((s) => [s.code, s.state]));
      for (const s of view.stages) {
        if (ACTIVE.includes(s.state) && s.assetId) wanted.set(s.assetId, `${r.id} ${s.code} runs on it`);
        if (s.state !== "queued" || s.resourceKind === "system") continue;
        // the stage before this one has started: wake the machines that may run this one
        const ps = preds.get(s.code) ?? [];
        if (!ps.every((p) => state.get(p) !== "queued")) continue;
        for (const b of bodies) if (b.site_id === r.site_id && !b.archived && (s.machine ? b.asset_id === s.machine : b.profile === s.resourceKind)) wanted.set(b.asset_id, `${r.id} reached the stage before ${s.code}`);
      }
    }
    for (const b of bodies) {
      const why = wanted.get(b.asset_id);
      // a failed body waits for a person to look at it and start it again
      if (!why || b.archived || !b.auto_start || b.state !== "stopped") continue;
      await this.start(b.site_id, b.asset_id, "system:bodies", `Look-ahead: ${why}`).catch((e: Error) => console.error(`[ordo] body ${b.asset_id}`, e.message));
    }
    // idle stop (a Vercel Sandbox runner): a body no run has wanted for its idle time is stopped, which snapshots its
    // microVM, and marked stopped so look-ahead starts it again; the others' sessions are kept alive
    for (const id of wanted.keys()) this.lastWanted.set(id, this.now());
    for (const runner of this.runners.values()) {
      const r = runner as BodyRunner & { sweep?: (lastActive: (assetId: string) => number | null) => Promise<{ stopped: string[] }> };
      if (!r.sweep) continue;
      const swept = await r.sweep((id) => this.lastWanted.get(id) ?? null).catch((e: Error) => (console.error("[ordo] body sweep", e.message), null));
      for (const id of swept?.stopped ?? [])
        await this.db.query("UPDATE machine_bodies SET state = 'stopped', stopped_at = now(), updated_at = now() WHERE asset_id = $1 AND state <> 'stopped'", [id]);
    }
  }

  /** The server is stopping: stop the runners' processes, leaving every body's record as it is so it starts again on boot. */
  async shutdown() {
    for (const r of this.runners.values()) await (r as BodyRunner & { shutdown?: () => Promise<void> }).shutdown?.().catch(() => undefined);
  }
}
