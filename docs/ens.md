# Ordo on ENS: a name for everything

Everything in an Ordo org has an ENS name, registered on-chain on ENSv2 (Sepolia) under one root, `ordo.eth`. That covers the org, its people and the roles they hold, its machines, agents, lines, vendors, runs, stages, budgets and work orders. The console, the CLI, the machine bodies, Hedera memos and HCS lines all use these names wherever an address, account or id would otherwise appear.

- **Identity:** a person is `priya.acme.ordo.eth`, minted to their own wallet from the handle they chose. Their display name never goes on-chain.
- **Roles:** holding `priya.validators.acme.ordo.eth` *is* holding the validator role. Contracts read roles from the names people hold, so promoting someone issues a name and demoting them revokes it.
- **Lots:** a run's name (`so-7781.runs.acme.ordo.eth`) is the lot. The three release signatures sign it, and `OrdoRunResolver` records the release on it.
- **Links between things live on-chain too:** a stage names its machine, a budget its treasury, a work order its vendor, a role name its person.

## The tree

```
ordo.eth                                              root (Ordo's ENS owner key; Ordo's PermissionedResolver)
└─ acme.ordo.eth                                      org (own registry; Hedera record = the org treasury)
   ├─ priya.acme.ordo.eth                             person: owner = addr = their wallet
   ├─ managers | validators | testers | contributors  role collections, each its own registry
   │    └─ priya.validators.acme.ordo.eth             holding it = holding the role (com.ordo.person → priya.acme.ordo.eth)
   ├─ machines → cnc-07.machines.acme.ordo.eth        owner = the machine's device key (DEVICE); Hedera record = the machine's account
   ├─ agents   → maintenance, scheduler, vision-qa … and Ordo's own: ens, hedera, treasury, passport, zk, bodies, pay-on-proof, policy-guard, 0g
   ├─ lines    → l1.lines.acme.ordo.eth
   ├─ vendors  → acme-steel.vendors.acme.ordo.eth     Hedera record = where they are paid (VENDOR)
   ├─ customers, financiers → <party>.customers.acme.ordo.eth
   ├─ pipelines → turbine-blade.pipelines.acme.ordo.eth
   ├─ workorders → wo-12.workorders.acme.ordo.eth     com.ordo.vendor → the vendor's name
   ├─ treasury.acme.ordo.eth                          Hedera record = the treasury account
   └─ runs → so-7781.runs.acme.ordo.eth               the lot (own registry; resolver = OrdoRunResolver)
        ├─ 01-wax-pattern.so-7781.runs.acme.ordo.eth  stages (com.ordo.machine → the machine's name)
        ├─ budget.so-7781.runs.acme.ordo.eth          the run budget (amount, com.hedera.schedule, com.ordo.treasury)
        └─ topup-03-ceramic-cores.so-7781.runs…       over-budget top-ups
```

**Labels** are lowercase letters, digits and dashes, at most 40 characters, and they stick once issued. A clash gets `-2`, `-3`, and so on.
- A run takes its order reference, or its run id when it has none.
- A stage is `<code>-<name>`.
- A work order is `wo-<n>`.
- A top-up is `topup-<stage>-<resource>`.

**Handles** are 3 to 32 characters, start and end with a letter or digit, have no `--`, and are unique across Ordo.
- Reserved: every collection word, plus `treasury`, `org`, `ordo`, `admin`, `root`, `system`, `ens`, `www`, `api`, `app`, `eth` and a few more.
- `member-` is reserved for the fallback. Someone who never picks a handle gets `member-<6 hex of their wallet>`.
- A display name is only ever a suggestion (`Lena Fischer` → `lena-fischer`), shown in the picker.
- Changing a handle revokes the old names and issues new ones.

**Records** stay small to save gas.
- Every name has `com.ordo.type` and `description`. People and machines also carry `addr`, and anything with a Hedera account carries its ENSIP-11 record.
- The ENSIP-11 coin type is `0x80000000 | 296 = 2147483944` on Hedera testnet and `2147483943` on mainnet. The record holds the account's long-zero EVM address, or its alias.
- Status records (`com.ordo.status`) wait 30 s to settle, and stages write theirs only once finished.
- Runs, stages, budgets, top-ups and work orders are history: they are never revoked.

## How names get on-chain: OrdoNames

`contracts/src/OrdoNames.sol` is the one contract that writes names, and the one contracts read roles from.

- **Batches.** `execute(Op[])` takes up to 16 operations a transaction: ISSUE, RECORDS, REVOKE, GRANT, UNGRANT.
  - Each runs in its own try/catch and emits `Applied(i, registry)` or `Failed(i, reason)`, so one bad name never sinks the batch.
  - ISSUE is an idempotent upsert. It deploys the name's own registry at a predicted address when the name has one, registers or fixes the subregistry and resolver, sets the parent, and writes the records in one resolver multicall.
  - A child can ride in the same batch as its parent, because its parent's registry address is predicted (`VerifiableFactory.predictProxyAddress`).
- **Roles.** `roles(site, account)` and `hasRole` are IOrdoTrust-compatible. They read ownership in the org's stored role registries:
  - manager 31
  - validator 4
  - tester 128
  - contributor 1
  - DEVICE 64, through machines
  - VENDOR 32, through vendors

  `nameOf(site, account)` gives the name a wallet goes by.
- **Registrar rights.** Managers also get `REGISTRAR` on their org's registry, so they can register names there themselves. A root role holds at most 15 accounts, so Ordo grants it to at most 12 managers.

The server side is `server/src/core/names.ts`.
- **Plan.** Every engine cycle it plans each org: what each name should say, from the database.
- **Send.** It sends at most one new batch a cycle and keeps at most two in flight.
  - Identity names go first, then active runs, then history.
  - Gas is budgeted from per-op guides (ISSUE with a registry 750k, without one 260k, RECORDS 50k, REVOKE 120k, +60k a record). `estimateGas` underestimates batches whose ops can fail, so it is not used.
- **Confirm.** It decodes `Applied`/`Failed` from the receipt.
  - A failed op backs off 1, 2, 4… minutes, then is marked failed with a Retry.
  - A batch not mined in 10 minutes is dropped and sent again, which is safe because every op is idempotent.
  - A `Taken` label is relabelled `-2`.

Names never block production. `names.ensure(kind, ref)` returns the name an entity will have before it is on-chain, which is why a Hedera memo can carry a budget's name before the budget exists.

**Gas limits.** Sending pauses while Sepolia's base fee is above `ENS_MAX_FEE_GWEI` (2), once a day's spend reaches `ENS_DAILY_ETH` (0.02), or when the owner holds under 0.002 ETH. Names stay pending, and the Names page says why.

## Releases on run names: OrdoRunResolver

`contracts/src/OrdoRunResolver.sol` keeps the release verification that `OrdoLotResolver` had. It drops the CCIP-Read gateway: every name is now a real ENSv2 name.

- `recordRelease(lot, sigs[3], proofs, params)` takes three `OrdoRelease` signatures (performed, reviewed, approved) over the run's full name.
- Each signer must hold the right role through a name, checked with `OrdoNames.roles`:
  - performed: any role
  - reviewed: VALIDATOR
  - approved: VALIDATOR and PLANT_MANAGER, which a manager holds
- Every stage proof must verify with `OrdoStageVerifier` and every source-signed parameter proof with `OrdoSpecVerifier`. They must fold to the root the three signed.
- The run name then answers `com.ordo.release*` from the contract. Everything else falls back to Ordo's PermissionedResolver.

The wallet's signing prompt shows the lot as `so-7781.runs.acme.ordo.eth`. Packages signed before runs had names (`lot-<order>`) are marked legacy and not recorded.

## Names everywhere else

| Where | What it shows |
|---|---|
| Console | `<Name>`: the full name, first label strong, root muted, click to copy, a link to the ENS app, a dot while it registers. Addresses, accounts, actors, runs, stages, machines and work orders show by name on every page. The Names page shows the whole tree. `/#/name/<ens>` opens what a name stands for. |
| Forms | Invite, ship-to, vendor pay-to and treasury link take a name, a 0x address or a Hedera account. The server resolves it: Ordo's own names first, then ENS's Universal Resolver (Hedera record, else `addr`). |
| Hedera | A run budget's schedule memo is `budget.<run name>` and a top-up's `topup-….<run name>`. Machine and party accounts are opened with their names as account memos. HCS `resource.purchase` and `budget.overbudget` lines carry `names: {run, stage, machine, vendor, buyer}`. ([hedera.md](hedera.md)) |
| Passport | The HIP-412 JSON has `properties.ens` (the lot) and `properties.org`. Each stage carries `ens` and `machineEns`, and signers show by name. |
| MCP | `verify_lot` returns the lot's and org's names, and signers by name. |
| x402 | The storefront catalog carries `vendorName` and `orgName`, and deliveries the vendor's, org's and run's names. |
| CLI | The `ordo-pow` banner shows the org, lot, stage, machine and you by name, and the interviewer is told them. |
| Machine bodies | A body is started with `BODY_NAME`, its machine's name, and logs under it. |

API: `GET /v1/sites/:id/directory` (every entity's name, level 1), `GET /v1/sites/:id/names` (the tree with status and gas, level 3), `GET /v1/sites/:id/names/resolve?q=`, `GET /v1/names/lookup?name=`, `GET /v1/handles/:handle`, and `PATCH /v1/me {handle}`.

## Setting it up (Sepolia)

1. **Register the root:** `ENS_LABEL=ordo pnpm --filter @ordo/contracts setup:ens`. This registers `ordo.eth` for 2 years (`ENS_YEARS`), paid in Sepolia mock USDC that the script mints, so the root outlives its 1-year names. It prints `ENS_PARENT_NAME`, `ENS_REGISTRY_ADDRESS`, `ENS_RESOLVER_ADDRESS` and `ENS_OWNER_KEY`.
2. **Deploy the contracts:** `pnpm --filter @ordo/contracts setup:ens-contracts`. This deploys OrdoNames and OrdoRunResolver (the verifiers are reused), grants OrdoNames `REGISTRAR | UNREGISTER | RENEW | SET_SUBREGISTRY | SET_RESOLVER` on the root registry and `0x111` on the resolver, and prints `ENS_NAMES_ADDRESS` and `ENS_RUN_RESOLVER_ADDRESS`.
3. **Set the env** on the server (Render) and on Vercel. `ENS_SEPOLIA_RPC_URL` is a comma list (`https://gateway.tenderly.co/public/sepolia,https://sepolia.rpc.thirdweb.com,https://0xrpc.io/sep,https://1rpc.io/sepolia`).
4. **Check it:** `pnpm env:doctor`. The "ens names" check covers the owner's balance, who holds the root, OrdoNames' roles on the registry and resolver, the run resolver and the base fee.

`ENS_ROLES_ADDRESS` (OrdoEnsRoles) and `ENS_LOT_RESOLVER_ADDRESS` (OrdoLotResolver) are retired. The doctor and the server warn when they are set. The old `ordo-mfg.eth` names stay on-chain, untouched.

## Live on Sepolia (6 Nov 2026)

| | Address |
| --- | --- |
| Root | [`ordo.eth`](https://sepolia.app.ens.domains/ordo.eth), registered for 2 years, owner `0x38e6…5b74` |
| Root registry (UserRegistry) | [`0xA15E…7CbE`](https://sepolia.etherscan.io/address/0xA15E53dCCAb3D4b8f63aC30c21206FC5E2d67CbE) |
| Ordo's resolver (PermissionedResolver) | [`0x2bF3…f238`](https://sepolia.etherscan.io/address/0x2bF3FEdAa5911CCF6F49468620150Ec6876Ff238) |
| `OrdoNames` | [`0x15f8…bb6b`](https://sepolia.etherscan.io/address/0x15f8e8cccf442e98369415fa9413b3b19d4bbb6b), holding its roles on the root registry and the resolver |
| `OrdoRunResolver` | [`0x0fd6…223f`](https://sepolia.etherscan.io/address/0x0fd6d4a5edf16d6df8d4ab3e541e417a7776223f), with the verifiers below |

## Tests

`server/test/flow/names.test.ts` and `server/test/flow/ens-lots.test.ts` run against ENS Labs' Sepolia bytecode on anvil.
- **names.test:** an org, its collections, people by handle, role names minted to wallets, roles read back from `OrdoNames`, promotions and demotions, someone leaving.
- **ens-lots.test:** run and stage names, the device role from a machine name, and a release recorded on a run name with every proof verified, refused for strangers.
