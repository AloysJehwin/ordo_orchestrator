export type {
  AgentKey,
  AnchorDto,
  AssetKind,
  AssetStatus,
  AssetView,
  AutonomyLevel,
  Criterion,
  CriterionBand,
  CriterionKind,
  CriterionResult,
  DataSource,
  DecisionView,
  InboxItemView,
  InboxOption,
  LedgerEntryDto,
  Outcome,
  OutcomeMedia,
  PackageType,
  Role,
  RunStatus,
  RunView,
  SignalAgg,
  SignalLimit,
  StageResource,
  StageMode,
  StageRunView,
  StageSpec,
  StageState,
  TemplateSpec,
  TemplateView,
} from "../../server/src/domain/types";
import type { AccessLevel, AccessScope, AgentKey, AutonomyLevel, CriterionResult, Outcome, OutcomeMedia, Role, StageMode } from "../../server/src/domain/types";
export type { AccessLevel, AccessScope };
export interface MyAccess {
  level: AccessLevel;
  scope: AccessScope;
  source: "manager" | "member" | "role";
}
export type StageModeT = typeof StageMode extends { options: readonly (infer X)[] } ? X : never;

export interface Me {
  user: { id: string; address: string; displayName: string | null; ens: string | null } | null;
  memberships: { siteId: string; siteName: string; roles: Role[] }[];
  canCreateSite: boolean;
}
export interface Site {
  id: string;
  name: string;
  timezone: string;
  publicPipelines: boolean;
  openJoin: boolean;
  lines: { id: string; name: string; autonomy: AutonomyLevel }[];
  zones: { id: string; name: string; sort: number }[];
  myRoles: Role[];
  myAccess: MyAccess;
}
export interface Meta {
  roles: { key: Role; label: string; info: string; defaultLevel: AccessLevel }[];
  levels: { level: AccessLevel; label: string }[];
  agents: { key: AgentKey; label: string; scope: string }[];
  assetKinds: { key: string; label: string }[];
  categories: string[];
  /** a run needs a machine on every stage (the server's STAGE_MACHINES) */
  machinesRequired?: boolean;
  packageTypes: string[];
}
export interface Status {
  rails: { rail: string; mode: string; live: boolean }[];
  warnings: string[];
  policy: { id: string; version: number; hash: string };
  build: { env: string; commit: string | null } | null;
  signatureChainId: number;
  restrictedSiteCreation: boolean;
  trust: TrustChainInfo | null;
}
export interface TrustChainInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  address: string;
  symbol: string;
  /** decimals of native value inside the contract (8 on Hedera, 18 elsewhere) */
  decimals: number;
  /** OrdoWorkOrders and OrdoPolicies on the same chain, when deployed */
  workOrders?: string | null;
  policies?: string | null;
}
export interface RelayView {
  kind: string;
  status: "pending" | "done" | "failed" | "waiting_site";
  txHash: string | null;
  txUrl: string | null;
  error: string | null;
}
export interface ChainStatus {
  configured: boolean;
  info?: { chainId: number; name: string; address: string; symbol: string; decimals: number; minStake: string; unstakeCooldownSeconds: number; relayer: string; explorerUrl: string | null } | { error: string };
  registered?: boolean;
  txHash?: string | null;
  txUrl?: string | null;
  registeredAt?: string | null;
}
export interface Staker {
  userId: string;
  address: string;
  name: string | null;
  roles: Role[];
  since: string;
  onchain: { stake: string; unlockAt: number; activeValidator: boolean; activeTester: boolean; payout: ScheduleView | null; bits: number; credentials: Role[] } | null;
}
export interface StakersView {
  stakers: Staker[];
  chain: ChainStatus;
  me: { validator: { ok: boolean; reason: string | null }; tester: { ok: boolean; reason: string | null } };
}
export interface VendorRow {
  id: string;
  address: string;
  company: string;
  categories: string;
  hourlyRate: string | null;
  responseMinutes: number | null;
  status: string;
  createdAt: string;
}
export interface OrdoSignatureTyped {
  /** version 2 names the contract that checks it (OrdoTrust), so it cannot be replayed on another deployment */
  domain: { name: "Ordo"; version: "1" | "2"; chainId: number; verifyingContract?: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrdoSignature";
  message: { action: string; entity: string; meaning: string; comment: string; site: string; nonce: string; issuedAt: string };
}
/** A release statement: names the lot, the content and the root of its stage proofs; no chain, so both release contracts check the same signature. */
export interface ReleaseTyped {
  domain: { name: "Ordo"; version: "2" };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrdoRelease";
  message: { site: string; packageId: string; runId: string; lot: string; meaning: string; statement: string; comment: string; contentHash: string; proofRoot: string; nonce: string; deadline: string };
}
/** A stage's counts as their source signs them: a commitment, never the counts. */
export interface ReadingTyped {
  domain: { name: "Ordo"; version: "2" };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrdoReading";
  message: { site: string; runId: string; stage: string; asset: string; commitment: string; anchor: string; signedAt: string };
}
export type TypedSignature = OrdoSignatureTyped | ReleaseTyped;
export interface AccessConfig {
  roles: { role: Role; level: AccessLevel; scope: AccessScope; fixed: boolean }[];
  members: { userId: string; level: AccessLevel; scope: AccessScope }[];
}
export interface OrgSummary {
  id: string;
  name: string;
  timezone: string;
  open: boolean;
  members: number;
  lines: number;
  running: number;
  member: boolean;
  createdAt: string;
}
export interface Team {
  members: { userId: string; address: string; name: string | null; ens: string | null; roles: Role[]; lastSeenAt: string | null }[];
  invites: { id: string; address: string; role: Role; createdAt: string }[];
  /** managers only */
  access: AccessConfig | null;
  /** managers only: the latest OrdoTrust relay of each person's role change, keyed `<userId>:<role>` */
  relays: Record<string, RelayView>;
}
export interface AgentRow {
  key: AgentKey;
  label: string;
  scope: string;
  autonomy: AutonomyLevel;
  assets: { id: string; name: string; status: string }[];
  currentTask: string | null;
  activeStages: number;
  decisionsToday: number;
  escalationsToday: number;
  avgConfidence: number | null;
  /** The agent's ERC-7857 iNFT on 0G, when configured */
  inft: {
    contract: string;
    tokenId: number | null;
    status: "pending" | "synced" | "failed";
    error: string | null;
    url: string | null;
    txUrl: string | null;
    data: { dataDescription: string; dataHash: string }[];
    authorizedUsers: string[];
  } | null;
  /** What it has learned, as encrypted versions on 0G Storage, sealed for this site and its licensees and named on its iNFT */
  memory: {
    version: number;
    cases: number;
    root: string;
    txUrl: string | null;
    dataHash: string;
    sealedFor: { siteId: string; name: string }[];
    onchain: boolean;
    at: string;
  } | null;
  /** How often people accepted what it recommended; proven agents can be licensed to other sites */
  record: TrackRecord;
  /** Agents of the same kind this site licenses from other sites (their playbooks feed this agent) */
  licensedFrom: { id: string; site: string; tokenId: number | null; tokenUrl: string | null; expiresAt: string | null }[];
}
export interface TrackRecord {
  recommended: number;
  decided: number;
  accepted: number;
  overridden: number;
  rate: number | null;
  proven: boolean;
}
export type LicenseStatus = "requested" | "declined" | "signed" | "active" | "revoking" | "revoked" | "expired" | "failed";
export interface AgentLicense {
  id: string;
  agent: AgentKey;
  agentLabel: string;
  licensor: { id: string; name: string };
  licensee: { id: string; name: string };
  tokenId: number | null;
  tokenUrl: string | null;
  status: LicenseStatus;
  days: number;
  expiresAt: string | null;
  termsHash: string | null;
  record: TrackRecord | null;
  cases: number;
  playbookSha256: string | null;
  storage: { root: string; url: string } | null;
  txUrl: string | null;
  error: string | null;
  requestedBy: string;
  grantedBy: string | null;
  createdAt: string;
}
export interface MarketAgent {
  site: { id: string; name: string };
  agent: AgentKey;
  label: string;
  scope: string;
  tokenId: number | null;
  tokenUrl: string | null;
  record: TrackRecord;
  license: AgentLicense | null;
}
export interface Incident {
  id: string;
  assetId: string;
  status: string;
  title: string;
  severity: string;
  openedAt: string;
  closedAt: string | null;
}
export interface PackageSummary {
  id: string;
  number: number;
  code: string;
  type: string;
  typeLabel: string;
  title: string;
  status: "draft" | "in_review" | "changes_requested" | "rejected" | "released";
  step: string;
  stepIndex: number;
  waitingOn: string | null;
  needsMe: boolean;
  owner: { address: string; name: string | null };
  runId: string | null;
  stageCode: string | null;
  checks: { total: number; done: number };
  updatedAt: string;
}
export interface PackageDetail extends Omit<PackageSummary, "owner" | "waitingOn" | "needsMe" | "checks"> {
  owner: { id: string; address: string; name: string | null };
  objective: string;
  acceptance: string;
  samplePlan: string;
  windowStart: string | null;
  windowEnd: string | null;
  templateId: string | null;
  assetId: string | null;
  outcome: string;
  returnedComment: string | null;
  assessment: { ranAt: string; agent: string; summary: string; figures: { label: string; value: string }[]; confidence: number | null } | null;
  checks: { id: string; criterion: string; method: string; target: string; source: string; result: string | null; actual: string | null; status: "pending" | "pass" | "fail"; auto: boolean; recordedBy: string | null; recordedAt: string | null }[];
  /** the linked stage's parameters as judged, so each automated check can be drawn against its band */
  parameters: CriterionResult[];
  evidence: { id: string; name: string; requirement: string; required: boolean; filename: string | null; mime: string | null; size: number | null; sha256: string | null; uploadedBy: string | null; uploadedAt: string | null; origin: string; version: number; removedAt: string | null; zeroG: { status: "pending" | "done" | "failed"; root: string | null; url: string | null; error: string | null } | null }[];
  chain: { meaning: string; label: string; role: Role; roleLabel: string; state: "signed" | "awaiting" | "pending" | "returned"; signer: { address: string; name: string | null } | null; signedAt: string | null; signature: string | null; comment: string | null }[];
  readiness: { ready: boolean; items: { label: string; ok: boolean }[] };
  audit: { seq: number; ts: string; actor: string; type: string; payload: Record<string, unknown>; entryHash: string }[];
  createdAt: string;
  onchain: RelayView | null;
}
export interface VerifyReport {
  ok: boolean;
  entries: number;
  headSeq: number;
  headHash: string | null;
  broken: { seq: number; ok: boolean; reason?: string }[];
  anchors: { id: number; kind: string; toSeq: number; entryHash: string; ref: string; url: string | null; ts: string; matchesChain: boolean; external: { ok: boolean; detail: string } }[];
  subject: { id: string; entries: { seq: number; ts: string; actor: string; type: string; entryHash: string; ok: boolean }[] } | null;
}
export type Mode = StageModeT;

// ---------------- Work orders: the maintenance agent pays vendors ----------------
export type WorkOrderStatus = "unassigned" | "assigned" | "escrowing" | "escrowed" | "escrow_failed" | "releasing" | "released" | "refunded";
export interface WorkOrderView {
  id: string;
  title: string;
  priority: string;
  assetId: string | null;
  runId: string | null;
  vendor: { id: string; company: string; address: string } | null;
  /** contract units (tinybars on Hedera) */
  amount: string | null;
  status: WorkOrderStatus;
  payer: string | null;
  escrow: { tx: string; url: string | null; expiresAt: string | null } | null;
  releasedBy: string | null;
  error: string | null;
  openedBy: string;
  createdAt: string;
  updatedAt: string;
  release: RelayView | null;
  /** The vibration assessment the agent bought over x402 */
  assessment: AssessmentView | null;
  /** The Hedera schedule that refunds the escrow if nobody releases it */
  refundSchedule: ScheduleView | null;
}
export interface AssessmentView {
  status: "pending" | "done" | "failed";
  error: string | null;
  skipped: string | null;
  assessment: { standard: string; zone: "A" | "B" | "C" | "D"; verdict: string; level: number; peak: number; slopePerHour: number; hoursToZoneD: number | null; samples: number } | null;
  payment: { transaction: string; url: string; payer: string | null; network: string } | null;
}
export interface WorkOrdersSetup {
  configured: boolean;
  contract: string | null;
  chainId: number | null;
  chainName: string | null;
  explorerUrl: string | null;
  symbol: string | null;
  decimals: number | null;
  agent: { address: string; via: string } | null;
  caps: { perOrder: string; perDay: string; setBy: string; updatedAt: string } | null;
  capsRelay: RelayView | null;
  siteRegistered: boolean;
  onchain: { funds: string; paused: boolean; perOrder: string; perDay: string; spentToday: string } | { error: string } | null;
}
export interface WorkOrdersResponse {
  setup: WorkOrdersSetup;
  items: WorkOrderView[];
}

// ---------------- Autonomy proposals: a manager signs ----------------
export interface AutonomyProposalView {
  id: string;
  lineId: string;
  lineName: string;
  from: AutonomyLevel;
  to: AutonomyLevel;
  version: number;
  comment: string;
  status: "open" | "applied" | "superseded";
  required: number;
  signers: { address: string; name: string | null; at: string }[];
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  onchain: RelayView | null;
}

/** The series behind a stage's measured parameters: a snapshot once its work is done, live telemetry before that. */
export interface StageSeriesView {
  window: { from: string; to: string } | null;
  live: boolean;
  signals: Record<string, { ts: number; value: number }[]>;
}

// ---------------- Lot passports ----------------
export type PassportStatus = "in_production" | "held" | "completed" | "aborted" | "shipped";
export interface PassportView {
  runId: string;
  status: PassportStatus;
  pageUrl: string;
  nft: { tokenId: string; serial: number | null; url: string | null; onchainStatus: string | null; mintTxUrl: string | null; error: string | null } | null;
  shipment: { to: string; at: string; txUrl: string | null; pending: boolean | null } | null;
  /** the lot's own ENS name, and its releases recorded there against the signers' ENS credentials */
  ens?: { name: string; url: string; releases: { packageId: string; status: "pending" | "done" | "failed"; txUrl: string | null; error: string | null }[] } | null;
}
export interface SpecProof {
  status: "proven" | "pending" | "failed";
  /** who committed to the measured value: the instrument's gateway, the operator, or Ordo's server */
  signer: string | null;
  signerKind: "device" | "operator" | "ordo";
  signerEns?: string | null;
  /** the signed OrdoMeasurement when the source committed, so its signer can be recovered here */
  measurement: { site: string; runId: string; stage: string; asset: string; criterion: string; commitment: string; anchor: string; signedAt: string; signature: string } | null;
  system: "groth16-bn254";
  circuit: "spec_check";
  /** [subject, target × 10⁴, op, commitment] */
  publicSignals: string[] | null;
  proof: unknown;
  ledgerSeq: number | null;
  verified: boolean | null;
  detail: string;
}
/** A stage's counts signed at their source (its machine's gateway, or the operator), and the zero-knowledge proof they meet its criteria. */
export interface StageWork {
  stage: string;
  signer: string;
  signerKind: "device" | "operator";
  signerEns: string | null;
  matches: boolean;
  commitment: string;
  anchor: string;
  signedAt: string;
  status: "proven" | "pending" | "failed" | "not_met";
  criteria: string[];
  system: "groth16-bn254";
  circuit: "stage_check";
  publicSignals: string[] | null;
  proof: unknown;
  verified: boolean | null;
  detail: string;
  reading: { site: string; runId: string; stage: string; asset: string; commitment: string; anchor: string; signedAt: string; signature: string };
}
export interface PublicPassport {
  name: string;
  creator: string;
  description: string;
  properties: { runId: string; status: PassportStatus; orderRef: string; quantity: number; product: string };
  passport: PassportView & {
    site: string | null;
    orderRef: string;
    quantity: number;
    product: { name: string; category: string; version: number };
    startedAt: string;
    finishedAt: string | null;
    stages: {
      code: string;
      name: string;
      state: string;
      mode: string;
      resource: string;
      startedAt: string | null;
      endedAt: string | null;
      /** whether each criterion was met and its acceptable band; the measurement stays private, with a zero-knowledge proof where it was met (a range proves its upper bound separately) */
      criteria: { label: string; target: string; ok: boolean | null; band: { lo: number | null; hi: number | null }; unit: string; zk: SpecProof | null; zkMax: SpecProof | null }[];
      deviation: boolean;
      /** proof of work: who signed the stage's counts where they were made, and the proof they meet its criteria */
      work: StageWork | null;
    }[];
    signed: { kind: string; summary: string; stageCode: string | null; by: string; ens: string | null; at: string; ledgerSeq: number | null }[];
    agentDecisions: number;
    releases: {
      id: string;
      number: number;
      type: string;
      title: string;
      releasedAt: string;
      signers: { meaning: string; address: string; ens: string | null; stake: { amount: string; active: boolean; symbol: string; decimals: number } | null }[];
      onchain: { txUrl: string | null; contract: string | null } | null;
      /** what the three signed: the lot, the content hash and the root of its stage proofs */
      statement: { lot: string; contentHash: string; proofRoot: string; stagesProven: string[] } | null;
    }[];
    proof: {
      chainIntact: boolean;
      headSeq: number;
      entries: number;
      lastSeq: number;
      anchor: { kind: string; ref: string; url: string | null; toSeq: number; at: string; matchesChain: boolean; external: { ok: boolean; detail: string } } | null;
      checkedAt: string;
    };
  };
}

// ---------------- ENS names (ENSv2 on Sepolia) ----------------
export interface EnsNameView {
  kind: "site" | "person" | "asset" | "agent" | "device";
  ref: string;
  name: string;
  status: "pending" | "issued" | "revoked" | "failed";
  error: string | null;
  url: string;
  txUrl: string | null;
  records: Record<string, string>;
}
export interface EnsNamesResponse {
  live: boolean;
  parent: string | null;
  items: EnsNameView[];
}

// ---------- Public pipelines (no sign-in) ----------
export interface OpenRole {
  role: Role;
  label: string;
  why: string[];
  holders: number;
}
export interface PublicPipeline {
  siteId: string;
  site: string;
  runId: string;
  pipeline: { name: string; category: string; description: string; version: number };
  status: string;
  quantity: number;
  startedAt: string;
  dueAt: string | null;
  metrics: { completed: number; total: number; gatesPending: number; rolledYield: number | null; onTrack: boolean | null };
  stages: { code: string; column: number; name: string; state: string; mode: string; agent: string; resource: string; gateRole: string; progress: number }[];
  roles: OpenRole[];
  validation?: { ref: string; type: string; status: string; stageCode: string | null; waitingFor: { meaning: string; label: string; role: string; roleLabel: string } | null }[];
}

/** A deadline Hedera's Schedule Service runs on its own */
export interface ScheduleView {
  kind: "workorder.refund" | "stake.withdraw" | "stage.timeout";
  status: "scheduled" | "executed" | "cancelled" | "failed" | "skipped";
  executeAt: string;
  scheduleId: string | null;
  url: string | null;
  executedAt: string | null;
  error: string | null;
}

// ---------------- Machine wallets: machines that pay for themselves over x402 ----------------
export interface MachinePurchase {
  id: string;
  kind: "assessment" | "callout";
  seller: string;
  amount: string | null;
  txId: string | null;
  txUrl: string | null;
  auditTx: string | null;
  incidentId: string | null;
  result: Record<string, unknown> | null;
  at: string;
}
export interface MachineWallet {
  assetId: string;
  status: "opening" | "active" | "paused" | "failed";
  accountId: string | null;
  accountUrl: string | null;
  evmAddress: string | null;
  dailyBudget: string;
  perCall: string;
  balance: string | null;
  lastTopUpAt: string | null;
  error: string | null;
  purchases: MachinePurchase[];
}

// ---------------- Pay on proof ----------------
export type PartyKind = "plant" | "customer" | "financier";
export interface FinanceParty {
  id: string;
  kind: PartyKind;
  name: string;
  status: "opening" | "active" | "failed";
  accountId: string | null;
  accountUrl: string | null;
  address: string | null;
  balance: string | null;
  error: string | null;
}
export interface FinanceOrder {
  id: string;
  packageId: string;
  packageTitle: string;
  packageStatus: string;
  runId: string | null;
  customer: { id: string; name: string };
  payee: { id: string; name: string; kind: PartyKind };
  amount: string;
  ask: string | null;
  expiresAt: string;
  status: "funding" | "open" | "paid" | "refunded" | "failed";
  holdId: string | null;
  key: string | null;
  txs: { kind: string; hash: string; url: string | null; at: string }[];
  note: string | null;
  error: string | null;
  createdAt: string;
}
export interface FinanceResponse {
  live: boolean;
  coin: { symbol: string; decimals: number; address: string; token: string; contract: string; studio: string } | null;
  parties: FinanceParty[];
  orders: FinanceOrder[];
}

// ---------------- Proof of work through 0G Private Computer ----------------
export type ContributionStatus = "unsigned" | "signed" | "selected" | "not_selected" | "withdrawn";
export type TrustMode = "private" | "verified" | "standard";
/** What each 0G trust mode means: only private is a TEE */
export const TRUST_TEXT: Record<TrustMode, string> = {
  private: "private mode (TEE providers only)",
  verified: "verified mode (verifiable providers, not a TEE)",
  standard: "standard routing (not a TEE)",
};
export interface TeeSummary {
  network: string;
  /** absent on records from before trust modes, which were all private */
  trustMode?: TrustMode;
  model: string;
  turns: number;
  verified: number;
  failed: number;
  providers: string[];
  allVerified: boolean;
}
export interface ContributionView {
  id: string;
  siteId: string;
  runId: string;
  stageCode: string;
  contributor: { userId: string; address: string; name: string | null };
  status: ContributionStatus;
  createdAt: string;
  signedAt: string | null;
  recordSha256: string;
  /** values only at level 3 and up, and to their author */
  measurements: { criterion: string; unit: string; commitment: string; subject: string; value?: number; note?: string }[];
  evidence: { name: string; sha256: string; size: number; mediaType?: string; analyzedBy?: { model: string; requestId?: string | null; kind?: "vision" | "transcription" } | null }[];
  /** the machine media the record binds, one per outcome; verdicts from level 3 (absent on records made before outcomes) */
  outcomes?: ContributionOutcome[];
  tee: TeeSummary;
  ledgerSeq: number | null;
  signatureId: string | null;
  replica: { status: "pending" | "done" | "failed"; root: string | null; url: string | null; error: string | null } | null;
  selection: { by: string; byName: string | null; at: string; comment: string | null } | null;
  summary?: string;
  notes?: { text: string; at: string }[];
  /** level 3: how many outcomes the contributor disputed */
  disputes?: number;
  voiceNotes?: VoiceNote[];
  machineQa?: MachineAnswer[];
}
export interface PowStart {
  sessionId: string;
  expiresAt: string;
  token: string;
  command: string;
  router: { network: string; model: string; trustMode?: TrustMode };
}
export interface PowSession {
  id: string;
  runId: string;
  stageCode: string;
  status: "open" | "submitted" | "signed" | "expired" | "cancelled";
  expiresAt: string;
  contributionId: string | null;
  createdAt: string;
}
export interface PublicContribution extends ContributionView {
  site: string;
  orderRef: string;
  receipts: { at: string; provider: string | null; model: string | null; resKey: string | null; requestId: string | null; teeVerified: boolean | null; requestSha256: string; responseSha256: string; kind?: "chat" | "transcription" }[];
  signature: { signature: string; typed: unknown } | null;
}

/** An org's rewards and slashing parameters (OrdoTrust v3 holds them; amounts in contract units) */
export interface RewardSettings {
  reward: string;
  fee: string;
  challengeWindow: number;
  responseWindow: number;
  defaultSlashBps: number;
  maxSlashBps: number;
  bountyBps: number;
  falseClaimBps: number;
}
export interface OnchainAcceptance {
  contributor: string;
  validator: string;
  reward: string;
  fee: string;
  vestAt: number;
  frozen: boolean;
  settled: boolean;
}
export interface AcceptanceView {
  contributionId: string;
  runId: string;
  stageCode: string;
  contributor: { address: string; name: string | null };
  validator: { address: string; name: string | null };
  selectedAt: string;
  onchain: OnchainAcceptance | null;
  relay: RelayView | null;
  openCase: string | null;
}
export interface RewardsView {
  configured: boolean;
  v3: boolean;
  symbol: string;
  decimals: number;
  settings: RewardSettings;
  settingsOnchain: boolean;
  pool: string | null;
  claimable: string | null;
  acceptances: AcceptanceView[];
}
export type CaseStatus = "open" | "responded" | "upheld" | "rejected";
export interface CaseView {
  id: string;
  contributionId: string;
  runId: string;
  stageCode: string;
  tester: { address: string; name: string | null };
  validator: { address: string; name: string | null };
  bps: number;
  evidence: string;
  evidenceHash: string;
  response: string | null;
  responseHash: string | null;
  status: CaseStatus;
  respondBy: string;
  createdAt: string;
  respondedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  chain: { open: RelayView | null; respond: RelayView | null; decide: RelayView | null };
  can: { respond: boolean; decide: boolean; readRecord: boolean };
}
export interface CaseCandidate {
  contributionId: string;
  runId: string;
  orderRef: string;
  stageCode: string;
  stageName: string;
  stageState: string | null;
  contributor: { address: string; name: string | null };
  validator: { address: string; name: string | null };
  selectedAt: string;
  wentWrong: string[];
  openCase: string | null;
}
/** The sealed record a contributor's terminal agent wrote: the manager's, and a tester's while their case is open */
export interface SealedRecordView {
  summary: string;
  measurements: { criterion: string; value: number; unit?: string; note?: string }[];
  notes: { text: string; at: string }[];
  evidence: { name: string; sha256: string; size: number }[];
  transcript: { role: string; content: string; at: string }[];
}

/** One outcome of a stage and what its machine captured for it: level 2 sees whether it met its target, level 3 the media. */
export interface OutcomeView {
  key: string;
  label: string;
  media: OutcomeMedia;
  mediaLabel: string;
  instrument: string;
  required: boolean;
  metric: Outcome["metric"];
  ok: boolean | null;
  captured: boolean;
  capturedAt: string | null;
  output: {
    id: string;
    version: number;
    versions: number;
    mime: string;
    size: number;
    sha256: string;
    hasPreview: boolean;
    value: number;
    device: string;
    signature: string;
    ledgerSeq: number | null;
    analysis: { summary: string; value?: number; anomaly?: string; requestId?: string; model?: string; provider?: string; teeVerified?: boolean } | null;
    replica: { status: string; root: string | null; url: string | null } | null;
  } | null;
}

// ---------- Stage resources: vendors' offers, purchases over x402 (server core/resources.ts) ----------
/** A vendor's offer of a stage resource: a kind, a SKU and a price in HBAR per unit */
export interface OfferView {
  id: string;
  vendorId: string;
  vendor: string;
  kind: string;
  sku: string;
  label: string;
  unit: string;
  price: string;
  priceTinybar: string;
  leadMin: number;
  createdAt: string;
  archivedAt: string | null;
}
export interface SupplierView {
  id: string;
  company: string;
  status: string;
  demo: boolean;
  /** the Hedera account sales are paid to; null: its offers cannot be bought */
  payTo: string | null;
  offers: OfferView[];
}
export interface ResourcePurchaseView {
  id: string;
  runId: string | null;
  stage: string | null;
  resource: string | null;
  kind: string;
  qty: number;
  unit: string;
  amount: string;
  amountTinybar: string;
  vendorId: string;
  vendor: string;
  sku: string;
  buyer: string | null;
  byAsset: string | null;
  byAssetName: string | null;
  status: "pending" | "delivered" | "expired";
  arrived: boolean;
  txId: string | null;
  txUrl: string | null;
  auditTx: string | null;
  auditUrl: string | null;
  at: string;
  deliveredAt: string | null;
}
export interface StageResourceView extends StageResourceT {
  need: number;
  delivered: number;
  pending: number;
  remaining: number;
  status: "delivered" | "partial" | "waiting" | "waived";
  /** approvedTinybar: above the stage's max price, the most an executed top-up approved for it */
  bestOffer: (OfferView & { withinMax: boolean; amountTinybar: string; approvedTinybar?: string | null }) | null;
  purchases: ResourcePurchaseView[];
}
export interface StageResourcesView {
  runId: string;
  stage: string;
  quantity: number;
  state: string;
  waived: { by: string; reason: string; at: string; signatureId: string } | null;
  resources: StageResourceView[];
  /** below level 4 the offers and purchases are left out */
  redacted: boolean;
}
type StageResourceT = import("../../server/src/domain/types").StageResource;

/** One outcome as a proof of work binds it: the machine's file the contributor reviewed, and their verdict (level 3). */
export interface ContributionOutcome {
  outcome: string;
  label: string;
  media: OutcomeMedia;
  sha256: string | null;
  version: number | null;
  verdict?: "confirm" | "dispute" | "unsure" | null;
  observed?: number | null;
  note?: string;
  machineValue?: number | null;
}
/** A voice note the contributor let 0G transcribe (whisper), kept in the sealed record. */
export interface VoiceNote {
  name: string;
  sha256: string;
  size?: number;
  mediaType?: string;
  transcript: string;
  model: string;
  requestId: string | null;
  at: string;
}
/** A question the interviewer asked the stage's machine, and its answer, as Ordo relayed it. */
export interface MachineAnswer {
  question: string;
  answer: string;
  requestId: string | null;
  model: string | null;
  at: string;
}
// ---------------- Org treasury: machine budgets (OrdoTreasury on Hedera) ----------------
export type BudgetStatus = "pending" | "approving" | "executed" | "expired" | "declined" | "failed" | "skipped";
/** A machine account a budget pays, in tinybars */
export interface BudgetCredit {
  accountId: string;
  amount: string;
  assetId: string;
  assetName: string;
  stages: string[];
}
export interface BudgetLine {
  stage: string;
  buyer: string;
  resource: string;
  label: string;
  qty: number;
  unit: string;
  maxPrice: number;
  tinybars: string;
  funded: boolean;
  reason?: "price_above_max" | "balance_short";
  detail?: string;
  vendorId?: string;
  sku?: string;
  priceTinybar?: string;
}
/** A run's budget or a machine's top-up: one scheduled transfer from the org's treasury that a manager approves */
export interface BudgetSchedule {
  id: string;
  kind: "run" | "topup";
  runId: string;
  orderRef: string | null;
  templateName: string | null;
  stageCode: string | null;
  resource: string | null;
  status: BudgetStatus;
  treasuryAccount: string;
  credits: BudgetCredit[];
  lines: BudgetLine[];
  total: string;
  budgetHash: string;
  entity: string | null;
  memo: string;
  scheduleId: string | null;
  scheduleUrl: string | null;
  txUrl: string | null;
  expiresAt: string;
  error: string | null;
  reasoning: string | null;
  requestId: string | null;
  valueAtRisk: string | null;
  device: string | null;
  assetId: string | null;
  hcs: { topicId: string; sequence: string; txId: string; url: string } | null;
  inboxItemId: string | null;
  approvedBy: string | null;
  approveTxUrl: string | null;
  executedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  heldAt: string | null;
  createdAt: string;
}
export interface TreasuryInfo {
  contract: string;
  contractUrl: string;
  keyAddress: string;
  keyContractId: string;
  keyUrl: string;
  accountId: string;
  accountUrl: string;
  balance: string | null;
  openedAt: string;
}
export interface BudgetsResponse {
  configured: boolean;
  note: string | null;
  contract: string | null;
  registered: boolean;
  treasury: TreasuryInfo | null;
  budgets: BudgetSchedule[];
  topups: BudgetSchedule[];
}
/** A virtual machine: an asset run by its own body (a process or microVM) with its own agent. Floor and the builder. */
import type { AssetKind as VmKind } from "../../server/src/domain/types";
export type BodyState = "stopped" | "starting" | "running" | "sleeping" | "safe_stopped" | "failed";
export interface MachineBody {
  assetId: string;
  name: string;
  kind: VmKind;
  zoneId: string | null;
  device: string;
  runtime: "local" | "sandbox";
  state: BodyState;
  heartbeatAt: string | null;
  brain: "0g" | "none";
  sandboxId: string | null;
  error: string | null;
  episodeRoot: string | null;
  seed: string;
  autoStart: boolean;
  startedAt: string | null;
  createdAt: string;
  alive: boolean | null;
  account: string | null;
  episode: { sha256: string; at: string; entries: number; decisions: number; final: boolean; replica: { status: string; root: string | null; url: string | null } | null } | null;
}
export interface MachinesView {
  /** where bodies run; null when BODY_RUNTIME is off and virtual machines do not run */
  runtime: "local" | "sandbox" | null;
  brain: "0g" | "none";
  /** the 0G Router's trust mode: only private is a TEE */
  trustMode?: TrustMode;
  bodies: MachineBody[];
}
export interface BodyAnswer {
  answer: string;
  requestId: string | null;
  model: string | null;
}
