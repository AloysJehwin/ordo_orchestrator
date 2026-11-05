import { z } from "zod";

// ---------- People ----------
export const ROLES = ["manager", "validator", "tester", "contributor"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;
/** Used only to pick the most senior of several roles (the one an escalation needs). */
export const ROLE_RANK: Record<Role, number> = { contributor: 1, tester: 2, validator: 3, manager: 4 };
export const ROLE_LABEL: Record<Role, string> = {
  manager: "Manager",
  validator: "Validator",
  tester: "Tester",
  contributor: "Contributor",
};
export const ROLE_INFO: Record<Role, string> = {
  manager: "Runs the org: every right, funds rewards, controls agents and wallets, decides cases",
  validator: "Stakes, selects the valid contribution for a stage, and can contribute too",
  tester: "Stakes, investigates stages that went wrong, and opens cases against validators",
  contributor: "Joins openly, learns the process, and submits proof of work",
};
/** Roles from before the four-role model, as stored in older rows, templates and policies. */
export const LEGACY_ROLE: Record<string, Role> = {
  admin: "manager",
  plant_manager: "manager",
  supervisor: "manager",
  process_engineer: "manager",
  maintenance_lead: "manager",
  quality_engineer: "validator",
  operator: "contributor",
};
export const normalizeRole = (r: unknown): unknown => (typeof r === "string" && LEGACY_ROLE[r] ? LEGACY_ROLE[r] : r);
/** A role read from stored data or a template: an old role name maps onto the four roles. */
export const RoleIn = z.preprocess(normalizeRole, Role);

// ---------- Visibility ----------
/** 1 stages and status · 2 plus outcomes · 3 plus proofs, measurements and contributions · 4 everything */
export const ACCESS_LEVELS = [1, 2, 3, 4] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const ACCESS_LABEL: Record<AccessLevel, string> = {
  1: "Stages and status",
  2: "Plus outcomes",
  3: "Plus proofs and measurements",
  4: "Everything",
};
export const DEFAULT_LEVEL: Record<Role, AccessLevel> = { manager: 4, validator: 3, tester: 3, contributor: 2 };
/** null means all lines or all stages */
export const AccessScope = z.object({
  lines: z.array(z.string().min(1).max(64)).max(50).nullable().default(null),
  stages: z.array(z.string().regex(/^\d{2}[a-z]?$/)).max(100).nullable().default(null),
});
export type AccessScope = z.infer<typeof AccessScope>;

export const LEVELS = ["L1", "L2", "L3", "L4"] as const;
export const AutonomyLevel = z.enum(LEVELS);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;
export const levelRank = (l: AutonomyLevel): number => LEVELS.indexOf(l) + 1;

// ---------- Agents ----------
export const AGENTS = ["planning", "supply", "scheduler", "line", "process", "vision_qa", "logistics", "maintenance"] as const;
export const AgentKey = z.enum(AGENTS);
export type AgentKey = z.infer<typeof AgentKey>;
export const AGENT_INFO: Record<AgentKey, { label: string; scope: string }> = {
  planning: { label: "Planning agent", scope: "Orders & capacity" },
  supply: { label: "Supply agent", scope: "Materials & AGVs" },
  scheduler: { label: "Scheduler agent", scope: "Machining cells" },
  line: { label: "Line agent", scope: "Assembly" },
  process: { label: "Process agent", scope: "Thermal & chemical" },
  vision_qa: { label: "Vision QA agent", scope: "Inspection & release" },
  logistics: { label: "Logistics agent", scope: "Packing & shipping" },
  maintenance: { label: "Maintenance agent", scope: "Asset health" },
};

// ---------- Assets & telemetry ----------
export const ASSET_KINDS = ["cnc", "robot", "manual_station", "inspection", "agv", "pack_line", "process_vessel", "maintenance_crew", "system"] as const;
export const AssetKind = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof AssetKind>;
export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  cnc: "CNC machine",
  robot: "Robot cell",
  manual_station: "Manual station",
  inspection: "Inspection station",
  agv: "Autonomous vehicle",
  pack_line: "Packing line",
  process_vessel: "Process vessel / oven",
  maintenance_crew: "Maintenance crew",
  system: "Business system (ERP / MES)",
};

export const DataSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mtconnect"), agentUrl: z.string().url(), device: z.string().min(1), pollSeconds: z.number().int().min(2).max(300).default(10) }),
  z.object({ type: z.literal("replay"), seriesId: z.string().optional() }),
  z.object({ type: z.literal("manual") }),
  // a gateway at the machine pushes its observations, signed with the gateway's own key, and signs each stage's counts
  z.object({ type: z.literal("gateway"), device: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase()) }),
]);
export type DataSource = z.infer<typeof DataSource>;

export const SignalLimit = z.object({ warn: z.number().optional(), alarm: z.number().optional(), unit: z.string().default("") });
export type SignalLimit = z.infer<typeof SignalLimit>;
export type Quality = "good" | "uncertain" | "bad";

/** One measurement. `minute` is minutes since epoch (fractional), used by the trend models. */
export interface TelemetrySample {
  assetId: string;
  signal: string;
  value: number;
  unit: string;
  minute: number;
  quality: Quality;
}

export type AssetStatus = "running" | "idle" | "stopped" | "degraded" | "alarm" | "offline" | "no_data";
export interface AssetView {
  id: string;
  name: string;
  kind: AssetKind;
  zoneId: string | null;
  zoneName: string | null;
  owningAgent: AgentKey;
  source: DataSource;
  status: AssetStatus;
  statusDetail: string;
  latest: Record<string, { value: number | null; text: string | null; ts: string; quality: Quality }>;
  utilization: number | null;
  oee: number | null;
  currentJob: string | null;
  lastDataAt: string | null;
  sourceError: string | null;
  limits: Record<string, SignalLimit>;
  idealCycleS: number | null;
}

// ---------- Templates ----------
export const STAGE_MODES = ["auto", "approve", "manual"] as const;
export const StageMode = z.enum(STAGE_MODES);
/** What a criterion measures. Absent on older specs: inferred from the label (yield, scrap, defects ppm, cycle time, OEE), else manual. */
export const CRITERION_KINDS = ["yield", "scrap_pct", "defects_ppm", "cycle_time", "oee", "signal", "manual"] as const;
export const CriterionKind = z.enum(CRITERION_KINDS);
export type CriterionKind = z.infer<typeof CriterionKind>;
export const CRITERION_KIND_LABEL: Record<CriterionKind, string> = {
  yield: "Yield %",
  scrap_pct: "Scrap %",
  defects_ppm: "Defects ppm",
  cycle_time: "Cycle time",
  oee: "OEE %",
  signal: "Measured signal",
  manual: "Confirmed by a person",
};
/** How a measured signal becomes one value over the stage window. `envelope` keeps both ends: min ≥ target and max ≤ targetMax. */
export const SIGNAL_AGGS = ["last", "min", "max", "mean", "envelope"] as const;
export const SignalAgg = z.enum(SIGNAL_AGGS);
export type SignalAgg = z.infer<typeof SignalAgg>;
export const SIGNAL_AGG_LABEL: Record<SignalAgg, string> = { last: "Final value", min: "Minimum", max: "Maximum", mean: "Mean", envelope: "Stays within" };
export const CRITERION_OPS = [">=", "<=", "=="] as const;
export const Criterion = z
  .object({
    label: z.string(),
    op: z.enum(CRITERION_OPS),
    target: z.number(),
    unit: z.string().default(""),
    abs: z.boolean().optional(),
    kind: CriterionKind.optional(),
    /** the telemetry signal a `signal` criterion reads on the stage's asset (the name as the asset reports it) */
    signal: z.string().regex(/^[\w.:-]{1,40}$/).optional(),
    /** default `last` */
    agg: SignalAgg.optional(),
    /** a range: `target` is the lower bound (op ≥) and this the upper */
    targetMax: z.number().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.kind === "signal" && !c.signal) ctx.addIssue({ code: "custom", message: "A measured-signal criterion names the signal it reads", path: ["signal"] });
    if (c.agg === "envelope" && c.targetMax === undefined) ctx.addIssue({ code: "custom", message: "A 'stays within' criterion needs an upper bound", path: ["targetMax"] });
    if (c.targetMax !== undefined) {
      if (c.op !== ">=") ctx.addIssue({ code: "custom", message: "A range uses ≥ for its lower bound", path: ["op"] });
      if (c.abs) ctx.addIssue({ code: "custom", message: "A range cannot be absolute", path: ["abs"] });
      if (c.targetMax < c.target) ctx.addIssue({ code: "custom", message: "The upper bound must be at least the lower bound", path: ["targetMax"] });
    }
  });
export type Criterion = z.infer<typeof Criterion>;
/** One criterion judged against what was measured. `actual`, `measured` and `measuredMax` carry the values: they stay on authenticated routes. */
export interface CriterionResult {
  label: string;
  kind: CriterionKind;
  signal?: string;
  agg?: SignalAgg;
  unit: string;
  /** the target as shown: "≥ 95 %", "35–39 °C" */
  target: string;
  actual: string | null;
  /** null: not measured; a person confirms it, it is never assumed to pass */
  ok: boolean | null;
  /** the acceptable region, for drawing; an open end is null */
  band: { lo: number | null; hi: number | null };
  /** how many samples the value came from (signal criteria) */
  n?: number;
  /** the number compared against the target (after `abs`): what a zero-knowledge proof of the result commits to */
  measured?: { value: number; op: Criterion["op"]; target: number };
  /** the upper half of a range (the window maximum for `envelope`): a second proof, under `label#max` */
  measuredMax?: { value: number; op: "<="; target: number };
}
export const StageSpec = z.object({
  code: z.string().regex(/^\d{2}[a-z]?$/),
  column: z.number().int().min(1),
  name: z.string().min(1).max(80),
  agent: AgentKey,
  resourceKind: AssetKind,
  mode: StageMode,
  escalationRole: RoleIn,
  timeoutMin: z.number().int().min(1).max(7 * 24 * 60),
  criteria: z.array(Criterion).default([]),
  /** work is done when the asset reports this signal with this value (a batch process's phase, e.g. execution = COMPLETE) instead of when the counts reach the quantity */
  completeOn: z.object({ signal: z.string().regex(/^[\w.:-]{1,40}$/), equals: z.string().trim().min(1).max(40) }).optional(),
});
export type StageSpec = z.infer<typeof StageSpec>;
export const TemplateSpec = z.object({
  stages: z.array(StageSpec).min(1).max(40),
  rework: z.object({ from: z.string(), to: z.string() }).nullable().default(null),
});
export type TemplateSpec = z.infer<typeof TemplateSpec>;

export interface TemplateView {
  id: string;
  key: string;
  name: string;
  category: string;
  description: string;
  origin: "library" | "custom";
  basedOn: string | null;
  version: number;
  versionId: string;
  spec: TemplateSpec;
  publishedAt: string;
  publishedBy: string | null;
}

// ---------- Runs ----------
export const STAGE_STATES = ["queued", "running", "awaiting_approval", "held", "done_deviation", "completed", "skipped"] as const;
export type StageState = (typeof STAGE_STATES)[number];
export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface StageRunView extends StageSpec {
  state: StageState;
  assetId: string | null;
  assetName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  unitsGood: number;
  unitsScrap: number;
  yieldPct: number | null;
  throughputPerHour: number | null;
  durationMin: number | null;
  progress: number;
  outcome: string | null;
  deviation: boolean;
  criteriaResults: CriterionResult[];
  decisions: number;
  gateItemId: string | null;
  /** why the stage waits on a person (no counter, manual mode, no asset registered) */
  waitingReason: string | null;
  reworkUnits: number;
  /** when the stage's work finished (the end of the window its signed reading covers) */
  workDoneAt: string | null;
}

export interface RunView {
  id: string;
  siteId: string;
  lineId: string | null;
  templateId: string;
  templateName: string;
  templateCategory: string;
  templateDescription: string;
  templateVersion: number;
  orderRef: string;
  quantity: number;
  status: RunStatus;
  startedBy: string | null;
  startedAt: string;
  dueAt: string | null;
  finishedAt: string | null;
  rework: { from: string; to: string } | null;
  stages: StageRunView[];
  metrics: {
    completed: number;
    total: number;
    rolledYield: number | null;
    throughputPerHour: number | null;
    eta: string | null;
    onTrack: boolean | null;
    decisions: number;
    escalated: number;
    gatesPending: number;
  };
}

// ---------- Decisions, inbox, incidents ----------
/** A criterion drawn as a band: the acceptable region and where the value fell (null when not measured) */
export interface CriterionBand {
  lo: number | null;
  hi: number | null;
  value: number | null;
  /** the upper value of an envelope (its minimum is `value`) */
  valueMax?: number | null;
  ok: boolean | null;
  unit: string;
}
export interface DecisionView {
  id: string;
  agent: string;
  kind: string;
  summary: string;
  reason: string | null;
  confidence: number | null;
  runId: string | null;
  stageCode: string | null;
  assetId: string | null;
  incidentId: string | null;
  modelId: string | null;
  ledgerSeq: number | null;
  ts: string;
  data: unknown;
}

export interface InboxOption {
  label: string;
  detail: string;
  action: ToolCall | { tool: "release_gate"; args: { runId: string; stageCode: string } } | { tool: "none"; args: Record<string, never> };
}
export interface InboxItemView {
  id: string;
  kind: "approval" | "exception";
  category: string;
  title: string;
  body: string;
  agent: string;
  severity: string | null;
  runId: string | null;
  stageCode: string | null;
  assetId: string | null;
  incidentId: string | null;
  metrics: { label: string; value: string; band?: CriterionBand }[];
  options: InboxOption[];
  recommended: number | null;
  confidence: number | null;
  requiredRole: Role;
  status: "pending" | "approved" | "rejected" | "expired";
  decidedBy: string | null;
  decidedOption: number | null;
  reason: string | null;
  signatureId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

// ---------- Healer tools: the only actions agents can propose ----------
export const ToolCall = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("hold_stage"), args: z.object({ runId: z.string(), stageCode: z.string(), reason: z.string().min(3) }) }),
  z.object({ tool: z.literal("reassign_stage"), args: z.object({ runId: z.string(), stageCode: z.string(), targetAssetId: z.string() }) }),
  z.object({
    tool: z.literal("open_work_order"),
    args: z.object({ assetId: z.string(), priority: z.enum(["low", "medium", "high"]), windowMinutes: z.number().int().min(0).max(7 * 24 * 60) }),
  }),
  z.object({ tool: z.literal("request_inspection"), args: z.object({ assetId: z.string(), sampleRatePct: z.number().min(1).max(100) }) }),
  z.object({ tool: z.literal("notify_operator"), args: z.object({ assetId: z.string(), instruction: z.string().min(5).max(300) }) }),
]);
export type ToolCall = z.infer<typeof ToolCall>;
export type ToolName = ToolCall["tool"];

export const Diagnosis = z.object({
  rootCause: z.string().min(10),
  evidence: z.array(z.object({ signal: z.string(), observation: z.string() })).min(1).max(5),
  confidence: z.number().min(0).max(1),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
export const Recommendation = z.object({
  actions: z.array(ToolCall).min(1).max(2),
  reason: z.string().min(10),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.object({ summary: z.string(), tradeoff: z.string() })).max(3),
});
export type Recommendation = z.infer<typeof Recommendation>;
export const ShiftSummary = z.object({ summary: z.string().min(10), citedSeqs: z.array(z.number().int().positive()) });
export type ShiftSummary = z.infer<typeof ShiftSummary>;

export interface Anomaly {
  assetId: string;
  signal: string;
  value: number;
  limit: number;
  level: "warn" | "alarm";
  kind: "threshold" | "drift";
  trendPerHour: number;
  minute: number;
}
export interface Forecast {
  assetId: string;
  signal: string;
  failureLimit: number;
  ttfHours: number | null;
  pFailure24h: number;
  confidence: number;
  modelId: string;
}

export type PolicyOutcome = "allow" | "require_approval" | "block";
export interface PolicyResult {
  outcome: PolicyOutcome;
  role?: Role;
  ruleIds: string[];
  explanation: string;
  policyVersion: number;
  policyHash: string;
}

// ---------- Validation ----------
export const PACKAGE_TYPES = ["stage_validation", "process_change", "pilot_validation", "proof_of_concept", "operational_qualification"] as const;
export const PackageType = z.enum(PACKAGE_TYPES);
export type PackageType = z.infer<typeof PackageType>;
export const PACKAGE_STEPS = ["draft", "precheck", "submitted", "qe_review", "approval", "released"] as const;
export type PackageStatus = "draft" | "in_review" | "changes_requested" | "rejected" | "released";

// ---------- Ledger / verify ----------
export interface LedgerEntryDto {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  subject: string | null;
  payload: unknown;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
}
export interface AnchorDto {
  id: number;
  kind: string;
  toSeq: number;
  entryHash: string;
  ref: string;
  url: string | null;
  ts: string;
}
