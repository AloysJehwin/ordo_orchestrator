# Ordo — contracts and deployment plan

Companion to [technical-requirements.md](technical-requirements.md) (TRD). This file covers **everything on-chain** (accounts, native Hedera resources, Solidity contracts, ENS, 0G) and **everything we deploy** (database, API, web, CI/CD), in the order we do it.

> **Current state (19 Oct 2026).** This plan predates v2. What is built: people sign with their own wallets (no server-held role keys, no scheduled transactions); the contracts are `OrdoTrust`, `OrdoWorkOrders` and `OrdoPolicies` (§4, and [contracts/README.md](../contracts/README.md) for deployment); they deploy from GitHub Actions with the operator key in the `hedera-testnet` environment. Sections 2, 3.2 and 7 describe the original design.

> "Contract" in this file means **smart contracts and on-chain resources**. The **API contract** (zod schemas → OpenAPI) is TRD §3.1 and §11 and is built in milestone M0.

---

## 0. Timing and eligibility

| Work | When | Why |
| --- | --- | --- |
| Accounts, keys, faucets, ENS parent name, GCP / Neon / Vercel setup | **Now** | Setup, not project code |
| Contract **design** (this doc), interfaces in `packages/adapters` | **Now** | Design is allowed prior work |
| Solidity code, chain bootstrap scripts, `packages/adapters-chain` | **At the event (5–7 Nov)** by default | Keeps partner prizes possible (TRD §2) |
| App deployment (API, web, DB, CI/CD) | **Now** | Off-chain core |

If ETHGlobal confirms a pre-existing project is still eligible, or you decide to accept the risk, move the event rows forward. The steps below are identical either way.

---

## 1. On-chain architecture

```mermaid
flowchart LR
    api["Ordo API<br/>(server-held keys)"]
    subgraph hedera["Hedera testnet"]
        hcs["HCS topics<br/>ledger-line02 · build"]
        hts["HTS NFT collection<br/>Ordo Batch (OBATCH)"]
        sch["Scheduled transactions<br/>= approvals"]
        trust["OrdoTrust.sol"]
        reg["OrdoPolicies.sol"]
        vault["OrdoWorkOrders.sol"]
    end
    subgraph eth["Ethereum Sepolia"]
        ens["ENS: ordo-*.eth<br/>subnames + text records"]
    end
    subgraph og["0G testnet"]
        comp["0G Compute (inference)"]
        stor["0G Storage (evidence)"]
    end
    api -- "anchor hashes" --> hcs
    api -- "mint / transfer / freeze" --> hts
    api -- "create; role key signs" --> sch
    api -- "relay signed grants, releases, selections, cases" --> trust
    api -- "publish policy (a manager)" --> reg
    api -- "agent escrows via Agent Kit; people release" --> vault
    api -- "names + records" --> ens
    api -- "root cause" --> comp
    api -- "evidence JSON" --> stor
```

| Component | Type | Needed for | Priority |
| --- | --- | --- | --- |
| HCS ledger topic per line | Hedera native | Audit anchor, Verify page | **Must** |
| HCS build topic | Hedera native | Proof of work at the event | **Must** |
| Role accounts with keys | Hedera native | Approvals enforced on-chain | **Must** |
| Scheduled transactions | Hedera native | Approve = sign | **Must** |
| `OrdoTrust` | Solidity on Hedera EVM | Role credentials, validator and tester stakes, release records; v3: cases and rewards | **Must** (live) |
| `OrdoWorkOrders` | Solidity on Hedera EVM | Agent pays vendors through escrow, within signed caps | **Must** (Hedera agentic-payments qualifier) |
| HTS batch NFTs | Hedera native | Reroute / hold on-chain; tokenization track | Should |
| `OrdoPolicies` | Solidity on Hedera EVM | Which policy and autonomy level each line runs; one plant manager publishes | Should |
| ENS names + text records | Sepolia, existing ENS contracts | Asset and agent identities | Should |
| ENS CCIP-Read gateway (live records) | Off-chain resolver | Creative ENS use | Stretch |
| 0G Compute / Storage | SDK only, no contract | 0G track | Should |

No custom contract is needed for HCS, HTS, ENS or 0G. Three Solidity contracts are ours.

---

## 2. Accounts and keys

All Hedera accounts use **ECDSA secp256k1** keys so the same key works with the Hedera SDK and EVM tools (Foundry, viem). For the MVP the API holds all keys server-side, one per role, and the UI "acting as" switch picks which key signs. Say so in the README. Wallet signing in the browser (HashPack / WalletConnect) is a stretch.

| Account | Holds | Used to | Fund with |
| --- | --- | --- | --- |
| `ordo-admin` | Admin of contracts, topic admin key | Deploy, configure, pause | 200 testnet HBAR |
| `ordo-api` | Topic submit key, HTS supply + freeze key | Write HCS messages, mint / freeze batches, pay fees | 300 HBAR |
| `role-operator` | Key that controls `line-02` | Sign L2/L3 approvals | 20 HBAR |
| `role-plant-manager` | Key required for high-risk approvals | Sign plant-manager approvals | 20 HBAR |
| `role-maintenance-lead` | Key for work-order release | Release vault escrow | 20 HBAR |
| `line-02`, `line-07` | Batch NFTs | Reroute = NFT transfer between them | 10 HBAR each |
| `agent-maintenance` | Caps in `OrdoWorkOrders`, signed by a site admin | Call `OrdoWorkOrders.escrow` via Agent Kit | 20 HBAR |
| `vendor-acme` | Payee | Receives maintenance payments | 1 HBAR |
| EVM wallet (Sepolia) | ENS parent name | Create subnames, set records | 0.2 Sepolia ETH |
| EVM wallet (0G testnet) | 0G tokens | Compute broker deposit, storage fees | Faucet |

**Key handling.** Generate keys locally, store them in a password manager and in Secret Manager. Never commit them, never send them to the browser. `.env.example` lists names only. A `check-balances` script (§7) runs before every demo.

**On-chain role enforcement.** `line-02`'s account key is the operator's key, so a scheduled NFT transfer *out of* `line-02` cannot execute until the operator signs. High-risk reroutes use a `KeyList` threshold key (operator **and** plant manager). The policy guard decides who must approve; Hedera enforces it.

---

## 3. Hedera native resources

Created by one idempotent script, `chain/scripts/bootstrap-hedera.ts`, which writes every id to `chain/deployments/hedera-testnet.json` (committed). Re-running it checks existing ids instead of creating duplicates.

| Resource | Settings |
| --- | --- |
| Topic `ordo-ledger-line02` | `submitKey` = `ordo-api` (only Ordo can write), `adminKey` = `ordo-admin`, memo `ordo:ledger:LINE-02:v1` |
| Topic `ordo-build` | `submitKey` = `ordo-api`, memo `ordo:build` — commit-hash anchors (build plan §1.3) |
| NFT collection `Ordo Batch` / `OBATCH` | Non-fungible, finite supply 10 000, treasury `ordo-api`, `supplyKey` + `freezeKey` = `ordo-api`, no wipe key. Metadata = `ipfs`-free short JSON pointer: `{batch, line, units}` or a 0G Storage root hash |
| Token associations | `line-02`, `line-07` associated with `OBATCH` |

### 3.1 HCS message format (one per ledger anchor)

```json
{ "v": 1, "line": "LINE-02", "fromSeq": 120, "toSeq": 131, "entryHash": "sha256:…", "incident": "INC-0042", "evidence": "0g:0x…" }
```

Kept under the 1 024-byte single-chunk limit. Verify reads it back from the mirror node `GET /api/v1/topics/{topicId}/messages?sequencenumber={n}` and compares `entryHash`.

### 3.2 Approval as a scheduled transaction

1. Guard returns `require_approval(role)`.
2. API builds the inner transaction (e.g. `TransferTransaction` of batch NFT `line-02 → line-07`, or a vault `release` call) and wraps it in `ScheduleCreateTransaction` with memo `ordo:approval:<approvalId>`, paid by `ordo-api`. Store `scheduleId`.
3. UI shows "Awaiting signature from Operator" with the schedule on HashScan.
4. Approve → API submits `ScheduleSignTransaction` signed with that role's key → network executes when the key requirement is met.
5. Reject / override → schedule is left to expire (or deleted with the admin key) and the alternative path runs.
6. API listens on the mirror node for the executed transaction and records `approval.resolved` with the tx id.

Check on the day that the inner transaction type is schedulable (crypto/token transfers are; confirm contract calls on the current release). If contract calls are not schedulable, schedule the HBAR/NFT transfer and call the vault directly after execution.

---

## 4. Solidity contracts (Hedera EVM)

`contracts/src`, Solidity 0.8.x compiled with npm `solc` (no Foundry), OpenZeppelin `ReentrancyGuard` only, `evmVersion: shanghai` so tests run on an in-process EVM. RPC: Hashio testnet `https://testnet.hashio.io/api`, chain id **296**.

Every authorisation is an Ordo EIP-712 signature (`OrdoSignature`, domain `{name: "Ordo", version: "1", chainId}`) — the typed data people sign in the console. Ordo's relayer only pays gas; each contract recovers the signer, checks the action, site and entity, and burns the nonce. `OrdoSigned` holds that logic for the newer contracts.

### 4.1 `OrdoTrust` — who may decide what

Per-org role bits (OPERATOR, SUPERVISOR, VALIDATOR, PLANT_MANAGER, ADMIN, VENDOR, DEVICE, TESTER), granted and revoked with an admin's signature. Ordo's four roles map onto them: a manager holds MANAGER (ADMIN, PLANT_MANAGER, SUPERVISOR and VALIDATOR, 30), a validator VALIDATOR, a tester TESTER; contributors hold none. Validators and testers stake; only an active staked validator's signature can be recorded as a release reviewer or approver. v3 adds cases (a staked tester accuses a validator, a plant manager who is neither party decides, an upheld case cuts the validator's stake), the reward pool for selected proofs of work, and per-org settings a manager signs. v3 is live on Hedera testnet at [`0x9294c81d116a9924edbaec601589ab00dca832fc`](https://hashscan.io/testnet/contract/0x9294c81d116a9924edbaec601589ab00dca832fc) since 5 Nov 2026; the earlier v2 is at `0xaed8e264873505bf81a9faba7e1542b07b4e8895`. Details in [contracts/README.md](../contracts/README.md#ordotrust-v3-four-roles-cases-and-rewards), redeploy steps in [Redeploying](../contracts/README.md#redeploying).

### 4.2 `OrdoWorkOrders` — the agent can pay, but only within hard limits

Why: Hedera's agentic-payments track needs an AI agent to move value. Giving the agent a raw key with a balance contradicts Ordo's safety story; this contract makes the guardrails on-chain.

```solidity
function fund(string siteId) payable;                                                    // anyone
function setAgent(string siteId, address agent, uint256 perOrder, uint256 perDay, OrdoSig sig); // site admin signs "agent.caps"
function setPaused(string siteId, bool stop, OrdoSig sig);                                // admin or plant manager: kill switch
function escrow(string siteId, string workOrderId, address vendor, uint256 amount, uint64 ttl, bytes32 incidentHash); // msg.sender = the agent
function release(string siteId, string workOrderId, OrdoSig sig);                         // supervisor or plant manager signs "workorder.release"
function refund(string siteId, string workOrderId);                                       // anyone, after expiry
function withdraw(string siteId, address to, uint256 amount, OrdoSig sig);                // site admin
```

The roles in the comments are OrdoTrust bits; an org's manager holds every one of them.

Escrow reverts unless the vendor holds the site's `VENDOR` credential in `OrdoTrust`, the amount is within the agent's per-order cap and its per-day total, the site's fund covers it, and the agent is not paused. `incidentHash` links every escrow to the Ordo ledger entry that justified it. State changes before every transfer, and transfers are `nonReentrant` (tested with a malicious vendor).

**Agent Kit wiring:** the maintenance agent has its own Hedera account. On Hedera it escrows through `@hashgraph/hedera-agent-kit` v4 with one custom tool, `ordo_escrow_work_order_tool` (`server/src/chain/agent-kit.ts`), behind an Agent Kit policy that blocks any escrow Ordo did not open (vendor, amount and id must match the work order), and with Agent Kit's HCS audit hook writing each call to the ledger topic. The kit's generic transfer tools are not given to the agent.

### 4.3 `OrdoPolicies` — which policy made the call

```solidity
struct Update { string lineId; uint8 level; bytes32 policyHash; uint32 version; }
function publish(string siteId, Update u, OrdoSig[] sigs);   // each signs "policy.publish", entity "<line>#L<level>#<hash>#<version>"
```

One plant manager's signature publishes, raises or lowers a line's policy (`REQUIRED = 1`): an org's manager holds every right. More may sign, each a different plant manager. Ordo publishes each applied change.

### 4.4 Deployment

From GitHub Actions, with the operator account in the `hedera-testnet` environment: **Deploy OrdoTrust** and **Hedera setup** (`topic`, `contracts`, `agent`). See [contracts/README.md](../contracts/README.md). The logs print only public values; the agent's key goes straight to Vercel.

Contracts are **immutable** — no proxies. A fix means deploying a new address and updating the `TRUST_*` variables. Fine for a testnet MVP and easier to audit.

---

## 5. ENS (Sepolia, ENSv2)

1. **ENS setup** workflow (`contracts/scripts/ens-setup.ts`): deploys Ordo's `PermissionedResolver` and a `UserRegistry` through ENS's `VerifiableFactory`, registers `<label>.eth` on the v2 `ETHRegistrar` pointing at both, and writes `ENS_PARENT_NAME`, `ENS_REGISTRY_ADDRESS`, `ENS_RESOLVER_ADDRESS` and `ENS_OWNER_KEY` to Vercel.
2. The app (`server/src/core/names.ts`) reconciles names in the engine cycle: the site gets `<site>.<parent>` and its own `UserRegistry` (ENSv2's per-name registries); people, assets and agents get names in it.
3. People's names are minted to their wallet with an empty role bitmap: the holder cannot transfer or repoint the name, and the site, which keeps the registry's root roles, unregisters it when the person holds no role. A role change updates the records.
4. Records (Ordo's resolver): `addr` (people, and the maintenance agent's account), `description`, `url`, `com.ordo.type` (`site` / `person` / `asset` / `agent`), `com.ordo.site`, `com.ordo.roles`, `com.ordo.validator` (scope), `com.ordo.signed` (validation signatures given at the site), `com.ordo.kind` (assets), `com.ordo.status` (`revoked`).
5. Names show wherever a person's address does: the team list and the public lot passport.
6. **Names as credentials** (`OrdoEnsRoles`): a wallet holds an on-chain role at a site only while it owns its member name and the name's `com.ordo.roles` / `com.ordo.validator` records grant it. Revoking the name revokes the role in every contract that asks. Deployed with `contracts <url>` in `.github/deploy/ens.request` (`contracts/scripts/ens-contracts.ts`), which sets `ENS_ROLES_ADDRESS` and `ENS_LOT_RESOLVER_ADDRESS`. Live on Sepolia at [`0x100f…ab91`](https://sepolia.etherscan.io/address/0x100f40fbdec56c458d0aa350b9971040d83eab91) (24 Oct 2026).
7. **Lot names** (`OrdoLotResolver`, `server/src/core/lot-names.ts`): the app links each site in `OrdoEnsRoles` and points the site name at the lot resolver, so `lot-<order>.<site>.<parent>` resolves for every lot with no gas. Released validation packages are recorded on the lot's name with their three signatures and their proofs: `OrdoStageVerifier` checks each stage's count proof and `OrdoSpecVerifier` each source-signed parameter proof, the signers' member names must hold the device or operator role, and the folded root must match the one the three signed. Signatures are accepted only from credentialed member names (`com.ordo.release`, `.package`, `.signers`, `.at`, `.count`). Other records (`url` to the passport, `com.ordo.status`, `com.ordo.product`, `com.ordo.order`, `com.ordo.quantity`, `com.ordo.nft`) come from the CCIP-Read gateway at `/v1/public/ens/{sender}/{data}.json`, signed with the ENS owner key. Live on Sepolia at [`0x83bc…5795`](https://sepolia.etherscan.io/address/0x83bcae34de88b862f9641a408d926e1964b25795), with `OrdoStageVerifier` [`0xadf0…3d22`](https://sepolia.etherscan.io/address/0xadf064b185151dad607a86f48166c36df1333d22) and `OrdoSpecVerifier` [`0xd4c4…ed17`](https://sepolia.etherscan.io/address/0xd4c4b8438c6519d6830668365068560e0239ed17) (24 Oct 2026).

---

## 6. 0G (no contracts)

- Wallet funded from the 0G faucet; RPC `https://evmrpc-testnet.0g.ai`.
- **Compute:** create the serving broker, deposit to the ledger account, `listService()` to pick a model (testnet showed Qwen 2.5 7B, GPT-OSS-20B, Gemma 3 27B), call through the OpenAI-compatible endpoint with single-use request headers. Store `providerAddress` + `model` with each decision.
- **Storage:** `@0gfoundation/0g-ts-sdk`, indexer `https://indexer-storage-testnet-turbo.0g.ai`; upload evidence JSON, keep the Merkle root hash; download with proof on Verify.
- Package names differ between 0G pages (`@0glabs/0g-serving-broker` vs `@0gfoundation/0g-compute-ts-sdk`). Pick the one the current quickstart uses on the day.

---

## 7. Chain scripts (all in `chain/scripts/`, run with `pnpm chain:<name>`)

| Script | Does | Run |
| --- | --- | --- |
| `create-accounts` | Creates the Hedera accounts in §2, prints ids and keys once | Once |
| `bootstrap-hedera` | Topics, NFT collection, associations; writes deployments file | Once, idempotent |
| `deploy-evm` | Wraps `forge script` + verify + ABI export | Once per contract version |
| `ens-setup` | ENSv2 parent name, Ordo's registry and resolver | Once |
| `check-balances` | HBAR per account, vault balance, 0G balance + broker deposit, Sepolia ETH; fails under thresholds | Before every demo, and in CI nightly |
| `smoke-chain` | One HCS message, one schedule create+sign, one vault escrow+release, one ENS read, one 0G call; prints HashScan links | After any chain change |
| `anchor-build` | Posts `git rev-parse HEAD` to the build topic | Every ~3 h at the event |

---

## 8. Application deployment

### 8.1 Environments

| Env | Web | API | DB | Chains | LLM |
| --- | --- | --- | --- | --- | --- |
| Local | `pnpm dev` :3000 | `pnpm dev` :8080 | Docker Postgres 16 | Local adapters (or testnet with your own keys) | Recorded or Gemini |
| Preview (per PR) | Vercel preview | — (uses demo API, read-only) or local | — | — | — |
| Demo (prod) | Vercel production | Cloud Run `ordo-api`, region **asia-south1 (Mumbai)** | Neon `main` | Testnets | Gemini live, recorded fallback |

### 8.2 One-time setup, in order

1. **Rename the repo to `ordo` first.** Workload Identity Federation (step 4) is bound to the repo name.
2. **GCP project** `ordo-demo`: billing on, **budget alert at USD 20**. Enable `run`, `artifactregistry`, `secretmanager`, `iamcredentials`, `sts`, `logging`.
3. **Artifact Registry** Docker repo `ordo` in `asia-south1`.
4. **Service accounts.** `ordo-api-runtime` (Secret Manager accessor only). `ordo-deployer` (Cloud Run admin, Artifact Registry writer, act-as `ordo-api-runtime`). **Workload Identity Federation** pool + GitHub OIDC provider with attribute condition `assertion.repository == 'AloysJehwin/ordo'`. No JSON keys anywhere.
5. **Neon** project in an Asia region; database `ordo`; copy the **pooled** URL (app) and **direct** URL (migrations).
6. **Secret Manager:** `DATABASE_URL`, `DATABASE_URL_DIRECT`, `GEMINI_API_KEY`, `LEDGER_SIGNING_KEY`; event-time additions: `HEDERA_*`, `ZG_*`, `ENS_*` keys.
7. **Vercel** project from the repo, root `apps/web`, env `NEXT_PUBLIC_API_URL` = Cloud Run URL. Previews on PRs, production on `main`.
8. **GitHub:** branch protection on `main` (CI green + 1 review); repo variables `GCP_PROJECT`, `GCP_REGION`, `WIF_PROVIDER`, `DEPLOYER_SA`.

### 8.3 API container

Multi-stage Dockerfile at `apps/api/Dockerfile`: build with pnpm + Turborepo, `pnpm deploy --filter api --prod /out`, run as non-root on `node:22-slim`, listen on `$PORT`, `/health` for probes.

### 8.4 Cloud Run settings (and why)

| Setting | Value | Reason |
| --- | --- | --- |
| Min / max instances | **1 / 1** | Simulator, in-process event bus and single ledger writer live in one process. Two instances would run two plants and fork the ledger |
| CPU | Always allocated, 1 vCPU, 1 GiB | Simulator ticks and SSE need CPU between requests |
| Request timeout | 3600 s | SSE streams; the client reconnects with `Last-Event-ID` |
| Concurrency | 80 | Plenty for a demo |
| Ingress | All; CORS limited to the Vercel domains | |
| Startup probe | `/health` | |

Scaling past one instance later means moving the bus to Pub/Sub or Postgres `LISTEN/NOTIFY` and the simulator to a separate job. Not needed for the MVP.

### 8.5 CI/CD workflows (`.github/workflows/`)

| Workflow | Trigger | Steps |
| --- | --- | --- |
| `ci.yml` | Every PR and push | pnpm install (cached) → Biome → typecheck → unit → integration (Postgres service container) → Playwright e2e in recorded mode |
| `contracts.yml` | PR touching `chain/evm/**` | `forge fmt --check`, `forge build`, `forge test` incl. fuzz and invariants |
| `deploy-api.yml` | Push to `main` touching `apps/api`, `packages/**` | auth (WIF) → build + push image tagged with commit SHA → **migrate** (direct URL, backward-compatible migrations only) → deploy Cloud Run → smoke `/health` + `/v1/openapi.json` + recorded scenario → on failure, route traffic back to the previous revision |
| Web | Vercel Git integration | Automatic previews and production |
| `chain-deploy.yml` | **Manual only** (`workflow_dispatch`, environment with required reviewer) | Runs a named chain script with secrets; never automatic |
| `nightly.yml` | Cron | `check-balances`, Playwright against production, live LLM smoke |

### 8.6 Rollback

- API: `gcloud run services update-traffic ordo-api --to-revisions=<previous>=100 --region asia-south1`.
- Web: Vercel "Instant Rollback" to the previous production deployment.
- DB: migrations are additive; Neon point-in-time restore as last resort.
- Contracts: deploy a new address and update `deployments/*.json`; the old one stays paused.

---

## 9. Demo-day runbook

1. **T-24 h:** `pnpm chain:check-balances`; top up from faucets. Re-check SDK versions and the Gemini model id.
2. **T-2 h:** confirm Cloud Run min instance is warm; `POST /v1/sim/reset`; reseed DB; run `smoke-chain`.
3. **T-15 min:** open dashboard, Ledger and HashScan tabs; set `DEMO_MODE=live`; keep the recorded-mode URL and the backup video ready.
4. **During:** if an LLM or chain call exceeds its budget, the app falls back automatically and labels it; keep going.
5. **After:** export the incident's ledger and HashScan links for the submission.

---

## 10. Step-by-step order (who and when)

| # | Step | Owner | When |
| --- | --- | --- | --- |
| 1 | Rename repo to `ordo` | Aloys | Today |
| 2 | GCP project, budget, APIs, Artifact Registry, service accounts, WIF (§8.2 1–4) | Srushti | 20 Oct |
| 3 | Neon DB, Secret Manager entries, Vercel project (§8.2 5–8) | Aloys | 20 Oct |
| 4 | Monorepo scaffold, `ci.yml`, Dockerfile, `deploy-api.yml`; `/health` live on Cloud Run, shell live on Vercel | Both | 21 Oct (TRD M0) |
| 5 | Hedera accounts created + funded; keys in password manager | Srushti | by 25 Oct |
| 6 | Sepolia ENS parent name registered and wrapped; 0G wallet funded | Aloys | by 25 Oct |
| 7 | Contract and script **designs** reviewed against this doc (no code) | Both | by 1 Nov |
| 8 | Tag `pre-ethglobal`, write `PRIOR_WORK.md` | Both | 4 Nov |
| 9 | Event: `bootstrap-hedera`, HCS anchor adapter, first build anchor | Srushti | Event h 0–4 |
| 10 | Event: Foundry contracts + tests, deploy + verify, policy hash set, vault funded | Srushti | Event h 4–14 |
| 11 | Event: scheduled-transaction approvals, Agent Kit vault tool, batch NFTs | Srushti | Event h 14–24 |
| 12 | Event: 0G compute + storage adapters, ENS bootstrap + names in UI | Aloys | Event h 4–24 |
| 13 | Event: `smoke-chain`, `check-balances`, production deploy, demo run, submission | Both | Event h 24–34 |

If you decide to build the chain parts before the event, steps 9–12 move to 26 Oct–1 Nov with no other change.
