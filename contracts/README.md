# Ordo contracts and chain setup

Three contracts on Hedera, two on Sepolia for ENS (below). Every authorisation in them is an Ordo EIP-712 signature (`OrdoSignature`, the typed data people sign in the console), so anyone can relay a transaction and the contract checks who signed, not who sent it.

| Contract | Purpose |
| --- | --- |
| `OrdoTrust` | Per-site role credentials (a manager holds ADMIN, PLANT_MANAGER, SUPERVISOR and VALIDATOR, 30), granted and revoked with an admin's signature; validator and tester stakes with an unstake cooldown (`withdrawFor` pays a stake back after it, the call Hedera's scheduler makes); release records that need a staked reviewer and a staked plant manager; v3 adds cases against validators and the reward pool ([below](#ordotrust-v3-four-roles-cases-and-rewards)). |
| `OrdoWorkOrders` | The maintenance agent pays vendors within limits people set: a per-site fund, per-order and per-day caps an admin signs, escrow only to holders of the site's `VENDOR` credential, release on a supervisor's or plant manager's signature, refund after expiry, and a pause an admin or plant manager signs (a manager holds all of these). |
| `OrdoPolicies` | Each line's autonomy level and policy hash, published with one plant manager's signature (`REQUIRED = 1`; more may sign, each a different plant manager). |
| `OrdoSpecVerifier` | Generated Groth16 verifier for `circuits/spec_check.circom`: checks a lot passport's proof that a criterion was met, without the measurement. Stateless; anyone can deploy and call `verifyProof`. |
| `OrdoStageVerifier` | Generated Groth16 verifier for `circuits/stage_check.circom`: checks that the counts a stage's gateway (or, for a manual stage, a manager) signed meet the stage's criteria. `OrdoLotResolver` calls it for every stage of a release. |
| `OrdoProofs` (library) | The two statements proof of work rests on: `OrdoReading` (a stage's counts as a signed commitment) and `OrdoRelease` (exactly what three people release: site, package, run, lot, content hash, proof root). See [docs/proof-of-work.md](../docs/proof-of-work.md). |

`OrdoWorkOrders` and `OrdoPolicies` read credentials from the deployed `OrdoTrust` and share its signature scheme through `OrdoSigned`.

```bash
pnpm --filter @ordo/contracts test     # compile with npm solc, and its tests on an in-process EVM
```

## OrdoTrust v3: four roles, cases and rewards

Ordo has four roles per org; OrdoTrust holds them as role bits:

| Bit | Value | |
| --- | --- | --- |
| `OPERATOR` | 1 | |
| `SUPERVISOR` | 2 | |
| `VALIDATOR` | 4 | Stakes; its signature records an acceptance and reviews a release |
| `PLANT_MANAGER` | 8 | Approves releases, decides cases, publishes autonomy policies |
| `ADMIN` | 16 | Grants and revokes roles, signs settings and caps |
| `VENDOR` | 32 | Receives work-order escrow |
| `DEVICE` | 64 | A machine's gateway: signs stage readings |
| `TESTER` | 128 | Stakes and opens cases against validators |
| `MANAGER` | 30 | `ADMIN`, `PLANT_MANAGER`, `SUPERVISOR` and `VALIDATOR`: every right at an org |

| Ordo role | OrdoTrust credential |
| --- | --- |
| Manager | `MANAGER`. The admin who registers the org becomes one. |
| Validator | `VALIDATOR` |
| Tester | `TESTER` |
| Contributor | None: paid from the reward pool, proven by their own signatures |

`grantRole` and `revokeRole` need an `ADMIN`'s signature, and `revokeRole` keeps one admin per org (`LastAdmin`).

**Stakes.** A `VALIDATOR` or a `TESTER` stakes. A stake is active while its owner holds the role, has not requested to unstake and has at least `minStake`. After `requestUnstake` the stake is inactive at once and can be withdrawn after the cooldown, but not while its owner is the tester or validator of an undecided case (`CaseOpen`).

**Rewards.** Anyone adds to an org's pool (`fundRewards`). `recordAcceptance` takes a validator's `contribution.select` signature (entity `<contributionId>#<0xcontributor>`) from an active staked validator who is not the contributor, reserves `reward + fee` from the pool (`PoolTooLow` if it holds less) and vests them after the challenge window. After that, anyone settles an unfrozen acceptance (`settle`): the reward is credited to the contributor and the fee to the validator. `claim` pays the caller's claimable balance; `claimFor` pays an account's balance to that account, so Ordo's relayer can pay the gas.

**Cases.** An active staked tester, not the validator, opens a case against a holder of `VALIDATOR` (`openCase`, action `case.open`, entity `<0xvalidator>#<bps>#<caseId>#<0xevidenceHash>`), proposing up to `maxSlashBps` of their stake. Naming an acceptance freezes it, and only while it is unsettled and inside its challenge window (`ChallengeClosed`, `UnknownAcceptance` otherwise). The validator answers before the response window ends (`respond`, entity `<caseId>#<0xresponseHash>`). A plant manager who is neither party decides once the validator answered or the window closed (`decideCase`, entity `<caseId>#uphold` or `<caseId>#reject`):

- upheld: `bps` of the validator's stake is cut; `bountyBps` of the cut is credited to the tester and the rest is paid to the org's quality fund (its treasury); a frozen acceptance loses its fee, which returns to the pool;
- rejected: `falseClaimBps` of the tester's stake is credited to the validator.

**Settings.** Each org's settings are changed with an `ADMIN`'s signature (`setSettings`, action `site.settings`, entity `r<reward>#f<fee>#c<challengeWindow>#w<responseWindow>#d<defaultSlashBps>#m<maxSlashBps>#b<bountyBps>#x<falseClaimBps>`). Basis points are at most 10000, and `defaultSlashBps` at most `maxSlashBps`. They apply to acceptances and cases made afterwards. `registerSite` starts an org with:

| Setting | Default |
| --- | --- |
| `reward` | 100000000 (1 HBAR) |
| `fee` | 20000000 (0.2 HBAR) |
| `challengeWindow` | 3 days |
| `responseWindow` | 48 hours |
| `defaultSlashBps` | 3000 |
| `maxSlashBps` | 5000 |
| `bountyBps` | 5000 |
| `falseClaimBps` | 1000 |

Amounts are in the chain's smallest unit: tinybars on Hedera.

**Removed from v2:** `slash` (two validators plus a plant manager), now cases; and OrdoPolicies' two-signature raise (`REQUIRED = 1`).

**How Ordo tells.** The server checks the configured contract for `isActiveTester(string,address)`. Against v2 it keeps selections in its ledger, refuses cases and turns rewards off; the env doctor warns "chain: OrdoTrust v3". The whole flow is in [docs/proof-of-work.md](../docs/proof-of-work.md).

**Unchanged:** the Sepolia ENS contracts (`OrdoEnsRoles`, `OrdoLotResolver`, the verifiers) and `OrdoAgentNFT`. ENS keeps the old role names (below).

## Hedera testnet

### Live on Hedera testnet (v3)

Deployed 5 Nov 2026, chain 296:

| What | Where |
| --- | --- |
| `OrdoTrust` | [`0x9294c81d116a9924edbaec601589ab00dca832fc`](https://hashscan.io/testnet/contract/0x9294c81d116a9924edbaec601589ab00dca832fc) |
| `OrdoWorkOrders` | [`0xffb1d1d8111ec261484db49c9670ccc148ac8e5e`](https://hashscan.io/testnet/contract/0xffb1d1d8111ec261484db49c9670ccc148ac8e5e) |
| `OrdoPolicies` | [`0x6b8a5fac0bfc58010442ec16310cbaec49bd562e`](https://hashscan.io/testnet/contract/0x6b8a5fac0bfc58010442ec16310cbaec49bd562e) |
| `OrdoPayOnProof` | [`0x792d5049fcaba10c04754a54f3025be19127d22f`](https://hashscan.io/testnet/contract/0x792d5049fcaba10c04754a54f3025be19127d22f) |
| Registrar and relayer | [`0xCe44d739E6FC129FE0B85f472d84B76df9170EA0`](https://hashscan.io/testnet/account/0xCe44d739E6FC129FE0B85f472d84B76df9170EA0) |
| Ledger topic (HCS) | [`0.0.11087048`](https://hashscan.io/testnet/topic/0.0.11087048) |
| Lot passport collection (HTS NFT) | [`0.0.11087232`](https://hashscan.io/testnet/token/0.0.11087232) |
| Maintenance agent account | [`0.0.11324776`](https://hashscan.io/testnet/account/0.0.11324776) |

The previous OrdoTrust, v2 at `0xaed8e264873505bf81a9faba7e1542b07b4e8895`, still holds the stakes made on it: their owners request to unstake there and withdraw after the cooldown.

Deployments run in GitHub Actions with the operator account held in the `hedera-testnet` environment (`HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, an **ECDSA** key):

- **Deploy OrdoTrust** (`.github/workflows/deploy-trust.yml`): push a change to `.github/deploy/trust.request`.
- **Hedera setup** (`.github/workflows/hedera-setup.yml`): list what to create in `.github/deploy/hedera.request` and push it:
  - `topic` creates the HCS topic the ledger is anchored to (`HEDERA_TOPIC_ID`),
  - `contracts` deploys `OrdoWorkOrders` and `OrdoPolicies` against `OrdoTrust` (`TRUST_WORKORDERS_ADDRESS`, `TRUST_POLICIES_ADDRESS`),
  - `passport` creates the HTS NFT collection for lot passports (`HEDERA_PASSPORT_TOKEN_ID`); the operator is treasury, supply and metadata key,
  - `agent` creates the maintenance agent's own account with 20 HBAR (`HEDERA_AGENT_ID`); its key goes straight to Vercel and is never printed, so this one needs `VERCEL_TOKEN` as a repository secret.

The logs print only public values. The same scripts run locally:

```bash
cd contracts
export HEDERA_OPERATOR_ID=0.0.xxxx HEDERA_OPERATOR_KEY=0x<ecdsa hex>
pnpm deploy:trust
pnpm setup:hedera topic
TRUST_CONTRACT_ADDRESS=0x… pnpm setup:hedera contracts
SECRET_OUT=agent.env pnpm setup:hedera agent
cd ../server && pnpm smoke:hedera      # posts an anchor to the topic and verifies it on the mirror node
```

Then, in Ordo: register the org on-chain (Setup asks right after creating it; Settings retries), sign the agent's caps and add funds (Work orders), and add vendors (Team → Vendors). When the agent's work order is approved, or it acts on its own at L4, it escrows through Hedera Agent Kit; a manager's signature pays the vendor.

Things to check on the day:

- Inside the EVM Hedera counts HBAR in tinybars (8 decimals); JSON-RPC `value` uses 18 decimals. Caps and amounts in the contracts are tinybars.
- The agent account is created with an ECDSA alias, so its EVM address (the one the caps are signed for) is derived from its key.
- Verify contract source on Sourcify for chain 296 so HashScan shows it; `artifacts/*.json` has the ABI and bytecode.

### Redeploying

A new OrdoTrust starts empty and its signatures are bound to its address, so a redeploy starts every org over on-chain and spends testnet HBAR from the operator. Run the scripts locally (the GitHub workflows at the repository root still assume the workspace sits at the root):

```bash
cd contracts
export HEDERA_OPERATOR_ID=0.0.xxxx HEDERA_OPERATOR_KEY=0x<ecdsa hex>
pnpm deploy:trust                                            # OrdoTrust; prints the TRUST_* values
TRUST_CONTRACT_ADDRESS=0x<new> pnpm setup:hedera contracts   # OrdoWorkOrders + OrdoPolicies against it
TRUST_CONTRACT_ADDRESS=0x<new> STABLECOIN_ADDRESS=… STABLECOIN_TOKEN_ADDRESS=… pnpm setup:hedera payonproof
```

`deploy:trust` reads `MIN_STAKE` (whole native units, default 10), `UNSTAKE_COOLDOWN_SECONDS` (default 7 days) and `TRUST_REGISTRAR` (default the deployer; set it to the relayer's address). Then:

1. Update `TRUST_CONTRACT_ADDRESS`, `TRUST_WORKORDERS_ADDRESS`, `TRUST_POLICIES_ADDRESS` and `PAY_ON_PROOF_ADDRESS` in Vercel and `server/.env`.
2. Run `pnpm run doctor` in `server/`: the "chain: OrdoTrust v3" warning goes once the contract is v3.
3. Every org registers again (Setup asks right after an org is created; Settings retries), managers re-record credentials (Team → Stakes), and validators and testers stake on the new contract.
4. Stakes on the old contract stay there: their owners request to unstake on it and withdraw after the cooldown.

The HCS topic, the passport collection, the agent account and the ENS contracts are unaffected.

## Deadlines on Hedera's Schedule Service

Three deadlines run as Hedera scheduled transactions (`ScheduleCreateTransaction` with `waitForExpiry`, HIP-423) that the network executes at their expiration time, so they happen even if Ordo is down. The operator pays and holds the admin key, and Ordo deletes a schedule that is no longer needed (`server/src/core/schedules.ts`, `server/src/chain/hedera.ts`):

| Deadline | Scheduled transaction | Deleted when |
| --- | --- | --- |
| Work-order escrow, 72h after it opens | `OrdoWorkOrders.refund(site, workOrder)` at the on-chain `expiresAt` | a manager releases the payment |
| Validator or tester unstake cooldown | `OrdoTrust.withdrawFor(site, validator)` at `unlockAt`, paying the stake back to the validator | the validator stakes again |
| Stage timeout | an HCS message `{kind:"stage.timeout"}` to the ledger topic at the deadline; Ordo raises the inbox item once the mirror node shows it executed | the stage finishes in time |

Ordo only does the job itself when a schedule could not be created (less than a minute or more than 62 days away, or Hedera unreachable) or has not run 5 minutes after its time. `HEDERA_SCHEDULES=off` turns it off.

The deployed OrdoTrust (v3) has `withdrawFor`, so Ordo schedules each stake's payout for the end of its cooldown. Against an older OrdoTrust without it, Ordo sees the function is missing and validators and testers withdraw from their wallets instead.

## Zero-knowledge spec proofs

A lot's public passport says whether each acceptance criterion was met but never shows the measurement (yields, scrap, cycle times and OEE are trade secrets). When a stage closes, the server commits each measured value as `Poseidon(subject, value, salt)` in the hash-chained ledger (so it is anchored with everything else), and for every criterion that passed it proves with Groth16 that the committed value meets the target. The passport carries the proof and its public signals `[subject, target × 10⁴, op, commitment]`; the server, the buyer's browser (snarkjs) or `OrdoSpecVerifier` can each check it, with the key at `GET /v1/public/zk/spec-check`.

The circuit's keys live in `server/zk`. Rebuild them after changing the circuit (needs the [circom 2](https://docs.circom.io/getting-started/installation/) compiler; the trusted setup is a local single-party ceremony, fine for a demo, not for production):

```bash
cd contracts && CIRCOM=/path/to/circom node scripts/zk-spec-setup.mjs setup "Your name"
```

## Zero-knowledge stage proofs (proof of work)

Each stage's counts are signed where they were made and proven against the stage's criteria; a release signs the root of those proofs and `OrdoLotResolver` verifies them on-chain. The design and trust model are in [docs/proof-of-work.md](../docs/proof-of-work.md). The circuit is on a public trusted setup (phase 1 from the PSE Perpetual Powers of Tau; phase 2 contributions are recorded in `server/zk/stage_check.ceremony.json`):

```bash
cd contracts && CIRCOM=/path/to/circom node scripts/zk-stage-setup.mjs setup      # compile + phase 2 + first contribution
node scripts/zk-stage-setup.mjs contribute "Your name"                              # each further contributor
node scripts/zk-stage-setup.mjs beacon <future block hash>                          # close the ceremony
node scripts/zk-stage-setup.mjs verify                                              # anyone: check the zkey
```

## Build log on HCS

Post the current commit to the HCS build topic every few hours:

```bash
cd server && HEDERA_BUILD_TOPIC_ID=<build topic> pnpm anchor:build
```

## ENS (Sepolia, ENSv2)

ENSv2 gives every name its own registry. `scripts/ens-setup.ts` registers Ordo's parent name once: it deploys Ordo's `PermissionedResolver` and a `UserRegistry` through ENS's `VerifiableFactory`, then registers `<label>.eth` (commit, wait, pay in the testnet's MockUSDC) pointing at both. Run it from the **ENS setup** workflow (put the label in `.github/deploy/ens.request`; needs the `sepolia` environment with `ENS_OWNER_KEY` holding some Sepolia ETH), or locally:

```bash
ENS_OWNER_KEY=0x... ENS_LABEL=ordo-mfg pnpm setup:ens
```

**Live:** [`ordo-mfg.eth`](https://sepolia.app.ens.domains/ordo-mfg.eth), registry `0x1F621f14718a9251b74F1683D6F1D5F8E9889358`, resolver `0xC2992b48350F642cd820a22DAf5ffaDB6e26566C`, owner `0x38e6C7622b2E9BdcB16821E88083274489625b74`.

The app then issues the rest as the site changes: `<site>.<parent>` with its own `UserRegistry`, and in it a name for each person (minted to their wallet with no roles on the token, so it cannot be transferred; revoked when they hold no role), each asset and each agent, with `com.ordo.*` text records in Ordo's resolver. The contract addresses are the Sepolia set ENS deployed on 2026-10-01 (`server/src/chain/ensv2.ts`).

### ENS as the access layer

Four more contracts on Sepolia make the names do something:

| Contract | Purpose |
| --- | --- |
| `OrdoEnsRoles` | Ordo roles read from ENS. A wallet holds a role at a site only while it owns its `member-<40 hex address>` name in the site's registry and the name's `com.ordo.roles` record lists the role (`com.ordo.validator` gives VALIDATOR). Revoke or let the name expire and the role is gone. It answers OrdoTrust's `sites`/`roles` calls (`IOrdoTrust`), so `OrdoWorkOrders` and `OrdoPolicies` can be deployed against it too. |
| `OrdoStageVerifier` | The Groth16 verifier of the stage-check circuit (counts against yield, scrap, defects and cycle-time criteria), generated by `zk-stage-setup.mjs` from the public ceremony. |
| `OrdoSpecVerifier` | The Groth16 verifier of the spec-check circuit (one measured value against one bound), generated by `zk-spec-setup.mjs` from the public ceremony. |
| `OrdoLotResolver` | The resolver of each site name, so every `lot-<order>.<site>.<parent>` resolves with no registration (ENSIP-10 wildcard). `recordRelease` stores a lot's release only with the three `OrdoRelease` statements from people whose member names carry the roles (any role, VALIDATOR, VALIDATOR + PLANT_MANAGER), and only if every stage proof it is given verifies (`OrdoStageVerifier`) and every parameter proof verifies (`OrdoSpecVerifier`), each was signed by a holder of the DEVICE or OPERATOR role, and together they fold to the proof root the three signed; `com.ordo.release*` records come from that, `com.ordo.release.proofs` included. Other records (`url`, `com.ordo.status`, `com.ordo.product`…) come from Ordo's CCIP-Read gateway (`/v1/public/ens/{sender}/{data}.json`), signed with the ENS owner key. Names that are not lots go to Ordo's resolver. |

These contracts are unchanged by OrdoTrust v3: `com.ordo.roles` keeps the names `OrdoEnsRoles` knows (a manager is `admin,operator,plant_manager,supervisor,validator`, so a manager's signed manual readings attest; a validator `validator`; a contributor `operator`; a tester none), so nothing on Sepolia is redeployed.

Deploy them with the **ENS setup** workflow (`contracts https://<Ordo's public URL>` in `.github/deploy/ens.request`), or locally with `pnpm setup:ens-contracts` (see `scripts/ens-contracts.ts`). It sets `ENS_ROLES_ADDRESS` and `ENS_LOT_RESOLVER_ADDRESS`; the app then links each site in `OrdoEnsRoles`, points the site name at the lot resolver, and records each released package on its lot's name.

**Live (24 Oct 2026):** `OrdoEnsRoles` [`0x100f…ab91`](https://sepolia.etherscan.io/address/0x100f40fbdec56c458d0aa350b9971040d83eab91) · `OrdoStageVerifier` [`0xadf0…3d22`](https://sepolia.etherscan.io/address/0xadf064b185151dad607a86f48166c36df1333d22) · `OrdoSpecVerifier` [`0xd4c4…ed17`](https://sepolia.etherscan.io/address/0xd4c4b8438c6519d6830668365068560e0239ed17) · `OrdoLotResolver` [`0x83bc…5795`](https://sepolia.etherscan.io/address/0x83bcae34de88b862f9641a408d926e1964b25795), lot names answered by `https://aiwarriors.vercel.app`.

## 0G (Galileo testnet, chain 16602)

`src/OrdoAgentNFT.sol` makes each agent of each site an ERC-7857 iNFT: its intelligent data is the policy hash it acts under, its model, the autonomy each line gives it and its scope; Ordo updates it when any of those change (`Updated` events), and the org's managers are its authorized users. Agents belong to their site, so tokens do not transfer. It uses OpenZeppelin's ERC-721, which needs Cancun, so `compile.mjs` compiles it in a separate Cancun pass (0G supports Cancun) and its tests run on anvil.

**Live:** `OrdoAgentNFT` `0x9577498d6305a8498744ab33217fab6722ff8141` on 0G Galileo, minter `0xa902C5542Fc209e639Ed151a3619e103D18bD55a`.

### Licensing a proven agent to another site

Agents don't transfer, but a site can license one. An agent is **proven** once people have decided at least 3 of its recommendations and accepted at least 75% (`PROVEN` in `server/src/core/agent-licenses.ts`). Its **playbook** is the accepted cases: asset kind, signal, the actions taken and their settings, not the site's ids.

```mermaid
sequenceDiagram
  participant B as Site B manager
  participant O as Ordo server
  participant A as Site A manager
  participant S as 0G Storage
  participant N as OrdoAgentNFT (0G Galileo)
  B->>O: request a 7/30/90-day licence to A's proven agent
  A->>O: sign "agent.license" (EIP-712): licensee, expiry, terms hash
  Note over O: terms pin the playbook by SHA-256
  O->>S: upload the playbook, encrypted
  O->>N: grantLicense(token, B, expiry, termsHash, signature)
  N->>N: signer must be one of the token's authorized users
  O->>N: licenseOf(token, B) is active with the same terms
  O->>N: update B's own agent token: license:<A>/<agent>#token
  Note over O: B's agent of that kind now recommends with A's playbook as precedent
  A->>O: sign "agent.unlicense" to end it early (revokeLicense), or it expires
```

`grantLicense` and `revokeLicense` take the same `OrdoSignature` typed data as the Hedera contracts, with the domain on chain 16602, so the wallet signs for 0G Galileo. The contract rebuilds the entity (`<site>/<agent>><licensee>#<expiresAt>#<termsHash>`) and rejects a signer who isn't an authorized user of that token, whoever relays it. Only sites that list publicly (Settings → public pipelines) appear to other sites as licensors.

**After this merges, redeploy the contract:** the licence functions are new, so the live `0x9577…8141` doesn't have them. Put `inft` in `.github/deploy/zerog.request` on `main` and push; the workflow deploys the new `OrdoAgentNFT` and writes `ZG_INFT_ADDRESS` to Vercel. Don't push that file on a branch, because the workflow runs on any push that changes it. Ordo notices the new address and mints every agent again on the new contract.

The **0G setup** workflow (`.github/deploy/zerog.request`; `key` generates Ordo's 0G key and keeps it in Vercel) deploys it (`inft`), turns on evidence copies to 0G Storage (`storage`) and funds the 0G Compute ledger (`ledger`), and writes the values and the key to Vercel. Locally:

```bash
ZG_PRIVATE_KEY=0x... pnpm setup:zerog                          # deploy OrdoAgentNFT → ZG_INFT_ADDRESS
ZG_PRIVATE_KEY=0x... pnpm --filter @ordo/server zerog:ledger   # fund 0G Compute (3 0G), list providers
```
