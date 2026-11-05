# Ordo rework plan (handoff)

The working plan for the November 2026 rework: a portastake-style UI, four roles, proof of work through 0G Private Computer, and tester slashing. A new session, including Claude Code on the web, should read this file first and continue from **Status**. `PLAN.md` and `TASKS.md` describe the earlier stack and are superseded.

**Repo:** `AloysJehwin/ordo_orchestrator` (public), with this folder as the git root (since 5 Nov 2026; the old `ai_warriors` repo and Vercel project were deleted). **Next plan:** machine bodies, multimedia outcomes and x402 resource agents on Hedera, in Batches 0–10 (`~/.claude/plans/federated-noodling-feigenbaum.md`, mirrored in **Next: machine bodies** below). Batches 0 and 1 are done.

## Status (5 Nov 2026)

| Phase | What | State |
|---|---|---|
| 1 | UI system and responsive shell (Part A) | **Built.** The user is testing it. Open item: the Builder's inspector as a bottom sheet on phones. |
| 2 | Four roles, visibility, open joining, on-chain org registration in the create-org flow (Part B) | **Built.** Server and web; role-based tests migrated (`test/flow/roles.test.ts` covers the access matrix). |
| 3 | Contracts v3: tester stakes, slashing cases, rewards (Part C) | **Deployed on Hedera testnet 5 Nov 2026** (addresses below). Every org registers again and its people re-record credentials and stake on v3. |
| 4 | 0G Private Computer proof of work: `sdk/` CLI, sessions, signing page, public proof (Part D) | **Built.** The model is `0gm-1.0-35b-a3b` (TeeML; `glm-5.3` lost its private-mode providers), with `whisper-large-v3` allowed on session keys. Runs locally with the scripted interviewer, which the CLI now picks by itself, until `ZG_ROUTER_MGMT_KEY` is set. CLI `ordo-pow` (62 tests) **not published yet** (publishing is pre-approved, planned with 0.2.0 in Batch 9). |
| 5 | Selection, rewards page, cases and slashing UI (Part E) | **Built.** `test/flow/pow.test.ts` runs session → finish → sign → select (stage closes) → case → decision. |
| 6 | Docs, doctor (Part F) | **Docs and doctor updated** for four roles, v3 and the Router change. Playwright runs left to the user, who tests by hand. |
| B1 | Review fixes | **Done.** Selected proof of work is committed by Ordo (no contributor-signed readings); on v3 a manager needs a stake to select and a case needs a challengeable acceptance; managers hold `operator` in ENS; an org's only manager may approve a package they performed; preview and Render links; empty env values count as unset. |

**Green as of 5 Nov 2026:** `pnpm -r typecheck` (server, web, contracts, sdk), server 233/233, contracts 45/45, sdk 61/61, doctor healthy (one warning: OrdoTrust is pre-v3).

### What Phases 2–5 changed

- **Roles (server `domain/types.ts`, `domain/policy.ts`, migration 24).** manager, validator, tester, contributor. Old roles are mapped by migration 24. Visibility levels 1–4 plus scope are enforced in the API (`needLevel`, `stageInScope`, `redactRun`); the web reads `sees(level)` and `can(role)` from `useApp()`.
- **Open joining.** `POST /v1/orgs/:id/join`; `web/src/pages/Explore.tsx` lists orgs. Onboarding applications, `Validators.tsx` and `Onboarding.tsx` are gone; vendors are a manager form in Team.
- **Org registration** is signed right after creating an org (`?register=1` opens the prompt); Settings → On-chain retries it.
- **Contracts v3** (`contracts/src/OrdoTrust.sol`): TESTER bit 128, tester stakes, `openCase` / `respond` / `decideCase`, `fundRewards` / `recordAcceptance` / `settle` / `claim` / `claimFor`, per-site settings signed by a manager, `LastAdmin`. OrdoPolicies `REQUIRED = 1`.
- **Proof of work** (`server/src/core/contributions.ts`, `server/src/chain/zg-router.ts`, migration 25, `sdk/`): sessions mint a private-mode Router key per session; `npx ordo-pow@latest <token>`; Poseidon commitments, sealed record replicated to 0G Storage, signed `contribution.sign`; `#/pow`, `#/pow/:id/sign`, public `#/pow/:id`.
- **Selection, cases, rewards** (`server/src/core/selection.ts`, `server/src/core/cases.ts`, migration 26): signed `contribution.select` closes the stage from the selected record (signer kind `contributor`, so ZK proofs work); `case.open` / `case.respond` / `case.decide`; web pages `Cases.tsx` and `Rewards.tsx`, a "Select as valid" action on each stage's proofs of work, a live `cases` count.
- **Fixes found on the way:** agent NFTs authorized nobody (looked for `plant_manager`); ENS role records used the new names, which OrdoEnsRoles doesn't know (`names.ts` `ensRoles`); role relays were ordered by a random id. Demoting a manager who stays a validator now asks the manager to sign the validator credential again (OrdoTrust's MANAGER value includes the VALIDATOR bit).

### What Phase 1 changed (web)

- **`web/src/styles.css`, rebuilt.** Tokens after portastake-shield: Inter Variable plus JetBrains Mono (`@fontsource`), glass cards, 44px controls, near-black primary, chips. Plain `#f4f5fb` background, deliberately **without** portastake's `body::before` gradient. Light only.
- **`web/src/Shell.tsx`.**
  - At 1024px and up: a floating glass sidebar.
  - Below 1024px: a sticky glass header, a bottom tab bar (`PRIMARY` = pipelines, floor, validation, approvals), and a More panel.
- **`web/src/ui/hooks.ts`.**
  - The layer stack in `useDismiss`: nested popups no longer close their parents, and Escape closes only the topmost.
  - `useMedia` and `useSheet` (under 640px means a bottom sheet).
  - Shared `usePlacement`: portaled and fixed, flips upward.
- **`web/src/ui/kit.tsx`.**
  - `Sheet`.
  - `Modal` and `Drawer` become bottom sheets on phones, via CSS.
  - `Menu` is portaled, and a sheet on phones.
  - Lucide icons.
  - Chip-style `Segmented` and `Tabs`.
- **`web/src/ui/Select.tsx`.**
  - Opens as a popover on desktop and a bottom sheet with search on phones.
  - `variant="chip"`.
  - `name` gives an accessible name and sheet title without a visible label.
- **`web/src/ui/Calendar.tsx`.** The pickers are portaled (no longer clipped inside dialogs). On phones they open as sheets: one month, presets as chips.
- **`web/src/ui/tables.ts`.** Every `table.t` stacks into labelled cards under 768px. Cells get `data-label` from the header row automatically.
- **Removed:** `lib/theme.ts`, `ui/ThemeToggle.tsx`, the Google Fonts link.

Earlier the same day:
- **World ID removed entirely.** Migration 23 drops its tables. Do not reintroduce it.
- **Vite proxy CSRF fix** (`changeOrigin: false`).
- **`--env-file-if-exists=.env`** added to the server's dev and start scripts.

## Decisions already made by the user (do not reopen)

- **UI:** like `github.com/AloysJehwin/portastake-shield` minus the gradient. Plain CSS, no Tailwind. Mobile first-class: tab bar, and sheets for lists, calendars and dialogs.
- **Roles:**
  - Exactly four: manager, validator, tester (slasher), contributor.
  - Joining is open: any signed-in wallet joins an org as a contributor, with no application forms. The manager promotes people.
- **Visibility:** a level 1–4 plus a line/stage scope, per role, with per-person overrides set by the manager.
- **Rewards:** a bounty plus payouts from a pool the manager funds.
  - Accepted contribution: a contributor reward plus a validator fee.
  - Confirmed slash: 50% to the tester, 50% to the quality fund.
  - Rejected claim: 10% of the tester's stake goes to the validator.
- **Slashing:** the tester opens a case, the validator gets a response window (48h default), the manager decides. Both signatures are enforced on-chain.
- **On-chain org registration stays.** Creating an org is signed (`site.register`) and relayed to OrdoTrust `registerSite`. Fold it into the create-org flow; today it's a button on Team → Validators.
- **0G:** the Private Computer Router runs on **mainnet**, because the iAI credits are there. Everything else stays on testnet, switchable per rail. Agent sessions are paid with org-funded keys: a `mk-` management key mints a private-mode `sk-` key per session.
- **Old features** (work orders, pay on proof, machine wallets, autonomy) stay, manager-only.
- **The proof-of-work agent is published to npm** (`npx <pkg>@latest <token>`). Confirm the package name and `npm whoami` before the first publish.

## Inputs still needed from the user

1. **`ZG_ROUTER_MGMT_KEY`:** an `mk-` key from pc.0g.ai (Key Manager: account:read, keys:read, keys:create, keys:manage), created by the wallet holding the iAI credits. Without it, sessions use the CLI's scripted interviewer and receipts say "no TEE".
2. **`VERCEL_TOKEN`** (and team id) for the machine sandboxes, and a Render account or `RENDER_API_KEY` for hosting Ordo (Batch 6). The user enters these; they are never printed.

Pre-approved by the user (5 Nov): pushing to `origin/main`, redeploying contracts on Hedera testnet, publishing `ordo-pow` to npm, creating Vercel Sandbox VMs, creating and funding testnet accounts.

## Ground rules

- **Never print secret values.** Report key names and whether they're set.
- **Commits:** straight to `main`, about 10–20 files per commit, roughly every 30 minutes as work gets built, pushed regularly. Honest messages and real timestamps: never backdate, never hold finished work back.
- **Before outward or irreversible actions not in the pre-approved list above, confirm first.**
- **Each phase ends green:** `pnpm -r typecheck`, `pnpm --filter @ordo/server test`, `pnpm --filter @ordo/contracts test`, and `pnpm run doctor` from `server/`.

## Layout and commands

- **Code:** this folder is the repo root, a pnpm workspace (`server`, `web`, `contracts`, `sdk`). Node 22 or newer, pnpm 10.28.
- **Run locally:** `pnpm install`, then `pnpm dev` (API :8080, console :5173 proxied). The server reads `server/.env` (git-ignored). With no `.env`, every rail is off: PGlite on disk, offline AI, local anchor. That's enough for UI work.
- **Deploy:** Ordo moves to Render (Docker and Postgres, `render.yaml`) in Batch 6. `pnpm vercel-build` still builds the static console plus one Node function. Production needs `DATABASE_URL` (Postgres).
- **Secrets** are in the user's local `server/.env` (and the host's environment once deployed). They are never in git. A cloud session works fine with every rail off; ask the user before needing live keys.

### Live testnet deployments (public addresses; OrdoTrust v3 and its companions since 5 Nov 2026)

| Rail | Address / id |
|---|---|
| Hedera operator | 0.0.11022138 · HCS topic 0.0.11087048 · passport NFT 0.0.11087232 · agent 0.0.11324776 |
| OrdoTrust (v3) | 0x9294c81d116a9924edbaec601589ab00dca832fc (v2, retired: 0xaed8e264873505bf81a9faba7e1542b07b4e8895) |
| OrdoWorkOrders | 0xffb1d1d8111ec261484db49c9670ccc148ac8e5e |
| OrdoPolicies | 0x6b8a5fac0bfc58010442ec16310cbaec49bd562e |
| Ordo USD (proxy / HTS token) | 0xacb80acbc65d73f4b544e2324fa2f5dcc38c8594 / 0x0000000000000000000000000000000000a9bbad |
| OrdoPayOnProof | 0x792d5049fcaba10c04754a54f3025be19127d22f |
| ENS (Sepolia) | parent ordo-mfg.eth · OrdoEnsRoles 0x100f40fbdec56c458d0aa350b9971040d83eab91 · OrdoLotResolver 0x83bcae34de88b862f9641a408d926e1964b25795 |
| 0G Galileo iNFT | OrdoAgentNFT 0x9577498d6305a8498744ab33217fab6722ff8141 |

### GitHub workflows

The old workflows stayed behind in the deleted `ai_warriors` repo; this repo has none yet. Run the deploy and setup scripts locally (`contracts/README.md#redeploying`).

---

# The approved plan

## Part A: UI system and responsive shell

**Approach.** Keep plain CSS with CSS variables; don't migrate to Tailwind. Rebuild the tokens and the existing component classes in `web/src/styles.css` to reproduce portastake's look, so all 22 pages re-skin at once. Then fix layout page by page for mobile. A Tailwind port would rewrite the markup of about 6,000 lines of pages for no visual gain.

**Tokens** (copied from portastake `frontend/tailwind.config.ts` and `src/styles/index.css`):
- Colors: bg `#FFFFFF`, surface `#FAFAFA`, line `#E5E5E5`, line-strong `#D4D4D4`, fg `#0A0A0A`, fg-muted `#6B6B6B`, fg-subtle `#A3A3A3`, accent `#2563EB` (focus ring and charts only), success `#10B981`, danger `#DC2626`, warn `#B45309` on `#F59E0B1A`.
- Page background: solid `#f4f5fb`. The `body::before` radial gradients are deliberately left out.
- Type: Inter Variable (body, `cv11 ss01 ss03`) and JetBrains Mono for every number (`.num` with `tnum`), both from `@fontsource`. Scale 12/14/16/20/28/40.
- Radii 8/10/12/16 px.
- Glass cards: `rgba(255,255,255,.62)` with `blur(20px) saturate(140%)`, a white/50 border and a black/5 ring. `.card-glass` for heroes and panels, `.card-solid` as the fallback.
- Light theme only, matching the reference: remove `ThemeToggle`, `lib/theme.ts` and the dark token blocks.

**Components** (`web/src/ui/`; keep their APIs so pages keep compiling):
- **Button (`.btn*`):** 44px primary (near-black), secondary, ghost and danger, plus a 36px `sm` for dense rows.
- **Card header:** an uppercase eyebrow title.
- **Chips:** `.chip`, `.chip-success`, `.chip-danger`, plus warn. They replace `tag` and `pill` through aliases.
- **Inputs:** `.input`, 44px.
- **Segmented:** becomes a chip group.
- **Tabs:** chip tabs that scroll horizontally on mobile.
- **`Select.tsx`:** keep the portaled listbox, add the portastake trigger and popover styling, and add a `ChipSelect` variant. On screens under 640px it opens as a bottom sheet with a search field. Remove the fixed `width` props in favour of fluid width.
- **`Calendar.tsx` (DatePicker, DateTimePicker, DateRangePicker):** portal them like `Select` (they are clipped inside modals today). Use 40px day cells, a bottom sheet with one month on mobile, and two months plus presets on desktop. The time picker becomes a chip/listbox matching `Select`.
- **`Modal`:** a centered glass dialog on desktop and a bottom sheet under 640px (portastake HelpDock pattern), with safe-area padding.
- **`Drawer`:** full-screen sheet on mobile.
- **`Menu`:** portaled, a sheet on mobile.
- **Toasts:** restyled, bottom-center on mobile, above the tab bar.
- **Icons:** add `lucide-react` and replace the 12 hand-drawn SVGs in `kit.tsx` `Icon`.
- **Tables:** the shared `table.t` gets a responsive mode. Under 768px each row becomes a stacked card using `data-label` cells; add a small `<RTable>` helper so pages pass column labels once. This covers the 22 tables listed in the exploration.
- **Touch targets:** at least 40px everywhere. Small icon buttons get 40px hit areas.

**Shell (`web/src/Shell.tsx`):**
- **Desktop (1024px and up):** a floating glass sidebar, 240px, fixed, with brand, nav (active item `bg-fg text-bg`), and the user/org chip at the bottom.
- **Under 1024px:** a sticky glass header with brand, org switcher and account; a floating glass bottom tab bar with four primary tabs per role plus "More", which opens a sheet with the rest. No hamburger.
- **Content:** max width 1120px with padding 12/24/32px.
- **Nav filtered by role and level** (Part B).
- **Responsive fixes:** replace the fixed widths found in the exploration with fluid widths: KPI strip (`.kpis.line` about 930px minimum), `.stream .row`, `.split`, `.b-grid`, `.filters .date` (280px), `Select` widths, Drawer and Modal widths. The Builder canvas and graph view stay horizontally scrollable; on mobile the inspector becomes a bottom sheet.

**Pages:** re-skin all of them through the classes. Rebuild the screens that change with Parts B–D (Team, Validators, Onboarding and Open become Join and Team; new Contribute, Contributions, Cases and Rewards screens) directly in the new style.

---

## Part B: Four roles, visibility and open joining

**Roles.** `ROLES = ["manager","validator","tester","contributor"]` in `server/src/domain/types.ts`. Replace `ROLE_RANK` and `canApprove`/`canApproveAny` (`domain/policy.ts`) with capabilities: the manager has all of them; the others get explicit ones (`contribute`, `select_contribution`, `open_case`, `view`). A person can hold several roles; the `memberships` primary key `(site, user, role)` stays.

**Old roles mapped onto the new ones:**
- admin, plant_manager, supervisor, process_engineer and maintenance_lead become **manager**: every `need()` (35 calls in `http/app.ts`) and the checks in `core/*` (`workorders.ts`, `machines.ts`, `autonomy.ts`, `agent-licenses.ts`, `trust.ts`).
- operator becomes **contributor**. The old operator "record stage" path becomes manager-only; contributors work through Part D.
- `VALIDATOR_SCOPES` and the onboarding-validator flow become **validator**.
- Release chain (`core/validation.ts` `CHAIN`): performed by the contributor whose work was selected, reviewed by the validator who selected it, approved by the manager. The manager stakes too.
- Template `escalationRole` (140 stages in `library/templates.json`) and `policies/default.yaml` (`defaultRole`, work-order and inspection roles) become manager.

**On-chain role bits** (keeps the ENS contracts on Sepolia unchanged):
- manager → `ADMIN|PLANT_MANAGER|SUPERVISOR|VALIDATOR`
- validator → `VALIDATOR`
- contributor → `OPERATOR`, so `OrdoLotResolver._proveStages` still accepts their stage readings
- tester → new `TESTER` bit (128)
- `VENDOR` stays for work-order payees, which the manager adds; vendor is not a user role
- ENS `com.ordo.roles` records keep writing the names `OrdoEnsRoles._roleBit` already knows: a manager is written as `admin,plant_manager,supervisor,validator`, a contributor as `operator`, a validator as `validator`. Testers need no ENS bit, because lot releases don't involve them. So `OrdoEnsRoles` and `OrdoLotResolver` on Sepolia are **not** redeployed.

**Visibility: level plus scope.**
- New tables: `role_access(site, role, level, scope_json)` holds each role's defaults; `member_access(site, user, level, scope_json)` holds per-person overrides.
- Levels: 1 stages and status; 2 plus outcomes (counts, pass/fail); 3 plus proofs, measurements and contribution details; 4 everything (agents, wallets, finance, ledger, settings).
- Scope: all, or chosen lines and stages.
- Defaults: contributor 2, validator 3, tester 3 (all lines), manager 4 (fixed).
- **Enforced on the server:** a new `core/access.ts` (`accessOf(principal, site)`, `inScope(...)`) plus a minimum level on each route and redaction of stage, run and live payloads (`/live`, runs, stage drawer, Floor, Finance, WorkOrders, Proof). The web hides what the API doesn't return, and the nav is filtered by role and level.

**On-chain org registration stays (user, 5 Nov).** Creating an org keeps the signed `site.register` → OrdoTrust `registerSite` relay. Today it is a separate button on Team → Validators; move it into the create-org flow: right after `POST /v1/sites`, Setup asks the new manager to sign the registration (when the trust rail is configured), with a "Register on-chain" retry on Team/Settings if they skip it or the relay fails. After the v3 redeploy every org registers again (registration is keyed by contract address already).

**Open joining:**
- `POST /v1/sites/:id/join` lets any signed-in wallet join as a contributor, if the manager has the org open (on by default).
- `Open.tsx` becomes "Explore orgs" with a Join button; joining by code (`Setup.tsx`) stays.
- Team page: the manager promotes people to validator or tester, which goes on-chain through the existing signed `role.grant` relay (`trust.ts` `relayGrant`), and sets each person's level and scope.
- **Removed:** onboarding applications (`ONBOARDING_KINDS`, `ApplyForm`, `ReviewQueue`, `MyApplications`, the onboarding routes). Vendors become a manager "Add vendor" form.

---

## Part C: Contracts v3 (redeploy on Hedera testnet)

**`OrdoTrust`** (`contracts/src/OrdoTrust.sol`):
- `TESTER = 128` in `roleName`.
- `stake` allowed for VALIDATOR or TESTER.
- **Remove** the 2-validators-plus-plant-manager `slash`. **Add a case flow:**
  - `openCase(site, validator, bps, evidenceHash, testerSig)`: the tester must have an active stake and can't be the accused.
  - `respond(caseId, responseHash, validatorSig)`.
  - `decideCase(caseId, uphold, managerSig)`: the manager decides, after the validator responds or the response window ends.
  - If upheld: `stake × bps` is taken; `bountyBps` (default 50%) goes to the tester's claimable balance, the rest to the site treasury (quality fund).
  - If rejected: `falseClaimBps` (default 10%) of the tester's stake goes to the validator's claimable balance.
- **Rewards:**
  - `fundRewards(site)` is payable; the manager funds the pool in HBAR.
  - `recordAcceptance(site, contributionId, contributor, validator, validatorSig)` accrues the contributor reward and validator fee. They vest after a challenge window and are frozen while a case on that acceptance is open.
  - `claim(site)` pays out.
- **Per-site settings, changed with the manager's signature:** reward, fee, challenge window, response window, default and maximum slash, bounty and false-claim percentages.
- **Tests:** extend `contracts/test/trust.test.ts` (12 tests today) with tester staking, the case lifecycle including both payout splits, rewards vesting, freezing and claiming, and signature replay.

**Redeploy alongside it:**
- `OrdoWorkOrders` and `OrdoPolicies` (they hold the trust address as `immutable`), and `OrdoPayOnProof`.
- In OrdoPolicies, change `REQUIRED` from 2 to 1, because the manager has all rights.
- The HCS topic and the passport NFT collection are unaffected. The registrar is the operator, whose key we have.
- Use the existing scripts `deploy:trust` then `setup:hedera contracts` and `payonproof`, then update the addresses in `server/.env`.

**Server:**
- `chain/trust.ts`: new ABI and methods.
- `core/trust.ts`: replace `propose`, `slashRequest` and `signSlash` (`slash_proposals`) with cases; remove the `validator_humans`-era leftovers.
- Hedera schedules (`core/schedules.ts`) also schedule the end of the response window and reward vesting.

---

## Part D: Proof of work through 0G Private Computer

**Network.** Per the user: everything stays on testnet and is switchable per rail. The 0G Private Computer Router defaults to **mainnet**, because the iAI credits live there.

**Config** (`server/src/config.ts`):
- `ZG_ROUTER_NETWORK=mainnet|testnet`. The base URL is derived: `https://router-api.0g.ai/v1` or `https://router-api-testnet.integratenetwork.work/v1`.
- `ZG_ROUTER_MGMT_KEY` (an `mk-` key with the keys and account scopes, created on pc.0g.ai by the wallet holding the credits).
- `ZG_ROUTER_MODEL`: a TeeML model such as `glm-5.3`, validated against `GET /v1/models` (`verifiability == "TeeML"`).
- `ZG_MAINNET_RPC_URL`, used to read TEE signer records.
- 0G Storage and the agent NFTs stay on Galileo testnet.
- **Note:** Ordo's own 0G wallet has 0 0G on mainnet, which is fine because billing goes through the pc.0g.ai account behind the management key. The doctor reports that account's Router balance.

**`server/src/chain/zg-router.ts`** (new):
- `mintSessionKey()`: `POST /v1/api-keys` with `trust_mode: "private"`, so only TEE providers serve it.
- `revokeKey()`, `balance()` (`GET /v1/account/*`), `models()`.
- `verifyReceipt(resKey, provider)`: fetch the provider's signature from `/v1/proxy/signature/<ZG-Res-Key>`, then recover it (EIP-191) and compare with the on-chain `teeSignerAddress` from the InferenceServing contract. This is the same idea as `zerog.ts` `processResponse`.
- **First task is a short spike:** confirm on the public Router which headers or `x_0g_trace` fields carry `ZG-Res-Key` and the provider address.

**Sessions** (new `core/contributions.ts`, tables `contribution_sessions` and `contributions`):
1. The contributor opens a running stage they can see (level 2 or more) and clicks **Contribute proof of work**. The server creates a session (opaque token, stored hashed, 2-hour expiry) and mints a scoped Router key.
2. The modal shows a command to copy: `npx <npm package>@latest <token>`. The token encodes the API base URL plus the session secret. The Router key never appears in the copied text or shell history; the agent fetches it with the token.

**Terminal agent:** a new workspace package `sdk/` (zero dependencies, Node 22, ESM, with a `bin` entry), **published to npm** on the user's logged-in account. Confirm the package name and `npm whoami` before the first publish.
- `GET /v1/pow/session` returns the org, stage, criteria and parameters, an interview guide, and the Router base URL, key and model.
- A chat loop through the Router with `X-0G-Provider-Trust-Mode: private` and tool calling: `record_measurement`, `note`, `attach_evidence(path)` (the file is hashed locally), `finish`.
- It interviews the contributor about what they did, the stage's measurements, evidence and anomalies, and keeps a receipt of every turn (`ZG-Res-Key`, provider, model, hashes).
- `finish` posts the record. The server returns a signing link `<console>/#/pow/sign/<id>`, which the agent prints and opens.
- The agent polls until the contributor has signed, prints the proof link, and the server revokes the Router key.

**Signing and recording:**
- New page `#/pow/sign/:id`. It shows the public summary, commitments and TEE-receipt status; the contributor signs an EIP-712 `OrdoContribution` through the existing `lib/sign.tsx` and the `Signatures.consume` path.
- The server then:
  - seals the full record with `KeyBox` (per site) and keeps an encrypted copy on 0G Storage (existing `Replicas`)
  - commits measured values with Poseidon and proves numeric criteria with the existing `spec-proofs.ts`, so pass/fail is provable without the values
  - writes a ledger entry with `rec.decide`, anchored to HCS
- A stage accepts many contributions, including several from the same person. Validators may contribute too; they sign, but no stake is needed for that.

**What is shown where:**
- **Public proof** (stage drawer, contributor view, public passport): contributor name, time, signature, TEE receipt ✓ (model and provider), commitments, ZK criteria proofs ✓, ledger sequence and HCS anchor. Never the raw answers or measurements.
- **Level 3 and up inside the org:** measurements and the agent's summary.
- **Sealed record:** opened for testers and the manager during a case.

**Doctor and onboarding:**
- New doctor rail "0g private computer": management key valid, balance above 0, TeeML model available.
- A Claude in Chrome note in `local-notes/` to create the `mk-` key on pc.0g.ai (Key Manager plus account:read) with the wallet that holds the iAI credits.

---

## Part E: Selection, rewards, cases and slashing (server and UI)

**Selection:**
- On the stage's contribution list (level 3), a validator with an active stake and the stage in scope, or the manager, clicks **Select as valid** and signs EIP-712 `contribution.select`. They can't select their own contribution.
- **The server then:**
  - marks it selected and the others not selected
  - writes the stage's single `stage_readings` row from the selected contribution (signer kind `contributor`; `stage_readings` stays one per stage, so stage proofs work unchanged), then runs `engine.finishWork`
  - relays `recordAcceptance` to the chain
- The contributor sees "Selected by <validator>" and their pending reward. A validator can also reject all contributions or ask for another.

**Cases:**
- Testers get a **Cases** screen listing stages that went wrong (`done_deviation`, held, failed criteria, or a released lot flagged as defective) with the validator who selected each one.
- **Open a case:** evidence notes, proposed percentage (default 30%, capped by policy), a `slash.open` signature, relayed. The tester can open the sealed record.
- **Response:** the validator answers within the window (48 hours by default) through the inbox (`slash.respond`).
- **Decision:** the manager confirms or rejects (`slash.decide`), and the payouts happen on-chain.

**Rewards page:** pool balance, a fund button (manager), each person's pending and claimable rewards, and claim (from the person's own wallet). Settings get a Rewards section for the per-site parameters.

---

## Part F: Sequence and checkpoints

Each phase ends green: typecheck, server and contract tests, and the app running. The user then reviews and commits.

1. **UI system and shell (Part A)**: tokens, fonts, icons, shell, kit (Select and calendars portaled, sheets), responsive tables, page re-skin, light only.
2. **Roles, visibility, open joining (Part B)**: server and web; update the role-based tests (`flow.test.ts`, `trust.test.ts`, `policy.test.ts`, and others).
3. **Contracts v3 (Part C)**: Solidity and tests, then redeploy on Hedera testnet with the operator key, and update `server/.env`.
4. **0G Private Computer proof of work (Part D)**: the Router spike first. Needs the `mk-` key, which the user gets through Claude in Chrome.
5. **Selection, rewards, cases (Part E)** on the v3 contracts.
6. **Docs, e2e and doctor**: update `README.md`, `docs/proof-of-work.md`, `docs/environments.md` and `.env.example`; Playwright runs at a mobile viewport (390×844) and a desktop one.

## Verification

- **Each phase:**
  - `pnpm -r typecheck`
  - `pnpm --filter @ordo/server test` (197 tests today, updated for the new roles)
  - `pnpm --filter @ordo/contracts test`
  - `pnpm run doctor` (from `server/`)
- **UI:** run `pnpm dev` and check every page at 390, 768, 1024 and 1440px wide with Chrome DevTools MCP screenshots. Dropdowns and calendars open as sheets on mobile and as portaled popovers on desktop, including inside modals. No horizontal overflow except the builder and graph canvases.
- **Roles and access:** a test matrix over the four roles and levels 1–4 asserts which API fields come back, and that out-of-scope stages return 404 or are redacted.
- **Contracts:** an in-process EVM covers stake, case uphold and reject splits, vesting, freeze and claim. After the redeploy, the doctor shows every chain rail green.
- **End-to-end proof of work (manual and scripted):**
  1. Contributor joins openly, opens a running stage, copies the command.
  2. The terminal agent chats through the mainnet Router in private mode; the signing link opens; the contributor signs.
  3. The proof appears with a verified TEE receipt and no raw values.
  4. A second contribution is added.
  5. A validator selects one; the contributor sees it selected; the stage completes with ZK proofs.
  6. A tester opens a case; the validator responds; the manager upholds.
  7. The stake split shows on HashScan; the rewards page shows the frozen or claimable state.

---

# Next: machine bodies, multimedia outcomes, x402 resource agents on Hedera

Approved 5 Nov 2026; full text in `~/.claude/plans/federated-noodling-feigenbaum.md`. Batches, each ending green and pushed:

- **0** ship the built work · **1** review fixes and the v3 redeploy (both done)
- **2** outcomes in the stage spec (≥5 multimedia outcomes per stage: thermal, image, audio, video, spectrum, document, each with a metric), machine output storage and `POST /v1/edge/outputs`
- **3** a machine on every stage (publish and run start refuse without one); Builder outcomes editor; drawer Outcomes panel
- **4** five high-value templates (mAb CHO fed-batch, turbine blade, CFRP wing spar, LPBF rocket injector, satellite integration and test)
- **5** `body/`: the machine's simulator, media rendering, 0G perception and decisions with an episode log on 0G Storage, safe stop, replay
- **6** Vercel Sandbox bodies; Ordo on Render
- **7** stage resources and x402 look-ahead purchasing from vendors
- **8** OrdoTreasury: run budgets and over-budget top-ups as Hedera scheduled transactions the manager approves (HIP-755 `authorizeSchedule`)
- **9** multimodal CLI linked to the machine (review outcomes, voice notes, ask the machine); publish `ordo-pow@0.2.0`
- **10** docs (`machines.md`, `hedera.md`, `templates.md`), doctor rails, status
