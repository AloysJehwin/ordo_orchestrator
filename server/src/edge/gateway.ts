import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { MEASUREMENT_TYPES, PROOF_DOMAIN, READING_TYPES } from "../auth/auth.js";
import { edgeMessage, type EdgeParameter, type EdgeStage, type MeasurementSubmission } from "../core/readings.js";
import { scaled, specCommitment } from "../core/spec-proofs.js";
import { FIELD, readingCommitment } from "../core/stage-proofs.js";
import { parseCurrent, readCurrent } from "../plant/mtconnect.js";

/** One instrument signal a simulated profile emits: base + drift over the stage + a swing around it, with a little noise. */
export interface ProfileSignal {
  name: string;
  base: number;
  swing: number;
  /** total change over one stage (per stageS) */
  drift?: number;
  /** seconds per swing cycle */
  periodS?: number;
}
/**
 * Where the gateway reads its machine: an MTConnect agent on the shop floor, a simulated machine (one part every cycleS),
 * or a simulated instrument running a profile: its signals follow the profile and it counts one batch (batchUnits) every stageS.
 */
export type MachineSource =
  | { kind: "mtconnect"; agentUrl: string; device: string }
  | { kind: "simulate"; cycleS: number; scrapEvery: number }
  | { kind: "profile"; stageS: number; batchUnits: number; signals: ProfileSignal[] };
export interface GatewayOptions {
  /** Ordo's base URL */
  url: string;
  /** the gateway's own key: its address is the asset's data source and holds the device role */
  key: Hex;
  assetId: string;
  source: MachineSource;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}
interface Sample {
  t: number;
  part_count: number | null;
  scrap: number | null;
  /** every numeric signal the machine reported, so the stage's measured parameters can be signed from the gateway's own readings */
  signals: Record<string, number>;
}
const KEEP_MS = 3 * 86_400_000;

/**
 * Ordo's edge gateway: a small service next to a machine that holds its own key. It pushes the machine's counters to
 * Ordo, every request signed with that key, keeps its own history of them, and when a stage on the machine finishes,
 * signs an OrdoReading over a commitment to the good and scrap units its own counters show for the stage's window, and
 * an OrdoMeasurement per measured parameter (final value, minimum, maximum or mean of a signal over the window) from its
 * own readings. Ordo then proves the stage's criteria from those commitments; the counts and values never leave Ordo.
 */
export class Gateway {
  readonly account: PrivateKeyAccount;
  private history: Sample[] = [];
  private sim = { parts: 1000, scrap: 0, at: 0 };

  constructor(private o: GatewayOptions) {
    this.account = privateKeyToAccount(o.key);
  }
  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** One request to Ordo, signed with the gateway's key. */
  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(this.now() / 1000);
    const nonce = randomBytes(12).toString("hex");
    const sig = await this.account.signMessage({ message: edgeMessage(ts, nonce, method, path, raw) });
    const res = await (this.o.fetch ?? fetch)(`${this.o.url.replace(/\/$/, "")}${path}`, {
      method,
      body: raw || undefined,
      headers: { "content-type": "application/json", "x-ordo-device": this.account.address, "x-ordo-ts": String(ts), "x-ordo-nonce": nonce, "x-ordo-sig": sig },
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? ""}`.trim());
    return json;
  }

  /** Read the machine and push what it shows. */
  async observe(): Promise<number> {
    const ts = new Date(this.now()).toISOString();
    let obs: { signal: string; ts: string; value: number | null; text: string | null }[];
    if (this.o.source.kind === "mtconnect") {
      obs = parseCurrent(await readCurrent(this.o.source.agentUrl), this.o.source.device).map((x) => ({ signal: x.signal, ts: x.ts, value: x.value, text: x.text }));
    } else if (this.o.source.kind === "profile") {
      // an instrument: its signals follow the profile over each stage, and one batch is counted when a stage's time is up
      const { stageS, batchUnits, signals } = this.o.source;
      if (!this.sim.at) this.sim.at = this.now();
      const elapsedS = (this.now() - this.sim.at) / 1000;
      const phase = (elapsedS % stageS) / stageS;
      const batches = Math.floor(elapsedS / stageS);
      this.sim.parts = 1000 + batches * batchUnits;
      const round = (v: number) => Math.round(v * 1000) / 1000;
      obs = [
        { signal: "execution", ts, value: null, text: "ACTIVE" },
        { signal: "part_count", ts, value: this.sim.parts, text: null },
        { signal: "scrap", ts, value: 0, text: null },
        ...signals.map((p) => ({ signal: p.name, ts, value: round(p.base + (p.drift ?? 0) * phase + p.swing * Math.sin((2 * Math.PI * elapsedS) / (p.periodS ?? 600)) + (Math.random() - 0.5) * p.swing * 0.2), text: null })),
      ];
    } else {
      // a machine making one good part every cycleS and one scrap part every scrapEvery parts
      const { cycleS, scrapEvery } = this.o.source;
      if (!this.sim.at) this.sim.at = this.now();
      const made = Math.floor((this.now() - this.sim.at) / (cycleS * 1000));
      for (let i = 0; i < made; i++) {
        if (scrapEvery > 0 && (this.sim.parts + this.sim.scrap + 1) % scrapEvery === 0) this.sim.scrap++;
        else this.sim.parts++;
      }
      this.sim.at += made * cycleS * 1000;
      obs = [
        { signal: "execution", ts, value: null, text: "ACTIVE" },
        { signal: "part_count", ts, value: this.sim.parts, text: null },
        { signal: "scrap", ts, value: this.sim.scrap, text: null },
      ];
    }
    const num = (s: string) => obs.find((x) => x.signal === s)?.value ?? null;
    const signals: Record<string, number> = {};
    for (const o of obs) if (o.value !== null && Number.isFinite(o.value)) signals[o.signal] = o.value;
    this.history.push({ t: this.now(), part_count: num("part_count"), scrap: num("scrap"), signals });
    this.history = this.history.filter((h) => this.now() - h.t < KEEP_MS);
    await this.request("POST", "/v1/edge/observations", { assetId: this.o.assetId, observations: obs });
    return obs.length;
  }

  /** A counter's value at time t (ms) by the gateway's own history: the last sample at or before t. */
  private at(counter: "part_count" | "scrap", t: number): number | null {
    let v: number | null = null;
    for (const h of this.history) {
      if (h.t > t) break;
      if (h[counter] !== null) v = h[counter];
    }
    return v ?? this.history.find((h) => h[counter] !== null)?.[counter] ?? null;
  }
  /** Good and scrap units over a stage's window, from the gateway's own counters. */
  countsFor(st: { startedAt: number; endedAt: number }): { good: number; scrap: number } | null {
    const [g0, g1] = [this.at("part_count", st.startedAt * 1000), this.at("part_count", st.endedAt * 1000 + 999)];
    if (g0 === null || g1 === null) return null;
    const [s0, s1] = [this.at("scrap", st.startedAt * 1000), this.at("scrap", st.endedAt * 1000 + 999)];
    return { good: Math.max(0, g1 - g0), scrap: s0 === null || s1 === null ? 0 : Math.max(0, s1 - s0) };
  }

  /** One bound of a measured parameter over a stage's window, from the gateway's own readings: the value × 10⁴ the circuit takes, or null without readings. */
  measurementFor(p: EdgeParameter, st: { startedAt: number; endedAt: number }): bigint | null {
    const vals = this.history.filter((h) => h.t >= st.startedAt * 1000 && h.t <= st.endedAt * 1000 + 999 && p.signal in h.signals).map((h) => h.signals[p.signal]!);
    if (!vals.length) return null;
    const v = p.agg === "last" ? vals.at(-1)! : p.agg === "min" ? Math.min(...vals) : p.agg === "max" ? Math.max(...vals) : vals.reduce((a, b) => a + b, 0) / vals.length;
    return scaled(v);
  }

  /** Sign the measured parameters of a finished stage: one OrdoMeasurement per bound, each over its own commitment. */
  private async signMeasurements(st: EdgeStage): Promise<number> {
    const ms: MeasurementSubmission[] = [];
    for (const p of st.parameters) {
      const value = this.measurementFor(p, { startedAt: st.startedAt, endedAt: st.endedAt! });
      if (value === null) {
        this.o.log?.(`${st.runId} · ${st.stage}: no readings of ${p.signal} in its window; not signing ${p.criterion}`);
        continue;
      }
      const salt = BigInt(`0x${randomBytes(31).toString("hex")}`) % FIELD;
      const commitment = await specCommitment(BigInt(p.subject), value, salt);
      const signedAt = Math.floor(this.now() / 1000);
      const signature = await this.account.signTypedData({
        domain: PROOF_DOMAIN,
        types: MEASUREMENT_TYPES,
        primaryType: "OrdoMeasurement",
        message: { site: st.site, runId: st.runId, stage: st.stage, asset: st.asset, criterion: p.criterion, commitment, anchor: st.anchor, signedAt: BigInt(signedAt) },
      });
      ms.push({ criterion: p.criterion, value: value.toString(), salt: salt.toString(), commitment: commitment.toString(), anchor: st.anchor, signedAt, signature });
    }
    if (!ms.length) return 0;
    const r = await this.request<{ measurements: { criterion: string; matches: boolean }[] }>("POST", "/v1/edge/measurements", { runId: st.runId, stage: st.stage, measurements: ms });
    this.o.log?.(`${st.runId} · ${st.stage}: signed ${r.measurements.length} measured parameter(s)${r.measurements.every((m) => m.matches) ? "" : " (some differ from Ordo's record)"}`);
    return r.measurements.length;
  }

  /** Sign every finished stage on this machine that is not signed yet: its counts, then its measured parameters. */
  async signFinished(): Promise<{ stage: string; runId: string; matches: boolean; measurements?: number }[]> {
    const { stages } = await this.request<{ stages: EdgeStage[] }>("GET", "/v1/edge/stages");
    const out: { stage: string; runId: string; matches: boolean; measurements?: number }[] = [];
    for (const st of stages) {
      if (st.endedAt === null || st.asset !== this.o.assetId) continue;
      if (st.signed) {
        if (st.parameters?.length && !st.measurementsSigned) out.push({ stage: st.stage, runId: st.runId, matches: true, measurements: await this.signMeasurements(st) });
        continue;
      }
      const counts = this.countsFor({ startedAt: st.startedAt, endedAt: st.endedAt });
      if (!counts) {
        this.o.log?.(`${st.runId} · ${st.stage}: no counter history for its window; not signing`);
        continue;
      }
      const salt = BigInt(`0x${randomBytes(31).toString("hex")}`) % FIELD;
      const commitment = await readingCommitment(BigInt(st.subject), { good: BigInt(counts.good), scrap: BigInt(counts.scrap), startedAt: BigInt(st.startedAt), endedAt: BigInt(st.endedAt) }, salt);
      const signedAt = Math.floor(this.now() / 1000);
      const signature = await this.account.signTypedData({
        domain: PROOF_DOMAIN,
        types: READING_TYPES,
        primaryType: "OrdoReading",
        message: { site: st.site, runId: st.runId, stage: st.stage, asset: st.asset, commitment, anchor: st.anchor, signedAt: BigInt(signedAt) },
      });
      const r = await this.request<{ matches: boolean }>("POST", "/v1/edge/readings", { runId: st.runId, stage: st.stage, ...counts, salt: salt.toString(), commitment: commitment.toString(), anchor: st.anchor, signedAt, signature });
      this.o.log?.(`${st.runId} · ${st.stage}: signed ${counts.good} good, ${counts.scrap} scrap${r.matches ? "" : " (differs from Ordo's record)"}`);
      const measurements = st.parameters?.length && !st.measurementsSigned ? await this.signMeasurements(st) : undefined;
      out.push({ stage: st.stage, runId: st.runId, matches: r.matches, ...(measurements !== undefined ? { measurements } : {}) });
    }
    return out;
  }

  async tick() {
    await this.observe();
    return this.signFinished();
  }
}
