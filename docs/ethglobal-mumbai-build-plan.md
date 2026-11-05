# Ordo — ETHGlobal Mumbai build plan and proof of work

Companion to [ethglobal-mumbai-strategy.md](ethglobal-mumbai-strategy.md) (which partners and why).
This file is **how we build it in ~36 hours and how we prove we did**.

Team: **Srushti** (backend, chain, agents) · **Aloys** (frontend, demo, submission).

---

## 0. The rule that shapes everything

ETHGlobal judges only the work done during the event:

- Partner prizes and Finalist require a **From Scratch** build. Prior project-specific **code** is not allowed. Prior **ideas, designs, docs and research are fine** if they are disclosed.
- One giant commit, or a repo with no history, can be **disqualified**. Judges look for steady progress over the weekend.
- The submission must clearly separate what existed before from what was built at the event.

What that means for us:

| Asset in this repo | Status at ETHGlobal | How we use it |
| --- | --- | --- |
| `PRD.md`, `docs/*.md`, `PLAN.md`, `TASKS.md` | Pre-existing **design** — allowed, disclose it | Reference only. Link from the submission |
| `mockups/*.png`, `*.dc.html` prototype | Pre-existing **design** — allowed, disclose it | Visual spec. **Do not copy its code or `support.js` / `_ds` bundle into the app**. Rebuild the screens |
| `_ds/.../styles.css` design tokens | Grey area | Re-type the handful of tokens (colours, fonts, spacing) by hand at the event. Don't vendor the file |
| Any app code | **None exists** — good | Write all of it after kickoff |

> ⚠️ **Google Cloud AI Builder Cup clash.** `PRD.md` and `PLAN.md` target that hackathon with an 8-day build. If the team writes Ordo's app code for it **before 5 Nov**, that code becomes pre-existing work and the ETHGlobal build cannot reuse it for partner prizes. Decide now: either the Google Cloud build happens after Mumbai, or the Mumbai app is written fresh and kept separate.

### Where the code lives

**Updated 19 Oct:** the team decided to build the app now, before the event. The fresh-repo-at-kickoff approach no longer applies. Instead:

- The off-chain core is built now in this repo and declared as prior work (tag `pre-ethglobal`, `PRIOR_WORK.md`).
- All Hedera, 0G and ENS code is written **at the event** in `packages/adapters-chain`, behind the interfaces in [technical-requirements.md §10](technical-requirements.md#10-adapter-interfaces-partner-integrations-plug-in-here). That package is the "new work" judges evaluate.
- Partner-prize eligibility for a pre-existing project is not guaranteed. Confirm with ETHGlobal before relying on it (technical-requirements.md §2).
- The proof-of-work rules in §1 below apply to the event-weekend commits.

---

## 1. Proof of work — how we make it undeniable

Four layers. Each one is cheap; together they leave no doubt.

### 1.1 Git discipline (mandatory)

- First commit = empty scaffold, made **after** kickoff. Tag it `hackathon-start`.
- Commit **at least every 60–90 minutes per person**, small and meaningful. Never squash. Never force-push `main`.
- Short-lived branches + PRs between the two of us (a PR timeline is extra evidence).
- Tag milestones: `m1-chain-ledger`, `m2-agent-loop`, `m3-ui-wired`, `m4-demo-ready`, `submission`.
- Commit messages describe the feature, not "wip" (`Add HCS ledger writer for agent decisions`).

### 1.2 `BUILD_LOG.md` in the app repo

One line per milestone with time (IST), who, what, commit hash. Updated in the same commit as the work. Judges read it in a minute.

```
| Time (IST) | Who | What | Commit |
| 05 Nov 20:10 | Srushti | Hedera testnet client + HCS topic created (0.0.xxxx) | a1b2c3d |
```

### 1.3 On-chain build anchoring (our differentiator)

Every ~3 hours, a script `scripts/anchor-build.ts` posts the current `git rev-parse HEAD` and a tree hash to a dedicated **HCS "build" topic**. Hedera gives each message a consensus timestamp that nobody can back-date. The README links the topic on HashScan.

This turns "trust our commit dates" into "verify on a public ledger" and it uses the exact Hedera feature our product is built on — a good story for the Hedera judges.

### 1.4 Disclosure section in README and submission form

Paste this, adjusted, into both:

> **Prior work.** The product idea, PRD, architecture docs and UI mockups for Ordo were written before ETHGlobal Mumbai (see github.com/AloysJehwin/ordo). No application code existed before the event. Everything in this repository was written between <kickoff> and <deadline>. Build checkpoints are anchored on Hedera topic 0.0.xxxx.

---

## 2. Proof in the product — what Ordo puts on-chain

This is the "proof" the judges will actually see in the demo. Every step of the incident loop leaves a verifiable record.

| Demo step | On-chain artefact | Partner |
| --- | --- | --- |
| Anomaly detected | HCS message: `{type:"anomaly", machine, readings_hash, ts}` | Hedera |
| Failure forecast + root cause | HCS message with model id, prompt hash, output hash; inference run on 0G Compute, full evidence JSON on 0G Storage (root hash in the HCS message) | Hedera, 0G |
| Recommendation + policy verdict | HCS message: action, autonomy level, verdict (`auto` / `needs_approval` / `blocked`) | Hedera |
| Operator approval | **Scheduled transaction** that only executes once the operator key signs. Approve button = sign | Hedera |
| Action executed | Batch NFT (HTS) transferred to the reroute line; vendor paid in testnet HBAR/USDC by the Healer agent via **Hedera Agent Kit** | Hedera |
| Identities | Machines, lines and agents named under `ordo.eth` (e.g. `cnc-05.line02.ordo.eth`) with text records for spec limits and owning agent | ENS |
| Shift summary | Summary + list of HCS sequence numbers it covers, hashed to HCS | Hedera |

**Verify page** (`/verify/<incident-id>`): pulls the HCS messages from the mirror node, recomputes hashes from the evidence on 0G Storage, and shows ✔ or ✘ per step with HashScan links. Tamper one field → ✘. That 10-second moment is the demo's proof shot.

---

## 3. Stack for 36 hours (cut from PLAN.md)

PLAN.md's Pub/Sub, Dataflow, BigQuery, Vertex and Firestore are **out** for Mumbai. One language end to end:

- **Next.js (TypeScript)** app with API routes as the backend. Deploy on Vercel.
- **@hashgraph/sdk** for HCS, HTS, scheduled transactions. **Hedera Agent Kit (JS)** for the Healer agent's payment tool. Mirror node REST for reads.
- **0G Compute** (TS SDK) for the root-cause call; **Gemini API key** as fallback. **0G Storage** for evidence JSON.
- **viem** + ENS on Sepolia for names and text records.
- Telemetry: a simulator in the API route with a deterministic seed and a "Simulate overheat / vibration spike" button. No real sensors.
- Failure forecast: a small rules + linear-trend function. No model training at the event.
- State: in-memory + SQLite (or a JSON file). The chain is the system of record for decisions.

---

## 4. Before kickoff (allowed — no project code)

Owner in brackets. Finish by **3 Nov**.

- [ ] Apply to ETHGlobal Mumbai and stake ETH for both members **[both]**
- [ ] Rename this repo to `ordo` **[Aloys]**
- [ ] Decide the Google Cloud Cup question in §0 **[both]**
- [ ] Hedera testnet: create 3 accounts (operator, line-02, vendor) at portal.hedera.com, fund from faucet, store keys in a password manager **[Srushti]**
- [ ] 0G testnet wallet funded; read the 0G Compute and Storage quickstarts; confirm a model is available on the testnet broker **[Srushti]**
- [ ] Register a Sepolia ENS name (`ordo.eth` or close) and get Sepolia ETH **[Aloys]**
- [ ] Gemini API key as fallback **[Srushti]**
- [ ] Vercel account linked to GitHub **[Aloys]**
- [ ] Walk through Hedera Agent Kit and scheduled-transaction tutorials **in a throwaway sandbox, not the project** **[Srushti]**
- [ ] Freeze the demo script (§7) and the screen list (§5) from the mockups **[Aloys]**
- [ ] Re-check the prizes page when tracks publish; adjust §2 to the exact qualification wording **[both]**

Learning by running tutorials is fine. Writing Ordo's code is not.

---

## 5. Screens to rebuild (from the mockups, trimmed)

Only what the demo needs. The other prototype screens stay in the design repo.

1. **Line dashboard** — assets with live readings, fault buttons (mockups 10, 01)
2. **Incident panel** — anomaly, forecast, root cause, recommended action, policy verdict (mockups 02, 05, 12)
3. **Approvals** — approve / override with reason; signing state (mockup 12)
4. **Ledger** — HCS messages with sequence, consensus time, HashScan links (mockup 04)
5. **Verify** — per-step ✔/✘ (new)

---

## 6. Hackathon schedule (hours from kickoff, ~36 h)

| Hours | Srushti (backend + chain) | Aloys (frontend + demo) | Gate |
| --- | --- | --- | --- |
| 0–1 | Create repo, Next.js scaffold, `.gitignore`, env template, tag `hackathon-start`, first build anchor | Team sync, open BUILD_LOG.md, copy screen list into issues | Repo public, first commit after kickoff |
| 1–4 | Hedera client, HCS topic, `ledger.write()` + mirror-node `ledger.read()` | App shell, tokens re-typed, dashboard with simulated telemetry | Message visible on HashScan |
| 4–8 | Telemetry simulator + anomaly rules + trend forecast; API routes | Incident panel wired to API | **M1**: fault → anomaly → HCS |
| 8–12 | Root cause via 0G Compute (Gemini fallback), evidence to 0G Storage | Ledger view from mirror node | **M2**: full agent loop writes to chain |
| 12–16 | Policy guard (autonomy L1–L4 matrix from PRD) + scheduled transaction for approvals | Approvals screen, sign-to-approve | Approve executes on testnet |
| 16–20 | *Sleep in shifts — one of you at a time, 3–4 h each* | | |
| 20–24 | Healer agent via Agent Kit: vendor payment + batch NFT transfer | Verify page + tamper demo | **M3**: UI fully wired |
| 24–28 | ENS names + text records for machines and agents | Show ENS names everywhere a machine/agent appears | |
| 28–31 | Shift summary, hardening, demo fallback (recorded responses if 0G/Gemini fail) | Polish, empty/error states, deploy to Vercel | **M4**: deployed URL runs demo end-to-end |
| 31–34 | README (setup, architecture, prior-work disclosure, contract/topic IDs) | Record 2–3 min demo video, screenshots | |
| 34–36 | Final anchor, tag `submission` | Fill submission form, pick prize tracks | Submitted with ≥1 h margin |

**Cut order if behind** (cut from the top): ENS → shift summary → 0G Storage (keep 0G Compute) → batch NFT. **Never cut:** HCS ledger, policy guard, scheduled-tx approval, agent payment, verify page.

---

## 7. Demo script (2–3 min)

1. "Line 02, CNC-05. Bearing vibration starts drifting." → press **Simulate vibration spike**.
2. Ordo flags it, forecasts failure in ~12 h, explains the cause in plain language (0G Compute).
3. Healer recommends rerouting batch B-2417 to CNC-07 and ordering maintenance. Policy guard: **needs approval**.
4. Operator approves → scheduled transaction executes → batch NFT moves, vendor paid by the agent.
5. Open **Ledger**: every step on Hedera with consensus timestamps.
6. Open **Verify**: all ✔. Edit one field in the evidence → ✘. "This is the audit trail regulators actually want."
7. Close: machine names are ENS identities; build history itself is anchored on Hedera.

---

## 8. Submission checklist

- [ ] Public repo, many commits across the weekend, tags present
- [ ] README: what it is, how to run, architecture diagram, **prior-work disclosure**, testnet IDs (topics, tokens, accounts), HashScan links
- [ ] BUILD_LOG.md complete; build anchors visible on the build topic
- [ ] Demo video 2–3 min, shows on-chain proof
- [ ] Live URL works without our laptops
- [ ] Each partner's qualification line ticked and stated in the form (e.g. "agent executes payment on Hedera testnet: tx 0.0.x@…")
- [ ] Up to the allowed number of partner prizes selected: Hedera, 0G, ENS
