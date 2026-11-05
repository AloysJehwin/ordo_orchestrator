import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, parseEther, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDO_TRUST_ABI, ORDO_TRUST_BYTECODE } from "../../src/chain/ordo-trust-abi.js";
import { boot, demote, enlist, promote, uid, wallet, type Client, type System } from "./helpers.js";

/**
 * The trust layer end to end against a real EVM (in-process): OrdoTrust deployed, Ordo relaying a manager's signed
 * promotions and demotions, validators and testers staking from their own wallets, a release recorded on-chain.
 */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let contract: Hex;
let pub: ReturnType<typeof createPublicClient>;
const keys = { admin: generatePrivateKey(), qe: generatePrivateKey(), v2: generatePrivateKey(), pm: generatePrivateKey(), pe: generatePrivateKey(), tester: generatePrivateKey() };
const people: Record<keyof typeof keys, Client> = {} as never;
let site = "";
const S = () => `/v1/sites/${site}`;
let transport: ReturnType<typeof custom>;
const BIT = { OPERATOR: 1, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, TESTER: 128, MANAGER: 30 };
/** Testers arrived with the v3 contract: their assertions run only when the ABI in the repo has them. */
const HAS_TESTER = (ORDO_TRUST_ABI as readonly { name?: string }[]).some((f) => f.name === "isActiveTester");
const itTester = HAS_TESTER ? it : it.skip;

beforeAll(async () => {
  const funder = generatePrivateKey();
  const relayer = generatePrivateKey();
  const provider = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: 31337 },
    wallet: { accounts: [funder, relayer, ...Object.values(keys)].map((secretKey) => ({ secretKey, balance: toHex(parseEther("1000")) })) },
  });
  transport = custom(provider as never);
  pub = createPublicClient({ chain: foundry, transport });
  const deployer = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(funder) });
  const hash = await deployer.deployContract({ abi: ORDO_TRUST_ABI, bytecode: ORDO_TRUST_BYTECODE, args: [parseEther("10"), 7n * 24n * 3600n, privateKeyToAccount(relayer).address] } as never);
  contract = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  ({ sys, app } = await boot({ TRUST_CONTRACT_ADDRESS: contract, TRUST_RELAYER_KEY: relayer, TRUST_CHAIN_ID: "31337", TRUST_DECIMALS: "18", TRUST_SYMBOL: "ETH" }, { trustTransport: transport }));
  for (const k of Object.keys(keys) as (keyof typeof keys)[]) people[k] = await wallet(app, keys[k]);
}, 120_000);
afterAll(async () => sys.close());

const stake = async (who: keyof typeof keys, amount: string) => {
  const w = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(keys[who]) });
  const h = await w.writeContract({ address: contract, abi: ORDO_TRUST_ABI, functionName: "stake", args: [site], value: parseEther(amount) } as never);
  return pub.waitForTransactionReceipt({ hash: h });
};
const read = <T>(fn: string, args: unknown[]) => pub.readContract({ address: contract, abi: ORDO_TRUST_ABI, functionName: fn, args } as never) as Promise<T>;
const bits = async (c: Client) => Number(await read<number>("roles", [await read("siteKey", [site]), c.account.address]));
const stakers = (c: Client) => c.call("GET", `${S()}/stakers`).then((r) => r.json);

describe("on-chain trust", () => {
  it("registers the org in OrdoTrust with its manager's signature, who holds every manager bit there", async () => {
    site = (await people.admin.call("POST", "/v1/sites", { name: "Chain Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
    expect((await people.admin.call("GET", `${S()}/chain`)).json.registered).toBe(false);
    const typed = (await people.admin.call("POST", `${S()}/chain/register/sign-request`)).json;
    expect(typed.domain.chainId).toBe(31337);
    const r = await people.admin.call("POST", `${S()}/chain/register`, { nonce: typed.message.nonce, signature: await people.admin.sign(typed) });
    expect(r.status).toBe(200);
    expect(r.json.registered).toBe(true);
    // ADMIN | PLANT_MANAGER | SUPERVISOR | VALIDATOR
    expect(await bits(people.admin)).toBe(BIT.MANAGER);
    expect(await read<boolean>("hasRole", [site, people.admin.account.address, BIT.ADMIN])).toBe(true);
  });

  it("a promotion to validator is relayed as an on-chain credential; staking activates it", async () => {
    for (const who of ["qe", "v2"] as const) {
      const r = await enlist(people.admin, S(), people[who], "validator");
      expect(r!.chain!.status, JSON.stringify(r)).toBe("done");
      expect(await read<boolean>("hasRole", [site, people[who].account.address, BIT.VALIDATOR])).toBe(true);
      // promoted, not moved: they are still a contributor, which holds no on-chain role
      expect(await bits(people[who])).toBe(BIT.VALIDATOR);
    }
    // credentialed but not staked: not an active validator
    let me = (await stakers(people.qe)).me;
    expect(me.validator.ok).toBe(false);
    expect(me.validator.reason).toMatch(/stake/);
    expect(me.tester.ok).toBe(false);
    await stake("qe", "10");
    await stake("v2", "10");
    me = (await stakers(people.qe)).me;
    expect(me.validator).toEqual({ ok: true, reason: null });
    const list = (await stakers(people.admin)).stakers;
    const qe = list.find((v: any) => v.address === people.qe.address);
    expect(qe.roles).toEqual(["validator"]);
    expect(qe.onchain).toMatchObject({ stake: parseEther("10").toString(), activeValidator: true, credentials: ["validator"] });
    // the registering manager is listed with their manager credential, not yet staked
    expect(list.find((v: any) => v.address === people.admin.address).onchain).toMatchObject({ activeValidator: false, credentials: ["manager"] });
  });

  it("a contributor has no role in OrdoTrust, so the contract refuses their stake", async () => {
    expect(await enlist(people.admin, S(), people.pe)).toBeNull();
    expect(await bits(people.pe)).toBe(0);
    await expect(stake("pe", "10")).rejects.toThrow();
    expect((await stakers(people.pe)).me.validator.reason).toMatch(/Only a validator or a manager/);
  });

  itTester("a promotion to tester is relayed too; a staked tester is active as a tester, not as a validator", async () => {
    const r = await enlist(people.admin, S(), people.tester, "tester");
    expect(r!.chain!.status, JSON.stringify(r)).toBe("done");
    expect(await bits(people.tester)).toBe(BIT.TESTER);
    let me = (await stakers(people.tester)).me;
    expect(me.tester.ok).toBe(false);
    expect(me.tester.reason).toMatch(/stake/);
    await stake("tester", "10");
    expect(await read<boolean>("isActiveTester", [site, people.tester.account.address])).toBe(true);
    expect(await read<boolean>("isActiveValidator", [site, people.tester.account.address])).toBe(false);
    me = (await stakers(people.tester)).me;
    expect(me.tester).toEqual({ ok: true, reason: null });
    expect(me.validator.ok).toBe(false);
    expect((await stakers(people.admin)).stakers.find((v: any) => v.address === people.tester.address).onchain).toMatchObject({ activeTester: true, activeValidator: false, credentials: ["tester"] });
  });

  it("a release is recorded on-chain only with a staked validator's review and a staked manager's approval", async () => {
    // a second manager: their promotion grants all four manager bits on-chain at once
    const r = await enlist(people.admin, S(), people.pm, "manager");
    expect(r!.chain!.status, JSON.stringify(r)).toBe("done");
    expect(await bits(people.pm)).toBe(BIT.MANAGER);

    // a manager creates the package and signs Performed by
    const pkg = (await people.admin.call("POST", `${S()}/validation`, { type: "process_change", title: "Coolant change", objective: "x", acceptance: "y" })).json;
    await people.admin.call("POST", `${S()}/validation/${pkg.id}/checks`, { criterion: "Surface finish", method: "Profilometer", target: "Ra ≤ 0.8" });
    const chk = (await people.admin.call("GET", `${S()}/validation/${pkg.id}`)).json.checks[0];
    await people.admin.call("PATCH", `${S()}/validation/${pkg.id}/checks/${chk.id}`, { status: "pass", result: "Ra 0.6" });
    await people.admin.call("POST", `${S()}/validation/${pkg.id}/precheck`);
    for (const e of (await people.admin.call("GET", `${S()}/validation/${pkg.id}`)).json.evidence.filter((x: any) => x.required)) {
      const f = new FormData();
      f.set("file", new File([`evidence ${e.name}`], `${e.name}.txt`, { type: "text/plain" }));
      f.set("slotId", e.id);
      await people.admin.upload(`${S()}/validation/${pkg.id}/evidence`, f);
    }
    const act = async (c: Client) => {
      const t = await c.call("POST", `${S()}/validation/${pkg.id}/sign-request`, { action: "sign", comment: "" });
      if (t.status !== 200) return t;
      // a release statement names the lot, not a chain: the same signature is checked by OrdoTrust and OrdoLotResolver
      expect(t.json.primaryType).toBe("OrdoRelease");
      expect(t.json.domain.chainId).toBeUndefined();
      return c.call("POST", `${S()}/validation/${pkg.id}/act`, { action: "sign", comment: "", nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    expect((await act(people.admin)).json.step).toBe("qe_review");
    expect((await act(people.qe)).json.step).toBe("approval");
    // a manager approves only with an active stake, like any validator
    const unstaked = await act(people.pm);
    expect(unstaked.status).toBe(403);
    expect(unstaked.json.error).toMatch(/stake/);
    await stake("pm", "10");
    const done = await act(people.pm);
    expect(done.json.status).toBe("released");
    expect(done.json.onchain, JSON.stringify(done.json.onchain)).toMatchObject({ status: "done" });
    const rel = await read<readonly unknown[]>("releases", [await read("siteKey", [site]), await read("siteKey", [pkg.id])]);
    // (contentHash, proofRoot, performedBy, reviewedBy, approvedBy, releasedAt): a package with no lot has no stage proofs
    expect(rel[1]).toBe(`0x${"00".repeat(32)}`);
    expect((rel[2] as string).toLowerCase()).toBe(people.admin.address);
    expect((rel[3] as string).toLowerCase()).toBe(people.qe.address);
    expect((rel[4] as string).toLowerCase()).toBe(people.pm.address);
  });

  itTester("on v3 a selection is the on-chain acceptance: an unstaked manager cannot select, and a case opens only against it", async () => {
    // the manager funds the pool from their own wallet
    const w = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(keys.admin) });
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: contract, abi: ORDO_TRUST_ABI, functionName: "fundRewards", args: [site], value: parseEther("1") } as never) });
    const spec = { stages: [{ code: "01", column: 1, name: "Inspect", agent: "vision_qa", resourceKind: "manual_station", mode: "manual", escalationRole: "manager", timeoutMin: 600, criteria: [] }], rework: null };
    const tpl = await people.admin.call("POST", `${S()}/templates`, { name: "Inspection", category: "Discrete", description: "v3", spec });
    const runId = (await people.admin.call("POST", `${S()}/runs`, { templateVersionId: tpl.json.versionId, orderRef: "SO-V3", quantity: 5 })).json.id;
    await sys.advance(true);
    // the contributor records proof of work through the terminal agent's endpoints, then signs it
    const s = await people.pe.call("POST", `${S()}/pow/sessions`, { runId, stage: "01" });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const secret = s.json.token.split(".")[2];
    const fin = await app.request("/v1/pow/session/finish", {
      method: "POST",
      headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: "Five good", measurements: [{ criterion: "Good units", value: 5 }, { criterion: "Scrap units", value: 0 }], notes: [], evidence: [], transcript: [], receipts: [] }),
    });
    const id = ((await fin.json()) as { contributionId: string }).contributionId;
    const sreq = await people.pe.call("POST", `${S()}/contributions/${id}/sign-request`, { chainId: 31337 });
    expect((await people.pe.call("POST", `${S()}/contributions/${id}/sign`, { nonce: sreq.json.message.nonce, signature: await people.pe.sign(sreq.json) })).status).toBe(200);

    // v3 takes the acceptance only from a staked validator: a manager without a stake is refused before signing
    const refused = await people.admin.call("POST", `${S()}/contributions/${id}/select/sign-request`, { comment: "" });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/stake/);
    const req = await people.qe.call("POST", `${S()}/contributions/${id}/select/sign-request`, { comment: "Counts match", chainId: 31337 });
    const sel = await people.qe.call("POST", `${S()}/contributions/${id}/select`, { comment: "Counts match", nonce: req.json.message.nonce, signature: await people.qe.sign(req.json) });
    expect(sel.json.chain, JSON.stringify(sel.json)).toMatchObject({ status: "done" });
    const acc = await read<readonly unknown[]>("acceptances", [await read("siteKey", [site]), await read("siteKey", [id])]);
    expect((acc[0] as string).toLowerCase()).toBe(people.pe.address);

    // the tester's case is checked against that acceptance and relayed
    const evidence = "The five units were never weighed; the record has no evidence at all.";
    const creq = await people.tester.call("POST", `${S()}/cases/sign-request`, { contributionId: id, bps: 1000, evidence, chainId: 31337 });
    expect(creq.status, JSON.stringify(creq.json)).toBe(200);
    const opened = await people.tester.call("POST", `${S()}/cases`, { caseId: creq.json.caseId, contributionId: id, bps: 1000, evidence, nonce: creq.json.typed.message.nonce, signature: await people.tester.sign(creq.json.typed) });
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    expect((await people.admin.call("GET", `${S()}/rewards`)).json.acceptances.find((a: any) => a.contributionId === id).onchain).toMatchObject({ frozen: true });
    // a second case on the same, now frozen, selection is refused
    const again = await people.tester.call("POST", `${S()}/cases/sign-request`, { contributionId: id, bps: 1000, evidence, chainId: 31337 });
    expect(again.status).toBe(409);
  });

  it("a validator whose credential never reached the chain is told so, not sent to stake into a revert", async () => {
    const w = await wallet(app);
    const id = await uid(w);
    // promoted in Ordo, but the grant relay failed: no VALIDATOR role in OrdoTrust
    await sys.db.query("INSERT INTO memberships (site_id, user_id, role) VALUES ($1,$2,'contributor'), ($1,$2,'validator')", [site, id]);
    await sys.db.query("INSERT INTO chain_relays (id, site_id, kind, ref, payload_json, status, error) VALUES ('rly_lost',$1,'grant',$2,'{}','failed','relayer out of gas')", [site, `role_${id}_validator_sig_lost`]);
    const v = await stakers(w);
    expect(v.me.validator).toMatchObject({ ok: false, reason: expect.stringMatching(/credential is not in OrdoTrust/) });
    expect(v.stakers.find((x: any) => x.userId === id).onchain).toMatchObject({ credentials: [], activeValidator: false });
    expect(v.stakers.find((x: any) => x.address === people.qe.address).onchain.credentials).toEqual(["validator"]);
    // Team shows managers the failed relay, so they can retry it
    expect((await people.admin.call("GET", `${S()}/team`)).json.relays[`${id}:validator`]).toMatchObject({ kind: "grant", status: "failed", error: "relayer out of gas" });
    expect((await w.call("GET", `${S()}/team`)).json.relays).toEqual({});
  });

  it("a manager OrdoTrust knows re-signs a credential Ordo holds but the contract lacks", async () => {
    const op = await wallet(app);
    const other = await wallet(app);
    await sys.db.query("INSERT INTO memberships (site_id, user_id, role) VALUES ($1,$2,'validator'), ($1,$3,'manager')", [site, await uid(op), await uid(other)]);
    const creds = (await people.admin.call("GET", `${S()}/chain/credentials`)).json;
    expect(creds.registered).toBe(true);
    expect([...creds.admins].sort()).toEqual([people.admin.address, people.pm.address].sort());
    expect(creds.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: op.address, role: "VALIDATOR", label: "Validator" }),
        expect.objectContaining({ address: other.address, role: "MANAGER", label: "Manager" }),
      ]),
    );
    // a manager in Ordo the contract does not know is told who can sign, before any signature is wasted
    const refused = await other.call("POST", `${S()}/chain/credentials/sign-request`, { address: op.address, role: "VALIDATOR" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain(people.admin.address);
    // a contributor cannot ask at all
    expect((await people.pe.call("GET", `${S()}/chain/credentials`)).status).toBe(403);
    const t = (await people.admin.call("POST", `${S()}/chain/credentials/sign-request`, { address: op.address, role: "VALIDATOR" })).json;
    const r = await people.admin.call("POST", `${S()}/chain/credentials/grant`, { address: op.address, role: "VALIDATOR", nonce: t.message.nonce, signature: await people.admin.sign(t) });
    expect(r.json.status).toBe("done");
    expect(await read<boolean>("hasRole", [site, op.address, BIT.VALIDATOR])).toBe(true);
    expect((await people.admin.call("GET", `${S()}/chain/credentials`)).json.missing.some((m: any) => m.address === op.address && m.role === "VALIDATOR")).toBe(false);
    // registration belongs to the contract it was made with: after a redeploy the site registers again
    await sys.db.query("UPDATE chain_sites SET contract = '0x000000000000000000000000000000000000dead' WHERE site_id = $1", [site]);
    expect((await people.admin.call("GET", `${S()}/chain`)).json.registered).toBe(false);
    await sys.db.query("UPDATE chain_sites SET contract = $2 WHERE site_id = $1", [site, contract]);
    expect((await people.admin.call("GET", `${S()}/chain`)).json.registered).toBe(true);
  });

  it("a manager demotes a validator: the credential is revoked on-chain, the stake stays withdrawable", async () => {
    expect(await read<boolean>("isActiveValidator", [site, people.v2.address])).toBe(true);
    expect((await demote(people.qe, S(), people.v2, "validator")).status).toBe(403); // only a manager
    const r = await demote(people.admin, S(), people.v2, "validator", "left the company");
    expect(r.status).toBe(200);
    expect(r.json.chain.status).toBe("done");
    expect(await read<boolean>("hasRole", [site, people.v2.address, BIT.VALIDATOR])).toBe(false);
    expect(await read<boolean>("isActiveValidator", [site, people.v2.address])).toBe(false);
    const v = await stakers(people.v2);
    expect(v.me.validator.ok).toBe(false);
    expect(v.me.validator.reason).toMatch(/Only a validator or a manager/);
    expect(v.stakers.some((x: any) => x.address === people.v2.address)).toBe(false);
    expect((await people.v2.call("GET", S())).json.myRoles).toEqual(["contributor"]);
    expect((await demote(people.admin, S(), people.v2, "validator")).status).toBe(409);
    // Team shows the latest relay of that role: the revocation, not the grant before it
    expect((await people.admin.call("GET", `${S()}/team`)).json.relays[`${await uid(people.v2)}:validator`]).toMatchObject({ kind: "revoke", status: "done" });
    // their stake is still theirs to take back
    const w = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(keys.v2) });
    const h = await w.writeContract({ address: contract, abi: ORDO_TRUST_ABI, functionName: "requestUnstake", args: [site] } as never);
    expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    const decisions = (await people.admin.call("GET", `${S()}/decisions?limit=50`)).json;
    expect(decisions.some((d: any) => d.kind === "team.role_revoked" && d.reason === "left the company")).toBe(true);
  });

  it("demoting a manager revokes all four manager bits on-chain; the last one cannot be demoted", async () => {
    const r = await demote(people.admin, S(), people.pm, "manager");
    expect(r.status).toBe(200);
    expect(r.json.chain.status).toBe("done");
    expect(await bits(people.pm)).toBe(0);
    expect((await people.pm.call("GET", S())).json.myRoles).toEqual(["contributor"]);
    // the manager who registered the org asks someone else to demote them
    const self = await promote(people.admin, S(), people.admin, "manager", { grant: false });
    expect(self.status).toBe(409);
    expect(await bits(people.admin)).toBe(BIT.MANAGER);
  });
});
