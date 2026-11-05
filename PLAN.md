# Ordo — Build Plan (2 people)

> **Note (19 Oct 2026):** phases 0–3 and the stack below are superseded by [docs/technical-requirements.md](docs/technical-requirements.md) §18 (dated milestones). Ground rules and ownership ideas still apply.

Stack decision: **PRD.md as written** (FastAPI + Gemini + Vertex AI + Pub/Sub/Dataflow/BigQuery + Firestore + Cloud Run, Next.js frontend).
Git model: **branch per task + PR, strict file ownership**.

---

## 0. Read this first — ground reality

There is currently **no application code**. The repo contains:

- 3 prototype `.dc.html` files (`Ordo Orchestrator.dc.html` is 1228 lines of a custom declarative format with a **vendored runtime whose source is missing** — it cannot be rebuilt or tested). Treat it as a **design spec**, not a codebase.
- 10 markdown specs in `docs/`
- `PRD.md`, which conflicts with `docs/architecture.md` §16 (tech "undecided") and §17 ("not a running system"). **Phase 4.3 resolves this.**

Because of that, every task below creates something new. Nothing can be "reused", only re-specified.

---

## 1. Ground rules (these are what actually prevent merge conflicts)

1. **`main` is always deployable and green.** Never commit directly to `main`.
2. **One branch per task.** Name: `t<id>/<slug>` e.g. `t2.3/gemini-rca`.
3. **PR required, other person must approve.** No self-merge.
4. **Never edit a file you don't own** (map below). If you need a change there, ask — don't just edit it.
5. **The OpenAPI spec has exactly one owner.** It is the only shared source of truth. Nobody hand-edits generated types.
6. **No ad-hoc formatting.** Pre-commit hooks run on every commit. Never bypass with `--no-verify`.
7. **Rebase `main` into your branch daily** (or before opening a PR), never merge `main` into a long-lived branch.
8. **Add `.gitignore` before anyone runs `npm install`.** This is the single highest-value 10 minutes in the plan.
9. **One task = one PR = one concern.** No drive-by refactors in someone else's file.
10. **Test or it didn't happen.** Every task ships a command that fails without the change.

### Definition of Done (applies to every single task)

A task is done only when **all** are true:

- [ ] A test exists that **fails** without the change and **passes** with it
- [ ] The full local test suite passes (`make test`, see §3)
- [ ] Lint + typecheck pass
- [ ] PR opened, other person approved and merged
- [ ] Task's "Verify" command from the task table below was run by the author and pasted into the PR description

---

## 2. File ownership map (the conflict-avoidance mechanism)

Zero file overlap by construction. This is the whole trick.

```
Srushti  — BACKEND / INFRA track
  backend/**                 FastAPI app, all Python
  backend/tests/**
  backend/scripts/**         smoke tests, seeding, training
  infra/dataflow/**          Beam pipelines
  infra/bigquery/**          schemas, DDL
  infra/vertex/**            training + endpoint config
  openapi/ordo.yaml          ← SOLE owner. The contract. Nobody else edits this.
  scripts/gcp/**             project setup, deploy

Aloys    — FRONTEND track
  web/**                     Next.js app, all TS/TSX/CSS
  web/tests/**
  web/e2e/**                 Playwright
  docs/ui/**                 new UI-facing notes only

BOTH (paired, scheduled — see §6)
  Makefile                   root commands
  .github/workflows/**       rotate owner weekly
  README.md                  append-only, own section each
  docs/architecture.md       only during Phase 4.3 reconciliation
```

**Conflict hot spots to watch, and the fix if one appears anyway:**

| Hot spot | Why | Fix |
|---|---|---|
| `Makefile` | both need to add a target | add `make test-<x>` namespaced, never edit existing lines |
| `openapi/ordo.yaml` | everyone depends on it | single owner; consumers raise a PR comment, owner edits |
| root `README.md` | natural place to both write | each owns a `## ` section |
| `.github/workflows/**` | both add jobs | separate files: `backend.yml`, `frontend.yml` |
| `package-lock.json` / lockfiles | classic silent conflict | **never** committed by the non-owner; if you must, announce it in standup |

---

## 3. Repo commands (created in Task 0.1 — both use these, neither edits them)

```
make setup          # one-time bootstrap for a fresh clone
make test           # runs backend + frontend + contract tests  (the gate for every PR)
make test-backend   # pytest
make test-frontend  # vitest
make test-e2e       # playwright (against local stack)
make test-contract  # validates live API responses against openapi/ordo.yaml
make lint
make typecheck
make demo           # runs the 9-step demo flow locally, end to end
make deploy
```

---

## 4. Task board

Legend — **Owner**: `BE` = Srushti, `FE` = Aloys, **BOTH** = pair session.
Estimates in half-days (HD). HD × 8 = 4h.

### Phase 0 — Foundations · must complete before anything else

| ID | Owner | Task | Deliverable | Verify (testable) | Est |
|---|---|---|---|---|---|
| 0.1 | BOTH | Repo hygiene | `.gitignore`, `.gitattributes`, `.editorconfig`, `Makefile`, `CONTRIBUTING.md` (ground rules above), branch protection on `main` | `make setup && make test` runs on both machines, green; a deliberately-committed `node_modules/` is ignored | 0.5 |
| 0.2 | BE | Python env | `backend/pyproject.toml` (pinned), venv on **Python 3.11+**, `backend/app/main.py` returning `/health`, ruff + mypy configured | `curl localhost:8000/health` → `200 {"status":"ok"}`; `make test-backend` has ≥1 passing test | 0.5 |
| 0.3 | FE | Next.js scaffold | `web/` on Next.js + TS strict, Tailwind, vitest, RTL, Playwright, eslint, prettier, pre-commit | `npm run dev` renders; `make test-frontend` green; Playwright smoke passes | 0.5 |
| 0.4 | BE | **GCP project + API enablement** ⚠️ | `scripts/gcp/setup.sh`: create project, enable billing, enable Vertex AI / Pub/Sub / Dataflow / BigQuery / Firestore / Cloud Run / Artifact Registry, request Gemini access, create service account | `bash scripts/gcp/setup.sh --verify` prints `ALL APIS ENABLED` | 1.0 |
| 0.5 | BE | **Gemini go/no-go gate** ⚠️ | `backend/scripts/gemini_smoke.py` — one real Gemini call, prints response | `python -m backend.scripts.gemini_smoke` exits 0. **If this fails, STOP and resolve before all other work.** | 0.5 |
| 0.6 | BE | Vertex access probe | `backend/scripts/vertex_probe.py` — trains a trivial model, gets an endpoint, calls it | `python -m backend.scripts.vertex_probe` exits 0 | 1.0 |

> ⚠️ **0.4/0.5/0.6 are the project's real risk.** "No project / not sure" + "full PRD stack" means access may not come. Day 1 is deliberately mostly these three tasks. If Gemini access is denied, escalate immediately and fall back to §7.

### Phase 1 — The contract · unblocks all parallel work

This phase exists so that Aloys can build the *entire* frontend before the backend exists.

| ID | Owner | Task | Deliverable | Verify | Est |
|---|---|---|---|---|---|
| 1.1 | BE | Write `openapi/ordo.yaml` | Every endpoint + schema needed by the 9-step demo flow (§5). Derived from `docs/integrations-api.md` + prototype data model | `npx @redocly/cli lint openapi/ordo.yaml` → clean | 1.0 |
| 1.2 | BE | Generate TS types | `web/src/lib/api-types.ts` **generated** from the spec | `make typecheck` fails if someone hand-edits the file (header comment + CI check) | 0.5 |
| 1.3 | BE | **Mock server** | FastAPI impl of every endpoint returning spec-conformant fake data. Port `TEMPLATES`, `ZONES`, `AGENTS`, `SEED_PKGS`, `INBOX`, `CATS` from the prototype | `make test-contract` green — every mock response validates against the spec | 1.0 |
| 1.4 | FE | Consume contract | Typed API client + MSW/fixture layer for frontend tests | One RTL test renders a component fed by a fixture, passes | 0.5 |

**Checkpoint 1** (pair, 0.25 HD): FE confirms every screen in the prototype has an endpoint in the spec. This is the last cheap moment to change the contract.

### Phase 2 — Parallel build · 8 days, both tracks at once

#### Track BE — backend & GCP (Srushti)

| ID | Task | Deliverable | Verify | Est |
|---|---|---|---|---|
| 2.1 | Telemetry simulator | Publishes anomaly-shaped events (PRD §"Example anomaly payload") to Pub/Sub; deterministic seed from the prototype's FNV-1a so the demo is reproducible | `pytest` roundtrip against the **Pub/Sub emulator** (no GCP needed) | 1.0 |
| 2.2 | Vertex predictive maintenance | Train on NASA C-MAPSS, deploy endpoint, `POST /v1/predictions/{machine_id}` | Local sklearn model in tests; separate `@pytest.mark.live` test hits the real endpoint. Assert RMSE ≤ threshold. Returns `predicted_failure_time_hours` + `confidence` | 1.5 |
| 2.3 | Gemini RCA + narration | Process & Diagnosis Agent: anomaly JSON → plain-language root cause. Multimodal variant for the thermal image | pytest against **recorded Gemini responses** (`--live` opt-in); prompt stored in `backend/app/prompts/` so it's diffable | 1.0 |
| 2.4 | Gemini function calling | Healer Agent: `reroute_batch(batch_id, target)`, `adjust_line_speed(line_id, pct)`, `hold_gate` | pytest asserts the returned **tool call JSON** matches a schema; recorded responses replayed | 1.0 |
| 2.5 | Policy guard + autonomy L1–L4 | Encodes the PRD §"Allowed vs blocked" matrix as executable rules | **Parametrized matrix test**: every row of the PRD table × every autonomy level → correct allow/block/require-approval. 36+ cases | 1.0 |
| 2.6 | Dataflow pipeline | Pub/Sub → Dataflow → BigQuery, Beam, streaming | `pytest` runs the pipeline on the **DirectRunner** against a 100-row local fixture, asserts output schema + row count. No GCP needed | 1.5 |
| 2.7 | Firestore state + hash-chained ledger | Run/stage/agent state; audit entries with hash chain per `docs/data-model.md` | pytest against the **Firestore emulator**: append 10 entries, assert chain verifies; tamper with entry 5, assert verification **fails** | 1.0 |
| 2.8 | Shift-handoff summarizer | Gemini summarizer over the day's decisions | pytest on recorded response; asserts it cites ≥1 decision id | 0.5 |
| 2.9 | Demo-mode fallback | `DEMO_MODE=true` serves recorded Gemini/Vertex responses when the live call fails or quota is exhausted | pytest: force a client failure → assert response is still spec-valid and flagged `degraded: true` | 0.5 |

#### Track FE — frontend (Aloys)

| ID | Task | Deliverable | Verify | Est |
|---|---|---|---|---|
| 2.10 | App shell + design system | Nav, layout, tokens ported from `_ds/styles.css` (Cormorant Garamond / Lora, the documented palette) | RTL render test; Playwright nav smoke | 1.0 |
| 2.11 | Line & asset dashboard | The live operational view — assets, zones, current health, live telemetry | RTL test with fixture; Playwright asserts a value updates after a poll | 1.0 |
| 2.12 | Anomaly + RCA panel | Highlights breached metric, renders Gemini RCA text, shows confidence + predicted failure horizon | RTL snapshot test; Playwright clicks **Simulate Overheat** → panel appears | 1.0 |
| 2.13 | Recommendation + policy guard UI | Shows proposed action, guard verdict, autonomy level, and blocks clearly what policy blocks | RTL test asserts blocked actions render a lock state; Playwright asserts **Increase line speed** is blocked | 1.0 |
| 2.14 | Approval / override flow | Operator approves or overrides, with a required reason | Playwright: approve → state changes in UI + backend reflects it | 1.0 |
| 2.15 | Validation package + e-signature | Per `docs/validation-workflow.md`: Draft → pre-check → submit → QE review → approval → Released, 3-stage signature chain | Playwright walks VP-117 rev D (the returned + retested case) to Released | 1.5 |
| 2.16 | Fault injection controls | Demo buttons: Simulate Overheat, Simulate Vibration Spike, Upload thermal image | Playwright: each button drives the full flow to a visible outcome | 0.5 |
| 2.17 | Audit ledger viewer | Renders hash-chained entries, verifies chain in-browser | RTL test with a deliberately-broken chain → renders a tamper warning | 0.5 |
| 2.18 | **E2E of the 9-step demo** | `web/e2e/demo.spec.ts` covering PRD §"Core demo flow" steps 1–9 | `make test-e2e` green. **This is the acceptance test for the whole project.** | 1.0 |

**Checkpoint 2** (pair, end of day 4): demo the vertical slice — inject fault → dashboard shows it → RCA appears. Everything else is polish until this works.

**Checkpoint 3** (pair, end of day 6): all 9 demo steps working locally against mock data.

### Phase 3 — Integration & deploy

| ID | Owner | Task | Verify | Est |
|---|---|---|---|---|
| 3.1 | BOTH | Swap mock → real backend across all screens | `make test-contract` green against the real API; `make test-e2e` green | 1.0 |
| 3.2 | BE | Deploy FastAPI → Cloud Run | `curl https://<svc>/health` → 200; CI deploys on merge to `main` | 0.5 |
| 3.3 | FE | Deploy Next.js → Firebase Hosting | Live URL loads; Playwright runs against the **live** URL, not local | 0.5 |
| 3.4 | BOTH | Live end-to-end rehearsal | Run `make demo` against deployed URL. Time it — must be < 3 min | 0.5 |
| 3.5 | BOTH | Fallback drill | Kill GCP access, run the demo, confirm `DEMO_MODE` keeps it alive | 0.25 |

### Phase 4 — Submission

| ID | Owner | Task | Verify | Est |
|---|---|---|---|---|
| 4.1 | BOTH | Demo script + 3-min video | Video follows PRD §"Judge-facing demo story" beat for beat | 1.0 |
| 4.2 | BE | Repo hygiene for judges: README rewrite (what it is / how to run / architecture / honest limitations), LICENSE, `.env.example` | A stranger clones and runs `make setup && make demo` unaided | 0.5 |
| 4.3 | BOTH | **Fix the PRD vs architecture contradiction** | `docs/architecture.md` §16/§17 rewritten to match what was actually built. Both PRs cross-reference each other | 0.5 |

---

## 5. The demo flow every task serves (PRD §"Core demo flow")

Every feature must be traceable to one of these 9 steps. **If a task doesn't serve one of them, it gets cut.**

1. Fault injected into operator dashboard → `2.10`, `2.16`
2. Threshold breach recognised, machine highlighted → `2.1`, `2.11`, `2.12`
3. Predictive maintenance estimates failure risk → `2.2`
4. Gemini synthesizes root cause → `2.3`, `2.12`
5. Healer agent recommends safe intervention → `2.4`, `2.13`
6. Policy guard validates safety, shows approval need → `2.5`, `2.13`
7. Operator approves or overrides → `2.14`
8. UI updates in real time, downtime avoided shown → `2.11`, `2.6`, `2.7`
9. Compliance ledger stores evidence + shift summary → `2.8`, `2.15`, `2.17`

The 8 non-demo agents (Planning, Supply, Logistics) are **out of scope for implementation**. They appear in docs as future work. Do not build them.

---

## 6. Cadence

- **Daily 15-min sync** — what you merged yesterday, what you're opening today, any blocker. Async in a shared `NOTES.md` if you prefer, but the blocker call is worth doing live.
- **Merge max 2–3 PRs per person per day.** More than that and nobody reviews properly.
- **Pair sessions** (Checkpoint 1, 2, 3 and all of Phase 3) are scheduled *in the plan*, not squeezed in.
- **Rebase `main` in before each PR.**
- **First 3 days: no feature work.** Foundations and the contract only. This is the phase everyone wants to skip, and it's the phase that determines whether you finish.

---

## 7. Risks, and what happens when they hit

| Risk | Likelihood | Response |
|---|---|---|
| **Gemini/Vertex access denied or quota-blocked** | **High** (no project yet, free tier) | Task 0.5 detects it on Day 1. `2.9` demo-mode serves recorded responses; video is still honest because §4.3 documents it. **This is a real possibility — plan for the demo to work without live AI.** |
| Python 3.9 only (system) | High | Task 0.2 pins 3.11 via venv. Never `pip install` globally. |
| Dataflow/Beam is slow and painful | High | `2.6` is scoped to one linear pipeline. If it's behind schedule at day 5, ship BigQuery writes from the FastAPI service instead and drop Dataflow. Note the difference in docs. |
| Vertex training exceeds time budget | Medium | `2.2` falls back to a local sklearn model served behind the same endpoint. Same API, same UI, no Vertex. |
| Scope creep — 8 agents, builder, ERP mock connectors | High | PRD §"Out of scope" is binding. §5 of this plan is binding. Cut features, not tests. |
| Both blocked on each other at the end | Medium | Checkpoints 1–3 exist precisely to surface this early. |
| Merge conflict on a shared file | Low | Ownership map in §2. If it happens, it means the map was violated — fix the map. |
| Overclaiming compliance | Medium | PRD already has an honesty framing section. Keep it in the README and the video narration. |

**Explicit cut order** if you're behind — cut from the bottom, in this order:
`2.17` → `2.8` → `2.6` → `2.2` → `2.15`
Never cut: `2.18`, `2.13`, `2.5`, `2.16`. The policy guard and the demo path are the product.
