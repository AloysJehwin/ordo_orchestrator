# Ordo — review of the current plan and where to improve

Reviewed on 19 Oct 2026: `PRD.md`, `PLAN.md`, `TASKS.md`, `docs/*.md`, the prototype and mockups. Each finding says what is wrong, why it matters, and the fix. Fixes are applied in [technical-requirements.md](technical-requirements.md) (TRD) unless marked **Action**.

## A. Blockers — fix before writing code

| # | Finding | Why it matters | Fix |
| --- | --- | --- | --- |
| A1 | **Building before ETHGlobal removes partner-prize eligibility** unless the partner runs a Continuity track. | The USD 5k target is entirely partner prizes. | Keep all chain code in adapters written at the event; disclose prior work; **Action:** get a written answer from ETHGlobal by 24 Oct (TRD §2). |
| A2 | **Three documents describe three different systems.** PRD = Google Cloud (FastAPI, Pub/Sub, Dataflow, BigQuery, Firestore, Vertex). `architecture.md` = enterprise edge + Kafka, tech "undecided". ETHGlobal plan = TypeScript + Hedera/0G/ENS. | Two people will build two different things. | TRD is the single source of truth for the MVP; pointers added to the old docs (TRD §19). |
| A3 | **The PRD names retired models** (Gemini 1.5 Pro, 2.0 Flash). 2.0 shut down 1 Jun 2026; 1.5 is gone. | Day-one integration failure. | Pin a current Gemini Flash model in config; check the deprecations page before the demo (TRD §3.1, §16). |
| A4 | **Language not decided for the chain work.** PLAN backend is Python; Hedera Agent Kit v4, 0G SDKs and viem are TypeScript-first. | Two languages for two people in two weeks. | TypeScript monorepo recommended; **Action:** decide by 21 Oct (TRD §20). |
| A5 | **Google Cloud AI Builder Cup status unknown.** PRD is written for it; no deadline appears anywhere. | It may collide with ETHGlobal week or require GCP services we are dropping. | **Action:** confirm whether you are still entering and its deadline. |

## B. Product and spec inconsistencies

| # | Finding | Fix |
| --- | --- | --- |
| B1 | Autonomy levels have two sets of names: PRD "L2 Advisory / L3 Conditional", architecture "L2 Recommend / L3 Supervised". | Use L1 Assist, L2 Recommend, L3 Supervised, L4 Autonomous everywhere (TRD §8). |
| B2 | Two different policy matrices: PRD's by action type, architecture's by situation × level. Neither covers the other. | One merged, versioned policy file with a matrix test (TRD §8). |
| B3 | Two different lists of "8 agents". PRD: Inspector, Maintenance, Diagnosis, Healer, Compliance, Planning, Supply, Logistics. Architecture: Planning, Supply, Scheduler, Line, Process, Vision QA, Logistics, Maintenance (no Healer or Compliance). | MVP builds 5 agents named in TRD §7; the rest stay future work in `architecture.md`. |
| B4 | Dataset mismatch: PRD says NASA **bearing** data, PLAN/TASKS say NASA **C-MAPSS** (turbofan engines). | Use the NASA IMS bearing run-to-failure set; it matches the CNC bearing story (TRD §6). |
| B5 | Demo scenario contradicts itself: anomaly is on `LINE-02/CNC-05`, but the Healer reroutes `batch_id="R-2417"` (a run id) to `target="Line_02"` (the same line). Risk jumps between 22 % / 120 h and 84 % / 2 h. | One scripted scenario: bearing wear on CNC-05, reroute batch B-2417's remaining units to CNC-07, work order at the next window (TRD §1.1, §7). |
| B6 | "Downtime avoided: 45 mins" has no formula. Judges ask. | Defined calculation shown with its inputs (TRD §14). |
| B7 | `docs/data-model.md` has no **Incident** entity, though the whole MVP is an incident loop; no fields for prompt/model hashes or external anchors. | Added Incident, Approval, decision hashes, anchor refs (TRD §5). |
| B8 | Deployment URL `ordo-ai-warriors.run.app` is not a valid Cloud Run URL format (Cloud Run generates `<service>-<hash>-<region>.a.run.app`). | Map a custom domain or quote the real URL after the first deploy. |

## C. Safety, compliance and honesty

| # | Finding | Fix |
| --- | --- | --- |
| C1 | PRD's Compliance agent does "GxP **Auto-Sign-off**". Under 21 CFR Part 11 signatures must be by an identified person with re-authentication; an AI signing contradicts the PRD's own honesty section. | Agents prepare and record; only humans sign (TRD §5, ValidationPackage row). |
| C2 | PRD architecture layer claims "strict GxP, ISO-22000 and 21 CFR Part 11 validation evidence". ISO 22000 is food safety and irrelevant to CNC; "strict" overclaims. | Say "designed to support Part 11 / Annex 11 style records" as `security-compliance.md` already does. **Action:** edit PRD wording when touching it. |
| C3 | LLM output is trusted to drive actions; no schema validation, no tool allow-list, no check that cited numbers exist. | Structured output + zod validation + allow-listed tools + citation check + fallback to human (TRD §7). |
| C4 | Uploaded images and telemetry text go into prompts with no prompt-injection handling. | Treat as data, enforce output schema, never let LLM choose tools outside the list (TRD §13). |
| C5 | Sensor quality flags exist in architecture.md but the PRD flow ignores them, so a broken sensor could trigger a reroute. | `sensor_fault` scenario; quality ≠ good forces approval (TRD §6, §8). |

## D. Architecture and engineering

| # | Finding | Fix |
| --- | --- | --- |
| D1 | Pub/Sub → Dataflow → BigQuery for one simulated line: high setup risk, cost, no visible demo benefit (PLAN already lists it as a likely cut). | Drop. In-process event bus + Postgres (TRD §3). |
| D2 | Vertex AI custom training for a forecast that a trend model does as well on demo data; PLAN rates access as the #1 risk. | Calibrated trend + logistic model in `packages/domain`, versioned parameters (TRD §7). |
| D3 | Hash-chained ledger in Firestore without a single-writer rule: concurrent appends fork the chain. | Postgres advisory lock, single append path, concurrency test (TRD §9, §15). |
| D4 | Ledger anchoring was only a "design detail"; it is the strongest proof story we have and the natural Hedera integration. | Anchor adapter is core; local signed checkpoint now, HCS at the event (TRD §9, §10). |
| D5 | OpenAPI YAML hand-written first, then a mock server, blocks the frontend for days (TASKS: "Aloys is blocked until 1.3 lands"). | zod schemas in a shared package are the contract; OpenAPI generated from them; frontend imports types on day one (TRD §3.1). |
| D6 | No idempotency or expiry on actions; a double-click on Approve could execute twice. | Idempotency keys + action id/expiry (TRD §11). |
| D7 | WebSockets on Cloud Run need extra care; the app only needs server → browser updates. | SSE with reconnect and backfill (TRD §3, §12). |
| D8 | No offline/demo mode until late in the plan (TASKS 2.9). | Recorded mode exists from M2 and the e2e test runs in it (TRD §15, §18). |
| D9 | The prototype's runtime source is missing (PLAN §0), so none of its code is reusable. | Rebuild screens from mockups; re-implement tokens from `_ds/styles.css` (TRD §12). |

## E. Process

| # | Finding | Fix |
| --- | --- | --- |
| E1 | PLAN's Definition of Done (failing test first, review on every PR, 2–3 PRs/day cap, "no feature work for 3 days") is sound but sized for a longer project; we have 17 days. | Keep: tests for domain logic, review on every PR, e2e acceptance test. Drop: 3-day feature freeze, PR caps (TRD §15, §18). |
| E2 | No date-based milestones; tasks are in half-days with no calendar. | Dated milestones M0–M4 with exit tests (TRD §18). |
| E3 | The repo will become the app repo; the root still describes the prototype only. | **Action:** after the rename, rewrite the root README around the app once M0 lands. |
