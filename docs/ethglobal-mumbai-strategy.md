# Ordo at ETHGlobal Mumbai (5–7 Nov 2026) — partner strategy

Goal: a minimum of **USD 5,000** in partner prizes. Submissions close **Sun 8 Nov, 09:00 IST**.

> Prize amounts below were collected on 19 Oct 2026 from the ETHGlobal Mumbai prizes page (via search snapshots) and a third-party guide dated 15 Oct. Several sponsors still show "Prize details coming soon", and sources disagree on some pools (World USD 12.5k vs 20k, 1inch USD 7k vs 20k, total USD 144.5k vs 175k). **Re-check https://ethglobal.com/events/mumbai/prizes before locking scope.**

## 1. Sponsor pools and fit with Ordo

| Sponsor | Pool (USD) | What they want (from past ETHGlobal tracks) | Fit with Ordo | Verdict |
| --- | --- | --- | --- | --- |
| **Hedera** | 15,000 | AI agents that execute a payment / token transfer on Hedera testnet (Hedera Agent Kit, x402, A2A); tokenization; creative use of Hedera Consensus Service (HCS) for logging and data integrity | **Very high.** Ordo's compliance ledger *is* an HCS use case; the Healer agent can pay vendors / move batch tokens; Scheduled Transactions model human sign-off | **Primary** |
| **0G** | 15,000 | AI products on 0G: inference via 0G Compute, evidence on 0G Storage, agent identity via ERC-7857 (iNFT). Tracks like "Best AI Product on 0G" | **High.** Swap one Gemini call (RCA narrator) for 0G Compute; store evidence bundles on 0G Storage. Heavy competition (67 entries in Lisbon) | **Secondary** |
| **ENS** | 10,000 | Creative / meaningful ENS integration | **Medium, low lift.** Machines and agents as ENS subnames (`cnc-05.line02.ordo.eth`) with text records for spec limits and owning agent | **Tertiary** |
| **World** | 12,500–20,000 | World ID proof-of-human; usually requires a World Mini App | Medium. World ID as the operator's e-signature identity is a credible 21 CFR Part 11 story, but a Mini App is a separate build surface | Only if Mumbai rules allow non-Mini-App World ID use |
| **Arc (Circle)** | 15,000 | Agentic commerce, USDC payments, nanopayments on Arc | Medium. Agent-to-vendor USDC payment is possible but overlaps the Hedera payment story | Skip unless Hedera track rules disappoint |
| Arkiv | 15,000 | Verifiable data layer (ex-Golem DB); no public track rules yet | Possible for the audit ledger, but unknown tooling maturity | Watch |
| Uniswap Foundation | 15,000 | Hooks / DeFi | Poor | Skip |
| 1inch | 7,000–20,000 | DeFi swaps; Continuity entries | Poor | Skip |
| Definitive | 5,000 | DeFi trading; Continuity entries | Poor | Skip |
| Chainlink | 5,000 | On-chain state change through Chainlink services | Medium, but small pool and heavy competition | Skip |
| Ethereum Foundation / Whitechain | 15,000 each | Not yet published | Unknown | Watch |

## 2. Recommendation: Hedera primary, 0G and ENS stacked

No single partner track reliably pays USD 5,000 to one team (Hedera's biggest past track was USD 6,000 split across 2–3 teams). The realistic path is **one deep integration plus two light ones**:

| Layer | Integration | Target track (past naming) | Realistic win |
| --- | --- | --- | --- |
| Hedera (deep) | HCS audit ledger + Agent Kit payments + HTS batch tokens + Scheduled Transactions for approvals | "AI & Agentic Payments" (USD 6k pool) and/or "Tokenization of Anything" (USD 6k pool) | 2,000–3,000 per track |
| 0G (medium) | RCA inference on 0G Compute, evidence bundles on 0G Storage, agents registered as ERC-7857 iNFTs | "Best AI Product on 0G" | 1,500–3,000 |
| ENS (light) | Asset and agent identities as ENS subnames with text records | "Best / most creative use of ENS" | 1,000–2,000 |

Two track wins already clear USD 5,000; three give headroom.

## 3. How Ordo maps onto Hedera

1. **Compliance Agent → Hedera Consensus Service.** Every event in the demo loop (anomaly detected, failure forecast, RCA, recommendation, policy-guard verdict, operator decision, action executed) is hashed and submitted to an HCS topic. The Ledger view shows consensus timestamp, sequence number, and a HashScan link. This is the tamper-evident evidence trail the PRD already promises.
2. **Human-in-the-loop → Scheduled Transactions.** L2/L3 actions are created as Hedera scheduled transactions that require the operator's key. "Approve" in the Approvals inbox signs the schedule. The policy guard becomes verifiable on-chain rather than a UI claim.
3. **Healer Agent → Hedera Agent Kit (Python).** Tool calls such as `issue_work_order` pay the maintenance vendor in testnet HBAR or USDC under a spend cap. This satisfies the usual "agent executes at least one payment on Hedera testnet" qualification.
4. **Batches → Hedera Token Service.** Each production batch is an HTS NFT with stage metadata. Reroute = transfer between line accounts, hold = freeze. Qualifies for tokenization tracks.
5. **Optional PolicyGuard contract** (Solidity on Hedera EVM) holding autonomy level and spend caps, if time allows.

Keep Gemini / Vertex for prediction and narration unless 0G Compute is adopted for the RCA call; the Google Cloud stack in PLAN.md still works for the backend.

## 4. Eligibility risks to handle now

- **Pre-existing work.** Covered in detail, with the proof-of-work plan, in [ethglobal-mumbai-build-plan.md](ethglobal-mumbai-build-plan.md).
- **Application and ETH stake.** Mumbai requires applying and staking ETH to confirm the spot. Do this early.
- **Track rules not published.** Hedera, 0G, ENS, World, Arc, Arkiv all show "coming soon". Build the HCS + Agent Kit payment + HTS path, which has qualified in every 2026 Hedera track so far, and adjust once rules land.
- **Testnet keys and faucets.** Create Hedera testnet accounts, 0G testnet wallet and ENS Sepolia names before day 1.

## 5. Demo loop (unchanged story, on-chain proof added)

Fault injected → anomaly detected → failure forecast → RCA (Gemini or 0G Compute) → Healer recommends reroute + work order → policy guard: L3, needs approval → scheduled transaction created → operator approves (signs) → batch NFT transferred, vendor paid on Hedera testnet → every step on HCS, visible in the Ledger view with HashScan links → shift summary generated.
