import type { LlmProvider, LlmResult, LlmTask } from "../adapters/llm.js";
import { Diagnosis, Recommendation, ShiftSummary, type Anomaly, type AssetKind, type Forecast, type SignalLimit, type TelemetrySample, type ToolCall } from "../domain/types.js";
import type { LicensedPlaybook } from "../core/agent-licenses.js";
import { groundingCheck } from "./grounding.js";

// ---------------- Context builders ----------------
export interface SignalStats {
  last: number;
  min: number;
  max: number;
  mean: number;
  n: number;
}
/** Summary statistics of every measured signal of one asset over the last `minutes` of data. */
export function signalStats(samples: TelemetrySample[], assetId: string, minutes = 30): Record<string, SignalStats> {
  const latest = samples.at(-1)?.minute ?? 0;
  const out: Record<string, SignalStats> = {};
  for (const s of samples) {
    if (s.assetId !== assetId || s.quality !== "good" || s.minute <= latest - minutes) continue;
    const st = out[s.signal] ?? { last: s.value, min: s.value, max: s.value, mean: 0, n: 0 };
    st.last = s.value;
    st.min = Math.min(st.min, s.value);
    st.max = Math.max(st.max, s.value);
    st.mean += s.value;
    st.n += 1;
    out[s.signal] = st;
  }
  for (const st of Object.values(out)) st.mean = Math.round((st.mean / st.n) * 100) / 100;
  return out;
}

export interface DiagnosisInput {
  asset: { id: string; name: string; kind: AssetKind; status: string; statusDetail: string };
  anomaly: Anomaly;
  forecast: Forecast | null;
  last30min: Record<string, SignalStats>;
  limits: Record<string, SignalLimit>;
  conditions: Record<string, string>;
}

export interface RecommendInput {
  asset: { id: string; name: string; kind: AssetKind; status: string };
  anomaly: Anomaly;
  forecast: Forecast | null;
  diagnosis: { rootCause: string; confidence: number };
  activeStage: { runId: string; stageCode: string; stageName: string; unitsLeft: number } | null;
  alternativeAssets: { id: string; name: string; status: string }[];
  tools: string;
  /** Accepted cases from another site's proven agent this site licenses through its iNFT, closest first */
  licensedPlaybook?: Pick<LicensedPlaybook, "from" | "tokenId" | "record" | "cases">;
}

// ---------------- Prompts (versioned with the code; their hash is recorded per decision) ----------------
const SYSTEM = `You are an agent inside Ordo, a manufacturing orchestration system. You advise; you never act directly.
A deterministic policy guard checks everything you propose. Use only numbers and identifiers that appear in the INPUT.
Be concise, specific and technical. Never invent sensor readings, units, assets, runs or stages.`;

export const DIAGNOSE_PROMPT = `Task: explain the most likely cause of the anomaly on the asset in plain language for a plant engineer.
Cite the signal values from INPUT with their units. Consider mechanical wear, thermal or cooling faults, overload, tooling, process drift and sensor faults.
Return JSON: { rootCause: string (2-3 sentences), evidence: [{ signal, observation }] (1-5 items), confidence: 0..1 }.`;

export const TOOLS_DOC = `Allowed tools (choose 1 or 2 actions; anything else is blocked):
- hold_stage { runId, stageCode, reason }               stop the active stage on this asset at its gate
- reassign_stage { runId, stageCode, targetAssetId }    move the active stage to an alternative asset of the same kind
- open_work_order { assetId, priority: low|medium|high, windowMinutes }  start a predictive-maintenance run for the asset
- request_inspection { assetId, sampleRatePct }         raise inspection sampling on units from the asset
- notify_operator { assetId, instruction }              an instruction a person carries out at the machine`;

export const RECOMMEND_PROMPT = `Task: recommend the safest effective intervention for this anomaly.
Prefer actions that protect product quality and prevent the predicted failure. Only use runId/stageCode from activeStage and
targetAssetId from alternativeAssets. Give up to 3 alternatives you rejected, each with its trade-off.
If INPUT has licensedPlaybook, it holds cases that another site's proven agent recommended and people there accepted:
weigh them as precedent and say so in the reason, but this site's asset, activeStage and alternativeAssets decide.
Return JSON: { actions: [ { tool, args } ] (1-2), reason: string, confidence: 0..1, alternatives: [{ summary, tradeoff }] }.`;

export const SUMMARY_PROMPT = `Task: write a short shift-handoff summary of the ledger entries in INPUT for the next shift and for QA.
Mention what ran, what was decided, who signed, and what is still open. Cite ledger sequence numbers.
Return JSON: { summary: string (max 120 words), citedSeqs: number[] }.`;

// ---------------- Offline (deterministic, grounded) outputs ----------------
const r2 = (n: number) => Math.round(n * 100) / 100;
const unitOf = (i: { limits: Record<string, SignalLimit> }, s: string) => i.limits[s]?.unit ?? "";
const pretty = (s: string) => s.replaceAll("_", " ");

export function offlineDiagnosis(i: DiagnosisInput): Diagnosis {
  const a = i.anomaly;
  const u = unitOf(i, a.signal);
  const st = i.last30min[a.signal];
  const others = Object.entries(i.last30min).filter(([k]) => k !== a.signal && i.limits[k]);
  const correlated = others.find(([k, v]) => v.max >= 0.8 * (i.limits[k]!.warn ?? i.limits[k]!.alarm ?? Infinity));
  const faults = Object.entries(i.conditions).filter(([, v]) => v === "FAULT" || v === "WARNING");
  const how = a.kind === "drift" ? `has drifted upward at ${a.trendPerHour} ${u}/h` : `reached ${a.value} ${u}, past its ${a.level} limit of ${a.limit} ${u}`;
  const cause = correlated
    ? `${pretty(correlated[0])} is also elevated (max ${correlated[1].max} ${unitOf(i, correlated[0])}), so a real process or mechanical change is more likely than a sensor fault`
    : faults.length
      ? `the controller reports ${faults.map(([k, v]) => `${pretty(k.replace("condition.", ""))} ${v}`).join(", ")}, which points to a fault the machine itself detected`
      : `no other monitored signal moved with it, so a local cause (tooling, fixture, sensor) should be checked first`;
  const evidence = [{ signal: a.signal, observation: st ? `${st.min} → ${st.last} ${u} over the last 30 min (mean ${st.mean})` : `${a.value} ${u}` }];
  if (correlated) evidence.push({ signal: correlated[0], observation: `max ${correlated[1].max} ${unitOf(i, correlated[0])}` });
  for (const [k, v] of faults.slice(0, 2)) evidence.push({ signal: k, observation: v });
  return {
    rootCause: `${pretty(a.signal)} on ${i.asset.name} ${how}. ${cause[0]!.toUpperCase()}${cause.slice(1)}.`,
    evidence,
    confidence: r2(Math.min(0.9, Math.max(0.5, (i.forecast?.confidence ?? 0.6) * (correlated || faults.length ? 1 : 0.85)))),
  };
}

export function offlineRecommendation(i: RecommendInput): Recommendation {
  const actions: ToolCall[] = [];
  const alternatives: Recommendation["alternatives"] = [];
  const a = i.anomaly;
  const ttfMin = i.forecast?.ttfHours == null ? null : Math.round(i.forecast.ttfHours * 60);
  const alt = i.alternativeAssets.find((x) => x.status === "idle" || x.status === "running");
  if (a.level === "alarm" && i.activeStage) {
    if (alt) actions.push({ tool: "reassign_stage", args: { runId: i.activeStage.runId, stageCode: i.activeStage.stageCode, targetAssetId: alt.id } });
    else actions.push({ tool: "hold_stage", args: { runId: i.activeStage.runId, stageCode: i.activeStage.stageCode, reason: `${pretty(a.signal)} ${a.value} past alarm limit ${a.limit}` } });
    alternatives.push({ summary: `Keep ${i.activeStage.stageCode} running on ${i.asset.name}`, tradeoff: `${i.activeStage.unitsLeft} units left on an asset past its alarm limit` });
  }
  if (["cnc", "robot", "agv", "process_vessel", "pack_line"].includes(i.asset.kind)) {
    const window = ttfMin === null ? 120 : Math.max(0, Math.min(240, Math.floor(ttfMin / 2)));
    actions.push({ tool: "open_work_order", args: { assetId: i.asset.id, priority: a.level === "alarm" ? "high" : "medium", windowMinutes: window } });
    alternatives.push({ summary: "Run to the next planned stop", tradeoff: ttfMin === null ? "Trend is unclear; the fault may recur without inspection" : `Projected to reach the limit in about ${ttfMin} min` });
  } else {
    actions.push({ tool: "request_inspection", args: { assetId: i.asset.id, sampleRatePct: 100 } });
  }
  if (actions.length < 2) actions.push({ tool: "notify_operator", args: { assetId: i.asset.id, instruction: `Check ${pretty(a.signal)} on ${i.asset.name}: ${a.value} against limit ${a.limit}` } });
  // a licensed playbook's closest accepted case puts its first action first when this site has it too
  const pb = i.licensedPlaybook;
  const like = pb?.cases.filter((c) => c.signal === a.signal && c.assetKind === i.asset.kind) ?? [];
  const lead = like[0]?.tools.find((t) => actions.some((x) => x.tool === t));
  if (lead) actions.sort((x, y) => Number(y.tool === lead) - Number(x.tool === lead));
  const what = actions.map((x) => x.tool.replaceAll("_", " ")).join(" and ");
  return {
    actions: actions.slice(0, 2),
    reason: `${pretty(a.signal)} on ${i.asset.name} is ${a.value} against the ${a.level} limit ${a.limit}${ttfMin !== null ? `, projected to reach the alarm limit in ${ttfMin} min` : ""}. Recommended: ${what}.${like.length && pb ? ` The licensed playbook from ${pb.from} has ${like.length === 1 ? "one accepted case" : `${like.length} accepted cases`} like this, resolved with ${like[0]!.tools.map(pretty).join(" and ")}.` : ""}`,
    confidence: r2(Math.min(0.9, Math.max(0.55, i.diagnosis.confidence))),
    alternatives: alternatives.slice(0, 3),
  };
}

export interface SummaryInput {
  entries: { seq: number; type: string; actor: string; subject: string | null; brief: string }[];
}
export function offlineSummary(i: SummaryInput): ShiftSummary {
  const pick = i.entries.filter((e) => /decision\.(run|gate|inbox\.decided|stage\.held|work_order|incident)/.test(e.type)).slice(-8);
  const used = pick.length ? pick : i.entries.slice(-3);
  if (!used.length) return { summary: "Nothing was recorded in this window.", citedSeqs: [] };
  return { summary: `Shift handoff. ${used.map((e) => `#${e.seq} ${e.brief}`).join(". ")}.`.slice(0, 900), citedSeqs: used.map((e) => e.seq) };
}

// ---------------- Agents ----------------
export class Agents {
  constructor(private llm: LlmProvider) {}
  get name() {
    return this.llm.name;
  }

  diagnose(input: DiagnosisInput): Promise<LlmResult<Diagnosis>> {
    const task: LlmTask<Diagnosis> = { name: "diagnose", system: SYSTEM, prompt: DIAGNOSE_PROMPT, input, schema: Diagnosis, offline: offlineDiagnosis as never };
    return this.llm.generate(task);
  }

  async recommend(input: RecommendInput): Promise<LlmResult<Recommendation> & { grounding: { ok: boolean; unknownNumbers: number[] } }> {
    const task: LlmTask<Recommendation> = { name: "recommend", system: SYSTEM, prompt: RECOMMEND_PROMPT, input, schema: Recommendation, offline: offlineRecommendation as never };
    const r = await this.llm.generate(task);
    const grounding = groundingCheck(r.value.reason, { input, actions: r.value.actions });
    // Ungrounded numbers cap confidence below the guard threshold so a person reviews it.
    const value = grounding.ok ? r.value : { ...r.value, confidence: Math.min(r.value.confidence, 0.6) };
    return { ...r, value, grounding };
  }

  summarize(input: SummaryInput): Promise<LlmResult<ShiftSummary>> {
    const task: LlmTask<ShiftSummary> = { name: "summarize", system: SYSTEM, prompt: SUMMARY_PROMPT, input, schema: ShiftSummary, offline: offlineSummary as never };
    return this.llm.generate(task);
  }
}
