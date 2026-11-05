# Web3 roadmap: roles, onboarding, staking, and the prize tracks

Written 19 Oct 2026, 17 days before ETHGlobal Mumbai (5–7 Nov). Mumbai's sponsor track rules are still "coming soon"; the shapes below come from ETHOnline 2026 (Sep 2026), the most recent event with the same sponsors. Re-check https://ethglobal.com/events/mumbai/prizes when rules land.

## What the sponsors reward right now

| Sponsor (Mumbai pool) | Recent track shape | What qualifies |
| --- | --- | --- |
| Hedera (USD 15k) | AI & Agentic Payments 6k (3 × 2k) · Tokenization of Anything 6k · Improve the Hedera Harness 2k · Continuity 1k | An agent that executes a payment on Hedera testnet with Hedera Agent Kit or x402; public repo; demo ≤ 5 min |
| 0G (USD 15k) | Best AI product on 0G | Inference on 0G Compute, data on 0G Storage, agents as ERC-7857 iNFTs |
| ENS (USD 10k) | Best Use of ENSv2 4.5k · Best Integration 0.5k (Continuity only) | Built on ENSv2 (Sepolia), with ENSv2 central to the product, not cosmetic |

Ordo is pre-existing work, so every track entered must also respect the Continuity rules (document what existed before the event).

## 1. Who can do what: roles become on-chain credentials

Today roles live in Postgres and are enforced by the server. For the hackathon, each role becomes a **non-transferable credential** that a contract can check, so "only a validator can validate" is enforced on-chain, not only in our API.

| Persona | Credential | Can | Earned by |
| --- | --- | --- | --- |
| Site admin | `ADMIN` | Approve onboarding, set policy | Creating the site |
| Operator | `OPERATOR` | Record units, hold a stage | Onboarding form + admin approval |
| Supervisor | `SUPERVISOR` | Start runs, release supervisor gates | Onboarding form + admin approval |
| **Validator** | `VALIDATOR` (+ scope: quality, process, plant) | Sign validation packages and quality gates | Onboarding form + qualification evidence + admin approval + **stake** |
| Maintenance vendor | `VENDOR` | Accept work orders, get paid by agents | Vendor form + **bond** |
| Agent | iNFT (ERC-7857) | Act within policy | Minted per agent with its policy hash and model id |
| Auditor / customer | none | Read and verify | Wallet only |

The existing roles map onto this: quality engineer, process engineer and plant manager become validator scopes; separation of duties (one signature per person per package) already exists in the server.

## 2. Onboarding flows ("entries")

Each flow is a form in the console, an admin review in the inbox, and an on-chain mint at approval. Every step writes to the ledger.

1. **Site onboarding.** Name, time zone, lines, zones (exists), plus an ENSv2 name for the site (`pune-plant-1.ordo.eth`) and the policy hash published to `OrdoPolicyRegistry`.
2. **Person onboarding.** Invite by wallet (exists) → the person fills a form: name, requested role, employee id, training certificates (files hashed, stored on 0G Storage) → admin approves in the inbox with an EIP-712 signature → credential minted and an ENS subname issued (`priya.pune-plant-1.ordo.eth`) with text records for role and site.
3. **Validator onboarding.** Person onboarding plus qualification evidence (for example an ISO 9001 auditor or GMP training certificate) and a **stake** of N HBAR into `ValidatorStaking`. Only an active, staked validator's EIP-712 signature counts in a validation package's chain.
4. **Vendor onboarding.** Company, wallet, service categories, hourly rate, response-time commitment, and a **bond**. Agents can only pay allow-listed vendors (`AgentSpendVault` already enforces this).
5. **Asset onboarding.** Register the machine (exists), give it an ENS subname (`cnc-05.pune-plant-1.ordo.eth`) with its limits and data source as text records, then run an **operational qualification** package. When validators release it, the asset joins its agent's pool, a flow the product docs already describe.
6. **Agent onboarding.** Each of the 8 agents is minted as an iNFT holding its scope, policy hash and model id; autonomy changes update it.

## 3. Staking, bonds and slashing

- **Why a stake.** A validator's signature releases product to customers. A stake makes a careless signature expensive, and turns "trust the QE" into "the QE has skin in the game", a strong judging story.
- **Mechanics** (`ValidatorStaking` on Hedera EVM): stake ≥ minimum to activate; unstaking has a 7-day cooldown so open disputes can still act; the stake is locked while the validator has a release inside its warranty window.
- **Slashing, carefully.** Only through a **recall package**: a new validation package that proves a released lot was defective, signed by two other validators and the plant manager. Slashed stake goes to a quality fund, not to the accusers, so nobody profits from a recall. Any automatic, agent-triggered slashing would be unfair and hard to defend to judges; avoid it.
- **Vendor bond.** A vendor that misses the response window on a work order loses a fixed share of its bond to the plant; one that delivers gets paid from the vault and its reputation record (on its ENS name) is updated.

## 4. The other web3 pieces worth building, ranked

| # | Implementation | Prize track | Why judges like it | Effort |
| --- | --- | --- | --- | --- |
| 1 | **HCS ledger anchoring live** (adapter exists) | Hedera | Every decision provable with HashScan links | S: needs a Hedera operator account |
| 2 | **Agents pay vendors** for work orders through Hedera Agent Kit, capped by `AgentSpendVault` | Hedera AI & Agentic Payments | This is the track's exact qualification | M |
| 3 | **Validator staking + role credentials** (sections 1–3) | Hedera; also strengthens every demo | "Only a staked validator can release product" on-chain | M |
| 4 | **Lot passport as an HTS NFT**: each production lot minted at run start, stage results and signatures appended, frozen when held, transferred to the customer on ship | Hedera Tokenization of Anything | Real regulation: the EU Digital Product Passport | M |
| 5 | **Public passport page**: a QR code on the shipped lot opens a page anyone can verify against HCS and the NFT | Hedera, ENS | Makes the proof tangible in a 5-minute demo | S |
| 6 | **ENSv2 names** for sites, people, assets and agents, with roles, limits and reputation as records; the console resolves names everywhere | ENS Best Use of ENSv2 | ENSv2 is central (identity and permissions), as the rules require | M |
| 7 | **0G Storage for evidence files** (Merkle root recorded in the ledger) and **0G Compute** for root-cause analysis | 0G | Verifiable AI and data, adapters partly exist | M |
| 8 | **Agents as iNFTs (ERC-7857)** with policy hash and model id | 0G | Agent identity and accountability | S–M |
| 9 | **x402 pay-per-call**: an agent buys an external inspection or data service per request | Hedera AI & Agentic Payments | Second qualifying payment path | M |
| 10 | **Threshold approvals**: autonomy L4 or a policy change needs 2-of-3 plant managers (Hedera threshold key or a Safe) | Hedera | Shows governance, not just logging | S–M |
| 11 | **Gasless smart wallets for the shop floor** (passkeys, sponsored gas) so operators never see a seed phrase | All | Adoption realism; strong UX point | M |
| 12 | **World ID** proof-of-personhood for signers (one human, one signer) | World (if Mumbai allows web apps) | Maps to 21 CFR Part 11 "unique signature" | M; may require a Mini App |
| 13 | **Chainlink** feeds machine data on-chain to settle vendor SLA disputes | Chainlink (5k, crowded) | Oracle use is real but secondary | M |

## 5. Recommended scope for the 17 days

Build in this order; stop at any line and still have a coherent demo.

1. Hedera operator account, HCS anchoring live, policy hash in `OrdoPolicyRegistry` (#1).
2. `OrdoRoles` credentials + `ValidatorStaking`, onboarding forms for people, validators and vendors, validator-only signatures checked on-chain (#3).
3. Agent pays the vendor for a work order through Agent Kit within the vault caps (#2).
4. Lot passport HTS NFT + public QR verify page (#4, #5).
5. ENSv2 names for site, people and assets with role and reputation records (#6).
6. 0G Storage for evidence and iNFT agents (#7, #8) if time remains.

That covers three sponsors with one coherent story: **a staked, named, accountable human signs; an accountable agent acts and pays within on-chain limits; every lot carries its proof to the customer.**

## 6. Demo script (5 minutes)

1. A validator onboards: fills the form, stakes HBAR, receives `priya.pune-plant-1.ordo.eth` with a validator credential.
2. A run starts; its lot is minted as a passport NFT.
3. A machine drifts; the agent opens a work order and pays the bonded vendor through Agent Kit, inside the vault cap.
4. The gate waits; an unstaked person's signature is rejected on-chain; Priya signs and the gate releases.
5. Scan the shipped lot's QR: the public page verifies the passport, the HCS trail and the validator's stake.

## 7. Testnets and what each one hosts

One ECDSA key can deploy on all three chains: its EVM address is derived from the key, so fund that address from each faucet. Keep each chain's key in its own GitHub environment; list the ones the app needs in `.github/vercel-secrets.map` and the **Sync secrets to Vercel** workflow copies them (names only in logs).

| Testnet | Chain id | Hosts | Items | Status | You provide |
| --- | --- | --- | --- | --- | --- |
| **Hedera testnet** | 296 | `OrdoTrust`; HCS ledger topic; agent and vendor accounts; `AgentSpendVault` + `OrdoPolicyRegistry`; lot passport HTS NFT collection; x402 settlement | #1 #2 #3 #4 #9 #10 | `OrdoTrust` live | Done: `hedera-testnet` environment. Later: an agent account (ECDSA) as `HEDERA_AGENT_ID` / `HEDERA_AGENT_KEY` |
| **Ethereum Sepolia** | 11155111 | ENSv2 parent name, subnames for site, people, assets and agents, text records | #6 | Not started | `sepolia` environment with `ENS_OWNER_KEY`; Sepolia ETH on its address. Confirm at the event that ENSv2 is still judged on Sepolia |
| **0G Galileo testnet** | check docs.0g.ai | 0G Storage for evidence files, 0G Compute for root-cause analysis, ERC-7857 agent iNFT contract | #7 #8 | Adapters partly exist | `zerog-testnet` environment with `ZG_PRIVATE_KEY`; 0G faucet tokens on its address |

Item #5 (public passport page) is a web route and needs no chain of its own.

## 8. Plan for the ten items

Each item lands as: a deploy workflow (like `deploy-trust.yml`) that prints only public values; public variables set in Vercel; secrets added to the map; tests on an in-process EVM or a mocked SDK; a demo step. Ordo is pre-existing work: record the baseline commit before 5 Nov and keep one visible, scoped item (suggested: #5 and the demo polish) for the event weekend.

| # | Item | Testnet | Build | Deploy and configure | Demo moment | Effort | When |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | HCS ledger anchoring live | Hedera | Adapter exists; add a workflow that creates the topic | `HEDERA_TOPIC_ID`, `ANCHOR=hedera`; operator id and key via the map | Proof page links each anchor to HashScan | 0.5 day | 20 Oct |
| 2 | Agents pay vendors (Agent Kit) | Hedera | Hedera Agent Kit tool behind the `open_work_order` action; vendor allow-list and caps from `AgentSpendVault`; payment written to the ledger | Run `bootstrap:hedera` and `deploy-hedera.ts` from a workflow; `HEDERA_AGENT_*`, `HEDERA_VENDOR_*`, `HEDERA_VAULT_ADDRESS`, `HEDERA_POLICY_REGISTRY_ADDRESS`, `PAYMENTS=hedera` | Drift opens a work order and the agent pays the bonded vendor inside the cap | 3 days | 21–23 Oct |
| 3 | Validator staking and role credentials | Hedera | Done | Done; needs `TRUST_RELAYER_KEY` in Vercel | An unstaked signature is rejected on-chain | Done | — |
| 4 | Lot passport HTS NFT | Hedera | Mint at run start (metadata = run, lot, template version); append stage results and signatures as HCS messages keyed to the serial; freeze on hold; transfer on ship | Workflow creates the NFT collection (supply, freeze and pause keys = operator); `HEDERA_PASSPORT_TOKEN_ID` | Run start mints serial #n; hold freezes it | 3 days | 24–27 Oct |
| 5 | Public passport page + QR | — | `#/passport/<token>/<serial>` without sign-in: verifies NFT state, the HCS trail and the releasing validators' stakes; QR on the run and release views | None | Scan the shipped lot's QR | 1 day | 28 Oct |
| 6 | ENSv2 names | Sepolia | Register the parent name; issue subnames at onboarding approval (people) and asset registration; role, site and reputation as text records; resolve names everywhere an address shows | Workflow runs `ens-bootstrap.ts`; `ENS_RPC_URL`, `ENS_PARENT_NAME`, `IDENTITY=ens`; `ENS_OWNER_KEY` via the map | The validator receives `priya.<site>.ordo…eth` on approval | 3 days | 29 Oct–1 Nov |
| 7 | 0G Storage and Compute | 0G | Evidence blobs uploaded to 0G Storage with the Merkle root in the ledger; root-cause analysis on 0G Compute with the provider's signed response stored | `ZG_RPC_URL`, `ZG_INDEXER_URL`, `ZG_PROVIDER_ADDRESS`; `ZG_PRIVATE_KEY` via the map; deposit to the compute ledger once | Evidence file shows its 0G root; diagnosis shows "verified on 0G Compute" | 2 days | 2–3 Nov |
| 8 | Agents as ERC-7857 iNFTs | 0G | Contract holding policy hash, model id and autonomy level; mint one per agent; autonomy changes update it | Workflow deploys it; `ZG_INFT_ADDRESS` | Agent page links to its iNFT | 1 day | 4 Nov |
| 9 | x402 pay-per-call | Hedera | An agent buys an external inspection report per request: Ordo hosts a paid `/v1/x402/inspection` endpoint and the agent pays it through an x402 facilitator | Facilitator URL; agent key reused. Confirm a Hedera testnet facilitator exists before building | Second payment path in the agent log | 2 days | Event weekend, if confirmed |
| 10 | Threshold approvals | Hedera | Raising autonomy to L4 or publishing a policy needs 2 of 3 plant manager signatures, checked by the contract against `OrdoTrust` roles | Redeploy `OrdoPolicyRegistry` with the threshold check | The third signature publishes the policy hash on-chain | 1.5 days | 24 Oct, alongside #4 |

**Priority if time runs short.** Must: #1, #2, #3, #4, #5 (Hedera Agentic Payments and Tokenization). Should: #6 (ENS), #10. Could: #7, #8 (0G), #9.

## Status

- **Done: roles, onboarding, validators, staking and slashing (#3).** `contracts/src/OrdoTrust.sol` keeps role credentials per site, granted only with a site admin's EIP-712 signature; validator stakes with a 7-day unstake cooldown; release records that require a staked reviewer and a staked plant manager; and slashing by two other active validators plus a plant manager into the site's quality fund. The contract verifies the same `OrdoSignature` typed data people sign in the console, so the relayer has no authority.
- **In the app:** applications to join a site (by site code), to become a validator, and to register as a vendor, with files hashed on upload; an Applications queue where admins approve or decline by signature; a Validators tab with stake, request-unstake and withdraw from the person's own wallet, and slash proposals; validation "Reviewed by" / "Approved by" and quality-gate releases accepted only from validators (and, with OrdoTrust configured, only from validators with an active stake); released packages recorded on-chain.
- **Tested:** 8 contract tests on an in-process EVM; an API test that deploys OrdoTrust and runs registration, signed grants, staking, an on-chain release and a slash; the browser flow with validator onboarding.
- **Deployed:** OrdoTrust is live on Hedera testnet at [`0xbb744b4a87aef7996537f5583e71ec14e093ffc0`](https://hashscan.io/testnet/contract/0xbb744b4a87aef7996537f5583e71ec14e093ffc0) (deploy tx [`0xe2bb91fd…d65447`](https://hashscan.io/testnet/transaction/0xe2bb91fdf32724b99f7f69fbe4ef9610b3550f8fd5ad762e864f7ca8f7d65447)), minimum stake 10 HBAR, 7-day unstake cooldown. It was deployed by the `Deploy OrdoTrust` workflow (`.github/workflows/deploy-trust.yml`) from the `hedera-testnet` environment's operator key.
- **Done: agents pay vendors (#2) and threshold approvals (#10).** `OrdoWorkOrders` holds a fund per site; the maintenance agent escrows from its own account, within per-order and per-day caps an admin signed, only to holders of the site's `VENDOR` credential; a maintenance lead's signature releases the money; an unreleased escrow is refunded after 72 hours; an admin or plant manager can stop the agent. On Hedera the escrow is a Hedera Agent Kit tool (`ordo_escrow_work_order_tool`, `@hashgraph/hedera-agent-kit` v4), guarded by an Agent Kit policy that only allows work orders Ordo opened and audited to the ledger topic by Agent Kit's HCS hook. `OrdoPolicies` and the app require two plant managers to raise a line's autonomy and one to lower it. The old `AgentSpendVault`/`OrdoPolicyRegistry` pair is retired: the new contracts read credentials from `OrdoTrust` instead of their own allow-lists.
- **Deployed by the Hedera setup workflow:** ledger topic [`0.0.11087048`](https://hashscan.io/testnet/topic/0.0.11087048), `OrdoWorkOrders` [`0x194a…441f`](https://hashscan.io/testnet/contract/0x194a5556707d7249f6729cc7257b435395e2441f), `OrdoPolicies` [`0x7ba9…42eb`](https://hashscan.io/testnet/contract/0x7ba973ee8c3d586e1d2e46e723191d00b84b42eb), the lot passport collection [`0.0.11087232`](https://hashscan.io/testnet/token/0.0.11087232) and the maintenance agent's account [`0.0.11087374`](https://hashscan.io/testnet/account/0.0.11087374). The operator, relayer and agent keys are synced to Vercel, so production is configured for HCS anchoring (#1), on-chain credentials, agent payments and passport NFTs.
- **Done: lot passports (#4) and the public passport page (#5).** Every run gets a passport. With `HEDERA_PASSPORT_TOKEN_ID` set, the operator mints it as an HTS NFT whose metadata is the URL of the passport's HIP-412 JSON; the engine cycle updates the metadata when the lot is held, completed or shipped (HIP-657), so the NFT's history follows the lot on HashScan; a supervisor's signed shipment airdrops it to the customer (HIP-904, pending until claimed if the account is not associated). The QR code opens `#/passport/<run>`, which needs no account: product and quantity, every stage with its criteria, each signed decision by wallet address, validation releases with the signers' current stake and the on-chain release record, and the ledger re-walked with the anchor that covers the lot.
- **Done: x402 pay-per-call (#9).** Ordo sells a vibration assessment (ISO 10816-3 zone, trend, time to zone D) at `POST /v1/x402/vibration-assessment` for 0.1 HBAR a call over x402 v2 (`@x402/hedera` exact scheme, public facilitator `x402.org/facilitator`, which pays the fees). When the agent opens a work order it buys one with its own Hedera account through `@x402/fetch`, capped per call by x402 spend controls; the job queue retries a failed purchase, and the assessment, its HashScan payment link and a ledger decision show on the work order. A request that fails is never charged. `GET /v1/x402` lists the offer.
- **Done in code: ENSv2 names (#6).** The site gets `<site>.<parent>` with its own `UserRegistry`; each person a name in it minted to their wallet (empty role bitmap: not transferable, revoked by the site when they hold no role) with their roles, validator scope and signature count as text records; each asset and agent a name too. Names show in the team list and on the public passport. Tested on the real ENSv2 contracts (deployed on anvil in CI). **Live:** [`ordo-mfg.eth`](https://sepolia.app.ens.domains/ordo-mfg.eth) is registered on ENSv2 (Sepolia), registered by the ENS setup workflow ([register tx](https://sepolia.etherscan.io/tx/0x577bd696504ef1b1e63bb9a7968b116d985ae87f5d5a34ef9007df6042e1162d)); Ordo's `UserRegistry` is `0x1F621f14718a9251b74F1683D6F1D5F8E9889358` and its `PermissionedResolver` `0xC2992b48350F642cd820a22DAf5ffaDB6e26566C`, owned by `0x38e6C7622b2E9BdcB16821E88083274489625b74`, whose key the workflow generated and keeps in Vercel.
- **Done in code: 0G Storage and Compute (#7).** With `EVIDENCE_STORE=0g`, each validation evidence file is copied to 0G Storage (encrypted with AES-256 under a key derived from Ordo's 0G key) by the job queue; the Merkle root and submission transaction go into the ledger and show on the evidence, and "verify" downloads the copy, decrypts it and checks it byte for byte. With `LLM_PROVIDER=0g`, diagnosis and recommendations run on 0G Compute through `@0gfoundation/0g-compute-ts-sdk`; each answer's chat id is checked against the provider's TEE signature (`processResponse`) and the decision records whether it verified. **Live:** `EVIDENCE_STORE=0g` is set in production. **Still to do:** 0G Compute needs its ledger funded (3 0G minimum, more than the faucet's daily amount: ask 0G at the event), then `ledger` in `.github/deploy/zerog.request` and `LLM_PROVIDER=0g`.
- **Done in code: agents as ERC-7857 iNFTs (#8).** `OrdoAgentNFT` follows ERC-7857's metadata and authorization interfaces (`IntelligentData`, `intelligentDatasOf`, `Updated`, `authorizeUsage`, `authorizedUsersOf`): each agent of each site is a token whose data hashes are its policy, model, per-line autonomy and scope. The engine cycle mints the tokens and updates them when one of those changes, so raising a line's autonomy appears as an `Updated` event on every agent's token; the site's plant managers are its authorized users; tokens do not transfer. The Agents tab links each agent to its token. Tested on anvil. **Live:** `OrdoAgentNFT` [`0x9577…8141`](https://chainscan-galileo.0g.ai/address/0x9577498d6305a8498744ab33217fab6722ff8141) on 0G Galileo ([deploy tx](https://chainscan-galileo.0g.ai/tx/0xb03ad82e75f1c4890b841dd3c27a749dd242e5344c4e79fa06bb3d53c12758ed)), minted and updated by Ordo's 0G account `0xa902C5542Fc209e639Ed151a3619e103D18bD55a`, whose key the 0G setup workflow generated and keeps in Vercel.
- **Done in code: machines that pay for themselves (Hedera x402).** A maintenance lead can give a machine its own Hedera account (asset drawer → Machine wallet) with a daily budget and a per-purchase cap. The site's treasury (the operator) opens the account and tops it back up to the budget once a day, so the balance is a hard cap on what the machine can spend. When an incident opens on the machine it pays, from its own account and with nobody approving: first Ordo's vibration assessment over x402, then, if the machine is in zone C or D, a vendor's urgent call-out (`POST /v1/x402/vendors/{id}/callout`), whose deposit (a tenth of the vendor's hourly rate) goes straight to the vendor's Hedera account. Each purchase is in the ledger as a decision by `machine:<name>` and written to the HCS topic. **To show it live:** give a machine a wallet in production, make sure a vendor of its kind has a funded Hedera account, and let the machine drift; put the settled transaction IDs in the README.
- **Done in code: a metered MCP server (Hedera x402).** Any AI agent's MCP client can connect to `/v1/x402/mcp` (streamable HTTP, stateless) and buy Ordo's tools per call: `assess_vibration` (ISO 10816-3 zone and trend), `forecast_failure` (time to a failure limit) and `verify_lot` (a verdict on a lot passport: criteria and their zero-knowledge proofs, held stages, the three-signature releases and the ledger anchor). `price_list` is free. A paid tool answers its first call with x402 terms; the client signs an HBAR transfer, retries with it in `_meta["x402/payment"]`, the tool runs and only then is the payment settled, so a call that fails is never charged. Sales are recorded and listed with HashScan links at `GET /v1/x402`. `server/src/chain/mcp-client.ts` is a paying client with a per-call cap; `pnpm --filter @ordo/server mcp:buyer` runs it. **Proof on testnet:** run the **x402 demo** workflow (Actions tab, or `mcp` in `.github/deploy/x402-demo.request`): it opens a fresh buyer account, pays the production MCP server for each tool and lists the settled transactions in its summary.
- **Done in code: pay on proof, with supply-chain finance (Hedera Stablecoin Studio).** Ordo USD (OUSD) is a stablecoin made with Stablecoin Studio's SDK and factory (`tools/stablecoin/create.cjs`, run by **Hedera setup** `stablecoin`): the operator holds the cash-in and hold-creator roles, the token's keys are the stablecoin contract's. A plant manager adds customers and financiers on the **Pay on proof** page (each gets its own Hedera account, its key sealed in Ordo) and cashes in OUSD for them (Stablecoin Studio's cash-in). For an order, the customer locks the price in a **Stablecoin Studio hold** on its own balance, naming `OrdoPayOnProof` as escrow and committing in the hold's data to the site, the lot's validation package and the plant's account. `OrdoPayOnProof` pays the hold out only when OrdoTrust records that package's release (performed, reviewed and approved by three people, the reviewer and approver staked validators); anyone may call `settle`, Ordo does in its engine cycle. Until then the plant can **sell the receivable**: it offers it below face value, a financier pays that price at once (an atomic `take`), and the financier is paid the full amount on proof. The plant can waive a rejected lot (the hold goes back to the customer), and an unproven hold returns to the customer when it expires. **To show it live:** run Hedera setup with `stablecoin` and `payonproof` (it needs the redeployed OrdoTrust to record releases on-chain), add a customer and a financier, cash in, hold a payment for a package, sell the receivable, then release the package.
- **Done in code: agent memory on 0G that travels with the iNFT (ERC-7857 sealed keys).** What an agent has learned at its site (the cases people accepted, its track record) is saved as versions: each one encrypted under a fresh AES-256-GCM key, the ciphertext stored on 0G Storage, and its keccak-256 written to the agent's iNFT as `memory:v<n>` (an `Updated` event per version). A new version is taken only when the agent learned something, at most every 30 minutes. The key is never stored in the clear: it is sealed (ECIES on X25519) for each site entitled to the memory, the agent's own and every site holding an active licence on its token. When a licence starts, the current memory is sealed for the licensee: the re-encryption of an ERC-7857 transfer, with Ordo as the oracle. The licensee's agent then recommends from the licensor's **live** memory, fetched from 0G, checked against the hash its iNFT carries and decrypted with its own key, instead of the snapshot the licence pinned; a licence that ends gets no key for later versions. The agents table shows each agent's memory version, its 0G upload and whom it is shared with. **Live with no redeploy:** with 0G Storage and the iNFT contract configured, proven agents' memories go to 0G in the engine cycle.
- **Next:** demo preparation: a Gemini key (or `LLM_PROVIDER=0g` once the compute ledger is funded), the ENS and 0G environments, a rehearsal and the pre-event baseline commit.
