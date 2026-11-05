import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import type { EdgeOutcome, EdgeStage } from "../../server/src/core/readings.js";
import type { AssetKind } from "../../server/src/domain/types.js";
import { Gateway } from "../../server/src/edge/gateway.js";
import { BODY_PROFILES } from "../../server/src/edge/profiles.js";
import { BrainError, type Brain, type Situation } from "./brain.js";
import { Purchasing } from "./buy.js";
import { uploadOutput, type Analysis } from "./edge.js";
import { EpisodeLog, type NewEntry } from "./episode.js";
import type { CaptureSpec, Rendered } from "./media/capture.js";
import { ffmpegPath } from "./media/mp4.js";
import { render } from "./media/render.js";
import { inSpec, pickValue, targetText } from "./metric.js";
import { Process } from "./process.js";
import { Rng } from "./rng.js";

export interface BodyConfig {
  url: string;
  key: Hex;
  asset: string;
  kind: Exclude<AssetKind, "system">;
  seed: string;
  dataDir: string | null;
  /** seconds the process takes over one stage */
  stageS: number;
  tickS: number;
  /** seconds between the agent's decisions while a stage runs */
  decideS: number;
  /** consecutive 0G failures before a safe stop */
  failLimit: number;
  brain: Brain | null;
  /** the machine's own Hedera account (never its key) */
  hedera: { network: string; accountId: string } | null;
  /** the machine account's key: it signs only the machine's x402 payments for what its stages consume */
  machineKey: string | null;
}

/** How often a capture reads out of spec on its first attempt, and on an attempt after the agent adjusted the process. */
const P_OUT_FIRST = 0.08;
const P_OUT_AGAIN = 0.03;
const MAX_ATTEMPTS = 3;
const UPLOAD_TRIES = 3;
const REPORT_EVERY_MS = 30_000;
const HEARTBEAT_MS = 60_000;
const PROBE_EVERY_MS = 30_000;

interface Capture {
  attempt: number;
  value: number | null;
  inSpec: boolean | null;
  agentRead: number | null;
  anomaly: string | null;
  /** uploaded, or given up on (no ffmpeg, upload refused three times) */
  done: boolean;
  uploaded: boolean;
  tries: number;
  /** rendered and read, waiting to upload */
  pending: { spec: CaptureSpec; res: Rendered; analysis: Analysis } | null;
}
interface Work {
  key: string;
  st: EdgeStage;
  base: number;
  elapsedMs: number;
  lastTick: number;
  made: number;
  captures: Map<string, Capture>;
  /** outcomes the agent asked to capture again */
  again: Set<string>;
  lastDecision: number;
  decideSoon: boolean;
  closed: boolean;
  agentHeld: boolean;
  safeHeld: boolean;
  reportedAt: number;
  reportedEntries: number;
  final: boolean;
}
interface Saved {
  parts: number;
  scrap: number;
  works: Record<string, { base: number; elapsedMs: number; made: number }>;
}

const keyOf = (st: { runId: string; stage: string }) => `${st.runId}/${st.stage}`;

/**
 * A machine's body: every tick it reads its stages from Ordo, runs its process through the running one, captures and
 * signs the media for the stage's outcomes as the stage goes, has its agent read each capture and decide what to do
 * next through 0G, holds back the last unit until the required outcomes are in, pushes its telemetry, signs its
 * finished stages, and reports its episode log. Without 0G configured it runs without a brain and says so; with 0G
 * configured and unreachable it stops safely and holds its stage for a person.
 */
export class Body {
  readonly gw: Gateway;
  readonly log: EpisodeLog;
  readonly process: Process;
  readonly buying: Purchasing;
  mode: "running" | "safe_stopped" = "running";
  private works = new Map<string, Work>();
  private fails = 0;
  private lastProbe = 0;
  private lastReport = 0;
  private lastError = "";
  private stopped = false;
  private saved: Saved | null = null;
  /** the stage the machine is working this tick */
  private working: { runId: string; stage: string } | null = null;

  constructor(readonly cfg: BodyConfig) {
    this.saved = this.load();
    this.process = new Process(BODY_PROFILES[cfg.kind], cfg.seed, this.saved, Date.now);
    this.gw = new Gateway({ url: cfg.url, key: cfg.key, assetId: cfg.asset, source: { kind: "feed", read: () => this.process.read() }, log: (l) => console.log(l) });
    this.log = new EpisodeLog({ seed: cfg.seed, asset: cfg.asset, machine: cfg.kind, device: this.gw.account.address }, cfg.dataDir);
    this.buying = new Purchasing({
      url: cfg.url,
      asset: cfg.asset,
      kind: cfg.kind,
      account: cfg.hedera && cfg.machineKey ? { ...cfg.hedera, key: cfg.machineKey } : null,
      brain: cfg.brain,
      gw: this.gw,
      working: () => this.working,
      add: (e) => this.add(e),
      log: (l) => console.log(l),
    });
  }

  get device() {
    return this.gw.account.address;
  }
  get state(): "running" | "sleeping" | "safe_stopped" {
    if (this.mode === "safe_stopped") return "safe_stopped";
    return [...this.works.values()].some((w) => !w.final) ? "running" : "sleeping";
  }

  async start() {
    const ff = await ffmpegPath();
    this.log.add({ kind: "start", seed: this.cfg.seed, asset: this.cfg.asset, machine: this.cfg.kind, device: this.device, brain: this.cfg.brain ? "0g" : "none", model: this.cfg.brain?.model ?? null, ffmpeg: ff, hedera: this.cfg.hedera?.accountId ?? null });
    console.log(`body ${this.cfg.asset} (${this.cfg.kind}) device ${this.device}: ${this.cfg.brain ? `0G brain ${this.cfg.brain.model}` : "no 0G brain (ZG_ROUTER_URL/KEY unset): runs without an agent"}; video ${ff ? `via ${ff}` : "skipped (no ffmpeg)"}`);
    if (this.cfg.hedera) console.log(`machine account ${this.cfg.hedera.accountId} on ${this.cfg.hedera.network}${this.buying.enabled ? ": buys ahead over x402" : ""}`);
    while (!this.stopped) {
      const t0 = Date.now();
      try {
        await this.tick();
        this.lastError = "";
      } catch (e) {
        const msg = (e as Error).message;
        if (msg !== this.lastError) console.error(`${msg}`);
        this.lastError = msg;
      }
      await new Promise((r) => setTimeout(r, Math.max(200, this.cfg.tickS * 1000 - (Date.now() - t0))));
    }
  }

  async stop() {
    this.stopped = true;
    await this.buying.settle();
    await this.reports(true).catch(() => undefined);
    this.save();
  }

  private add(e: NewEntry) {
    return this.log.add(e);
  }

  // ---------------------------------------------------------------- one tick
  async tick() {
    const { stages } = await this.gw.request<{ stages: EdgeStage[] }>("GET", "/v1/edge/stages");
    const mine = stages.filter((s) => s.asset === this.cfg.asset);
    const open = new Map(mine.filter((s) => s.endedAt === null).map((s) => [keyOf(s), s]));
    // a stage that ended (or left this machine) closes its episode
    for (const w of this.works.values()) {
      if (w.final) continue;
      const now = open.get(w.key);
      if (!now) {
        const ended = mine.find((s) => keyOf(s) === w.key);
        this.add({ kind: "stage", event: "finished", runId: w.st.runId, stage: w.st.stage, name: w.st.name });
        w.final = true;
        if (!ended) console.log(`${w.key} left this machine`);
        // a batch phase goes back to idle, so the next stage does not read the last one's end
        if (w.st.completeOn) this.process.extra.set(w.st.completeOn.signal, { value: null, text: "IDLE" });
        this.process.endStage();
      } else if (now.state !== w.st.state) {
        if (now.state === "held") this.add({ kind: "stage", event: "held", runId: now.runId, stage: now.stage, name: now.name });
        if (w.st.state === "held" && now.state === "running") {
          this.add({ kind: "stage", event: "released", runId: now.runId, stage: now.stage, name: now.name });
          w.safeHeld = false;
        }
        w.st = now;
      }
    }
    const running = [...open.values()].filter((s) => s.state === "running").sort((a, b) => a.startedAt - b.startedAt);
    const st = running[0] ?? null;
    this.working = st ? { runId: st.runId, stage: st.stage } : null;
    // time only runs for the stage being worked
    for (const w of this.works.values()) if (w.key !== (st && keyOf(st))) w.lastTick = Date.now();

    if (this.mode === "safe_stopped") {
      await this.probe();
      if (this.mode === "safe_stopped") {
        this.process.execution = st || open.size ? "FEED_HOLD" : "READY";
        if (st) await this.safeHold(this.workFor(st), this.lastError || "the 0G Router did not answer");
      }
    }
    if (this.mode === "running") {
      if (st) await this.work(this.workFor(st));
      else this.process.execution = [...open.values()].some((s) => s.state === "held") ? "FEED_HOLD" : "READY";
      // buying ahead runs beside the loop, about once a minute (and when a stage starts)
      void this.buyAhead(false);
    }

    await this.gw.observe();
    if (mine.some((s) => s.endedAt !== null && (!s.signed || (s.parameters.length > 0 && !s.measurementsSigned)))) await this.gw.signFinished();
    await this.reports();
    this.save();
  }

  private workFor(st: EdgeStage): Work {
    const key = keyOf(st);
    let w = this.works.get(key);
    if (w) {
      w.st = st;
      return w;
    }
    const prior = this.saved?.works[key];
    w = {
      key,
      st,
      base: prior?.base ?? this.process.parts,
      elapsedMs: prior?.elapsedMs ?? 0,
      lastTick: Date.now(),
      made: prior?.made ?? 0,
      captures: new Map(),
      again: new Set(),
      lastDecision: Date.now(),
      decideSoon: false,
      closed: false,
      agentHeld: false,
      safeHeld: false,
      reportedAt: 0,
      reportedEntries: 0,
      final: false,
    };
    // what Ordo already has (a body restarted mid-stage): not captured again
    for (const o of st.outcomes) if (o.captured) w.captures.set(o.key, { attempt: o.version, value: null, inSpec: null, agentRead: null, anomaly: null, done: true, uploaded: true, tries: 0, pending: null });
    this.works.set(key, w);
    // the last stage's outcome values and batch phase are not this one's
    for (const k of [...this.process.extra.keys()]) if (k.startsWith("outcome.")) this.process.extra.delete(k);
    this.process.beginStage(new Rng(this.cfg.seed, this.cfg.asset, st.runId, st.stage, "stage"));
    this.add({ kind: "stage", event: prior ? "resumed" : "started", runId: st.runId, stage: st.stage, name: st.name, quantity: st.quantity });
    console.log(`${prior ? "resuming" : "working"} ${key} ${st.name} (${st.quantity} units, ${st.outcomes.length} outcome(s))`);
    this.working = { runId: st.runId, stage: st.stage };
    void this.buyAhead(true);
    return w;
  }

  /**
   * Buying ahead: the resources the stages after this one consume, and those of its own stage waiting to start, are
   * bought from vendors over x402, paid from the machine's own Hedera account (MACHINE_ACCOUNT_ID), before those stages
   * start; what is over budget is asked of the org's treasury as a top-up (buy.ts). When a stage starts and about once
   * a minute while the body runs; never two cycles at once, never while it is safe-stopped, never throwing.
   */
  private async buyAhead(now: boolean): Promise<void> {
    if (this.mode !== "running" || this.stopped) return;
    await this.buying.run(now);
  }

  private async work(w: Work) {
    const st = w.st;
    const now = Date.now();
    w.elapsedMs += Math.min(now - w.lastTick, this.cfg.tickS * 3000);
    w.lastTick = now;
    const progress = w.elapsedMs / (this.cfg.stageS * 1000);
    this.process.progress = Math.min(1, progress);
    this.process.execution = "ACTIVE";

    // captures at points spread through the stage, and any the agent asked for again
    const n = st.outcomes.length;
    let done = 0;
    for (const [i, o] of st.outcomes.entries()) {
      if (this.mode !== "running" || done >= 2) break;
      const c = w.captures.get(o.key);
      const due = progress >= 0.1 + (0.75 * (i + 0.5)) / Math.max(1, n);
      if ((c?.pending || (!c && due) || w.again.has(o.key)) && !(c?.done && !w.again.has(o.key))) {
        await this.capture(w, o);
        done++;
      }
    }
    if (this.mode !== "running") return;

    // the agent decides on a cadence, after each perception, and once before the stage's last unit
    const brain = this.cfg.brain;
    const required = st.outcomes.filter((o) => o.required);
    const outcomesIn = required.every((o) => w.captures.get(o.key)?.done) && w.again.size === 0 && ![...w.captures.values()].some((c) => c.pending);
    if (brain && (w.decideSoon || now - w.lastDecision >= this.cfg.decideS * 1000)) await this.decide(w, false);
    if (brain && outcomesIn && progress >= 1 && !w.closed && this.mode === "running" && w.st.state === "running") {
      // only a decision the agent made closes the stage: a failed one is tried again next tick
      w.closed = await this.decide(w, true);
      return;
    }
    if (this.mode !== "running" || w.st.state !== "running") return;

    // units: the last one waits for the required outcomes (and the agent's closing decision)
    const finish = outcomesIn && progress >= 1 && (!brain || (w.closed && w.again.size === 0));
    const target = Math.min(st.quantity, Math.floor(Math.min(1, progress) * st.quantity), finish ? st.quantity : st.quantity - 1);
    if (target > w.made) {
      this.process.parts += target - w.made;
      w.made = target;
      if (w.made >= st.quantity) {
        this.add({ kind: "stage", event: "units_done", runId: st.runId, stage: st.stage, name: st.name, quantity: st.quantity });
        console.log(`${w.key} made ${st.quantity} unit(s)`);
      }
    }
    if (st.completeOn) this.process.extra.set(st.completeOn.signal, { value: null, text: finish ? st.completeOn.equals : "RUNNING" });
  }

  // ---------------------------------------------------------------- captures
  private async capture(w: Work, o: EdgeOutcome) {
    const st = w.st;
    let c = w.captures.get(o.key);
    if (!c?.pending) {
      const attempt = (c?.attempt ?? o.version) + 1;
      const vr = new Rng(this.cfg.seed, this.cfg.asset, st.runId, st.stage, o.key, attempt, "value");
      const value = pickValue(o.metric, vr, vr.chance(attempt === 1 ? P_OUT_FIRST : P_OUT_AGAIN));
      const spec: CaptureSpec = {
        seed: this.cfg.seed,
        asset: this.cfg.asset,
        kind: this.cfg.kind,
        device: this.device,
        runId: st.runId,
        stage: st.stage,
        stageName: st.name,
        outcome: { key: o.key, label: o.label, media: o.media, instrument: o.instrument, metric: o.metric, required: o.required },
        attempt,
        value,
        capturedAt: Math.floor(Date.now() / 1000),
        progress: Math.round(Math.min(1, w.elapsedMs / (this.cfg.stageS * 1000)) * 1000) / 1000,
        signals: this.process.signals(),
      };
      const { seed: _s, asset: _a, kind: _k, device: _d, ...logged } = spec;
      const res = await render(spec);
      c = { attempt, value, inSpec: inSpec(o.metric, value), agentRead: null, anomaly: null, done: false, uploaded: false, tries: 0, pending: null };
      w.captures.set(o.key, c);
      w.again.delete(o.key);
      if ("skipped" in res) {
        // never faked: the outcome stays without media, and its criterion says so
        c.done = true;
        this.add({ kind: "capture", ...logged, sha256: null, previewSha256: null, mime: null, uploaded: false, skipped: res.skipped });
        console.log(`${w.key} ${o.key} skipped: ${res.skipped}`);
        return;
      }
      let analysis: Analysis;
      if (this.cfg.brain) {
        try {
          const p = await this.cfg.brain.perceive(spec, res.perceive);
          this.fails = 0;
          c.agentRead = p.value;
          c.anomaly = p.anomaly;
          this.add({ kind: "perception", runId: st.runId, stage: st.stage, outcome: o.key, attempt, value: p.value, summary: p.summary, anomaly: p.anomaly, requestId: p.reply.requestId, provider: p.reply.provider, teeVerified: p.reply.teeVerified, model: p.reply.model, ms: p.reply.ms });
          analysis = { summary: p.summary, ...(p.value !== null ? { value: p.value } : {}), ...(p.anomaly ? { anomaly: p.anomaly } : {}), ...(p.reply.requestId ? { requestId: p.reply.requestId } : {}), model: p.reply.model, ...(p.reply.provider ? { provider: p.reply.provider } : {}), teeVerified: p.reply.teeVerified };
          w.decideSoon = true;
        } catch (e) {
          // not read, so not uploaded: it is captured again once 0G answers
          w.captures.delete(o.key);
          if (attempt > 1) w.again.add(o.key);
          await this.brainFailed(e as Error);
          return;
        }
      } else {
        analysis = { summary: "No 0G brain: this virtual machine runs without an on-board agent, so nothing read this capture. The value is the instrument's." };
      }
      c.pending = { spec, res, analysis };
    }
    const { spec, res, analysis } = c.pending;
    const { seed: _s, asset: _a, kind: _k, device: _d, ...logged } = spec;
    try {
      const up = await uploadOutput({ url: this.cfg.url, account: this.gw.account }, { site: st.site, runId: st.runId, stage: st.stage, asset: st.asset }, o.key, spec.value, spec.capturedAt, res.file, res.preview, analysis);
      c.uploaded = c.done = true;
      c.pending = null;
      // the value the machine read goes into its telemetry too, so it signs the outcome's measurement with the stage
      this.process.extra.set(`outcome.${o.key}`, { value: spec.value, text: null });
      this.add({ kind: "capture", ...logged, sha256: up.sha256, previewSha256: up.previewSha256, mime: res.file.mime, uploaded: true, version: up.version });
      console.log(`${w.key} ${o.key} v${up.version} ${res.file.mime} ${res.file.bytes.byteLength} B, ${o.metric.label} ${spec.value}${c.inSpec ? "" : " (out of spec)"}`);
    } catch (e) {
      c.tries++;
      const msg = (e as Error).message;
      if (c.tries >= UPLOAD_TRIES) {
        c.done = true;
        c.pending = null;
        this.add({ kind: "capture", ...logged, sha256: null, previewSha256: null, mime: res.file.mime, uploaded: false, error: msg });
      }
      console.error(`${w.key} ${o.key} upload failed (${c.tries}/${UPLOAD_TRIES}): ${msg}`);
    }
  }

  // ---------------------------------------------------------------- the agent's decisions
  private situation(w: Work): Situation {
    const st = w.st;
    return {
      kind: this.cfg.kind,
      runId: st.runId,
      stage: st.stage,
      stageName: st.name,
      progress: Math.min(1, w.elapsedMs / (this.cfg.stageS * 1000)),
      units: { made: w.made, of: st.quantity },
      signals: this.process.profile.signals.map((s) => ({ name: s.name, value: this.process.value(s), unit: s.unit, ...(s.warn !== undefined ? { warn: s.warn } : {}), ...(s.alarm !== undefined ? { alarm: s.alarm } : {}) })),
      captures: st.outcomes
        .filter((o) => w.captures.get(o.key)?.value !== null && w.captures.get(o.key)?.uploaded)
        .map((o) => {
          const c = w.captures.get(o.key)!;
          return { outcome: o.key, label: o.label, value: c.value!, target: targetText(o.metric), inSpec: Boolean(c.inSpec), attempt: c.attempt, agentRead: c.agentRead, anomaly: c.anomaly };
        }),
      pending: st.outcomes.filter((o) => !w.captures.get(o.key)?.done).map((o) => o.key),
    };
  }

  private async decide(w: Work, closing: boolean): Promise<boolean> {
    const brain = this.cfg.brain!;
    const s = this.situation(w);
    let d;
    try {
      d = await brain.decide(s);
      this.fails = 0;
    } catch (e) {
      await this.brainFailed(e as Error);
      return false;
    }
    w.lastDecision = Date.now();
    w.decideSoon = false;
    const st = w.st;
    const applied: string[] = [];
    const outOfSpec = s.captures.filter((c) => !c.inSpec);
    const warn = s.signals.filter((x) => x.warn !== undefined && x.value >= x.warn);
    if (d.action === "adjust") {
      const sig = d.signal ?? this.process.drifting;
      if (sig && this.process.adjust(sig)) applied.push(`brought ${sig} back to nominal`);
      const again = d.recapture ?? (outOfSpec[0]?.outcome || null);
      const c = again ? w.captures.get(again) : undefined;
      if (again && c?.uploaded && !c.inSpec && c.attempt < MAX_ATTEMPTS) {
        w.again.add(again);
        applied.push(`capturing ${again} again (attempt ${c.attempt + 1})`);
      }
      if (!applied.length) applied.push("nothing to adjust: carried on");
    } else if (d.action === "hold") {
      if (w.agentHeld) applied.push("already held once this stage: carried on");
      else if (!outOfSpec.length && !warn.length) applied.push("declined: no capture out of spec and no signal at its warn limit; carried on");
      else {
        w.agentHeld = true;
        const ok = await this.hold(st, `${d.reason}`.slice(0, 400) || "The machine's agent held the stage.", "agent");
        applied.push(ok ? "held the stage for a person" : "could not hold the stage");
      }
    } else applied.push("carried on");
    this.add({ kind: "decision", runId: st.runId, stage: st.stage, action: d.action, reason: closing ? `closing: ${d.reason}` : d.reason, signal: d.signal, recapture: d.recapture, applied: applied.join("; "), requestId: d.reply.requestId, provider: d.reply.provider, teeVerified: d.reply.teeVerified, model: d.reply.model, ms: d.reply.ms });
    if (d.action !== "continue") console.log(`${w.key} agent ${d.action}: ${applied.join("; ")}`);
    return true;
  }

  // ---------------------------------------------------------------- safe stop
  private async brainFailed(e: Error) {
    if (!(e instanceof BrainError)) throw e;
    this.fails++;
    this.lastError = e.message;
    this.add({ kind: "brain_error", error: e.message, consecutive: this.fails });
    console.error(`0G failed (${this.fails}/${this.cfg.failLimit}): ${e.message}`);
    if (this.fails < this.cfg.failLimit || this.mode === "safe_stopped") return;
    this.mode = "safe_stopped";
    this.lastProbe = Date.now();
    this.process.execution = "FEED_HOLD";
    for (const w of this.works.values()) if (!w.final && w.st.state === "running") await this.safeHold(w, e.message);
    await this.reports(true).catch(() => undefined);
  }

  private async safeHold(w: Work, why: string) {
    if (w.safeHeld) return;
    w.safeHeld = true;
    await this.hold(w.st, `0G Router unreachable (${this.fails} failures in a row: ${why}). The machine does not decide without its agent, so it stopped.`, "safe_stop");
  }

  private async hold(st: EdgeStage, reason: string, kind: "safe_stop" | "agent"): Promise<boolean> {
    try {
      await this.gw.request("POST", "/v1/edge/hold", { runId: st.runId, stage: st.stage, reason: reason.slice(0, 500), kind });
      this.add({ kind: "hold", runId: st.runId, stage: st.stage, reason, hold: kind, accepted: true });
      console.log(`held ${keyOf(st)} (${kind})`);
      return true;
    } catch (e) {
      this.add({ kind: "hold", runId: st.runId, stage: st.stage, reason, hold: kind, accepted: false, error: (e as Error).message });
      console.error(`could not hold ${keyOf(st)}: ${(e as Error).message}`);
      return false;
    }
  }

  /** After a safe stop: a small request now and then; when 0G answers, the body runs again (the hold waits for a person). */
  private async probe() {
    if (!this.cfg.brain || Date.now() - this.lastProbe < PROBE_EVERY_MS) return;
    this.lastProbe = Date.now();
    try {
      const r = await this.cfg.brain.probe();
      this.fails = 0;
      this.mode = "running";
      this.add({ kind: "brain_back", requestId: r.requestId });
      console.log(`0G answers again; running (a held stage waits for a person to release it)`);
      await this.reports(true).catch(() => undefined);
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  // ---------------------------------------------------------------- reports
  private async report(episode: { runId: string; stage: string; final: boolean } | null) {
    await this.gw.request("POST", "/v1/edge/episodes", {
      assetId: this.cfg.asset,
      state: this.state,
      brain: this.cfg.brain ? "0g" : "none",
      model: this.cfg.brain?.model ?? null,
      episode: episode ? { runId: episode.runId, stage: episode.stage, final: episode.final, log: this.log.episode(episode.runId, episode.stage) } : null,
    });
    this.lastReport = Date.now();
  }

  /** Each stage's episode at most every 30 s while it changes and once when it ends; a heartbeat otherwise. */
  async reports(force = false) {
    const now = Date.now();
    for (const w of [...this.works.values()]) {
      const n = this.log.entries.filter((e) => e.runId === w.st.runId && e.stage === w.st.stage).length;
      if (n !== w.reportedEntries && (force || w.final || now - w.reportedAt >= REPORT_EVERY_MS)) {
        await this.report({ runId: w.st.runId, stage: w.st.stage, final: w.final });
        w.reportedAt = now;
        w.reportedEntries = n;
      }
      if (w.final && n === w.reportedEntries) this.works.delete(w.key);
    }
    if (force || now - this.lastReport >= HEARTBEAT_MS) await this.report(null);
  }

  // ---------------------------------------------------------------- the body's own disk
  private file() {
    return this.cfg.dataDir ? join(this.cfg.dataDir, "state.json") : null;
  }
  private load(): Saved | null {
    const f = this.file();
    if (!f || !existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as Saved;
    } catch {
      return null;
    }
  }
  /** The counters and each open stage's progress, so a restarted body carries on where it was. */
  private save() {
    const f = this.file();
    if (!f) return;
    const works: Saved["works"] = {};
    for (const w of this.works.values()) if (!w.final) works[w.key] = { base: w.base, elapsedMs: w.elapsedMs, made: w.made };
    try {
      mkdirSync(this.cfg.dataDir!, { recursive: true });
      writeFileSync(f, JSON.stringify({ parts: this.process.parts, scrap: this.process.scrap, works }));
    } catch {
      // the next tick tries again
    }
  }
}
