import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { z } from "zod";
import { SESSION_COOKIE, type Principal } from "../auth/auth.js";
import { MCP_PATH } from "../chain/mcp.js";
import { ASSESSMENT_PATH, assessVibration } from "../chain/x402.js";
import { CATEGORIES } from "../core/templates.js";
import { REJECT } from "../core/inbox.js";
import { LICENSE_DAYS } from "../core/agent-licenses.js";
import { lineInScope, needLevel, redactRun, redactRuns, stageInScope, type Access } from "../core/access.js";
import { FinishBody } from "../core/contributions.js";
import { MAX_OUTPUT_BYTES, MAX_PREVIEW_BYTES, OutputMeta } from "../core/outputs.js";
import { OfferBody, OfferPatch } from "../core/resources.js";
import { BodyCreate, BodyHold, BodyReport, MAX_EPISODE_BYTES } from "../core/body-service.js";
import { publicBase } from "../config.js";
import { canApproveAny } from "../domain/policy.js";
import { ACCESS_LABEL, ACCESS_LEVELS, AccessScope, AGENT_INFO, AGENTS, ASSET_KIND_LABEL, ASSET_KINDS, AgentKey, AssetKind, AutonomyLevel, DataSource, DEFAULT_LEVEL, MachineRole, PackageType, Role, ROLE_INFO, ROLE_LABEL, ROLES, SignalLimit, TemplateSpec, type AccessLevel } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import { probeDevices } from "../plant/mtconnect.js";
import type { System } from "../wiring.js";

export interface AppOptions {
  webDist?: string;
  corsOrigins?: string[];
  secureCookies?: boolean;
  build?: { env: string; commit: string | null };
}
type Env = { Variables: { principal: Principal | null; siteId: string; roles: Role[]; access: Access } };

const Hex = z.string().regex(/^0x[0-9a-fA-F]+$/) as unknown as z.ZodType<`0x${string}`>;
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** an address, or a name that resolves to one */
const AddressOrName = z.string().trim().min(3).max(255);
const SignedBody = z.object({ nonce: z.string().min(8), signature: Hex });
const AssetBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: AssetKind,
  zoneId: z.string().nullable().default(null),
  description: z.string().max(300).nullable().default(null),
  owningAgent: AgentKey,
  source: DataSource,
  limits: z.record(z.string(), SignalLimit).default({}),
  idealCycleS: z.number().positive().nullable().default(null),
});

export function createApp(sys: System, opts: AppOptions = {}) {
  const app = new Hono<Env>();
  if (opts.corsOrigins?.length) app.use("/v1/*", cors({ origin: opts.corsOrigins, credentials: true, allowHeaders: ["content-type"] }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  const host = (c: Context) => c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost";

  // CSRF: a state-changing request from a browser must come from this origin (or an allowed one).
  app.use("/v1/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      // x402 and public ENS routes are meant to be called from anywhere
      if (origin && !c.req.path.startsWith("/v1/x402/") && !c.req.path.startsWith("/v1/public/")) {
        let o: string | null = null;
        try {
          o = new URL(origin).host;
        } catch {
          // "null" (sandboxed frames, privacy redirects) or garbage: not this origin
        }
        if (o !== host(c) && !(opts.corsOrigins ?? []).includes(origin)) throw new HttpError(403, "Cross-site request blocked");
      }
    }
    c.set("principal", await sys.auth.principal(getCookie(c, SESSION_COOKIE)));
    await next();
  });

  const me = (c: Context<Env>) => {
    const p = c.get("principal");
    if (!p) throw new HttpError(401, "Sign in with your wallet");
    return p;
  };
  const need = (c: Context<Env>, ...roles: Role[]) => {
    const have = c.get("roles");
    if (!roles.some((r) => canApproveAny(have, r))) throw new HttpError(403, `Needs ${roles.map((r) => ROLE_LABEL[r]).join(" or ")}`);
  };
  /** The caller's visibility in this org must reach `min` (1 stages, 2 outcomes, 3 proofs and measurements, 4 everything). */
  const lvl = (c: Context<Env>, min: AccessLevel, what?: string) => needLevel(c.get("access"), min, what);
  const actor = (c: Context<Env>) => `user:${me(c).user.address}`;
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => schema.parse(await c.req.json().catch(() => ({})));

  // ---------------- Public ----------------
  app.get("/health", (c) => c.json({ status: "ok", db: sys.db.kind, ...opts.build }));
  app.get("/v1/status", async (c) =>
    c.json({
      rails: sys.rails,
      warnings: sys.warnings,
      policy: { id: sys.policy.policy.id, version: sys.policy.policy.version, hash: sys.policy.hash },
      build: opts.build ?? null,
      signatureChainId: sys.cfg.SIGNATURE_CHAIN_ID,
      trust: sys.trust.chain
        ? { chainId: sys.trust.chain.cfg.chainId, name: sys.trust.chain.cfg.name, rpcUrl: sys.trust.chain.cfg.rpcUrl, explorerUrl: sys.trust.chain.cfg.explorerUrl, address: sys.trust.chain.cfg.address, symbol: sys.trust.chain.cfg.symbol, decimals: sys.trust.chain.cfg.decimals, workOrders: sys.trust.chain.cfg.workOrders ?? null, policies: sys.trust.chain.cfg.policies ?? null }
        : null,
      restrictedSiteCreation: Boolean(sys.cfg.BOOTSTRAP_ADMIN_ADDRESS),
    }),
  );
  app.get("/v1/meta", (c) =>
    c.json({
      roles: ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r], info: ROLE_INFO[r], defaultLevel: DEFAULT_LEVEL[r] })),
      levels: ACCESS_LEVELS.map((l) => ({ level: l, label: ACCESS_LABEL[l] })),
      agents: AGENTS.map((a) => ({ key: a, ...AGENT_INFO[a] })),
      assetKinds: ASSET_KINDS.map((k) => ({ key: k, label: ASSET_KIND_LABEL[k] })),
      categories: CATEGORIES,
      packageTypes: PackageType.options,
      policy: sys.policy.policy,
      /** whether a run needs a machine on every stage (STAGE_MACHINES) */
      machinesRequired: sys.cfg.STAGE_MACHINES === "required",
      /** the ENS root every name sits under (ordo.eth), when names are on */
      ensRoot: sys.names.live ? sys.names.root : null,
      /** the Hedera network, for HashScan links to payments, schedules and HCS records */
      hederaNetwork: sys.cfg.HEDERA_NETWORK,
    }),
  );

  // ---------------- Auth (Sign-In with Ethereum) ----------------
  app.post("/v1/auth/nonce", async (c) => c.json({ nonce: await sys.auth.issueNonce(), domain: host(c), uri: `${c.req.header("x-forwarded-proto") ?? "http"}://${host(c)}` }));
  app.post("/v1/auth/verify", async (c) => {
    const b = await body(c, z.object({ message: z.string().min(20).max(4000), signature: Hex }));
    const { token, principal } = await sys.auth.signIn({ message: b.message, signature: b.signature, domain: host(c), userAgent: c.req.header("user-agent") });
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: opts.secureCookies ?? false, path: "/", maxAge: sys.cfg.SESSION_TTL_HOURS * 3600 });
    await sys.rec.event(`user:${principal.user.address}`, "auth.signed_in", null, { userAgent: c.req.header("user-agent")?.slice(0, 120) ?? null });
    return c.json(await meView(principal));
  });
  app.post("/v1/auth/logout", async (c) => {
    const p = c.get("principal");
    if (p) await sys.auth.signOut(p.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  const meView = async (p: Principal) => {
    const ens = sys.ensNames ? (await sys.ensNames.lookup([p.user.address]))[p.user.address] ?? null : null;
    const canCreateSite = !sys.cfg.BOOTSTRAP_ADMIN_ADDRESS || sys.cfg.BOOTSTRAP_ADMIN_ADDRESS.toLowerCase() === p.user.address;
    // someone who has not chosen a handle (or was given member-…) is offered one from their display name
    const handleSuggestion = !p.user.handle || p.user.handle.startsWith("member-") ? await sys.handles.suggestion(p.user.id) : null;
    return { user: { ...p.user, ens, handleSuggestion, names: await sys.names.ofUser(p.user.id) }, memberships: p.memberships, canCreateSite };
  };
  /** an optional handle in a body: chosen before the action it comes with (joining, creating an org) */
  const takeHandle = async (c: Context, userId: string) => {
    const b = (await c.req.json().catch(() => ({}))) as { handle?: unknown };
    if (typeof b.handle === "string" && b.handle.trim()) await sys.handles.set(userId, b.handle);
  };
  app.get("/v1/me", async (c) => {
    const p = c.get("principal");
    if (!p) return c.json({ user: null, memberships: [], canCreateSite: false });
    return c.json(await meView(p));
  });
  app.patch("/v1/me", async (c) => {
    const b = await body(c, z.object({ displayName: z.string().trim().min(1).max(60).optional(), handle: z.string().trim().min(1).max(64).optional() }).refine((x) => x.displayName !== undefined || x.handle !== undefined, "Send a display name or a handle"));
    if (b.displayName !== undefined) await sys.auth.setDisplayName(me(c).user.id, b.displayName);
    if (b.handle !== undefined) await sys.handles.set(me(c).user.id, b.handle);
    return c.json(await meView((await sys.auth.principal(getCookie(c, SESSION_COOKIE)))!));
  });
  // what an Ordo name names (for /#/name/<ens> links), signed out too
  app.get("/v1/names/lookup", async (c) => {
    const n = (c.req.query("name") ?? "").trim().toLowerCase();
    if (!/^([a-z0-9-]{1,63}\.)+eth$/.test(n)) throw new HttpError(400, "Expected an ENS name");
    const hit = await sys.names.lookup(n);
    if (!hit) throw new HttpError(404, `${n} is not an Ordo name`);
    const p = c.get("principal");
    const member = p?.memberships.some((m) => m.siteId === hit.siteId) ?? false;
    // outsiders learn the name exists and its kind; members also learn what it points at
    return c.json(member ? hit : { name: hit.name, kind: hit.kind, status: hit.status });
  });
  // is a handle free? (signed out works too, for the join screen)
  app.get("/v1/handles/:handle", async (c) => c.json(await sys.handles.check(c.req.param("handle").slice(0, 64), c.get("principal")?.user.id)));

  app.post("/v1/sites", async (c) => {
    const p = me(c);
    if (sys.cfg.BOOTSTRAP_ADMIN_ADDRESS && sys.cfg.BOOTSTRAP_ADMIN_ADDRESS.toLowerCase() !== p.user.address) throw new HttpError(403, "Only the configured administrator wallet can create sites");
    const b = await body(c, z.object({ name: z.string().trim().min(2).max(80), timezone: z.string().min(1).max(60), lineName: z.string().trim().min(1).max(60), zones: z.array(z.string().max(60)).max(20), handle: z.string().trim().min(1).max(64).optional() }));
    if (b.handle) await sys.handles.set(p.user.id, b.handle);
    const { handle: _handle, ...site } = b;
    const id = await sys.plant.createSite(site, p.user.id);
    await sys.rec.decide(id, { agent: `user:${p.user.address}`, kind: "site.created", summary: `Created site ${b.name} with line ${b.lineName}` });
    return c.json({ id });
  });

  // ---------------- Proof of work: the contributor's terminal agent, authenticated by its session token ----------------
  /** Where the console is, for links the terminal agent prints: the public URL, else the origin this request came to. */
  const origin = (c: Context) => publicBase(sys.cfg) ?? `${c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")}://${host(c)}`;
  const powSecret = (c: Context) => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  app.get("/v1/pow/session", async (c) => c.json(await sys.contributions.sessionInfo(powSecret(c), sys.bodies)));
  app.post("/v1/pow/session/finish", async (c) => c.json(await sys.contributions.finish(powSecret(c), await body(c, FinishBody), origin(c))));
  app.get("/v1/pow/session/status", async (c) => c.json(await sys.contributions.status(powSecret(c), origin(c))));
  // the media the stage's machine captured for one outcome (or its preview), so the interviewer can show it to the contributor
  for (const which of ["file", "preview"] as const) {
    app.get(`/v1/pow/session/outputs/:key${which === "preview" ? "/preview" : ""}`, async (c) => {
      const v = c.req.query("version");
      const f = await sys.contributions.sessionOutput(powSecret(c), c.req.param("key"), which, v && /^\d{1,6}$/.test(v) ? Number(v) : undefined);
      return new Response(f.bytes, { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${f.name}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    });
  }
  // the interviewer asks the stage's machine about its run; its body answers through 0G
  app.post("/v1/pow/session/ask-machine", async (c) => {
    const b = await body(c, z.object({ question: z.string().trim().min(3).max(1000) }));
    return c.json(await sys.contributions.askMachine(powSecret(c), b.question, sys.bodies));
  });
  // a signed proof of work, for anyone with the link: commitments and receipts, never the values
  app.get("/v1/public/contributions/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(404, "Not found");
    return c.json(await sys.contributions.publicView(id));
  });

  // ---------------- Explore and join orgs (any signed-in wallet) ----------------
  app.get("/v1/orgs", async (c) => c.json(await sys.plant.explore(c.get("principal")?.user.id ?? null)));
  app.post("/v1/orgs/:siteId/join", async (c) => {
    const p = me(c);
    const siteId = c.req.param("siteId");
    if (!/^[\w-]{1,64}$/.test(siteId)) throw new HttpError(404, "No org with that code");
    await takeHandle(c, p.user.id);
    const r = await sys.plant.join(siteId, p.user.id);
    if (r.joined) await sys.rec.decide(siteId, { agent: `user:${p.user.address}`, kind: "team.joined", summary: `${p.user.displayName ?? p.user.address} joined as a contributor` });
    return c.json({ ...r, me: await meView((await sys.auth.principal(getCookie(c, SESSION_COOKIE)))!) });
  });

  // ---------------- Lot passports: public, no sign-in (the QR code on a shipped lot and the NFT metadata) ----------------
  app.get("/v1/public/passports/:runId", async (c) => {
    const id = c.req.param("runId");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(404, "No passport for this lot");
    c.header("access-control-allow-origin", "*");
    c.header("cache-control", "public, max-age=30");
    return c.json(await sys.passports.publicView(id));
  });

  app.get("/v1/public/zk/spec-check", (c) => {
    const vkey = sys.passports.specs?.verificationKey();
    if (!vkey) throw new HttpError(404, "This deployment does not prove criteria");
    c.header("access-control-allow-origin", "*");
    c.header("cache-control", "public, max-age=3600");
    return c.json({
      circuit: "spec_check",
      system: "groth16-bn254",
      publicSignals: ["subject", "target", "op", "commitment"],
      statement: "The prover knows value and salt with Poseidon(subject, value, salt) = commitment and value ≥ target (op 0), ≤ target (op 1) or = target (op 2), fixed point ×10⁴.",
      subject: "sha256('ordo:spec:<runId>:<stageCode>:<criterion label>') mod the BN254 scalar field. A range criterion proves twice over that subject: its lower bound (op 0), and its upper bound listed as '<label>#max' (op 1).",
      measurement: "When the instrument's gateway (or the operator) measured the value, the commitment is the one it signed as an OrdoMeasurement (EIP-712, domain {name: Ordo, version: 2}); the passport carries that signature. Otherwise Ordo's server committed to the value it recorded.",
      verificationKey: vkey,
      ceremony: sys.passports.specs?.ceremony() ?? null,
    });
  });

  app.get("/v1/public/zk/stage-check", (c) => {
    const vkey = sys.stageProofs.verificationKey();
    if (!vkey) throw new HttpError(404, "This deployment does not prove stages");
    c.header("access-control-allow-origin", "*");
    c.header("cache-control", "public, max-age=3600");
    return c.json({
      circuit: "stage_check",
      system: "groth16-bn254",
      publicSignals: ["subject", "commitment", "kind[4]", "op[4]", "target[4]"],
      statement:
        "The prover knows good, scrap, startedAt, endedAt and salt with Poseidon(subject, good, scrap, startedAt, endedAt, salt) = commitment, and each used criterion holds: kind 1 yield %, 2 scrap %, 3 defects ppm, 4 cycle time in s, 5 cycle time in min; op 0 ≥, 1 ≤, 2 =; targets ×10⁴. The commitment is what the machine's gateway (or the operator) signed as an OrdoReading.",
      subject: "sha256('ordo:stage:<siteId>:<runId>:<stageCode>') mod the BN254 scalar field",
      verificationKey: vkey,
      ceremony: sys.stageProofs.ceremony(),
    });
  });

  // ---------------- Edge: a machine's gateway, authenticated by its own key on every request ----------------
  const edge = async (c: Context<Env>) => {
    const raw = c.req.method === "GET" ? "" : await c.req.text();
    const device = await sys.readings.device({ device: c.req.header("x-ordo-device"), ts: c.req.header("x-ordo-ts"), nonce: c.req.header("x-ordo-nonce"), sig: c.req.header("x-ordo-sig") }, c.req.method, c.req.path, raw);
    return { device, json: () => JSON.parse(raw || "{}") as unknown };
  };
  const Observation = z.object({ signal: z.string().trim().min(1).max(40), ts: z.string().datetime(), value: z.number().finite().nullable(), text: z.string().max(200).nullable().default(null) });
  const ReadingBody = z.object({
    runId: z.string().min(1).max(64),
    stage: z.string().min(1).max(32),
    good: z.number().int().min(0),
    scrap: z.number().int().min(0),
    salt: z.string().regex(/^\d{1,80}$/),
    commitment: z.string().regex(/^\d{1,80}$/),
    anchor: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((x) => x as `0x${string}`),
    signedAt: z.number().int().positive(),
    signature: Hex,
  });
  app.get("/v1/edge/stages", async (c) => c.json({ stages: await sys.readings.edgeStages((await edge(c)).device) }));
  app.post("/v1/edge/observations", async (c) => {
    const e = await edge(c);
    const b = z.object({ assetId: z.string().min(1), observations: z.array(Observation).min(1).max(1000) }).parse(e.json());
    return c.json(await sys.readings.observations(e.device, b.assetId, b.observations));
  });
  app.post("/v1/edge/readings", async (c) => {
    const e = await edge(c);
    return c.json(await sys.readings.submitFromDevice(e.device, ReadingBody.parse(e.json())));
  });
  const MeasurementsBody = z.object({
    runId: z.string().min(1).max(64),
    stage: z.string().min(1).max(32),
    measurements: z
      .array(
        z.object({
          criterion: z.string().min(1).max(90),
          value: z.string().regex(/^\d{1,20}$/),
          salt: z.string().regex(/^\d{1,80}$/),
          commitment: z.string().regex(/^\d{1,80}$/),
          anchor: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((x) => x as `0x${string}`),
          signedAt: z.number().int().positive(),
          signature: Hex,
        }),
      )
      .min(1)
      .max(40),
  });
  // a machine asks what the stages after its running stage still need, with the best offer for each (look-ahead buying)
  app.get("/v1/edge/purchases/needed", async (c) => c.json(await sys.resources.needed(await sys.readings.assetsOf((await edge(c)).device))));
  app.post("/v1/edge/measurements", async (c) => {
    const e = await edge(c);
    const b = MeasurementsBody.parse(e.json());
    return c.json(await sys.readings.submitMeasurementsFromDevice(e.device, b.runId, b.stage, b.measurements));
  });
  /**
   * A machine uploads the media it captured for one of its stage's outcomes: multipart with `meta` (JSON: run, stage,
   * outcome, capturedAt, value, sha256, its OrdoOutput signature, and its agent's reading), `file`, and an optional
   * `preview` (a keyframe, spectrogram or chart). The request itself is signed like every edge request, over the bytes.
   */
  app.post("/v1/edge/outputs", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_OUTPUT_BYTES + MAX_PREVIEW_BYTES + 64 * 1024) throw new HttpError(400, "The upload is too large");
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const device = await sys.readings.device({ device: c.req.header("x-ordo-device"), ts: c.req.header("x-ordo-ts"), nonce: c.req.header("x-ordo-nonce"), sig: c.req.header("x-ordo-sig") }, c.req.method, c.req.path, raw);
    const form = await new Request("http://edge/", { method: "POST", headers: { "content-type": c.req.header("content-type") ?? "" }, body: raw }).formData().catch(() => {
      throw new HttpError(400, "Send multipart/form-data with meta and file");
    });
    const metaRaw = form.get("meta");
    const file = form.get("file");
    const preview = form.get("preview");
    if (typeof metaRaw !== "string" || !(file instanceof File)) throw new HttpError(400, "Send multipart/form-data with meta and file");
    const meta = OutputMeta.parse(JSON.parse(metaRaw));
    const asUpload = async (f: File) => ({ bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type });
    return c.json(await sys.outputs.ingest(device, meta, await asUpload(file), preview instanceof File ? await asUpload(preview) : null));
  });
  /**
   * A machine whose purchase is over budget (the price above the stage's maxPrice, or above its balance) asks for a
   * top-up: the purchasing helper's report (edge/purchasing.ts OverBudget) with its reasoning, the 0G request id of the
   * decision and the value at risk. A machine without a 0G brain sends no request id: its reasoning is its report of the
   * facts, and the top-up says so. Ordo writes the reasoning to HCS first, then schedules a top-up from the org's
   * treasury that a manager approves (OrdoTreasury); unapproved, it lapses on Hedera and the stage is held.
   */
  const tinybars = z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative()]).transform(String);
  const OverBudgetBody = z.object({
    runId: z.string().min(1).max(64),
    stage: z.string().min(1).max(32),
    resource: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    amountTinybar: tinybars,
    reasoning: z.string().trim().min(10).max(4000),
    requestId: z.string().trim().min(1).max(200).optional(),
    valueAtRisk: z.union([z.string().trim().min(1).max(120), z.number().finite()]).transform(String).optional(),
    // the rest of the purchasing helper's report, all optional
    reason: z.enum(["price_above_max", "balance_short"]).optional(),
    assetId: z.string().min(1).max(64).optional(),
    qty: z.number().nonnegative().max(1e12).optional(),
    unit: z.string().max(16).optional(),
    vendorId: z.string().max(64).optional(),
    sku: z.string().max(120).optional(),
    priceTinybar: tinybars.optional(),
    maxPriceTinybar: tinybars.optional(),
    balanceTinybar: tinybars.nullable().optional(),
    detail: z.string().max(500).optional(),
  });
  app.post("/v1/edge/overbudget", async (c) => {
    const e = await edge(c);
    return c.json(await sys.budgets.overBudget(e.device, OverBudgetBody.parse(e.json())));
  });

  // a virtual machine's body: it holds its stage (a safe stop when 0G is unreachable, or its agent's decision), and reports
  // its state with its episode log (every perception and decision, with its 0G request ID)
  app.post("/v1/edge/hold", async (c) => {
    const e = await edge(c);
    return c.json(await sys.bodies.hold(e.device, BodyHold.parse(e.json())));
  });
  app.post("/v1/edge/episodes", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_EPISODE_BYTES + 64 * 1024) throw new HttpError(400, "An episode log is at most 2 MB");
    const e = await edge(c);
    return c.json(await sys.bodies.report(e.device, BodyReport.parse(e.json())));
  });

  // ---------------- Running pipelines: public, no sign-in, so a newcomer can see what a site runs and apply for a role ----------------
  app.get("/v1/public/pipelines", async (c) => {
    c.header("cache-control", "public, max-age=15");
    return c.json(await sys.openings.list());
  });
  app.get("/v1/public/pipelines/:siteId/:runId", async (c) => {
    const [siteId, runId] = [c.req.param("siteId"), c.req.param("runId")];
    if (!/^[\w-]{1,64}$/.test(siteId) || !/^[\w-]{1,64}$/.test(runId)) throw new HttpError(404, "No public pipeline here");
    c.header("cache-control", "public, max-age=15");
    return c.json(await sys.openings.get(siteId, runId));
  });

  // ---------------- x402: vibration assessments sold per call, paid in HBAR (no sign-in; the payment is the credential) ----------------
  const Assess = z.object({
    machineClass: z.enum(["medium", "large"]).default("medium"),
    samples: z.array(z.object({ t: z.number().finite(), v: z.number().finite().min(0).max(1000) })).min(3).max(5000),
  });
  const x402Cors = cors({ origin: "*", allowHeaders: ["content-type", "payment-signature", "x-payment"], exposeHeaders: ["payment-required", "payment-response"] });
  app.get("/v1/x402", async (c) => {
    c.header("access-control-allow-origin", "*");
    return c.json(
      sys.x402
        ? {
            offers: [
              { method: "POST", path: ASSESSMENT_PATH, ...sys.x402.terms, unit: "tinybar" },
              { method: "POST", path: "/v1/x402/vendors/{vendorId}/callout", network: sys.x402.terms.network, payTo: "the vendor's Hedera account", price: "a tenth of the vendor's hourly rate, at least 0.1 HBAR", asset: sys.x402.terms.asset },
              ...(sys.resources.store
                ? [{ method: "POST", path: "/v1/x402/vendors/{vendorId}/offers/{sku}?qty=&run=&stage=&resource=", network: sys.x402.terms.network, payTo: "the vendor's Hedera account", price: "the offer's price × qty (GET /v1/x402/vendors/{vendorId}/offers)", asset: sys.x402.terms.asset }]
                : []),
            ],
            mcp: sys.mcp ? { path: MCP_PATH, transport: "streamable-http", ...sys.mcp.priceList(), recentSales: await sys.mcp.sales(10) } : null,
          }
        : { offers: [], mcp: null },
    );
  });

  // The metered MCP server: any agent's MCP client connects here and pays per tool call (x402 in the call's _meta)
  app.use(MCP_PATH, cors({ origin: "*", allowMethods: ["POST", "GET", "DELETE", "OPTIONS"], allowHeaders: ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"], exposeHeaders: ["mcp-session-id"] }));
  app.all(MCP_PATH, async (c) => {
    if (!sys.mcp) throw new HttpError(404, "This deployment sells no MCP tools");
    return sys.mcp.handle(c.req.raw);
  });
  app.use(ASSESSMENT_PATH, x402Cors);
  app.use(ASSESSMENT_PATH, async (c, next) => {
    if (!sys.x402) throw new HttpError(404, "This deployment does not sell assessments");
    return sys.x402.middleware(c, next);
  });
  app.post(ASSESSMENT_PATH, async (c) => c.json(assessVibration(await body(c, Assess))));

  // A vendor's urgent call-out: machines (or anyone) reserve one by paying the vendor's deposit over x402
  const VENDOR_CALLOUT = "/v1/x402/vendors/:vendorId/callout";
  app.use(VENDOR_CALLOUT, x402Cors);
  app.use(VENDOR_CALLOUT, async (c, next) => {
    if (!sys.x402) throw new HttpError(404, "This deployment does not sell call-outs");
    // check the vendor before asking for payment, so nobody pays for a slot that cannot be reserved
    if (c.req.method === "POST" && !(await sys.machines.vendorAccount(c.req.param("vendorId")!))) throw new HttpError(404, "This vendor takes no call-outs: it has no Hedera account");
    return sys.x402.middleware(c, next);
  });
  app.post(VENDOR_CALLOUT, async (c) => {
    const b = await body(c, z.object({ assetId: z.string().max(64).optional(), reason: z.string().max(300).optional() }));
    return c.json(await sys.machines.reserveCallout(c.req.param("vendorId"), b));
  });

  // A vendor's offers of stage resources, sold per quantity: price × qty paid to the vendor; a delivery receipt Ordo signs
  const VENDOR_OFFER = "/v1/x402/vendors/:vendorId/offers/:sku";
  // a stage's purchase carries the ticket Ordo gave its Buyer machine (buyer, exp, t)
  const offerQuery = (c: Context) => ({ qty: c.req.query("qty"), run: c.req.query("run"), stage: c.req.query("stage"), resource: c.req.query("resource"), buyer: c.req.query("buyer"), exp: c.req.query("exp"), t: c.req.query("t") });
  app.use("/v1/x402/vendors/:vendorId/offers", x402Cors);
  app.get("/v1/x402/vendors/:vendorId/offers", async (c) => c.json(await sys.resources.catalog(c.req.param("vendorId"))));
  app.use(VENDOR_OFFER, x402Cors);
  app.use(VENDOR_OFFER, async (c, next) => {
    if (!sys.resources.store) throw new HttpError(404, "This deployment does not sell vendors' offers");
    // check the offer, the quantity and the stage before asking for payment, so nobody pays for what cannot be sold
    if (c.req.method === "POST") await sys.resources.check(c.req.param("vendorId")!, c.req.param("sku")!, offerQuery(c));
    return sys.resources.store(c, next);
  });
  app.post(VENDOR_OFFER, async (c) => c.json(await sys.resources.sell(c.req.param("vendorId"), c.req.param("sku"), offerQuery(c))));

  // ---------------- Site scope ----------------
  const site = new Hono<Env>();
  site.use("*", async (c, next) => {
    const p = me(c);
    const siteId = c.req.param("siteId")!;
    const m = p.memberships.find((x) => x.siteId === siteId);
    if (!m) throw new HttpError(403, "You are not a member of this site");
    c.set("siteId", siteId);
    c.set("roles", m.roles);
    c.set("access", await sys.access.of(siteId, p.user.id, m.roles));
    await next();
  });
  const sid = (c: Context<Env>) => c.get("siteId");
  // fields where people type an address also take a name (priya.acme.ordo.eth): resolved here, so the rest of Ordo sees addresses
  const toAddress = async (c: Context<Env>, q: string) => (/^0x[0-9a-fA-F]{40}$/.test(q) ? (q.toLowerCase() as `0x${string}`) : sys.nameResolver.toAddress(sid(c), q));
  const toAccount = async (c: Context<Env>, q: string) => (/^0\.0\.\d+$/.test(q) ? q : sys.nameResolver.toAccount(sid(c), q));
  /** a ship-to: a Hedera account or an EVM address, or a name standing for one (its Hedera account first) */
  const toShipTarget = async (c: Context<Env>, q: string) => {
    if (/^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/.test(q)) return q;
    const r = await sys.nameResolver.resolve(sid(c), q);
    const to = r.hedera ?? r.address;
    if (!to) throw new HttpError(400, `${q} has no Hedera account or address to ship to`);
    return to;
  };

  site.get("/", async (c) => {
    const s = await sys.plant.site(sid(c));
    const a = c.get("access");
    // lines out of the caller's scope are not listed
    return c.json({ ...s, lines: s.lines.filter((l) => lineInScope(a, l.id)), myRoles: c.get("roles"), myAccess: a });
  });
  site.patch("/", async (c) => {
    need(c, "manager");
    await sys.plant.updateSite(sid(c), await body(c, z.object({ name: z.string().trim().min(2).max(80).optional(), timezone: z.string().max(60).optional(), publicPipelines: z.boolean().optional(), openJoin: z.boolean().optional() })));
    return c.json(await sys.plant.site(sid(c)));
  });
  site.post("/zones", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
    return c.json({ id: await sys.plant.addZone(sid(c), b.name) });
  });
  site.patch("/zones/:zoneId", async (c) => {
    need(c, "manager");
    await sys.plant.renameZone(sid(c), c.req.param("zoneId"), (await body(c, z.object({ name: z.string().trim().min(1).max(60) }))).name);
    return c.json({ ok: true });
  });
  site.delete("/zones/:zoneId", async (c) => {
    need(c, "manager");
    await sys.plant.deleteZone(sid(c), c.req.param("zoneId"));
    return c.json({ ok: true });
  });

  // Autonomy is a policy decision: lowering takes one plant manager's signature, raising takes two.
  site.post("/lines/:lineId/autonomy/sign-request", async (c) => {
    const b = await body(c, z.object({ level: AutonomyLevel, comment: z.string().max(500).default(""), chainId: z.number().int().optional() }));
    return c.json(await sys.autonomy.request(sid(c), me(c).user, c.get("roles"), c.req.param("lineId"), b));
  });
  site.put("/lines/:lineId/autonomy", async (c) => {
    const b = await body(c, SignedBody.extend({ level: AutonomyLevel, comment: z.string().max(500).default("") }));
    const proposal = await sys.autonomy.sign(sid(c), me(c).user, c.get("roles"), c.req.param("lineId"), b);
    return c.json({ site: await sys.plant.site(sid(c)), proposal });
  });
  site.get("/autonomy/proposals", async (c) => c.json(await sys.autonomy.list(sid(c))));

  // ---- Team: four roles, open joining, promotions signed by a manager, visibility per role and per person ----
  site.get("/team", async (c) => {
    lvl(c, 1);
    const t = await sys.plant.team(sid(c));
    const issued = await sys.names.byAddress(sid(c));
    const ens = sys.ensNames ? await sys.ensNames.lookup(t.members.map((m) => m.address)) : {};
    const manager = c.get("roles").includes("manager");
    // each person's role names (priya.validators.acme.ordo.eth), from the org's directory
    const dir = (await sys.names.directory(sid(c))).entries;
    const roleNames = (userId: string) => dir.filter((e) => e.kind === "role" && e.ref.endsWith(`:${userId}`) && e.status !== "revoked").map((e) => ({ role: e.ref.split(":")[0], name: e.name, status: e.status }));
    return c.json({
      ...t,
      invites: manager ? t.invites : [],
      members: t.members.map((m) => ({ ...m, ens: issued.get(m.address.toLowerCase()) ?? ens[m.address] ?? null, roleNames: roleNames(m.userId) })),
      access: manager ? await sys.access.config(sid(c)) : null,
      relays: manager ? await sys.trust.roleRelays(sid(c)) : {},
    });
  });

  // ---- ENS names (ENSv2 on Sepolia) ----
  site.get("/names", async (c) => {
    lvl(c, 3, "names");
    const items = await sys.names.list(sid(c));
    return c.json({ live: sys.names.live, parent: sys.names.root, root: sys.names.root, org: items.find((x) => x.kind === "org")?.name ?? null, ...(await sys.names.state(sid(c))), items });
  });
  // every entity's name, for showing names wherever an id, address or account appears
  site.get("/directory", async (c) => {
    lvl(c, 1);
    return c.json({ live: sys.names.live, ...(await sys.names.directory(sid(c))) });
  });
  // a name typed into a form (or an address or account) → what it is at this org
  site.get("/names/resolve", async (c) => {
    lvl(c, 1);
    return c.json(await sys.nameResolver.resolve(sid(c), (c.req.query("q") ?? "").trim()));
  });
  // a manager registers the org's names now: anything not planned yet, and failed names again
  site.post("/names/sync", async (c) => {
    need(c, "manager");
    if (!sys.names.live) throw new HttpError(409, "ENS names are off on this server (ENS_PARENT_NAME, ENS_NAMES_ADDRESS)");
    return c.json(await sys.names.resync(sid(c)));
  });
  site.post("/names/:kind/:ref/retry", async (c) => {
    need(c, "manager");
    await sys.names.retry(sid(c), c.req.param("kind"), c.req.param("ref"));
    // releases on run names live in their own queue
    if (c.req.param("kind") === "run" || c.req.param("kind") === "release") await sys.lotNames.retry(sid(c), c.req.param("ref"));
    return c.json({ ok: true });
  });
  // a manager adds someone by wallet: they join as a contributor, and a manager promotes them from there
  site.post("/team/invites", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ address: AddressOrName }));
    const address = await toAddress(c, b.address);
    const r = await sys.plant.invite(sid(c), address, "contributor", me(c).user.id);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "team.invited", summary: `${r.added ? "Added" : "Invited"} ${b.address === address ? address : `${b.address} (${address})`} as a contributor` });
    return c.json(r);
  });
  site.delete("/team/invites/:id", async (c) => {
    need(c, "manager");
    await sys.plant.cancelInvite(sid(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  const RoleChange = z.object({ role: Role, grant: z.boolean(), comment: z.string().max(500).default("") });
  site.post("/team/members/:userId/roles/sign-request", async (c) => {
    need(c, "manager");
    const b = await body(c, RoleChange.extend({ chainId: z.number().int().optional() }));
    if (b.role === "contributor" && !b.grant) throw new HttpError(400, "To take someone out of the org, remove them");
    return c.json(await sys.trust.roleRequest(sid(c), me(c).user, c.req.param("userId"), b.role, b.grant, b.comment, b.chainId));
  });
  site.post("/team/members/:userId/roles", async (c) => {
    need(c, "manager");
    const b = await body(c, RoleChange.merge(SignedBody));
    return c.json(await sys.trust.setRole(sid(c), me(c).user, c.req.param("userId"), b.role, b.grant, b));
  });
  site.delete("/team/members/:userId", async (c) => {
    const target = c.req.param("userId");
    // anyone can leave; a manager can remove anyone
    if (target !== me(c).user.id) need(c, "manager");
    const held = (await sys.plant.team(sid(c))).members.find((m) => m.userId === target);
    if (held && [...held.roles, ...held.pending].some((r) => r !== "contributor") && target !== me(c).user.id)
      throw new HttpError(409, "Remove their validator, tester or manager role first, so the change is signed and reaches OrdoTrust");
    await sys.plant.removeMember(sid(c), target);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "team.removed", summary: target === me(c).user.id ? "Left the org" : `Removed ${target} from the org` });
    return c.json({ ok: true });
  });
  // visibility: a level and a scope per role, with per-person overrides
  const AccessBody = z.object({ level: z.number().int().refine((n) => (ACCESS_LEVELS as readonly number[]).includes(n), "level: 1 to 4").transform((n) => n as AccessLevel), scope: AccessScope });
  site.get("/access", async (c) => {
    need(c, "manager");
    return c.json(await sys.access.config(sid(c)));
  });
  site.put("/access/roles/:role", async (c) => {
    need(c, "manager");
    const role = Role.parse(c.req.param("role"));
    const b = await body(c, AccessBody);
    await sys.access.setRole(sid(c), me(c).user.id, role, b.level, b.scope);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "access.role_set", summary: `${ROLE_LABEL[role]}s see level ${b.level} (${ACCESS_LABEL[b.level]})${b.scope.lines || b.scope.stages ? " in a limited scope" : ""}`, data: { role, ...b } });
    return c.json(await sys.access.config(sid(c)));
  });
  site.put("/access/members/:userId", async (c) => {
    need(c, "manager");
    const b = await body(c, AccessBody.nullable());
    await sys.access.setMember(sid(c), me(c).user.id, c.req.param("userId"), b);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "access.member_set", summary: b ? `Set ${c.req.param("userId")} to level ${b.level}` : `Returned ${c.req.param("userId")} to their roles' access`, data: { userId: c.req.param("userId"), access: b } });
    return c.json(await sys.access.config(sid(c)));
  });

  // ---- Assets & data sources ----
  const assetAdmin = (c: Context<Env>) => need(c, "manager");
  site.get("/assets", async (c) => {
    lvl(c, 2, "the floor");
    return c.json(await sys.plant.views(sid(c)));
  });
  site.post("/assets/probe", async (c) => {
    assetAdmin(c);
    const b = await body(c, z.object({ agentUrl: z.string().url() }));
    return c.json({ devices: await probeDevices(b.agentUrl).catch((e: unknown) => Promise.reject(new HttpError(502, `Could not read the MTConnect agent: ${e instanceof Error ? e.message : e}`))) });
  });
  site.post("/assets", async (c) => {
    assetAdmin(c);
    const b = await body(c, AssetBody);
    const id = await sys.plant.createAsset(sid(c), b, me(c).user.id);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "asset.created", assetId: id, summary: `Registered ${b.name} (${ASSET_KIND_LABEL[b.kind]}) · ${b.source.type}` });
    await sys.advance(true);
    return c.json({ id });
  });
  // ---- Machine roles: Attester, Buyer and Runner, each an ENS role name a manager grants with a signature ----
  site.get("/assets/:id/roles", async (c) => {
    lvl(c, 2, "the floor");
    return c.json(await sys.machineRoles.list(sid(c), c.req.param("id")));
  });
  const MachineRoleChange = z.object({
    role: MachineRole,
    grant: z.boolean(),
    kinds: z.array(AssetKind).max(ASSET_KINDS.length).optional(),
    order: z.string().regex(/^\d{1,18}$/, "tinybar").optional(),
    daily: z.string().regex(/^\d{1,18}$/, "tinybar").optional(),
    comment: z.string().max(500).default(""),
  });
  site.post("/assets/:id/roles/sign-request", async (c) => {
    assetAdmin(c);
    const b = await body(c, MachineRoleChange.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.machineRoles.request(sid(c), me(c).user, c.req.param("id"), b.role, b.grant, { kinds: b.kinds, order: b.order, daily: b.daily }, b.comment, b.chainId));
  });
  site.post("/assets/:id/roles", async (c) => {
    assetAdmin(c);
    const b = await body(c, MachineRoleChange.merge(SignedBody));
    const r = await sys.machineRoles.set(sid(c), me(c).user, c.req.param("id"), b.role, b.grant, { kinds: b.kinds, order: b.order, daily: b.daily }, b);
    sys.names.touch(sid(c));
    return c.json(r);
  });
  // ---- Pay on proof: customers pay for a lot in Ordo USD, released only when the lot's quality is proven on-chain ----
  const Units = z.string().trim().regex(/^\d+(\.\d+)?$/, "an amount like 250 or 99.5");
  site.get("/finance", async (c) => {
    lvl(c, 4, "finance");
    return c.json(await sys.payOnProof.view(sid(c)));
  });
  site.post("/finance/parties", async (c) => {
    const b = await body(c, z.object({ kind: z.enum(["customer", "financier"]), name: z.string().trim().min(2).max(80) }));
    return c.json({ id: await sys.payOnProof.addParty(sid(c), me(c).user, c.get("roles"), b) });
  });
  site.post("/finance/parties/:partyId/cash-in", async (c) => {
    await sys.payOnProof.cashIn(sid(c), me(c).user, c.get("roles"), c.req.param("partyId"), (await body(c, z.object({ amount: Units }))).amount);
    return c.json({ queued: true });
  });
  site.post("/finance/orders", async (c) => {
    const b = await body(c, z.object({ packageId: z.string().min(1).max(64), customerId: z.string().min(1).max(64), amount: Units, days: z.number().int().min(1).max(365).default(30) }));
    return c.json(await sys.payOnProof.createOrder(sid(c), me(c).user, c.get("roles"), b));
  });
  site.post("/finance/orders/:orderId/offer", async (c) => {
    await sys.payOnProof.offer(sid(c), me(c).user, c.get("roles"), c.req.param("orderId"), (await body(c, z.object({ ask: Units }))).ask);
    return c.json({ queued: true });
  });
  site.post("/finance/orders/:orderId/take", async (c) => {
    await sys.payOnProof.take(sid(c), me(c).user, c.get("roles"), c.req.param("orderId"), (await body(c, z.object({ financierId: z.string().min(1).max(64) }))).financierId);
    return c.json({ queued: true });
  });
  site.post("/finance/orders/:orderId/waive", async (c) => {
    await sys.payOnProof.waive(sid(c), me(c).user, c.get("roles"), c.req.param("orderId"));
    return c.json({ queued: true });
  });

  // ---- Machine wallets: a machine's own Hedera account, which pays over x402 when the machine drifts ----
  const Budget = z.object({ dailyBudget: z.string().regex(/^\d+$/), perCall: z.string().regex(/^\d+$/) });
  site.get("/assets/:assetId/wallet", async (c) => {
    lvl(c, 4, "wallets");
    return c.json({ live: sys.machines.live, wallet: await sys.machines.get(sid(c), c.req.param("assetId")) });
  });
  site.put("/assets/:assetId/wallet", async (c) => c.json(await sys.machines.enable(sid(c), me(c).user, c.get("roles"), c.req.param("assetId"), await body(c, Budget))));
  site.post("/assets/:assetId/wallet/pause", async (c) => c.json(await sys.machines.pause(sid(c), me(c).user, c.get("roles"), c.req.param("assetId"), (await body(c, z.object({ stop: z.boolean() }))).stop)));
  // ---- Org treasury: run budgets and machine top-ups as Hedera schedules a manager approves (OrdoTreasury) ----
  site.get("/budgets", async (c) => {
    lvl(c, 4, "budgets");
    return c.json(await sys.budgets.view(sid(c)));
  });
  site.post("/treasury", async (c) => {
    const b = await body(c, z.object({ accountId: z.string().trim().min(3).max(255).optional() }));
    return c.json(await sys.budgets.open(sid(c), me(c).user, c.get("roles"), b.accountId ? await toAccount(c, b.accountId) : undefined));
  });
  site.post("/budgets/:id/approve/sign-request", async (c) => c.json(await sys.budgets.approveRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"))));
  site.post("/budgets/:id/approve", async (c) => c.json(await sys.budgets.approve(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, SignedBody))));
  site.post("/budgets/:id/decline", async (c) => c.json(await sys.budgets.decline(sid(c), me(c).user, c.get("roles"), c.req.param("id"), (await body(c, z.object({ reason: z.string().trim().max(500).default("") }))).reason)));
  site.get("/assets/:assetId", async (c) => {
    lvl(c, 3, "machine data");
    const id = c.req.param("assetId");
    const view = (await sys.plant.views(sid(c))).find((a) => a.id === id);
    if (!view) throw new HttpError(404, "Asset not found");
    const minutes = Math.min(24 * 60, Number(c.req.query("minutes") ?? 60));
    const signals = [...new Set([...Object.keys(view.limits), ...Object.keys(view.latest).filter((k) => view.latest[k]!.value !== null)])].slice(0, 8);
    const series: Record<string, { ts: number; value: number | null }[]> = {};
    for (const s of signals) series[s] = (await sys.plant.series(id, s, minutes)).map((p) => ({ ts: p.ts, value: p.value }));
    const asset = await sys.plant.asset(sid(c), id);
    return c.json({ view, asset, series, replays: await sys.plant.replays(sid(c), id) });
  });
  site.put("/assets/:assetId", async (c) => {
    assetAdmin(c);
    const b = await body(c, AssetBody);
    await sys.plant.updateAsset(sid(c), c.req.param("assetId"), b);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "asset.updated", assetId: c.req.param("assetId"), summary: `Updated ${b.name}` });
    return c.json({ ok: true });
  });
  site.delete("/assets/:assetId", async (c) => {
    assetAdmin(c);
    await sys.plant.archiveAsset(sid(c), c.req.param("assetId"));
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "asset.archived", assetId: c.req.param("assetId"), summary: `Archived asset` });
    return c.json({ ok: true });
  });
  site.post("/assets/:assetId/readings", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ signal: z.string().trim().min(1).max(40), value: z.number().nullable().default(null), text: z.string().max(80).nullable().default(null) }));
    await sys.plant.manualReading(sid(c), c.req.param("assetId"), b);
    await sys.rec.event(actor(c), "telemetry.manual", c.req.param("assetId"), b);
    return c.json({ ok: true });
  });
  site.post("/assets/:assetId/replays", async (c) => {
    assetAdmin(c);
    const csv = await c.req.text();
    if (csv.length > 4_000_000) throw new HttpError(400, "CSV is limited to 4 MB");
    const r = await sys.plant.uploadReplay(sid(c), c.req.param("assetId"), c.req.query("name") ?? "dataset.csv", csv, me(c).user.id);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "dataset.uploaded", assetId: c.req.param("assetId"), summary: `Uploaded ${c.req.query("name") ?? "dataset"}: ${r.rows} rows of ${r.signals.join(", ")}` });
    return c.json(r);
  });
  site.post("/assets/:assetId/replays/:seriesId/start", async (c) => {
    assetAdmin(c);
    const b = await body(c, z.object({ speed: z.number().min(0.1).max(600).default(1) }));
    await sys.plant.startReplay(sid(c), c.req.param("assetId"), c.req.param("seriesId"), b.speed);
    await sys.rec.decide(sid(c), { agent: actor(c), kind: "dataset.replay_started", assetId: c.req.param("assetId"), summary: `Started dataset replay at ${b.speed}×` });
    return c.json({ ok: true });
  });

  // ---- Templates & builder ----
  site.get("/templates", async (c) => {
    lvl(c, 1);
    return c.json(await sys.templates.list(sid(c)));
  });
  site.get("/templates/:templateId", async (c) => c.json(await sys.templates.get(sid(c), c.req.param("templateId"))));
  site.post("/templates", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ templateId: z.string().optional(), name: z.string().trim().min(2).max(80), category: z.string().trim().min(2).max(40), description: z.string().max(300).default(""), spec: TemplateSpec, note: z.string().max(200).optional() }));
    return c.json(await sys.templates.publish(sid(c), actor(c), b));
  });
  site.delete("/templates/:templateId", async (c) => {
    need(c, "manager");
    await sys.templates.archive(sid(c), c.req.param("templateId"));
    return c.json({ ok: true });
  });

  // ---- Runs ----
  site.get("/runs", async (c) => c.json(redactRuns(await sys.engine.list(sid(c), { days: Number(c.req.query("days") ?? 7), status: (c.req.query("status") || undefined) as never }), c.get("access"))));
  /** The run, as the caller may see it (404 when its line is out of their scope). */
  const runFor = async (c: Context<Env>, runId: string) => {
    const r = redactRun(await sys.engine.view(sid(c), runId), c.get("access"));
    if (!r) throw new HttpError(404, "Run not found");
    return r;
  };
  const stageFor = async (c: Context<Env>, runId: string, code: string, min: AccessLevel, what: string) => {
    lvl(c, min, what);
    const run = await sys.engine.view(sid(c), runId);
    if (!stageInScope(c.get("access"), run.lineId, code)) throw new HttpError(404, "Stage not found");
    const stage = run.stages.find((s) => s.code === code);
    if (!stage) throw new HttpError(404, "Stage not found");
    return { run, stage };
  };
  // ---------------- Proof of work (console side) ----------------
  site.post("/pow/sessions", async (c) => {
    const b = await body(c, z.object({ runId: z.string().min(1).max(64), stage: z.string().regex(/^\d{2}[a-z]?$/) }));
    await stageFor(c, b.runId, b.stage, 2, "this stage");
    return c.json(await sys.contributions.start(sid(c), me(c).user, b.runId, b.stage, origin(c)));
  });
  site.get("/pow/sessions", async (c) => c.json(await sys.contributions.mySessions(sid(c), me(c).user.id)));
  site.delete("/pow/sessions/:id", async (c) => {
    await sys.contributions.cancel(sid(c), me(c).user.id, c.req.param("id"));
    return c.json({ ok: true });
  });
  site.get("/runs/:runId/stages/:code/contributions", async (c) => {
    const { run, stage } = await stageFor(c, c.req.param("runId"), c.req.param("code"), 1, "this stage");
    return c.json(await sys.contributions.forStage(sid(c), run.id, stage.code, { userId: me(c).user.id, level: c.get("access").level }));
  });
  // ---------------- Outcomes: the media each stage's machine captured ----------------
  site.get("/runs/:runId/stages/:code/outputs", async (c) => {
    const { run, stage } = await stageFor(c, c.req.param("runId"), c.req.param("code"), 2, "outcomes");
    return c.json({ outcomes: await sys.outputs.forStage(sid(c), run.id, stage, c.get("access").level) });
  });
  for (const which of ["file", "preview"] as const) {
    site.get(`/runs/:runId/stages/:code/outputs/:key/${which}`, async (c) => {
      const { run, stage } = await stageFor(c, c.req.param("runId"), c.req.param("code"), 3, "outcome media");
      const v = c.req.query("version");
      const f = await sys.outputs.file(sid(c), run.id, stage.code, c.req.param("key"), which, v && /^\d{1,6}$/.test(v) ? Number(v) : undefined);
      return new Response(f.bytes, { headers: { "content-type": f.mime, "content-disposition": `inline; filename="${f.name}"`, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
    });
  }
  site.get("/runs/:runId/contribution-counts", async (c) => {
    lvl(c, 1);
    const run = await runFor(c, c.req.param("runId"));
    return c.json(await sys.contributions.countsForRun(sid(c), run.id));
  });
  site.get("/contributions/mine", async (c) => c.json(await sys.contributions.mine(sid(c), me(c).user.id)));
  /** One proof of work: its author sees all of it; others need level 3 and the stage in their scope for the values. */
  const contributionFor = async (c: Context<Env>, id: string) => {
    const v = await sys.contributions.view(sid(c), id, 1);
    if (v.contributor.userId === me(c).user.id) return sys.contributions.view(sid(c), id, 3);
    if (v.status === "unsigned") throw new HttpError(404, "Proof of work not found");
    const run = await sys.engine.view(sid(c), v.runId);
    if (!stageInScope(c.get("access"), run.lineId, v.stageCode)) throw new HttpError(404, "Proof of work not found");
    return c.get("access").level >= 3 ? sys.contributions.view(sid(c), id, 3) : v;
  };
  site.get("/contributions/:id", async (c) => c.json(await contributionFor(c, c.req.param("id"))));
  // the outcome cards of a proof of work: what the stage's machine captured and the contributor's verdicts on it, for
  // its author (who reviewed the media through the session) and level 3; the files are the versions the record binds
  const boundFor = async (c: Context<Env>, id: string) => {
    const v = await contributionFor(c, id);
    if (v.contributor.userId !== me(c).user.id && c.get("access").level < 3) throw new HttpError(403, "The machine's media needs level 3");
    return v;
  };
  site.get("/contributions/:id/outcomes", async (c) => {
    const v = await boundFor(c, c.req.param("id"));
    const run = await sys.engine.view(sid(c), v.runId);
    const stage = run.stages.find((s) => s.code === v.stageCode);
    if (!stage) throw new HttpError(404, "Stage not found");
    return c.json({ outcomes: await sys.outputs.forStage(sid(c), run.id, stage, 3), bound: v.outcomes });
  });
  for (const which of ["file", "preview"] as const) {
    site.get(`/contributions/:id/outputs/:key/${which}`, async (c) => {
      const v = await boundFor(c, c.req.param("id"));
      const o = v.outcomes.find((x) => x.outcome === c.req.param("key"));
      if (!o?.version) throw new HttpError(404, "This proof of work binds no file for that outcome");
      const f = await sys.outputs.file(sid(c), v.runId, v.stageCode, o.outcome, which, o.version);
      return new Response(f.bytes, { headers: { "content-type": f.mime, "content-disposition": `inline; filename="${f.name}"`, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
    });
  }
  site.post("/contributions/:id/sign-request", async (c) => {
    const b = await body(c, z.object({ chainId: z.number().int().positive() }));
    return c.json(await sys.contributions.signRequest(sid(c), me(c).user, c.req.param("id"), b.chainId));
  });
  site.post("/contributions/:id/sign", async (c) => {
    const b = await body(c, z.object({ nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
    return c.json(await sys.contributions.sign(sid(c), me(c).user, c.req.param("id"), b as { nonce: string; signature: `0x${string}` }));
  });
  // ---------------- Selection: a validator (or the manager) picks the valid proof of work for a stage ----------------
  site.post("/contributions/:id/select/sign-request", async (c) => {
    lvl(c, 3, "proof of work");
    const b = await body(c, z.object({ comment: z.string().max(500).default(""), chainId: z.number().int().positive().optional() }));
    await contributionFor(c, c.req.param("id"));
    return c.json(await sys.selection.selectRequest(sid(c), me(c).user, c.req.param("id"), b.comment, b.chainId));
  });
  site.post("/contributions/:id/select", async (c) => {
    lvl(c, 3, "proof of work");
    const b = await body(c, z.object({ comment: z.string().max(500).default(""), nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
    await contributionFor(c, c.req.param("id"));
    return c.json(await sys.selection.select(sid(c), me(c).user, c.req.param("id"), b as { comment: string; nonce: string; signature: `0x${string}` }));
  });

  // ---------------- Rewards ----------------
  const SettingsBody = z.object({
    reward: z.string().regex(/^\d{1,30}$/),
    fee: z.string().regex(/^\d{1,30}$/),
    challengeWindow: z.number().int().min(0).max(365 * 86_400),
    responseWindow: z.number().int().min(60).max(90 * 86_400),
    defaultSlashBps: z.number().int().min(0).max(10_000),
    maxSlashBps: z.number().int().min(1).max(10_000),
    bountyBps: z.number().int().min(0).max(10_000),
    falseClaimBps: z.number().int().min(0).max(10_000),
  });
  site.get("/rewards", async (c) => {
    lvl(c, 1);
    return c.json(await sys.selection.rewards(sid(c), me(c).user));
  });
  site.post("/rewards/settings/sign-request", async (c) => {
    need(c, "manager");
    const b = await body(c, SettingsBody.extend({ chainId: z.number().int().positive().optional() }));
    return c.json(await sys.selection.settingsRequest(sid(c), me(c).user, b, b.chainId));
  });
  site.put("/rewards/settings", async (c) => {
    need(c, "manager");
    const b = await body(c, SettingsBody.extend({ nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
    const { nonce, signature, ...settings } = b;
    return c.json(await sys.selection.setSettings(sid(c), me(c).user, settings, { nonce, signature: signature as `0x${string}` }));
  });
  site.post("/rewards/settle/:contributionId", async (c) => c.json(await sys.selection.settle(sid(c), c.req.param("contributionId"))));
  site.post("/rewards/claim", async (c) => c.json(await sys.selection.claim(sid(c), me(c).user)));

  // ---------------- Cases: testers against validators, decided by the manager ----------------
  const isManager = (c: Context<Env>) => c.get("roles").includes("manager");
  site.get("/cases", async (c) => c.json(await sys.cases.list(sid(c), me(c).user, isManager(c))));
  site.get("/cases/candidates", async (c) => {
    lvl(c, 3, "proof of work");
    return c.json(await sys.cases.candidates(sid(c)));
  });
  site.get("/cases/:id", async (c) => c.json(await sys.cases.get(sid(c), c.req.param("id"), me(c).user, isManager(c))));
  site.get("/cases/:id/record", async (c) => c.json(await sys.cases.record(sid(c), c.req.param("id"), me(c).user, isManager(c))));
  site.post("/cases/sign-request", async (c) => {
    const b = await body(c, z.object({ contributionId: z.string().min(1).max(64), bps: z.number().int().min(1).max(10_000), evidence: z.string().trim().min(10).max(8000), chainId: z.number().int().positive().optional() }));
    return c.json(await sys.cases.openRequest(sid(c), me(c).user, b));
  });
  site.post("/cases", async (c) => {
    const b = await body(c, z.object({ caseId: z.string(), contributionId: z.string().min(1).max(64), bps: z.number().int().min(1).max(10_000), evidence: z.string().trim().min(10).max(8000), nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
    return c.json(await sys.cases.open(sid(c), me(c).user, b as typeof b & { signature: `0x${string}` }));
  });
  site.post("/cases/:id/respond/sign-request", async (c) => {
    const b = await body(c, z.object({ response: z.string().trim().min(10).max(8000), chainId: z.number().int().positive().optional() }));
    return c.json(await sys.cases.respondRequest(sid(c), me(c).user, c.req.param("id"), b.response, b.chainId));
  });
  site.post("/cases/:id/respond", async (c) => {
    const b = await body(c, z.object({ response: z.string().trim().min(10).max(8000), nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
    return c.json(await sys.cases.respond(sid(c), me(c).user, c.req.param("id"), b as typeof b & { signature: `0x${string}` }));
  });
  site.post("/cases/:id/decide/sign-request", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ uphold: z.boolean(), comment: z.string().max(500).default(""), chainId: z.number().int().positive().optional() }));
    return c.json(await sys.cases.decideRequest(sid(c), me(c).user, c.req.param("id"), b.uphold, b.comment, b.chainId));
  });
  site.post("/cases/:id/decide", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ uphold: z.boolean(), comment: z.string().max(500).default(""), nonce: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
    return c.json(await sys.cases.decide(sid(c), me(c).user, c.req.param("id"), b as typeof b & { signature: `0x${string}` }));
  });

  /** The sealed record: the conversation, values and notes. The manager only (testers too, during a case). */
  site.get("/contributions/:id/record", async (c) => {
    need(c, "manager");
    return c.json(await sys.contributions.sealedRecord(sid(c), c.req.param("id")));
  });

  site.post("/runs", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ templateVersionId: z.string(), orderRef: z.string().trim().min(1).max(60), quantity: z.number().int().min(1).max(1_000_000), dueAt: z.string().datetime().nullable().optional(), lineId: z.string().optional() }));
    const id = await sys.engine.start(sid(c), actor(c), b);
    return c.json(await runFor(c, id));
  });
  site.get("/runs/:runId/passport", async (c) => {
    lvl(c, 3, "passports");
    await runFor(c, c.req.param("runId"));
    return c.json(await sys.passports.get(sid(c), c.req.param("runId")));
  });
  const ShipTo = z.object({ to: z.string().trim().min(3).max(255) });
  site.post("/runs/:runId/ship/sign-request", async (c) => c.json(await sys.passports.shipRequest(sid(c), me(c).user, c.get("roles"), c.req.param("runId"), await toShipTarget(c, (await body(c, ShipTo)).to))));
  site.post("/runs/:runId/ship", async (c) => {
    const b = await body(c, SignedBody.merge(ShipTo));
    return c.json(await sys.passports.ship(sid(c), me(c).user, c.get("roles"), c.req.param("runId"), { ...b, to: await toShipTarget(c, b.to) }));
  });
  site.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await runFor(c, runId);
    const outcomes = c.get("access").level >= 2;
    const [decisions, inbox] = outcomes ? await Promise.all([sys.rec.decisions(sid(c), { runId, limit: 200 }), sys.inbox.list(sid(c), { runId, status: "all" })]) : [[], []];
    return c.json({ run, decisions, inbox });
  });
  site.post("/runs/:runId/step", async (c) => {
    need(c, "manager");
    const r = await sys.engine.step(sid(c), actor(c), c.req.param("runId"));
    return c.json({ ...r, run: await runFor(c, c.req.param("runId")) });
  });
  site.post("/runs/:runId/abort", async (c) => {
    need(c, "manager");
    await sys.engine.abort(sid(c), actor(c), c.req.param("runId"), (await body(c, z.object({ reason: z.string().trim().min(3).max(300) }))).reason);
    return c.json(await runFor(c, c.req.param("runId")));
  });
  site.post("/runs/:runId/stages/:code/record", async (c) => {
    need(c, "manager");
    const b = await body(
      c,
      z.object({
        good: z.number().int().min(0),
        scrap: z.number().int().min(0),
        complete: z.boolean().default(false),
        note: z.string().max(300).optional(),
        // the stage's measured parameters, when a person reads them off an instrument
        readings: z.array(z.object({ signal: z.string().regex(/^[\w.:-]{1,40}$/), value: z.number().finite() })).max(20).optional(),
      }),
    );
    await sys.engine.record(sid(c), actor(c), c.req.param("runId"), c.req.param("code"), b);
    return c.json(await runFor(c, c.req.param("runId")));
  });
  // the operator of a stage with no gateway signs the counts they recorded (an OrdoReading over their commitment)
  site.post("/runs/:runId/stages/:code/reading/sign-request", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ good: z.number().int().min(0), scrap: z.number().int().min(0) }));
    return c.json(await sys.readings.operatorRequest(sid(c), me(c).user, c.req.param("runId"), c.req.param("code"), b));
  });
  site.post("/runs/:runId/stages/:code/reading", async (c) => {
    need(c, "manager");
    const b = await body(c, ReadingBody.omit({ runId: true, stage: true }));
    return c.json(await sys.readings.submitFromOperator(sid(c), me(c).user, { ...b, runId: c.req.param("runId"), stage: c.req.param("code") }));
  });
  // the series behind a stage's measured parameters (values: signed-in users only; the public passport shows bands and proofs)
  site.get("/runs/:runId/stages/:code/series", async (c) => {
    const { run, stage } = await stageFor(c, c.req.param("runId"), c.req.param("code"), 3, "measurements");
    return c.json(await sys.series.read(run.id, stage));
  });
  site.get("/runs/:runId/proofs", async (c) => {
    lvl(c, 3, "proofs");
    const [run, stages] = await Promise.all([sys.engine.view(sid(c), c.req.param("runId")), sys.stageProofs.forRun(c.req.param("runId"))]);
    if (!lineInScope(c.get("access"), run.lineId)) throw new HttpError(404, "Run not found");
    return c.json({ runId: run.id, stages: [...stages.values()].filter((p) => stageInScope(c.get("access"), run.lineId, p.stage)) });
  });
  site.post("/runs/:runId/stages/:code/hold", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ reason: z.string().trim().min(3).max(300) }));
    await sys.engine.hold(sid(c), actor(c), c.req.param("runId"), c.req.param("code"), b.reason);
    return c.json(await runFor(c, c.req.param("runId")));
  });
  site.post("/runs/:runId/stages/:code/reassign", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ assetId: z.string() }));
    await sys.engine.reassign(sid(c), actor(c), c.req.param("runId"), c.req.param("code"), b.assetId);
    return c.json(await runFor(c, c.req.param("runId")));
  });

  // ---- Inbox (approvals & exceptions) ----
  site.get("/inbox", async (c) => {
    lvl(c, 2, "approvals");
    return c.json(await sys.inbox.list(sid(c), { status: c.req.query("status") ?? "pending" }));
  });
  const OptionBody = z.object({ option: z.number().int().min(REJECT), comment: z.string().max(500).default("") });
  site.post("/inbox/:id/sign-request", async (c) => {
    const b = await body(c, OptionBody.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.inbox.signatureRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"), b.option, b.comment, b.chainId));
  });
  site.post("/inbox/:id/decide", async (c) => {
    const b = await body(c, OptionBody.merge(SignedBody));
    return c.json(await sys.inbox.decide(sid(c), me(c).user, c.get("roles"), c.req.param("id"), { option: b.option, reason: b.comment, nonce: b.nonce, signature: b.signature }));
  });

  // ---- Decisions, agents, incidents ----
  site.get("/decisions", async (c) => {
    lvl(c, 2, "decisions");
    return c.json(await sys.rec.decisions(sid(c), { runId: c.req.query("runId") || undefined, limit: Number(c.req.query("limit") ?? 50) }));
  });
  site.get("/incidents", async (c) => {
    lvl(c, 2, "incidents");
    const r = await sys.db.query<{ id: string; asset_id: string; status: string; title: string; severity: string; opened_at: string; closed_at: string | null }>(
      "SELECT id, asset_id, status, title, severity, opened_at::text, closed_at::text FROM incidents WHERE site_id = $1 ORDER BY opened_at DESC LIMIT 50",
      [sid(c)],
    );
    return c.json(r.rows.map((x) => ({ id: x.id, assetId: x.asset_id, status: x.status, title: x.title, severity: x.severity, openedAt: new Date(x.opened_at).toISOString(), closedAt: x.closed_at ? new Date(x.closed_at).toISOString() : null })));
  });
  site.get("/agents", async (c) => {
    lvl(c, 4, "agents");
    const s = await sys.plant.site(sid(c));
    const level = s.lines[0]?.autonomy ?? "L2";
    const stats = await sys.db.query<{ agent: string; n: string; conf: string | null }>(
      "SELECT agent, COUNT(*)::text n, AVG(confidence)::text conf FROM decisions WHERE site_id = $1 AND ts > now() - interval '24 hours' AND agent LIKE 'agent:%' GROUP BY agent",
      [sid(c)],
    );
    const esc = await sys.db.query<{ agent: string; n: string }>("SELECT agent, COUNT(*)::text n FROM inbox_items WHERE site_id = $1 AND created_at > now() - interval '24 hours' GROUP BY agent", [sid(c)]);
    const tasks = await sys.db.query<{ run_id: string; code: string; name: string | null; spec_json: string; state: string }>(
      "SELECT sr.run_id, sr.code, sr.data_json::json->>'name' AS name, v.spec_json, sr.state FROM stage_runs sr JOIN runs r ON r.id = sr.run_id JOIN template_versions v ON v.id = r.template_version_id WHERE r.site_id = $1 AND r.status = 'running' AND sr.state IN ('running','awaiting_approval','held')",
      [sid(c)],
    );
    const views = await sys.plant.views(sid(c));
    const nfts = await sys.agentNfts.ofSite(sid(c));
    const records = new Map(await Promise.all(AGENTS.map(async (a) => [a, await sys.agentLicenses.record(sid(c), a)] as const)));
    const licensed = (await sys.agentLicenses.list(sid(c))).outgoing.filter((l) => l.status === "active");
    const memories = await sys.agentMemory.ofSite(sid(c));
    return c.json(
      AGENTS.map((a) => {
        const st = stats.rows.find((x) => x.agent === `agent:${a}`);
        const current = tasks.rows.filter((t) => (JSON.parse(t.spec_json) as TemplateSpec).stages.find((s) => s.code === t.code)?.agent === a);
        return {
          key: a,
          ...AGENT_INFO[a],
          inft: nfts.get(a) ?? null,
          memory: memories.get(a) ?? null,
          record: records.get(a)!,
          licensedFrom: licensed.filter((l) => l.agent === a).map((l) => ({ id: l.id, site: l.licensor.name, tokenId: l.tokenId, tokenUrl: l.tokenUrl, expiresAt: l.expiresAt })),
          autonomy: level,
          assets: views.filter((v) => v.owningAgent === a).map((v) => ({ id: v.id, name: v.name, status: v.status })),
          currentTask: current[0] ? `${current[0].run_id} · ${current[0].code} ${current[0].name ?? ""}`.trim() : null,
          activeStages: current.length,
          decisionsToday: Number(st?.n ?? 0),
          escalationsToday: Number(esc.rows.find((x) => x.agent === `agent:${a}`)?.n ?? 0),
          avgConfidence: st?.conf ? Number(st.conf) : null,
        };
      }),
    );
  });

  // ---- Licensing proven agents between sites (their iNFTs on 0G) ----
  site.get("/agents/market", async (c) => {
    lvl(c, 4, "agents");
    return c.json(await sys.agentLicenses.market(sid(c)));
  });
  site.get("/agents/licenses", async (c) => {
    lvl(c, 4, "agents");
    return c.json(await sys.agentLicenses.list(sid(c)));
  });
  site.post("/agents/licenses", async (c) => {
    const b = await body(c, z.object({ site: z.string().min(1), agent: AgentKey, days: z.number().int().refine((d) => (LICENSE_DAYS as readonly number[]).includes(d), `days: one of ${LICENSE_DAYS.join(", ")}`) }));
    return c.json(await sys.agentLicenses.request(sid(c), me(c).user, c.get("roles"), b), 201);
  });
  site.post("/agents/licenses/:id/sign-request", async (c) => {
    const b = await body(c, z.object({ kind: z.enum(["grant", "revoke"]), comment: z.string().max(500).default(""), chainId: z.number().int().optional() }));
    return c.json(await sys.agentLicenses.signRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"), b));
  });
  site.post("/agents/licenses/:id/grant", async (c) => c.json(await sys.agentLicenses.grant(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, SignedBody))));
  site.post("/agents/licenses/:id/revoke", async (c) => c.json(await sys.agentLicenses.revoke(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, SignedBody))));
  site.post("/agents/licenses/:id/decline", async (c) => c.json(await sys.agentLicenses.decline(sid(c), me(c).user, c.get("roles"), c.req.param("id"))));

  // ---- Validation packages ----
  // validation packages: proofs and evidence, so level 3 and up
  site.use("/validation/*", async (c, next) => {
    lvl(c, 3, "validation");
    await next();
  });
  site.get("/validation", async (c) => {
    lvl(c, 3, "validation");
    return c.json(await sys.validation.list(sid(c), me(c).user, c.get("roles")));
  });
  const PackageFields = z.object({
    title: z.string().trim().min(3).max(120),
    objective: z.string().max(2000).default(""),
    acceptance: z.string().max(2000).default(""),
    samplePlan: z.string().max(1000).default(""),
    windowStart: z.string().datetime().nullable().optional(),
    windowEnd: z.string().datetime().nullable().optional(),
  });
  site.post("/validation", async (c) => {
    need(c, "manager");
    const b = await body(c, PackageFields.extend({ type: PackageType, runId: z.string().nullable().optional(), stageCode: z.string().nullable().optional(), templateId: z.string().nullable().optional(), assetId: z.string().nullable().optional() }));
    return c.json(await sys.validation.create(sid(c), me(c).user, b));
  });
  site.get("/validation/:id", async (c) => c.json(await sys.validation.get(sid(c), c.req.param("id"))));
  site.patch("/validation/:id", async (c) => c.json(await sys.validation.update(sid(c), me(c).user, c.req.param("id"), await body(c, PackageFields.partial()))));
  site.post("/validation/:id/checks", async (c) =>
    c.json(await sys.validation.addCheck(sid(c), me(c).user, c.req.param("id"), await body(c, z.object({ criterion: z.string().trim().min(2).max(200), method: z.string().max(200).default("Manual"), target: z.string().max(100).default("") })))),
  );
  site.patch("/validation/:id/checks/:checkId", async (c) =>
    c.json(await sys.validation.recordCheck(sid(c), me(c).user, c.get("roles"), c.req.param("id"), c.req.param("checkId"), await body(c, z.object({ status: z.enum(["pass", "fail"]), result: z.string().trim().max(200).default("") })))),
  );
  site.delete("/validation/:id/checks/:checkId", async (c) => c.json(await sys.validation.removeCheck(sid(c), me(c).user, c.req.param("id"), c.req.param("checkId"))));
  site.post("/validation/:id/precheck", async (c) => c.json(await sys.validation.precheck(sid(c), me(c).user, c.req.param("id"))));
  site.post("/validation/:id/evidence", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Attach a file");
    const bytes = new Uint8Array(await file.arrayBuffer());
    return c.json(await sys.validation.attach(sid(c), me(c).user, c.req.param("id"), { slotId: typeof form.slotId === "string" && form.slotId ? form.slotId : null, name: typeof form.name === "string" && form.name ? form.name : file.name, filename: file.name, mime: file.type || "application/octet-stream", bytes }));
  });
  site.delete("/validation/:id/evidence/:evidenceId", async (c) => c.json(await sys.validation.removeEvidence(sid(c), me(c).user, c.req.param("id"), c.req.param("evidenceId"))));
  site.get("/validation/:id/evidence/:evidenceId/0g", async (c) => c.json(await sys.validation.verifyOnZeroG(sid(c), c.req.param("id"), c.req.param("evidenceId"))));
  site.get("/validation/:id/evidence/:evidenceId/file", async (c) => {
    const f = await sys.validation.blob(sid(c), c.req.param("id"), c.req.param("evidenceId"));
    return new Response(Buffer.from(f.bytes), { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${f.filename.replace(/"/g, "")}"`, "x-content-type-options": "nosniff" } });
  });
  const PkgAction = z.object({ action: z.enum(["sign", "return", "reject"]), comment: z.string().max(1000).default("") });
  site.post("/validation/:id/sign-request", async (c) => {
    const b = await body(c, PkgAction.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.validation.signatureRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"), b.action, b.comment, b.chainId));
  });
  site.post("/validation/:id/act", async (c) => c.json(await sys.validation.act(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, PkgAction.merge(SignedBody)))));


  // ---- Stakes, vendors, on-chain trust ----
  site.get("/stakers", async (c) => {
    lvl(c, 1);
    const [stakers, chain, validator, tester] = await Promise.all([sys.trust.stakers(sid(c)), sys.trust.chainStatus(sid(c)), sys.trust.isValidator(sid(c), me(c).user), sys.trust.isTester(sid(c), me(c).user)]);
    return c.json({ stakers, chain, me: { validator, tester } });
  });
  // after a stake or unstake from the wallet: schedule (or delete) the payout at the end of the cooldown on Hedera
  site.post("/stakers/me/payout-schedule", async (c) => c.json({ payout: (await sys.schedules?.syncStake(sid(c), me(c).user.address)) ?? null }));
  site.get("/vendors", async (c) => {
    lvl(c, 4, "vendors");
    return c.json(await sys.trust.vendors(sid(c)));
  });
  const VendorBody = z.object({
    address: AddressOrName,
    company: z.string().trim().min(2).max(120),
    categories: z.string().max(200).default(""),
    hourlyRate: z.string().regex(/^\d+(\.\d+)?$/).nullable().default(null),
    responseMinutes: z.number().int().min(1).max(10_000).nullable().default(null),
  });
  site.post("/vendors/sign-request", async (c) => {
    need(c, "manager");
    const b = await body(c, VendorBody.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.trust.vendorRequest(sid(c), me(c).user, { ...b, address: await toAddress(c, b.address) }, b.chainId));
  });
  site.post("/vendors", async (c) => {
    need(c, "manager");
    const b = await body(c, VendorBody.merge(SignedBody));
    return c.json(await sys.trust.addVendor(sid(c), me(c).user, { ...b, address: await toAddress(c, b.address) }));
  });
  site.get("/chain", async (c) => c.json(await sys.trust.chainStatus(sid(c))));
  // registering the org in OrdoTrust: right after creating it (Setup), or later from Settings
  site.post("/chain/register/sign-request", async (c) => {
    need(c, "manager");
    const s = await sys.plant.site(sid(c));
    return c.json(await sys.trust.registerRequest(sid(c), me(c).user, s.name));
  });
  site.post("/chain/register", async (c) => {
    need(c, "manager");
    return c.json(await sys.trust.register(sid(c), me(c).user, await body(c, SignedBody)));
  });
  const ChainRoleName = z.enum(["OPERATOR", "SUPERVISOR", "VALIDATOR", "PLANT_MANAGER", "ADMIN", "VENDOR", "DEVICE", "TESTER", "MANAGER"]);
  site.get("/chain/credentials", async (c) => {
    need(c, "manager");
    return c.json(await sys.trust.credentials(sid(c)));
  });
  site.post("/chain/credentials/sign-request", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ address: Hex, role: ChainRoleName }));
    return c.json(await sys.trust.credentialRequest(sid(c), me(c).user, b.address, b.role));
  });
  site.post("/chain/credentials/grant", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ address: Hex, role: ChainRoleName }).merge(SignedBody));
    return c.json(await sys.trust.grantCredential(sid(c), me(c).user, b.address, b.role, b));
  });
  // a credential OrdoTrust holds that no ENS name backs (someone left, or was demoted on ENS): a manager signs it away
  site.post("/chain/credentials/revoke-request", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ address: Hex, role: ChainRoleName }));
    return c.json(await sys.trust.credentialRevokeRequest(sid(c), me(c).user, b.address, b.role));
  });
  site.post("/chain/credentials/revoke", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ address: Hex, role: ChainRoleName }).merge(SignedBody));
    return c.json(await sys.trust.revokeCredential(sid(c), me(c).user, b.address, b.role, b));
  });
  site.post("/chain/retry", async (c) => {
    need(c, "manager");
    return c.json(await sys.trust.retry(sid(c), (await body(c, z.object({ ref: z.string().min(3) }))).ref));
  });

  // ---- Work orders: the agent escrows vendor payments, people release them ----
  const Caps = z.object({ perOrder: z.string().regex(/^\d+$/), perDay: z.string().regex(/^\d+$/) });
  site.get("/work-orders", async (c) => {
    lvl(c, 4, "work orders");
    return c.json({ setup: await sys.workOrders.status(sid(c)), items: await sys.workOrders.list(sid(c)) });
  });
  site.post("/work-orders/caps/sign-request", async (c) => c.json(await sys.workOrders.capsRequest(sid(c), me(c).user, c.get("roles"), await body(c, Caps))));
  site.put("/work-orders/caps", async (c) => c.json(await sys.workOrders.setCaps(sid(c), me(c).user, c.get("roles"), await body(c, SignedBody.merge(Caps)))));
  site.post("/work-orders/pause/sign-request", async (c) => c.json(await sys.workOrders.pauseRequest(sid(c), me(c).user, c.get("roles"), (await body(c, z.object({ stop: z.boolean() }))).stop)));
  site.put("/work-orders/pause", async (c) => {
    const b = await body(c, SignedBody.extend({ stop: z.boolean() }));
    return c.json(await sys.workOrders.setPaused(sid(c), me(c).user, c.get("roles"), b.stop, b));
  });
  site.post("/work-orders/:id/release/sign-request", async (c) => c.json(await sys.workOrders.releaseRequest(sid(c), me(c).user, c.get("roles"), c.req.param("id"))));
  site.post("/work-orders/:id/release", async (c) => c.json(await sys.workOrders.release(sid(c), me(c).user, c.get("roles"), c.req.param("id"), await body(c, SignedBody))));
  site.post("/work-orders/:id/assessment/retry", async (c) => c.json(await sys.workOrders.retryAssessment(sid(c), c.get("roles"), c.req.param("id"))));
  site.post("/work-orders/:id/retry", async (c) => c.json(await sys.workOrders.retryEscrow(sid(c), c.get("roles"), c.req.param("id"))));

  // ---- Ledger & proof ----
  site.get("/ledger", async (c) => {
    lvl(c, 4, "the ledger");
    const subject = c.req.query("subject") || undefined;
    return c.json({ entries: await sys.ledger.latestForSite(sid(c), Math.min(500, Number(c.req.query("limit") ?? 100)), subject), anchors: await sys.proof.anchors(20), anchorKind: sys.proof.kind });
  });
  site.get("/verify", async (c) => {
    lvl(c, 3, "verification");
    const subject = c.req.query("subject") || undefined;
    // the chain check covers every site; the subject's entries are listed only for a subject of this site
    if (subject && !(await sys.ledger.latestForSite(sid(c), 1, subject)).length) throw new HttpError(404, "Nothing on the ledger for that subject at this site");
    return c.json(await sys.proof.verify(subject));
  });
  site.post("/anchors", async (c) => {
    need(c, "manager");
    return c.json(await sys.proof.anchorHead(sid(c), c.req.query("subject") || null));
  });
  site.post("/summaries/shift", async (c) => {
    lvl(c, 2, "summaries");
    const entries = (await sys.ledger.latestForSite(sid(c), 120)).reverse();
    const r = await sys.agents.summarize({ entries: entries.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, subject: e.subject, brief: String((e.payload as { summary?: string })?.summary ?? e.type) })) });
    return c.json({ ...r.value, modelId: r.modelId, fallback: r.fallback });
  });

  /** One call per poll: advances the engine, then returns everything a screen needs to refresh. */
  site.get("/live", async (c) => {
    await sys.advance().catch((e) => console.error("[ordo] advance", e));
    const s = sid(c);
    const a = c.get("access");
    const none = <T>(): Promise<T[]> => Promise.resolve([]);
    const [assets, runs, inbox, decisions, head, validation] = await Promise.all([
      a.level >= 2 ? sys.plant.views(s) : none<Awaited<ReturnType<typeof sys.plant.views>>[number]>(),
      sys.engine.list(s, { days: 7 }),
      a.level >= 2 ? sys.inbox.list(s, { status: "pending" }) : none<Awaited<ReturnType<typeof sys.inbox.list>>[number]>(),
      a.level >= 2 ? sys.rec.decisions(s, { limit: 30 }) : none<Awaited<ReturnType<typeof sys.rec.decisions>>[number]>(),
      sys.ledger.head(),
      a.level >= 3 ? sys.validation.list(s, me(c).user, c.get("roles")) : none<Awaited<ReturnType<typeof sys.validation.list>>[number]>(),
    ]);
    const roles = c.get("roles");
    const manager = canApproveAny(roles, "manager");
    return c.json({
      now: new Date().toISOString(),
      access: a,
      assets,
      runs: redactRuns(runs, a),
      inbox,
      decisions,
      headSeq: head?.seq ?? 0,
      counts: {
        approvals: inbox.filter((i) => canApproveAny(roles, i.requiredRole)).length,
        validation: validation.filter((v) => v.needsMe).length,
        workOrders: manager ? (await sys.db.query("SELECT 1 FROM work_orders WHERE site_id = $1 AND status IN ('escrowed', 'escrow_failed')", [s])).rows.length : 0,
        autonomy: manager ? (await sys.autonomy.list(s)).filter((p) => p.status === "open" && !p.signers.some((x) => x.address === me(c).user.address)).length : 0,
        cases: await sys.cases.due(s, me(c).user, manager),
      },
    });
  });

  // ---- Stage resources: vendors' offers, what each stage has received, the signed waiver, a run's resource budget ----
  site.get("/vendors/offers", async (c) => {
    lvl(c, 4, "vendors");
    return c.json({ suppliers: await sys.resources.suppliers(sid(c), c.req.query("archived") === "1"), storefront: Boolean(sys.resources.store), receiptSigner: sys.resources.receiptSigner });
  });
  site.post("/vendors/:vendorId/offers", async (c) => c.json(await sys.resources.addOffer(sid(c), me(c).user, c.get("roles"), c.req.param("vendorId"), await body(c, OfferBody))));
  site.patch("/vendors/:vendorId/offers/:offerId", async (c) => c.json(await sys.resources.editOffer(sid(c), me(c).user, c.get("roles"), c.req.param("vendorId"), c.req.param("offerId"), await body(c, OfferPatch))));
  site.delete("/vendors/:vendorId/offers/:offerId", async (c) => c.json(await sys.resources.archiveOffer(sid(c), me(c).user, c.get("roles"), c.req.param("vendorId"), c.req.param("offerId"))));
  site.get("/runs/:runId/stages/:code/resources", async (c) => {
    const { run, stage } = await stageFor(c, c.req.param("runId"), c.req.param("code"), 2, "this stage");
    return c.json(await sys.resources.stageView(sid(c), run, stage, c.get("access").level));
  });
  const WaiveBody = z.object({ reason: z.string().trim().min(3).max(300) });
  site.post("/runs/:runId/stages/:code/resources/waive/sign-request", async (c) => {
    const b = await body(c, WaiveBody.extend({ chainId: z.number().int().optional() }));
    return c.json(await sys.resources.waiveRequest(sid(c), me(c).user, c.get("roles"), c.req.param("runId"), c.req.param("code"), b.reason, b.chainId));
  });
  site.post("/runs/:runId/stages/:code/resources/waive", async (c) => {
    const b = await body(c, WaiveBody.merge(SignedBody));
    await sys.resources.waive(sid(c), me(c).user, c.get("roles"), c.req.param("runId"), c.req.param("code"), b);
    return c.json(await runFor(c, c.req.param("runId")));
  });
  site.get("/runs/:runId/budget", async (c) => {
    lvl(c, 4, "budgets");
    await runFor(c, c.req.param("runId"));
    const m = c.req.query("margin");
    return c.json(await sys.resources.budget(sid(c), c.req.param("runId"), m === undefined ? undefined : Math.min(100, Math.max(0, Number(m) || 0))));
  });

  // ---- Virtual machines: each an asset run by its own body and agent ----
  site.get("/machines", async (c) => {
    lvl(c, 2, "the floor");
    return c.json({ runtime: sys.bodies.runtime, brain: sys.contributions.router.network === "mock" ? "none" : "0g", trustMode: sys.contributions.router.trustMode, bodies: await sys.bodies.list(sid(c)) });
  });
  // the machines the library's templates need, created on one manager signature (right after creating an org)
  site.get("/machines/fleet", async (c) => {
    lvl(c, 2, "the floor");
    return c.json(await sys.fleet.view(sid(c)));
  });
  site.post("/machines/fleet/sign-request", async (c) => {
    need(c, "manager");
    const b = await body(c, z.object({ chainId: z.number().int().positive().optional() }));
    return c.json(await sys.fleet.request(sid(c), me(c).user, c.get("roles"), b.chainId));
  });
  site.post("/machines/fleet", async (c) => {
    need(c, "manager");
    const r = await sys.fleet.create(sid(c), me(c).user, c.get("roles"), await body(c, SignedBody));
    await sys.advance(true);
    return c.json(r);
  });
  site.post("/machines", async (c) => {
    need(c, "manager");
    const r = await sys.bodies.create(sid(c), me(c).user, c.get("roles"), await body(c, BodyCreate));
    await sys.advance(true);
    return c.json(r);
  });
  site.post("/machines/:assetId/start", async (c) => {
    need(c, "manager");
    return c.json(await sys.bodies.start(sid(c), c.req.param("assetId"), actor(c)));
  });
  site.post("/machines/:assetId/stop", async (c) => {
    need(c, "manager");
    return c.json(await sys.bodies.stop(sid(c), c.req.param("assetId"), actor(c)));
  });
  site.get("/machines/:assetId/episodes", async (c) => {
    lvl(c, 3, "machine logs");
    return c.json({ episodes: await sys.bodies.episodes(sid(c), c.req.param("assetId")) });
  });
  site.get("/machines/:assetId/episode", async (c) => {
    lvl(c, 3, "machine logs");
    return c.json(await sys.bodies.episode(sid(c), c.req.param("assetId"), c.req.query("sha256")));
  });
  site.post("/machines/:assetId/ask", async (c) => {
    lvl(c, 3, "machine logs");
    const b = await body(c, z.object({ question: z.string().trim().min(2).max(500) }));
    return c.json(await sys.bodies.ask(sid(c), c.req.param("assetId"), b.question));
  });

  app.route("/v1/sites/:siteId", site);

  // ---------------- Web console (single-container mode) ----------------
  const dist = opts.webDist ? resolve(opts.webDist) : null;
  if (dist && existsSync(resolve(dist, "index.html"))) {
    // index.html names the build's hashed bundles, so it is re-read when a rebuild replaces it: a copy cached at boot
    // would point at bundles the rebuild deleted, and every page would load blank
    const indexFile = resolve(dist, "index.html");
    let index = { mtime: 0, html: "" };
    const indexHtml = () => {
      const mtime = statSync(indexFile).mtimeMs;
      if (mtime !== index.mtime) index = { mtime, html: readFileSync(indexFile, "utf8") };
      return index.html;
    };
    app.use("/assets/*", serveStatic({ root: dist, onFound: (_p, c) => c.header("Cache-Control", "public, max-age=31536000, immutable") }));
    // a bundle that is not there is a 404, never the page: the browser would refuse it as a script and show nothing
    app.get("/assets/*", (c) => c.text("Not found", 404));
    app.get("/favicon.svg", serveStatic({ root: dist }));
    app.get("*", (c) => {
      if (c.req.path.startsWith("/v1/")) return c.json({ error: "Not found" }, 404);
      c.header("Cache-Control", "no-cache");
      return c.html(indexHtml());
    });
  } else {
    app.get("/", (c) => c.text("Ordo API is running."));
  }
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
