# Product Requirement Document (PRD)

> **Note (19 Oct 2026):** the stack and timeline sections of this PRD are superseded by [docs/technical-requirements.md](docs/technical-requirements.md). Product intent, scope and guardrails still apply. Review: [docs/improvements.md](docs/improvements.md).

## Project Title

**Ordo** — Autonomous Self-Healing Manufacturing Orchestration Platform

## Hackathon Context

**Google Cloud AI Builder Cup 2026**

**Team:** AI Warriors

**Track:** Manufacturing — Intelligent Operations & Industrial Efficiency

**Target Deployment:** `[https://ordo-ai-warriors.run.app](https://ordo-ai-warriors.run.app)`

**Core Thesis:** Evolving industrial manufacturing from passive dashboard telemetry and manual intervention into a closed-loop multi-agent swarm that detects, predicts, simulates, auto-remediates, and validates physical line operations in real time.

---

## Executive Summary

Modern manufacturing environments (pharmaceutical, electronics, discrete assembly) are crippled by micro-stoppages and manual gate approvals. When operational parameters drift—such as bearing vibration spikes, temperature spikes, or vision quality defects—legacy SCADA/MES applications flag $▲$ out-of-target warnings, pause production, and await human engineering intervention.

**Ordo** addresses this bottleneck by bridging enterprise-grade validation workflows with an AI-assisted agent grid powered by **Google Cloud Vertex AI** and **Gemini 2.0/1.5 Pro**. When operational anomalies occur, Ordo’s specialized agents analyze sensor drift, forecast failure risk, suggest safe interventions, and generate an evidence-backed audit trail. The system is designed to reduce downtime, shorten manual investigation time, and provide a governed path from anomaly detection to corrective action while keeping human operators in the loop for high-risk decisions.

### Why this is the right scope for a hackathon

This project aims to demonstrate a clear and compelling operational loop rather than a fully autonomous factory control platform. The product is intentionally scoped around a single high-value use case: detecting a line anomaly, explaining the likely root cause, recommending a safe action, and recording the decision trail. This approach delivers a realistic demo path while staying technically achievable within a short hackathon timeline.

### Hackathon MVP Scope

The Minimum Viable Product for the challenge will center on the following user journey:

1. A simulated production line experiences a threshold breach or quality defect.
2. The system detects the issue using live telemetry and rules-based monitoring.
3. A predictive model estimates failure risk and time-to-failure.
4. Gemini explains the likely root cause in natural language.
5. The platform recommends a limited safe action such as rerouting a batch, slowing the line, or holding a gate.
6. The policy guard checks whether the action is low-risk or requires human approval.
7. The user approves, overrides, or rejects the action.
8. The system records the decision and produces an audit summary for operators or validators.

This flow is the core value proposition and the main story for the live demo.

### Product scope boundaries and trade-offs

To maximize competitiveness, Ordo will intentionally prioritize the following over broad platform ambition:

- Live anomaly detection and response workflow
- AI root cause analysis and recommendation engine
- Human-in-the-loop decision approval
- Audit/evidence ledger for governance and transparency
- Clear, responsive dashboard for operations teams

The following items are intentionally secondary for the hackathon and should be treated as stretch goals if delivery risk is low:

- Full enterprise ERP or MES integration
- Large-scale multi-plant orchestration
- Multi-line production optimization beyond a single demo line
- Exhaustive regulatory certification claims
- Full fleet logistics optimization at scale

### Safety, governance, and policy guardrails

A critical requirement for the platform is safe operation in industrial settings. Because manufacturing environments are sensitive to false positives and unsafe interventions, Ordo implements a policy guard that restricts autonomous behavior by risk level.

- L1: Assist — AI flags anomalies and suggests fixes; the operator executes the action.
- L2: Advisory — AI drafts recommended actions and shows approval logic; the user clicks to approve.
- L3: Conditional — AI can execute only low-risk, predefined workflows, and it immediately escalates if threshold confidence or risk is high.
- L4: Autonomous — Reserved for limited, highly constrained scenarios and only when the policy guard deems the action safe and traceable.

This approach reduces over-claiming and creates a more credible product story. It also makes the live demo safer and more realistic, especially when the judges ask how the system avoids harmful automation.

### Compliance framing

The PRD uses compliance terminology to signal enterprise relevance; however, the hackathon implementation is best framed as a regulatory-aware workflow and evidence-generation system rather than a fully compliant production system. The intent is to mirror how industrial quality and safety teams operate:

- evidence capture
- decision logging
- operator signoff
- traceable root cause explanation
- structured summary for audits and handoff

This preserves the strategic value of GxP-inspired governance while staying honest about the prototype context.

### Target users and user value

Primary users:

- Plant engineers responsible for line health and availability
- Operations managers monitoring throughput and quality risk
- Maintenance teams prioritizing interventions
- QA and compliance stakeholders reviewing evidence and handoff summaries

Primary value delivered:

- Faster anomaly detection and lower mean time to diagnosis
- Better prioritization of intervention decisions
- Reduced manual investigation and approval friction
- Increased confidence in recovery actions through recorded rationale
- Reduced production downtime from fast, guided action

### KPI and success measures

To make the project measurable and judge-friendly, Ordo will define success based on practical operational outcomes rather than abstract AI claims. Potential KPIs include:

- Time to detect line anomaly
- Time to root-cause diagnosis
- Downtime avoided during simulated incidents
- Percentage of low-risk actions executed without human intervention
- Percentage of actions requiring operator approval
- Confidence score and explanation quality for AI recommendations
- Audit trail completeness and traceability

These metrics will provide clear evidence of usefulness during the showcase and help turn the demo into a product story rather than a feature list.

### Core demo flow and event narrative

The primary live demonstration should follow a single, polished scenario:

1. A simulated line fault is injected into the operator dashboard.
2. The system recognises the threshold breach and highlights the affected machine.
3. The predictive maintenance module estimates imminent failure risk.
4. Gemini synthesizes a concise root-cause explanation using telemetry and quality signals.
5. The healer agent recommends a safe intervention such as rerouting a batch or slowing production.
6. The policy guard validates action safety and displays human approval requirements.
7. The operator approves or overrides the action.
8. The UI updates in real time to reflect the new machine state and downtime avoided.
9. The compliance ledger stores the evidence and creates a short shift summary.

This should be the central storyline of the demo video and product walk-through.

### Judge-facing demo story (2–3 minute narrative)

The demo should be narrated as follows:

> A production line begins drifting outside safe operating thresholds. Ordo detects the anomaly, predicts a likely equipment failure horizon, and explains the root cause in plain language. It recommends a low-risk intervention, checks the action against a policy guard, and asks the operator to approve or override. Once confirmed, the system updates the line state, documents the reasoning and evidence in an audit trail, and shows the impact in downtime avoided and production recovery.

This storyline is short, clear, and directly aligned with the value proposition. It also helps judges understand the impact quickly without needing to navigate the entire architecture.

### Out-of-scope items for this hackathon

The following are intentionally out of scope for the first implementation to keep the project feasible and high-impact:

- enterprise-wide MES deployment
- multi-plant fleet optimization
- large-scale supply chain orchestration
- formal certification or regulatory signoff beyond prototype workflows
- deep ERP system integration
- broad microservice platform complexity without direct demo benefit

### User personas and pain points

**Plant Engineer**
- Pain: limited visibility into line drift; manual triage of inspection alerts; delayed decisions during micro-stoppages.
- Need: a single operational view with root-cause explanation and recommended action.

**Maintenance Lead**
- Pain: cannot predict which machine is likely to fail next; manual review of noisy sensor streams.
- Need: risk forecasting and intervention prioritization with clear evidence.

**Operations Manager**
- Pain: downtime reduces throughput and schedule adherence; decisions often rely on fragmented dashboards.
- Need: a real-time advisory layer that reduces downtime and supports faster recovery.

**QA / Compliance Stakeholder**
- Pain: quality deviations and interventions are difficult to explain or audit after the fact.
- Need: traceable decisions and summarized evidence packages for shift handoff and review.

### Allowed vs blocked autonomous actions

To make the governance model explicit, the system should distinguish between actions that are safe to automate and actions that require operator review.

| Action Type | Risk Level | Auto-Execute? | Approval Required? |
| --- | --- | --- | --- |
| Slow line by 5–10% within predefined range | Low | Yes | No |
| Hold production gate for a single batch | Low to Medium | Yes, if within guardrail | Optional |
| Reroute a batch to alternate line | Medium | Conditional | Yes for high-priority or high-volume reroutes |
| Trigger machine maintenance work order | Medium | Conditional | Usually yes |
| Increase line speed beyond safe threshold | High | No | Yes |
| Unbounded process parameter change | High | No | Mandatory |

This explicit matrix helps show that the product is not just “AI doing random actions”; it is a policy-enabled operational assistant with safety boundaries.

### Realism, data, and simulation model

To remain credible and robust within a hackathon, the system will clearly distinguish between real implementation and simulated industrial context:

- Real: AI orchestration, telemetry processing, recommendation logic, dashboard interactions, policies, audit records
- Simulated: production line faults, machine health, batch flows, shop floor actions, some operational signals
- Mocked: ERP or MES datastores, extended supplier/inventory flows, broad fleet logistics

This level of transparency reduces over-claiming and gives the team space to focus on the most impactful demonstration rather than full production realism.

### Example anomaly payload (mock data)

```json
{
  "machine_id": "CNC-05",
  "line_id": "LINE-02",
  "timestamp": "2026-10-05T10:42:17Z",
  "sensor_readings": {
    "vibration": 8.7,
    "temperature": 88,
    "runtime_hours": 1840,
    "cycle_time_ms": 1800
  },
  "quality_signal": "minor surface deviation",
  "severity": "warning",
  "predicted_failure_time_hours": 12,
  "confidence": 0.82
}
```

This simplified example helps the team explain the data flow clearly during the demo and gives judges a concrete signal of what the system is analyzing.

### Risks and mitigations

#### 1. Scope creep
Risk: Too many features dilute implementation quality.
Mitigation: Keep the MVP focused on one or two line-failure scenarios with a polished end-to-end demo.

#### 2. Overstated autonomy
Risk: The project appears unrealistic or unsafe.
Mitigation: Present the system as AI-assisted decision support with explicit guardrails and human approvals.

#### 3. Compliance overclaiming
Risk: Regulatory language makes the product seem more mature than it is.
Mitigation: Frame compliance features as governance-ready artifacts and audit evidence generation rather than formal certification.

#### 4. Weak demo loop
Risk: AI outputs are not visible or compelling in a live setting.
Mitigation: Build a clear event-driven demo with visible KPI changes, recommended actions, and decision history.

#### 5. Technical complexity
Risk: Too many cloud services reduce reliability.
Mitigation: Use a lean architecture that supports a working frontend, backend, AI calls, and a visible event stream without unnecessary complexity.

### Feature prioritization for the hackathon

Must-have features:

- telemetry anomaly detection
- predictive risk estimation
- root cause explanation
- safe intervention recommendation
- human-in-the-loop approval flow
- audit log and shift summary
- real-time dashboard updates

Stretch features:

- multimodal defect analysis using uploaded images
- advanced batch rerouting logic
- richer compliance report generation
- natural-language pipeline builder

Future / not essential for hackathon core:

- full logistics optimization
- ERP/MES data synchronization
- plant-wide fleet scheduling
- end-to-end enterprise deployment maturity

---

## High-Level System Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       ORDO FRONTEND EXPERIENCE                                         │
│            React / JS Dashboard • Flow • Graph • Ledger • Floor & Fleet • Approvals Inbox              │
└───────────────────────────────────────────────────▲────────────────────────────────────────────────────┘
                                                    │ WebSockets / REST API
┌───────────────────────────────────────────────────┴────────────────────────────────────────────────────┐
│                                   GOOGLE CLOUD RUN BACKEND PLATFORM                                    │
│                                           (FastAPI / Python)                                           │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  ┌─────────────────────────────┐   ┌─────────────────────────────┐   ┌──────────────────────────────┐  │
│  │   Live Telemetry Pipeline   │   │  Judges' Fault Injector     │   │ Natural Language Builder     │  │
│  │ Pub/Sub ➔ Dataflow ➔ BQuery │   │  Simulate Anomaly Trigger   │   │ (Prompt-to-DAG Pipeline)     │  │
│  └──────────────┬──────────────┘   └──────────────┬──────────────┘   └──────────────┬───────────────┘  │
│                 │                                 │                                 │                  │
│                 └─────────────────────────┬───────┴─────────────────────────────────┘                  │
│                                           ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                 DOMAIN AGENT ORCHESTRATION GRID                                  │  │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                                                  │  │
│  │  1. INSPECTOR / LINE AGENT ──► Anomaly Detection ($▲$ target failure & sensor drift)             │  │
│  │  2. MAINTENANCE AGENT     ──► Vertex AI Time-Series Failure Forecasting (NASA Bearing Model)    │  │
│  │  3. DIAGNOSIS / PROCESS   ──► Gemini Multimodal & Natural Language Root Cause Analysis (RCA)   │  │
│  │  4. HEALER / SCHEDULER    ──► Gemini Tool Calling (`reroute_batch`, `adjust_line_speed`)        │  │
│  │  5. COMPLIANCE AGENT      ──► Auto-Summarization & GxP / 21 CFR Part 11 Digital Audit Ledger     │  │
│  │                                                                                                  │  │
│  └────────────────────────────────────────────────┬─────────────────────────────────────────────────┘  │
│                                                   │                                                    │
└───────────────────────────────────────────────────┼────────────────────────────────────────────────────┘
                                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       PERSISTENCE & ANALYTICS LAYER                                    │
│               Firestore (Live System State)  •  BigQuery (Telemetry & Audit Ledger)                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

```

---

## Core System Architecture Layers

1. **Shop Floor & Edge Layer (L1/L2):** Simulated OPC UA / MTConnect sensor feeds broadcasting vibration, thermal, cycle time, and vision telemetry.
2. **Data Pipeline & Telemetry Ingestion Layer:** Google Cloud Pub/Sub streaming telemetry through Apache Beam (Dataflow) into BigQuery time-series storage.
3. **Orchestration & Agent Core:** Deployed microservice on **Cloud Run** housing the domain agent swarm, model endpoints, and policy guard.
4. **Validation & Regulatory Layer:** Audit ledger maintaining strict GxP, ISO-22000, and 21 CFR Part 11 validation evidence with e-signature packages.
5. **Experience Surface:** React-based interactive console containing Flow, Graph, Ledger, Floor & Fleet, Approvals Inbox, and Pipeline Builder views.

---

## Domain Agents & AI Engine Specifications

Ordo operates through 8 domain-specific agents, with live Google Cloud AI integrations backing key roles:

```
                  ┌───────────────────────────────────────────────┐
                  │                 POLICY GUARD                  │
                  │   Autonomy Levels: L1 Assist ➔ L4 Autonomous  │
                  └───────────────────────┬───────────────────────┘
                                          │
       ┌──────────────────────────────────┼──────────────────────────────────┐
       │                                  │                                  │
┌──────▼────────┐                  ┌──────▼────────┐                  ┌──────▼────────┐
│ Line Agent    │                  │ Maint. Agent  │                  │ Process Agent │
│ Sensor Drift  │                  │ Vertex AI     │                  │ Gemini RCA &  │
│ & Detection   │                  │ Predictive    │                  │ Multimodal QA │
└──────┬────────┘                  └──────┬────────┘                  └──────┬────────┘
       │                                  │                                  │
       └──────────────────────────────────┼──────────────────────────────────┘
                                          │
                               ┌──────────▼──────────┐
                               │   Healer Agent      │
                               │ Gemini Function     │
                               │ Tool Execution      │
                               └──────────┬──────────┘
                                          │
                               ┌──────────▼──────────┐
                               │ Compliance Agent    │
                               │ Audit Log & GxP     │
                               │ Auto-Sign-off       │
                               └─────────────────────┘

```

| Agent Name | Primary Operational Responsibility | Backing AI Technology |
| --- | --- | --- |
| **Line & Inspector Agent** | Continuous telemetry monitoring & metric threshold enforcement | Rules Engine + Pub/Sub Streaming |
| **Maintenance Agent** | Time-series sensor analysis & failure horizon forecasting | **Vertex AI Time-Series Model** (NASA Bearing Dataset) |
| **Process & Diagnosis Agent** | Deep root-cause analysis, anomaly narration & visual defect triage | **Gemini 1.5 Pro / 2.0 Flash** (Multimodal Vision) |
| **Healer & Scheduler Agent** | Autonomous action execution, batch re-routing, line re-balancing | **Gemini Tool Calling / Function Execution** |
| **Compliance Agent** | GxP validation evidence generation & audit trail preservation | **Gemini Text Summarization** + Firestore Hash Ledger |
| **Planning Agent** | Order fulfillment tracking & material constraint alignment | Linear Optimization / Rules Engine |
| **Supply Agent** | Inventory reservation & raw material shortage flagging | Rules Engine + ERP Mock Connectors |
| **Logistics Agent** | AGV/AMR routing on the shop floor | Pathfinding Algorithms / Rules Engine |

---

## Detailed Functional Features & Gemini Integrations

### 1. Natural Language Pipeline Builder

* **User Intent:** Plant engineers describe production goals using natural language.
* **Implementation:** Gemini converts unstructured descriptions into structured pipeline JSON DAGs.
* **Example Input:** *"Create a discrete assembly line for motor brackets featuring a visual quality check after stage 2 and a thermal hold gate before packaging."*
* **Output:** JSON schema rendered into Ordo's Graph and Flow views.

```json
{
  "pipeline_id": "PIPE-EV-BRACKET-01",
  "name": "Discrete Bracket Assembly",
  "stages": [
    { "id": "ST-01", "name": "Raw Material Prep", "owning_agent": "Supply Agent" },
    { "id": "ST-02", "name": "CNC Machining", "owning_agent": "Line Agent" },
    { "id": "ST-03", "name": "Vision QA Inspection", "owning_agent": "Process Agent", "type": "gate" },
    { "id": "ST-04", "name": "Thermal Curing & Packaging", "owning_agent": "Maintenance Agent" }
  ]
}

```

### 2. Predictive Maintenance Engine (Vertex AI)

* **User Intent:** Predict equipment failure days before a catastrophic stoppage occurs.
* **Implementation:** FastAPI backend queries a Vertex AI endpoint trained on time-series bearing sensor data (vibration, heat, runtime).
* **Output:** Returns failure probability, expected time-to-failure (TTF), and confidence score.

### 3. Anomaly Narrator & RCA Generator

* **User Intent:** Human operators require immediate, natural-language explanations of complex sensor anomalies.
* **Implementation:** Sensor logs and metric variations are passed to Gemini 1.5/2.0 to synthesize a concise Root Cause Analysis (RCA).
* **Example Output:** *"Vibration on CNC-05 increased by 18% over 36 hours alongside an 8°C temperature rise on bearing 2. Predicted failure risk is 22% within 120 hours. Recommended action: Reroute 60 units to CNC-07."*

### 4. Multimodal Quality Triage

* **User Intent:** Inspectors upload thermal scans or visual photos of damaged components or worn line belts.
* **Implementation:** Gemini Vision checks the uploaded image against operational specs, flags surface cracks or belt wear, and sets the stage gate to `Held`.

### 5. Shift Handoff & Validation Summarizer

* **User Intent:** Plant managers need shift summaries and regulatory validation check packages.
* **Implementation:** Gemini processes raw audit ledger events from the past 8 hours to output a GxP-compliant shift handover summary and auto-filled validation check table.

---

## Policy Guard & Autonomy Levels

To ensure safe operation in high-risk manufacturing environments, Ordo implements a 4-tier policy guard:

```
[L1: ASSIST]      ──► AI flags anomalies and suggests fixes; human performs all actions.
[L2: ADVISORY]    ──► AI drafts execution packages; human provides single-click approval.
[L3: CONDITIONAL] ──► AI executes standard low-risk fixes autonomously; alerts human on high-risk breaches.
[L4: AUTONOMOUS]  ──► Full agent swarm execution with auto-generated audit ledger trails.

```

---

## Google Cloud Infrastructure & Mapping

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     GOOGLE CLOUD RUN PLATFORM                                  │
│  ┌───────────────────────────────┐  ┌───────────────────────────────┐  ┌────────────────────────────┐  │
│  │   FastAPI Web Microservice    │  │   Vertex AI SDK Integration   │  │  Google GenAI SDK (Gemini) │  │
│  └───────────────┬───────────────┘  └───────────────┬───────────────┘  └─────────────┬──────────────┘  │
└──────────────────┼──────────────────────────────────┼────────────────────────────────┼─────────────────┘
                   │                                  │                                │
┌──────────────────▼──────────────────────────────────▼────────────────────────────────▼─────────────────┐
│                                   GOOGLE CLOUD MANAGED SERVICES                                │
│  ┌───────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────────────┐  │
│  │  Cloud Pub/Sub            │  │  Cloud Dataflow           │  │  BigQuery                         │  │
│  │  (Live Sensor Telemetry)  │  │  (Apache Beam Stream ETL) │  │  (Time-series Telemetry Storage)  │  │
│  └───────────────────────────┘  └───────────────────────────┘  └───────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  ┌───────────────────────────────────┐  │
│  │  Cloud Firestore                                         │  │  Firebase Hosting                 │  │
│  │  (Real-Time Agent State & Pipeline DAG Store)            │  │  (Static Asset & React Production)│  │
│  └──────────────────────────────────────────────────────────┘  └───────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

```

---

## Key Scenarios for Live Hackathon Video Demo

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                DEMO SCENARIO 1: SELF-HEALING LOOP                               │
│                                                                                                 │
│  [User triggers "Simulate Overheat"] ➔ [Stage 3 metric breaches limit: ▲ 88°C]                 │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Maintenance Agent queries Vertex AI] ➔ [Failure risk: 84% in 2 hours]                         │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Gemini Healer Agent executes Tool] ➔ [`reroute_batch(batch_id="R-2417", target="Line_02")`]    │
│                                           │                                                     │
│                                           ▼                                                     │
│  [UI Updates Live in Real-time]      ➔ [Status: Self-Healed | Downtime Avoided: 45 Mins]        │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           DEMO SCENARIO 2: MULTIMODAL VISION CHECK                              │
│                                                                                                 │
│  [Operator uploads thermal image]    ➔ [Gemini Vision identifies micro-fissure on belt segment] │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Stage Gate status shifts]          ➔ [Status: Held Gate]                                      │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Approvals Inbox auto-populated]    ➔ [Compliance package generated with digital signature]    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

```

---

## 2-Week Implementation Sprint Plan

### Week 1: Core AI & Gemini Backend Integration

* **Day 1–2:** Build Python FastAPI backend on Cloud Run; integrate `google-genai` SDK with Gemini 1.5/2.0 Flash.
* **Day 3–4:** Implement Function Calling handlers (`reroute_batch`, `adjust_line_speed`) and natural language pipeline generation endpoints.
* **Day 5–7:** Train/deploy Vertex AI custom predictive maintenance endpoint using NASA bearing time-series data; wire to Firestore for real-time state sync.

### Week 2: Streaming Pipeline, UI Polish & Video Submission

* **Day 8–9:** Implement Pub/Sub $\rightarrow$ Dataflow $\rightarrow$ BigQuery telemetry streaming pipeline; hook up live sensor dashboards in React.
* **Day 10–11:** Integrate UI fault-injection controls; implement Gemini shift-handoff summarizer and GxP audit package generator.
* **Day 12–14:** Deploy production build to Cloud Run and Firebase Hosting (`[https://ordo-ai-warriors.run.app](https://ordo-ai-warriors.run.app)`); record 3-minute video walkthrough; publish open-source GitHub repository.

---