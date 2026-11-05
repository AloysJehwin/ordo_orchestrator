# Ordo — Task Assignment (2 people)

> **Note (19 Oct 2026):** this task list follows the old Python + Google Cloud stack. Use the milestones in [docs/technical-requirements.md](docs/technical-requirements.md) §18 until it is rewritten.

Companion to [`PLAN.md`](./PLAN.md). That file explains *why* the plan is shaped this way.
**This file is the working checklist** — everything is split by owner and every task has a test.

| Person | Track | Owns |
|---|---|---|
| **Srushti** | Backend / Infra / AI | `backend/**` `infra/**` `openapi/ordo.yaml` `scripts/gcp/**` |
| **Aloys** | Frontend / UI | `web/**` `web/e2e/**` `docs/ui/**` |
| **Both** | Pair sessions | `Makefile` `.github/workflows/**` `README.md` `docs/architecture.md` |

If a file isn't in your column, don't edit it. Ask the owner.

---

## How to use this file

1. Open a branch: `git checkout -b t<id>/<slug>` (e.g. `t2.3/gemini-rca`)
2. Do only that task
3. Run its **Verify** command, paste output in the PR description
4. `make test && make lint && make typecheck` — all green
5. Open PR, other person approves, merge
6. Tick the box here and commit to `main`

**Every task is done when its Verify command passes.** A task with no passing test is not done.

---

## ⚠️ Before anyone starts — read these four things

- [ ] **0.1 first.** `.gitignore` before either person runs `npm install`. Ten minutes, prevents the worst merge-conflict source you'll ever hit.
- [ ] **0.4 / 0.5 first.** We do not have a GCP project yet. Gemini access may be denied or quota-blocked. Find out on Day 1, not Day 6.
- [ ] **Phase 1 before Phase 2.** The mock server (1.3) is what unblocks Aloys. Don't skip it to "start features early" — that's how you end up with two people blocked at the end.
- [ ] **Every task serves one of the 9 demo steps** (see the map at the bottom). If it doesn't, it gets cut.

---

# Blockers — who waits on whom

Read this before picking up any task.

```
0.1 (repo hygiene) ──┬──> 0.2 (python env, Srushti) ──> 1.1 (openapi, Srushti) ──> 1.3 (mock server, Srushti) ──┐
                     │                                                                    │                     │
                     └──> 0.3 (next.js, Aloys) ────────────────────────────────────────────────────────────────┤
                                                                                                                  │
0.4 (gcp project, Srushti) ──> 0.5 (gemini probe) ──> 0.6 (vertex probe)                                   v
                                                                                                    1.2 (ts types, Srushti)
                                                                                                          │
                                                                                                          v
                                                                                              1.4 (api client, ALOYS)
                                                                                                          │
1.1 ──> 1.2 ──> 1.4 ─────────────────────────────────────────────────────────────────────────────────────> v
                                                                                                Phase 2: BOTH TRACKS RUN
```

**Consequences you must accept up front:**

- **Aloys is blocked until 1.3 lands.** That is Phase 0 + Task 1.1–1.3 for Srushti. Nothing Aloys can do about it — so those tasks are the first priority, every day.
- **Srushti is blocked on GCP.** If 0.5 fails, Phase 2 BE tasks 2.2/2.3/2.4 stall. See "If Gemini access fails" at the bottom.
- **Checkpoint 1 must not slip.** It is the last cheap moment to change the API contract. After it, the contract is frozen and both tracks move.

---

# Phase 0 — Foundations

No features. This phase exists so the rest is cheap. Do not skip it.

## Srushti

### [ ] 0.1 — Repo hygiene · **BOTH** · 0.5 HD

- [ ] `.gitignore` (node_modules, `.next/`, `__pycache__/`, `.venv/`, `*.env`, `.pytest_cache/`, `credentials*.json`, `.DS_Store`)
- [ ] `.gitattributes`, `.editorconfig`
- [ ] `Makefile` with: `setup` `test` `test-backend` `test-frontend` `test-e2e` `test-contract` `lint` `typecheck` `demo` `deploy`
- [ ] `CONTRIBUTING.md` — the 10 ground rules from PLAN.md §1
- [ ] Turn on branch protection for `main` (require PR + 1 approval)
- [ ] Both people confirm: `make setup && make test` works on a fresh clone

**Verify:** on both machines, `make setup && make test` is green. Then `git check-ignore node_modules/x` → `node_modules/x`.

> **Do this before anything else in the repo.** Split the actual work any way you like, but it lands first.

### [ ] 0.2 — Python environment · 0.5 HD

- [ ] Python **3.11+** (system python is 3.9.6 — do not use it)
- [ ] `backend/pyproject.toml`, pinned deps
- [ ] `backend/app/main.py` → `GET /health` returns `{"status":"ok"}`
- [ ] ruff + mypy configured, clean on first run
- [ ] `backend/tests/test_health.py` — at least one passing test so CI has something to run

**Verify:** `curl localhost:8000/health` → `200 {"status":"ok"}`  ·  `make test-backend` → ≥1 passing

### [ ] 0.4 — GCP project & API enablement · 1.0 HD · ⚠️ HIGHEST RISK

- [ ] `scripts/gcp/setup.sh` — create project, enable billing
- [ ] Enable: Vertex AI, Pub/Sub, Dataflow, BigQuery, Firestore, Cloud Run, Artifact Registry
- [ ] Request/enable Gemini API access
- [ ] Create service account + key, wire into `.env.example` (never commit the real `.env`)
- [ ] `--verify` flag that confirms each API is actually reachable

**Verify:** `bash scripts/gcp/setup.sh --verify` → prints `ALL APIS ENABLED`

### [ ] 0.5 — Gemini go/no-go gate · 0.5 HD · ⚠️ BLOCKING

- [ ] `backend/scripts/gemini_smoke.py` — one real Gemini call, prints the response

**Verify:** `python -m backend.scripts.gemini_smoke` exits 0

> **If this fails: stop and resolve it before all other work.** Escalate immediately, then see the fallback section at the bottom of this file.

### [ ] 0.6 — Vertex AI probe · 1.0 HD

- [ ] `backend/scripts/vertex_probe.py` — train a trivial model → get endpoint → call it → print result

**Verify:** `python -m backend.scripts.vertex_probe` exits 0

## Aloys

### [ ] 0.3 — Next.js scaffold · 0.5 HD

- [ ] `web/` on Next.js + TypeScript **strict**
- [ ] Tailwind, ESLint, Prettier, pre-commit hook
- [ ] vitest + React Testing Library + Playwright
- [ ] Base `make`-driven scripts wired to the root `Makefile`

**Verify:** `make test-frontend` green · Playwright smoke passes · `make lint && make typecheck` clean

---

# Phase 1 — The contract

This phase is what lets both people work in parallel. Srushti's jobs here; Aloys has one job at the end.

## Srushti

### [ ] 1.1 — Write `openapi/ordo.yaml` · 1.0 HD · **SOLE OWNER — nobody else edits this file**

Cover every endpoint the 9-step demo flow needs. Endpoints to include:

```
GET    /health
GET    /v1/lines
GET    /v1/lines/{line_id}/assets
GET    /v1/assets/{asset_id}/health
GET    /v1/telemetry/{asset_id}          (live / streaming)
POST   /v1/simulate/fault                (fault injection for the demo)
GET    /v1/anomalies
POST   /v1/anomalies/{id}/rca
POST   /v1/predictions/{asset_id}
POST   /v1/actions/propose               (healer recommendation)
POST   /v1/policy/check                  (policy guard verdict)
POST   /v1/actions/{id}/approve
POST   /v1/actions/{id}/override
POST   /v1/validations
POST   /v1/validations/{id}/precheck
POST   /v1/validations/{id}/signatures
GET    /v1/audit?entity=
POST   /v1/summarize/shift-handoff
```

Source material: `docs/integrations-api.md`, `docs/data-model.md`, `docs/validation-workflow.md`, and the data shapes in `Ordo Orchestrator.dc.html`.

**Verify:** `npx @redocly/cli lint openapi/ordo.yaml` → clean

### [ ] 1.2 — Generate TypeScript types · 0.5 HD

- [ ] Codegen → `web/src/lib/api-types.ts`
- [ ] CI check that fails if anyone hand-edits the generated file

**Verify:** `make typecheck` passes; hand-edit one line → CI fails

### [ ] 1.3 — Mock server · 1.0 HD · **THIS IS WHAT UNBLOCKS ALOYS — do it first**

- [ ] FastAPI impl of **every** endpoint, returning spec-conformant fake data
- [ ] Port these datasets out of `Ordo Orchestrator.dc.html`: `TEMPLATES`, `ZONES`, `AGENTS`, `SEED_PKGS`, `INBOX`, `CATS`
- [ ] Reuse the prototype's FNV-1a `hsh`/`rnd` seeding so data looks varied but is deterministic

**Verify:** `make test-contract` green — every response validates against `openapi/ordo.yaml`

## Aloys

### [ ] 1.4 — Typed API client · 0.5 HD · blocked on 1.2

- [ ] `web/src/lib/api.ts` — typed client from the generated types
- [ ] Fixture/mock layer for frontend tests (MSW or equivalent)

**Verify:** one RTL test renders a component fed by a fixture → passes

## ✅ CHECKPOINT 1 (pair, 0.25 HD)

Aloys walks the prototype's screens; Srushti's spec has an endpoint for each.
**Contract is frozen after this.** Raise anything missing *now*, not in Phase 3.

---

# Phase 2 — Parallel build

Both tracks run simultaneously. Checkpoints at the end.

## Srushti — backend & GCP track

### [ ] 2.1 — Telemetry simulator → Pub/Sub · 1.0 HD

- [ ] Publishes anomaly-shaped events matching the PRD's example payload (`CNC-05`, vibration 8.7, temp 88, `predicted_failure_time_hours`, `confidence`)
- [ ] Deterministic seeding

**Verify:** `pytest` roundtrip against the **Pub/Sub emulator** — no GCP account needed

### [ ] 2.2 — Vertex AI predictive maintenance · 1.5 HD

- [ ] Train on NASA C-MAPSS → deploy endpoint
- [ ] `POST /v1/predictions/{asset_id}`

**Verify:** local sklearn model in unit tests; separate `@pytest.mark.live` test hits the real endpoint. Assert RMSE ≤ threshold.

> **Most likely thing to blow the schedule.** Designed fallback: a local sklearn model behind the identical endpoint — same API, same UI, no Vertex. Take the fallback without guilt.

### [ ] 2.3 — Gemini root-cause analysis · 1.0 HD

- [ ] Process & Diagnosis Agent: anomaly JSON → plain-language root cause
- [ ] Multimodal variant for the uploaded thermal image
- [ ] Prompts live in `backend/app/prompts/` as files, so they diff in review

**Verify:** `pytest` against recorded Gemini responses (`--live` to opt in)

### [ ] 2.4 — Gemini function calling (Healer Agent) · 1.0 HD

- [ ] Tools: `reroute_batch(batch_id, target)`, `adjust_line_speed(line_id, pct)`, `hold_gate`

**Verify:** `pytest` asserts returned tool-call JSON matches a schema; recorded responses replayed

### [ ] 2.5 — Policy guard + autonomy L1–L4 · 1.0 HD

- [ ] Encode the PRD's "Allowed vs blocked autonomous actions" table as executable rules
- [ ] Autonomy levels L1 Assist → L4 Autonomous

**Verify:** parametrized matrix test — **every row of the PRD table × every autonomy level** → correct allow / block / require-approval. 36+ cases, all asserted explicitly.

### [ ] 2.6 — Dataflow: Pub/Sub → BigQuery · 1.5 HD

- [ ] Apache Beam streaming pipeline

**Verify:** `pytest` runs the pipeline on the **DirectRunner** against a 100-row local fixture; assert output schema + row count. No GCP needed.

> Highest complexity-per-demo-value task in the plan. If it's behind at day 5, write to BigQuery from the FastAPI service instead and drop Dataflow. Note the difference in the docs.

### [ ] 2.7 — Firestore state + hash-chained ledger · 1.0 HD

- [ ] Run / stage / agent state
- [ ] Audit entries hash-chained per `docs/data-model.md`

**Verify:** `pytest` against the **Firestore emulator**: append 10 entries → chain verifies; **tamper with entry 5 → verification fails**

### [ ] 2.8 — Shift-handoff summarizer · 0.5 HD

- [ ] Gemini summarizer over the day's decisions

**Verify:** `pytest` on a recorded response; assert it cites ≥1 real decision id

### [ ] 2.9 — Demo-mode fallback · 0.5 HD · **do not skip, do it before 2.2/2.3/2.4**

- [ ] `DEMO_MODE=true` serves recorded Gemini/Vertex responses when a live call fails or quota is exhausted

**Verify:** `pytest` — force a client failure → response is still spec-valid and carries `degraded: true`

## Aloys — frontend track

### [ ] 2.10 — App shell + design system · 1.0 HD

- [ ] Nav, layout, routing
- [ ] Design tokens ported from `_ds/styles.css` — Cormorant Garamond / Lora, documented palette

**Verify:** RTL render test · Playwright nav smoke

### [ ] 2.11 — Line & asset dashboard · 1.0 HD

- [ ] Assets, zones, current health, live telemetry

**Verify:** RTL test with fixture · Playwright asserts a value updates after a poll

### [ ] 2.12 — Anomaly + RCA panel · 1.0 HD

- [ ] Highlights the breached metric, renders Gemini RCA text, shows confidence + predicted failure horizon

**Verify:** RTL snapshot test · Playwright: click **Simulate Overheat** → panel appears

### [ ] 2.13 — Recommendation + policy guard UI · 1.0 HD · **never cut**

- [ ] Shows proposed action, guard verdict, autonomy level
- [ ] Clearly blocks what policy blocks

**Verify:** RTL test asserts blocked actions render a lock state · Playwright asserts **Increase line speed** is blocked

### [ ] 2.14 — Approval / override flow · 1.0 HD · **never cut**

- [ ] Operator approves or overrides; override requires a reason

**Verify:** Playwright: approve → UI state changes **and** backend reflects it

### [ ] 2.15 — Validation package + e-signature · 1.5 HD

- [ ] Per `docs/validation-workflow.md`: Draft → agent pre-check → submit → QE review → approval → Released, with ChangesRequested / Rejected branches
- [ ] 3-stage signature chain

**Verify:** Playwright walks **VP-117 rev D** (the returned + retested case) all the way to Released

### [ ] 2.16 — Fault injection controls · 0.5 HD · **never cut**

- [ ] Demo buttons: Simulate Overheat, Simulate Vibration Spike, Upload thermal image

**Verify:** Playwright: each button drives the flow to a visible outcome

### [ ] 2.17 — Audit ledger viewer · 0.5 HD

- [ ] Renders hash-chained entries, verifies chain in-browser

**Verify:** RTL test with a deliberately broken chain → renders a tamper warning

### [ ] 2.18 — E2E of the 9-step demo · 1.0 HD · **never cut, do it before the others**

- [ ] `web/e2e/demo.spec.ts` covering PRD "Core demo flow" steps 1–9

**Verify:** `make test-e2e` green. **This is the acceptance test for the entire project.**

## ✅ CHECKPOINT 2 (pair, end of day 4)

Vertical slice: inject fault → dashboard shows it → RCA appears. Nothing else is polish until this works.

## ✅ CHECKPOINT 3 (pair, end of day 6)

All 9 demo steps working locally against mock data.

---

# Phase 3 — Integration & deploy · BOTH (pair sessions)

- [ ] **3.1** Swap mock → real backend across all screens · 1.0 HD
  **Verify:** `make test-contract` green against the real API · `make test-e2e` green
- [ ] **3.2** *(Srushti)* Deploy FastAPI → Cloud Run · 0.5 HD
  **Verify:** `curl https://<svc>/health` → 200; CI deploys on merge to `main`
- [ ] **3.3** *(Aloys)* Deploy Next.js → Firebase Hosting · 0.5 HD
  **Verify:** live URL loads; Playwright runs against the **live** URL
- [ ] **3.4** *(BOTH)* Live rehearsal · 0.5 HD
  **Verify:** `make demo` against the deployed URL, **timed — must be under 3 minutes**
- [ ] **3.5** *(BOTH)* Fallback drill · 0.25 HD
  **Verify:** kill GCP access → demo still runs in `DEMO_MODE`

---

# Phase 4 — Submission

- [ ] **4.1** *(BOTH)* Demo script + 3-minute video · 1.0 HD
  **Verify:** video follows the PRD "Judge-facing demo story" beat for beat
- [ ] **4.2** *(Srushti)* Judge-facing README, LICENSE, `.env.example` · 0.5 HD
  **Verify:** a stranger clones and runs `make setup && make demo` unaided
- [ ] **4.3** *(BOTH)* **Fix the PRD vs architecture contradiction** · 0.5 HD
  `docs/architecture.md` §16/§17 currently say technology is undecided and this isn't a running system. Rewrite to match what was actually built. Cross-reference the two PRs.
  **Verify:** no doc claims something that isn't in the repo

---

# Task → demo step map

Every feature traces to a step in the PRD's 9-step demo flow. **If a task serves none of them, cut it.**

| Demo step | Srushti | Aloys |
|---|---|---|
| 1. Fault injected | 2.1 | 2.10, 2.16 |
| 2. Breach detected, machine highlighted | 2.1 | 2.11, 2.12 |
| 3. Failure risk estimated | **2.2** | 2.12 |
| 4. Gemini root cause | 2.3 | 2.12 |
| 5. Healer recommends intervention | 2.4 | 2.13 |
| 6. Policy guard validates safety | **2.5** | 2.13 |
| 7. Operator approves / overrides | 2.4 | **2.14** |
| 8. UI updates, downtime avoided | 2.6, 2.7 | 2.11 |
| 9. Evidence stored + shift summary | 2.8, 2.7 | 2.15, 2.17 |

**Out of scope for implementation:** Planning, Supply and Logistics agents. They stay in the docs as future work. Do not build them.

---

# Cadence

- [ ] **Daily 15-min sync** — what you merged yesterday, what you're opening today, any blocker. Live, not async, for the blocker call.
- [ ] **Max 2–3 PRs per person per day.** More than that and nobody reviews properly.
- [ ] **Rebase `main` into your branch before opening a PR.**
- [ ] **Never `--no-verify`.** Never commit straight to `main`.
- [ ] Pair sessions are scheduled above — don't let them get squeezed out by feature work.

---

# If Gemini access fails (Task 0.5 or 0.6)

This is the most likely failure mode, because we haven't created the project yet.

1. **Stop.** Don't build Phase 2 BE tasks on top of an unverified assumption.
2. Escalate together — check whether it's a billing issue, a quota issue, or access-not-yet-granted. These have different fixes.
3. Fall back, in this order:
   - Fix access and wait — cheapest, do it if it's under a day
   - Vertex → local sklearn model behind the same endpoint (task 2.2). Same API, same UI.
   - Gemini live → `DEMO_MODE` recorded responses (task 2.9, write this early)
4. **Say so in the README and the video.** The PRD already has an honesty framing section — keep it. "Regulatory-aware workflow and evidence-generation system," not "compliant production system." Judges respect this; overclaiming is what gets caught in Q&A.

---

# If you're behind — cut in this order

Cut from the bottom. Never cut the last four.

- [ ] ~~`2.17` audit ledger viewer~~ (keep the backend ledger, drop the viewer)
- [ ] ~~`2.8` shift-handoff summarizer~~
- [ ] ~~`2.6` Dataflow~~ (→ BigQuery writes from FastAPI)
- [ ] ~~`2.2` Vertex AI~~ (→ local sklearn model)
- [ ] ~~`2.15` validation package + e-signature~~

### Never cut

`2.18` E2E demo test · `2.13` policy guard UI · `2.5` policy guard rules · `2.16` fault injection

**The policy guard and the demo path are the product.** Everything else is supporting material.
