import type { AgentKey, AssetStatus, StageState } from "../types";

export const AGENT_LABEL: Record<AgentKey, string> = {
  planning: "Planning agent",
  supply: "Supply agent",
  scheduler: "Scheduler agent",
  line: "Line agent",
  process: "Process agent",
  vision_qa: "Vision QA agent",
  logistics: "Logistics agent",
  maintenance: "Maintenance agent",
};
export const STATE_LABEL: Record<StageState, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  held: "Held by operator",
  done_deviation: "Done · deviation",
  completed: "Completed",
  skipped: "Skipped",
};
export const STATUS_LABEL: Record<AssetStatus, string> = {
  running: "Running",
  idle: "Idle",
  stopped: "Stopped",
  degraded: "Degraded",
  alarm: "Alarm",
  offline: "Offline",
  no_data: "No data yet",
};
export const LEVEL_LABEL: Record<string, string> = { L1: "Assist", L2: "Recommend", L3: "Supervised", L4: "Autonomous" };
export const LEVEL_TEXT: Record<string, string> = {
  L1: "Agents monitor and suggest. People start every stage transition.",
  L2: "Agents plan and prepare actions. People confirm each decision.",
  L3: "Agents execute within guardrails and escalate at quality gates and out-of-policy events.",
  L4: "Agents execute end to end, including in-policy gates. People are notified and may intervene.",
};

/** "agent:vision_qa" → "Vision QA agent", "user:0xabc…" → a name from the team map. */
export function actorLabel(actor: string, names: Map<string, string> = new Map()): string {
  const [kind, rest = ""] = actor.split(/:(.*)/s);
  if (kind === "agent") return AGENT_LABEL[rest as AgentKey] ?? rest;
  if (kind === "user") return names.get(rest) ?? `${rest.slice(0, 6)}…${rest.slice(-4)}`;
  if (kind === "guard") return "Policy guard";
  if (kind === "system") return "System";
  return actor;
}
export const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—");
export const dateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
export const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(0, s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
export const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
export const num = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: d }));
export const dur = (min: number | null | undefined) => (min === null || min === undefined ? "—" : min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`);
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const signalLabel = (s: string) => s.replace("condition.", "condition · ").replaceAll("_", " ");

/** " · verified on 0G Compute" when a model's answer carries a checked TEE signature. */
export function computeProof(d: { data: unknown; modelId: string | null }): string {
  const a = (d.data as { attestation?: { kind: string; verified: boolean | null } | null } | null)?.attestation;
  if (!a || a.kind !== "0g-compute") return "";
  return a.verified === true ? ` · ${d.modelId ?? "model"} verified on 0G Compute` : a.verified === false ? " · 0G Compute signature did not verify" : ` · ${d.modelId ?? "model"} on 0G Compute`;
}
