# Ordo v2 — real accounts, real data, the full design

Status: in build · Supersedes the demo-only parts of technical-requirements.md.

## 1. Identity: Sign-In with Ethereum + roles in Postgres (recommended)

| Option | Fit for Ordo | Verdict |
| --- | --- | --- |
| **Sign-In with Ethereum (EIP-4361) + DB sessions** | Wallet = identity. The same key signs approvals and validation sign-offs (EIP-712), giving non-repudiable e-signatures and on-chain proof on Hedera EVM (chain 296). Works with MetaMask, HashPack (EVM), Rabby, smart wallets (ERC-1271). | **Chosen** |
| Neon Auth (email / Google, already provisioned) | Easy for non-crypto users, but signatures would be "clicked a button", not cryptographic; no link to the chain. | Later, as an optional second login linked to the same user |
| Hedera-native (HashConnect, ED25519 accounts) | Best Hedera UX, but ED25519 keys can't sign EVM messages; extra SDK and a second signature format. | Not now; ECDSA Hedera accounts already work through the EVM path |
| Embedded wallets (Privy, Dynamic, Web3Auth) | Email→wallet onboarding, but a paid third party holds key shares. | Not needed for the hackathon |

**How it works**
1. `GET /v1/auth/nonce` → single-use nonce stored in `auth_nonces` (5 min).
2. The browser builds an EIP-4361 message (domain, address, chain 296, nonce) and the wallet signs it.
3. `POST /v1/auth/verify` checks domain, nonce, expiry and signature (viem; ERC-1271 for smart accounts), upserts `users(address)`, creates a session (random token, only its SHA-256 stored), sets an `HttpOnly; Secure; SameSite=Lax` cookie.
4. Roles live in `memberships(user, site, role)`: operator, supervisor, process engineer, quality engineer, maintenance lead, plant manager, admin. The first wallet to sign in (or `BOOTSTRAP_ADMIN_ADDRESS`) becomes admin + plant manager; admins invite others by wallet address.
5. **Signatures that matter** (gate release, approval, validation sign-off, autonomy change) are EIP-712 typed data signed by the user's wallet: `{action, entity, meaning, comment, issuedAt, nonce}`. The server verifies, stores signature + typed data in the hash-chained ledger, and anchors the ledger on Hedera HCS. This is what "re-authentication" means for a Part 11-style signature.

## 2. "Real data" — what it means here

No fabricated records. The app starts empty except for product content (the 15 pipeline templates and the policy file). Everything else comes from:

| Data | Real source |
| --- | --- |
| Users, roles | Wallet sign-in, admin invites |
| Site, lines, zones, assets | Created by an admin in the app |
| Telemetry | **MTConnect agents** (live CNC data; the public `demo.mtconnect.org` works out of the box), **CSV replay** of a dataset you upload (e.g. NASA IMS bearing run-to-failure), and **manual readings** entered by operators |
| Orders, runs | Started by people from a template version |
| Stage progress | Auto stages: part counts from the bound asset's telemetry. Manual stages: operator records good / scrap. Gates: wallet-signed release |
| Agent decisions | Rules + LLM on the data above; every decision cites its inputs |
| Evidence | Files uploaded to Vercel Blob (content-hashed) |
| Proof | Ledger anchored to Hedera; signatures from users' wallets |

When a value can't be measured from real data, the UI shows "—" and asks a person, never a placeholder number.

## 3. Screens (from the Claude Design prototype and mockups 01–13)
Pipelines (Flow · Graph · Ledger, node block, stage panel, decision stream), Validation (list, step tracker, readiness, checks, evidence, signature chain, audit trail), Templates, Run history, Floor & fleet (Assets by zone, Agents), Approvals & exceptions (options with recommendation), Builder (stages, mode, criteria, timeout, escalation, publish version), plus Sign-in, Setup (site/zones/assets/data sources) and Team (roles, invites).

## 3a. Design system components (no browser-default controls)
Every dropdown and date field uses Ordo components styled with the design tokens (IBM Plex, gold accent, hairline borders):
- **Select**: custom listbox with search for long lists, keyboard navigation (↑ ↓ Enter Esc, type-ahead), grouped options, descriptions under labels, disabled options, clear button; ARIA `combobox`/`listbox`.
- **DatePicker**: calendar popover (month grid, today marker, min/max, keyboard arrows, Esc), typed input fallback.
- **DateTimePicker**: calendar + hour/minute columns, for due times and trial windows; **DateRangePicker** for trial windows and history filters.
- Also: Segmented control, Tabs, Modal, Drawer (stage panel), Popover (node block), Toasts, Empty states.

## 4. Build order
1. Schema v2 with versioned migrations.
2. Wallet auth, sessions, roles, invites, EIP-712 signatures.
3. Assets + telemetry ingestion (MTConnect, CSV replay, manual), derived status / utilization / OEE.
4. Template library, builder, versioning.
5. Run engine: lanes, merges, rework, executors, gates, agent decisions.
6. Screens.
7. Validation packages + evidence.
8. Hedera anchoring of signatures (needs a testnet operator account from portal.hedera.com).

## Status (implemented)

- Wallet accounts: SIWE sessions, per-site roles, invites by address, EIP-712 signatures for gates, inbox decisions, autonomy changes and validation sign-off.
- Real data: MTConnect agents, CSV dataset replay, manual readings; metrics only from measured data.
- Pipelines: 15 library templates, builder with parallel branches and rework loop, versioned publishing, run engine driven by part counters and operator records.
- Agents on real telemetry with the policy guard; work orders start predictive-maintenance runs.
- Validation packages with agent pre-check, hashed evidence in Postgres, separation of duties in the signature chain.
- Console rebuilt to the mockups with custom Select, DatePicker, DateTimePicker and DateRangePicker components.
- Tests: 80 server tests, Playwright flow with an injected wallet on the single-container and Vercel builds.
