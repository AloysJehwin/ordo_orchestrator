# Ordo documentation

Markdown versions of the Ordo product, architecture and validation documentation. Edit these files directly; diagrams are written in [Mermaid](https://mermaid.js.org/) and render on GitHub.

| Document | What it covers |
| --- | --- |
| [technical-requirements.md](technical-requirements.md) | **MVP build spec (Oct–Nov 2026):** scope, stack, repo layout, agents, policy guard, ledger, adapters, API, tests, milestones. Wins over other docs for the MVP |
| [environments.md](environments.md) | **How to run, configure and live-test Ordo:** Vercel environments, syncing variables, env doctor, the preview rework loop |
| [contracts-and-deployment.md](contracts-and-deployment.md) | On-chain accounts, Hedera resources, Solidity contracts, ENS, 0G, and app deployment (GCP, Neon, Vercel, CI/CD), step by step |
| [hedera.md](hedera.md) | Why Ordo's money moves on Hedera: org treasuries keyed to a contract, run budgets and machines' top-ups as scheduled transfers a manager approves (HIP-755), and what the testnet spike showed |
| [improvements.md](improvements.md) | Review of PRD, plan and docs: blockers, inconsistencies, safety and engineering fixes |
| [ethglobal-mumbai-strategy.md](ethglobal-mumbai-strategy.md) | ETHGlobal Mumbai partner choice (Hedera, 0G, ENS) |
| [proof-of-work.md](proof-of-work.md) | Proof of work through 0G Private Computer: sessions, the terminal agent, signing, selection, cases, rewards; signed stage readings, zero-knowledge proofs, release statements; ceremony |
| [../sdk/README.md](../sdk/README.md) | ordo-pow, the contributor's terminal agent |
| [ethglobal-mumbai-build-plan.md](ethglobal-mumbai-build-plan.md) | Event schedule, proof-of-work protocol, submission checklist |
| [research.md](research.md) | Related work for the autonomous-lab pitch: self-driving labs, the A-Lab verification case, reproducibility, blockchain for research records, and how Ordo maps onto a protein lab |
| [architecture.md](architecture.md) | Full system architecture: design principles, the five layers and every service in detail, end-to-end flows, autonomy and policy guard, events and messages, deployment, failure modes, technology options, open decisions |
| [product.md](product.md) | What Ordo does, roles, core concepts (pipelines, node states, agents, autonomy, gates) and all seven console screens |
| [agent-decision-model.md](agent-decision-model.md) | How an agent action is proposed, checked, executed or escalated, and recorded |
| [validation-workflow.md](validation-workflow.md) | Validation package types, the six steps, signature chain, rules, readiness and a worked example |
| [data-model.md](data-model.md) | Entities, fields and relationships |
| [integrations-api.md](integrations-api.md) | Enterprise and shop-floor systems, REST endpoints and events |
| [security-compliance.md](security-compliance.md) | Identity, e-signatures, records, network and safety |
| [pipeline-templates.md](pipeline-templates.md) | All 16 templates with every stage, owning agent, resource, gate and parameters |
| [data-sources.md](data-sources.md) | Real-time industrial data providers, demo endpoints and datasets |
| [glossary.md](glossary.md) | Terms and abbreviations |

The original designed versions are kept alongside: [`Ordo Documentation.dc.html`](../Ordo%20Documentation.dc.html) (printable) and [`Ordo Architecture.dc.html`](../Ordo%20Architecture.dc.html) (diagram). If you change behaviour here, update the prototype or note the difference.
- [web3-roadmap.md](web3-roadmap.md): roles as on-chain credentials, onboarding, staking, and the ranked web3 build list
