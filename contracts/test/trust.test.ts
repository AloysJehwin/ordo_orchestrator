import { describe, expect, it } from "vitest";
import { decodeErrorResult, encodeDeployData, parseEther, parseEventLogs, type Abi, type Address, type Hex } from "viem";
import { artifact, chain } from "./chain.js";
import { ORDO_RELEASE, ORDO_SIGNATURE, PROOF_DOMAIN, trustDomain } from "./sigs.js";

const SITE = "site_pune1";
const ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, VENDOR: 32, DEVICE: 64, TESTER: 128, MANAGER: 30 } as const;
let nonce = 0;

async function setup() {
  const c = await chain();
  // account 4 relays everything and is Ordo's registrar
  const trust = await c.deploy("OrdoTrust", [parseEther("10"), 7 * 24 * 3600, c.accounts[4]]);
  // 0 manager · 1 QE validator · 2 second validator · 3 process engineer or tester · 4 relayer · 5 stranger or contributor
  // · 6 treasury · 7 second manager
  const acct = c.accounts;
  const sign = async (who: number, action: string, entity: string, site = SITE, n = `n${++nonce}`) => {
    const message = { action, entity, meaning: action, comment: "", site, nonce: n, issuedAt: new Date().toISOString() };
    const signature = await c.wallet(who).signTypedData({ domain: trustDomain(31337, trust.address), types: ORDO_SIGNATURE, primaryType: "OrdoSignature", message });
    return { ...message, signature };
  };
  const register = async (treasury = c.accounts[6]!, by = 0, relayer = 4) => write(relayer, "registerSite", [SITE, treasury, await sign(by, "site.register", `${SITE}#${treasury.toLowerCase()}`)]);
  const write = async (from: number, fn: string, args: unknown[], value?: bigint) => {
    const account = c.wallet(from).account;
    await c.pub.simulateContract({ account, address: trust.address, abi: trust.abi, functionName: fn, args, value } as never);
    const hash = await c.wallet(from).writeContract({ address: trust.address, abi: trust.abi, functionName: fn, args, value } as never);
    return c.pub.waitForTransactionReceipt({ hash: hash as Hex });
  };
  const read = <T>(fn: string, args: unknown[]) => c.pub.readContract({ address: trust.address, abi: trust.abi, functionName: fn, args }) as Promise<T>;
  const ent = (a: Address, role: keyof typeof ROLE) => `${a.toLowerCase()}#${role}`;
  const grant = async (who: number, role: keyof typeof ROLE, by = 0) => write(4, "grantRole", [SITE, acct[who], ROLE[role], await sign(by, "role.grant", ent(acct[who]!, role))]);
  return { ...c, trust, sign, write, read, ent, grant, acct, register };
}
type T = Awaited<ReturnType<typeof setup>>;

const ERR = artifact("OrdoTrust").abi as Abi;
function revertName(e: unknown): string {
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++) {
    const data = cur.data ?? cur.details?.match?.(/0x[0-9a-f]{8,}/i)?.[0];
    if (typeof data === "string" && /^0x[0-9a-f]{8,}$/i.test(data)) {
      try {
        return decodeErrorResult({ abi: ERR, data: data as Hex }).errorName;
      } catch {
        /* keep walking */
      }
    }
    cur = cur.cause;
  }
  return e instanceof Error ? e.message : String(e);
}
const reverts = async (p: Promise<unknown>, name: string) => {
  let got = "no revert";
  try {
    await p;
  } catch (e) {
    got = revertName(e);
  }
  expect(got).toBe(name);
};

/** Site registered by 0 (the manager: every right); 0, 1 and 2 are staked validators; 3 a process engineer. */
async function staffed(): Promise<T> {
  const t = await setup();
  await t.register();
  for (const v of [1, 2]) await t.grant(v, "VALIDATOR");
  for (const v of [0, 1, 2]) await t.write(v, "stake", [SITE], parseEther("10"));
  return t;
}
const lotOf = (pkg: string, contentHash: Hex = `0x${"ab".repeat(32)}`, proofRoot: Hex = `0x${"cd".repeat(32)}`) => ({ siteId: SITE, lotLabel: "lot-so-1", packageId: pkg, runId: "run_1", contentHash, proofRoot });
type Lot = ReturnType<typeof lotOf>;
const releaseSig = async (t: T, who: number, lot: Lot, meaning: string, deadline = BigInt(Math.floor(Date.now() / 1000) + 86_400)) => {
  const message = { site: lot.siteId, packageId: lot.packageId, runId: lot.runId, lot: lot.lotLabel, meaning, statement: `${meaning} ${lot.packageId}`, comment: "", contentHash: lot.contentHash, proofRoot: lot.proofRoot, nonce: `r${++nonce}`, deadline };
  const signature = await t.wallet(who).signTypedData({ domain: PROOF_DOMAIN, types: ORDO_RELEASE, primaryType: "OrdoRelease", message });
  return { ...message, signature };
};
const releaseSigs = async (t: T, lot: Lot, who: [number, number, number]) => [
  await releaseSig(t, who[0], lot, "performed"),
  await releaseSig(t, who[1], lot, "reviewed"),
  await releaseSig(t, who[2], lot, "approved"),
];

describe("OrdoTrust: sites and role credentials", () => {
  it("registers a site from the admin's signature over the site and its treasury, sent by Ordo's registrar", async () => {
    const t = await setup();
    // nobody but the registrar can claim a site id, even with a valid admin signature
    await reverts(t.register(t.acct[6], 5, 5), "NotRegistrar");
    // the treasury is signed: a relayer cannot swap in its own quality fund
    await reverts(t.write(4, "registerSite", [SITE, t.acct[4], await t.sign(0, "site.register", `${SITE}#${t.acct[6]!.toLowerCase()}`)]), "WrongEntity");
    const r = await t.register();
    // the registering admin is the site's manager: four role bits, one RoleGranted each
    for (const role of ["ADMIN", "PLANT_MANAGER", "SUPERVISOR", "VALIDATOR"] as const) expect(await t.read<boolean>("hasRole", [SITE, t.acct[0], ROLE[role]])).toBe(true);
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[0], ROLE.TESTER])).toBe(false);
    const k = await t.read<Hex>("siteKey", [SITE]);
    expect(await t.read<number>("roles", [k, t.acct[0]])).toBe(ROLE.MANAGER);
    const granted = parseEventLogs({ abi: t.trust.abi, logs: r.logs, eventName: "RoleGranted" }) as unknown as { args: { role: number } }[];
    expect(granted.map((l) => l.args.role)).toEqual([ROLE.ADMIN, ROLE.PLANT_MANAGER, ROLE.SUPERVISOR, ROLE.VALIDATOR]);
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[4], ROLE.ADMIN])).toBe(false);
    expect((await t.read<readonly [boolean, Address]>("sites", [await t.read("siteKey", [SITE])]))[1]).toBe(t.acct[6]);
    await reverts(t.register(t.acct[6], 5), "SiteExists");
  });

  it("refuses a signature made for another deployment of OrdoTrust, so old grants cannot be replayed on a new one", async () => {
    const t = await setup();
    const other = await t.deploy("OrdoTrust", [parseEther("10"), 7 * 24 * 3600, t.accounts[4]]);
    const message = { action: "site.register", entity: `${SITE}#${t.acct[6]!.toLowerCase()}`, meaning: "", comment: "", site: SITE, nonce: "elsewhere", issuedAt: new Date().toISOString() };
    const signature = await t.wallet(0).signTypedData({ domain: trustDomain(31337, other.address), types: ORDO_SIGNATURE, primaryType: "OrdoSignature", message });
    await t.write(4, "registerSite", [SITE, t.acct[6], { ...message, signature }]);
    // the signer recovered here is not account 0, so it holds no role
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[0], ROLE.ADMIN])).toBe(false);
  });

  it("grants a role only with a site admin's signature for exactly that account and role", async () => {
    const t = await setup();
    await t.register();
    await t.grant(1, "OPERATOR");
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[1], ROLE.OPERATOR])).toBe(true);
    // a stranger cannot grant
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.VALIDATOR, await t.sign(5, "role.grant", t.ent(t.acct[2]!, "VALIDATOR"))]), "NotAuthorized");
    // an admin signature for OPERATOR cannot be used for VALIDATOR
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.VALIDATOR, await t.sign(0, "role.grant", t.ent(t.acct[2]!, "OPERATOR"))]), "WrongEntity");
    // nor replayed
    const sig = await t.sign(0, "role.grant", t.ent(t.acct[2]!, "SUPERVISOR"));
    await t.write(4, "grantRole", [SITE, t.acct[2], ROLE.SUPERVISOR, sig]);
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.SUPERVISOR, sig]), "NonceUsed");
    // nor used at another site
    await reverts(t.write(4, "grantRole", [SITE, t.acct[2], ROLE.SUPERVISOR, await t.sign(0, "role.grant", t.ent(t.acct[2]!, "SUPERVISOR"), "site_other")]), "WrongSite");
    // revoke
    await t.write(4, "revokeRole", [SITE, t.acct[1], ROLE.OPERATOR, await t.sign(0, "role.revoke", t.ent(t.acct[1]!, "OPERATOR"))]);
    expect(await t.read<boolean>("hasRole", [SITE, t.acct[1], ROLE.OPERATOR])).toBe(false);
  });
});

describe("OrdoTrust: validator and tester staking", () => {
  it("only credentialed validators can stake; active needs the minimum and no pending unstake", async () => {
    const t = await setup();
    await t.register();
    await reverts(t.write(1, "stake", [SITE], parseEther("10")), "NotValidator");
    await t.grant(1, "VALIDATOR");
    await t.write(1, "stake", [SITE], parseEther("4"));
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[1]])).toBe(false);
    await t.write(1, "stake", [SITE], parseEther("6"));
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[1]])).toBe(true);
    await t.write(1, "requestUnstake", [SITE]);
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[1]])).toBe(false);
    await reverts(t.write(1, "withdraw", [SITE]), "StillLocked");
    await t.increaseTime(7 * 24 * 3600 + 1);
    const before = await t.pub.getBalance({ address: t.acct[1]! });
    await t.write(1, "withdraw", [SITE]);
    expect((await t.pub.getBalance({ address: t.acct[1]! })) - before).toBeGreaterThan(parseEther("9.99"));
  });

  it("after the cooldown anyone can pay a stake back, only to the validator (the call Hedera's scheduler makes)", async () => {
    const t = await setup();
    await t.register();
    await t.grant(1, "VALIDATOR");
    await t.write(1, "stake", [SITE], parseEther("10"));
    await reverts(t.write(4, "withdrawFor", [SITE, t.acct[1]]), "StillLocked");
    await t.write(1, "requestUnstake", [SITE]);
    await reverts(t.write(4, "withdrawFor", [SITE, t.acct[1]]), "StillLocked");
    await t.increaseTime(7 * 24 * 3600 + 1);
    const before = await t.pub.getBalance({ address: t.acct[1]! });
    await t.write(4, "withdrawFor", [SITE, t.acct[1]]);
    expect((await t.pub.getBalance({ address: t.acct[1]! })) - before).toBe(parseEther("10"));
    await reverts(t.write(4, "withdrawFor", [SITE, t.acct[1]]), "NothingStaked");
  });
});

describe("OrdoTrust: releases need staked validators", () => {
  it("records a release signed by a process engineer, a staked reviewer and a staked plant manager, once", async () => {
    const t = await staffed();
    await t.grant(3, "OPERATOR");
    const lot = lotOf("vp_1");
    const r = await t.write(4, "recordRelease", [lot, await releaseSigs(t, lot, [3, 1, 0])]);
    expect(r.status).toBe("success");
    const rel = await t.read<readonly [Hex, Hex, Address, Address, Address, bigint]>("releases", [await t.read("siteKey", [SITE]), await t.read("siteKey", ["vp_1"])]);
    expect(rel.slice(0, 4)).toEqual([lot.contentHash, lot.proofRoot, t.acct[3], t.acct[1]]);
    // the record cannot be overwritten with another hash
    const again = lotOf("vp_1", `0x${"ee".repeat(32)}`);
    await reverts(t.write(4, "recordRelease", [again, await releaseSigs(t, again, [3, 1, 0])]), "AlreadyReleased");
  });

  it("signatures cover the content, the proofs and the lot: none of them can be swapped by whoever relays", async () => {
    const t = await staffed();
    await t.grant(3, "OPERATOR");
    const lot = lotOf("vp_9");
    const sigs = await releaseSigs(t, lot, [3, 1, 0]);
    for (const swapped of [{ ...lot, contentHash: `0x${"11".repeat(32)}` }, { ...lot, proofRoot: `0x${"22".repeat(32)}` }, { ...lot, lotLabel: "lot-so-2" }, { ...lot, runId: "run_2" }])
      await reverts(t.write(4, "recordRelease", [swapped, sigs]), "WrongRelease");
    // a "reviewed" signature cannot stand in for "approved"
    await reverts(t.write(4, "recordRelease", [lot, [sigs[0], sigs[1], await releaseSig(t, 0, lot, "reviewed")]]), "WrongMeaning");
    // an expired signature is refused
    const late = [sigs[0], sigs[1], await releaseSig(t, 0, lot, "approved", 1n)];
    await reverts(t.write(4, "recordRelease", [lot, late]), "Expired");
  });

  it("rejects an unstaked reviewer, a reviewer who is unstaking, a non-manager approver and one person signing twice", async () => {
    const t = await staffed();
    const l = (p: string) => lotOf(p);
    // the performer is the package owner, whom Ordo checks; process engineers hold no OrdoTrust role
    await t.grant(5, "VALIDATOR"); // credential but no stake
    await reverts(t.write(4, "recordRelease", [l("vp_2"), await releaseSigs(t, l("vp_2"), [3, 5, 0])]), "NotAuthorized");
    await reverts(t.write(4, "recordRelease", [l("vp_3"), await releaseSigs(t, l("vp_3"), [3, 1, 2])]), "NotAuthorized");
    await reverts(t.write(4, "recordRelease", [l("vp_4"), await releaseSigs(t, l("vp_4"), [3, 0, 0])]), "DuplicateSigner");
    await t.write(1, "requestUnstake", [SITE]);
    await reverts(t.write(4, "recordRelease", [l("vp_5"), await releaseSigs(t, l("vp_5"), [3, 1, 0])]), "NotAuthorized");
  });
});


describe("OrdoTrust: the manager role", () => {
  it("grants and revokes MANAGER (all four manager bits) in one signed call; a revoked manager loses the ADMIN check", async () => {
    const t = await setup();
    await t.register();
    expect(await t.read<string>("roleName", [ROLE.MANAGER])).toBe("MANAGER");
    expect(await t.read<string>("roleName", [ROLE.TESTER])).toBe("TESTER");
    await reverts(t.read("roleName", [ROLE.ADMIN | ROLE.VENDOR]), "BadRole");
    const k = await t.read<Hex>("siteKey", [SITE]);
    // a signature for one bit cannot grant the composite
    await reverts(t.write(4, "grantRole", [SITE, t.acct[7], ROLE.MANAGER, await t.sign(0, "role.grant", t.ent(t.acct[7]!, "ADMIN"))]), "WrongEntity");
    await t.grant(7, "MANAGER");
    expect(await t.read<number>("roles", [k, t.acct[7]])).toBe(ROLE.MANAGER);
    expect(await t.read<bigint>("adminCount", [k])).toBe(2n);
    // the new manager can use its ADMIN right
    await t.grant(5, "OPERATOR", 7);
    await t.write(4, "revokeRole", [SITE, t.acct[7], ROLE.MANAGER, await t.sign(0, "role.revoke", t.ent(t.acct[7]!, "MANAGER"))]);
    expect(await t.read<number>("roles", [k, t.acct[7]])).toBe(0);
    expect(await t.read<bigint>("adminCount", [k])).toBe(1n);
    await reverts(t.grant(5, "VALIDATOR", 7), "NotAuthorized");
    // single bits still work and leave the other bits alone
    await t.grant(7, "VALIDATOR");
    await t.grant(7, "MANAGER");
    await t.write(4, "revokeRole", [SITE, t.acct[7], ROLE.SUPERVISOR, await t.sign(0, "role.revoke", t.ent(t.acct[7]!, "SUPERVISOR"))]);
    expect(await t.read<number>("roles", [k, t.acct[7]])).toBe(ROLE.ADMIN | ROLE.PLANT_MANAGER | ROLE.VALIDATOR);
  });

  it("a site cannot lose its last admin", async () => {
    const t = await setup();
    await t.register();
    const revoke = async (who: number, role: keyof typeof ROLE, by: number) => t.write(4, "revokeRole", [SITE, t.acct[who], ROLE[role], await t.sign(by, "role.revoke", t.ent(t.acct[who]!, role))]);
    await reverts(revoke(0, "ADMIN", 0), "LastAdmin");
    await reverts(revoke(0, "MANAGER", 0), "LastAdmin");
    // revoking a bit the account does not hold changes no count
    await revoke(5, "ADMIN", 0);
    await t.grant(7, "MANAGER");
    await revoke(0, "MANAGER", 7);
    await reverts(revoke(7, "ADMIN", 7), "LastAdmin");
    await reverts(t.grant(5, "OPERATOR", 0), "NotAuthorized");
  });

  it("testers stake like validators; an active tester is credentialed, staked to the minimum and not unstaking", async () => {
    const t = await setup();
    await t.register();
    await reverts(t.write(3, "stake", [SITE], parseEther("10")), "NotValidator");
    await t.grant(3, "TESTER");
    await t.write(3, "stake", [SITE], parseEther("4"));
    expect(await t.read<boolean>("isActiveTester", [SITE, t.acct[3]])).toBe(false);
    await t.write(3, "stake", [SITE], parseEther("6"));
    expect(await t.read<boolean>("isActiveTester", [SITE, t.acct[3]])).toBe(true);
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[3]])).toBe(false);
    await t.write(3, "requestUnstake", [SITE]);
    expect(await t.read<boolean>("isActiveTester", [SITE, t.acct[3]])).toBe(false);
    await t.increaseTime(7 * 24 * 3600 + 1);
    await t.write(4, "withdrawFor", [SITE, t.acct[3]]);
    // a staked manager is an active validator (it holds VALIDATOR) but not a tester
    await t.write(0, "stake", [SITE], parseEther("10"));
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[0]])).toBe(true);
    expect(await t.read<boolean>("isActiveTester", [SITE, t.acct[0]])).toBe(false);
  });
});

type Settings = { reward: bigint; fee: bigint; challengeWindow: bigint; responseWindow: bigint; defaultSlashBps: number; maxSlashBps: number; bountyBps: number; falseClaimBps: number };
const settingsEntity = (s: Settings) => `r${s.reward}#f${s.fee}#c${s.challengeWindow}#w${s.responseWindow}#d${s.defaultSlashBps}#m${s.maxSlashBps}#b${s.bountyBps}#x${s.falseClaimBps}`;
const DEFAULTS: Settings = { reward: 100_000_000n, fee: 20_000_000n, challengeWindow: 3n * 86_400n, responseWindow: 48n * 3600n, defaultSlashBps: 3000, maxSlashBps: 5000, bountyBps: 5000, falseClaimBps: 1000 };

describe("OrdoTrust: site settings", () => {
  it("starts with the defaults; only an admin's signature over exactly the new values changes them", async () => {
    const t = await setup();
    await t.register();
    expect(await t.read<Settings>("settings", [SITE])).toEqual(DEFAULTS);
    const next: Settings = { ...DEFAULTS, reward: parseEther("1"), fee: parseEther("0.2"), maxSlashBps: 6000, bountyBps: 4000 };
    await reverts(t.write(4, "setSettings", [SITE, next, await t.sign(5, "site.settings", settingsEntity(next))]), "NotAuthorized");
    await reverts(t.write(4, "setSettings", [SITE, next, await t.sign(0, "site.settings", settingsEntity({ ...next, fee: 0n }))]), "WrongEntity");
    for (const bad of [{ ...next, defaultSlashBps: 7000 }, { ...next, maxSlashBps: 10_001, defaultSlashBps: 3000 }, { ...next, bountyBps: 10_001 }, { ...next, falseClaimBps: 10_001 }])
      await reverts(t.write(4, "setSettings", [SITE, bad, await t.sign(0, "site.settings", settingsEntity(bad))]), "BadSettings");
    const r = await t.write(4, "setSettings", [SITE, next, await t.sign(0, "site.settings", settingsEntity(next))]);
    expect(await t.read<Settings>("settings", [SITE])).toEqual(next);
    const [ev] = parseEventLogs({ abi: t.trust.abi, logs: r.logs, eventName: "SettingsChanged" }) as unknown as { args: { by: Address } }[];
    expect(ev!.args.by).toBe(t.acct[0]);
  });
});

const EVIDENCE = `0x${"ee".repeat(32)}` as Hex;
const RESPONSE = `0x${"5e".repeat(32)}` as Hex;
type CaseRow = readonly [Address, Address, number, Hex, Hex, bigint, bigint, number, bigint, Hex];
const CASE = { NONE: 0, OPEN: 1, RESPONDED: 2, UPHELD: 3, REJECTED: 4 } as const;

/** Staffed site plus tester 3 (staked 10), contributor 5, second manager 7, and 10 in the reward pool. */
async function court(): Promise<T> {
  const t = await staffed();
  await t.grant(3, "TESTER");
  await t.write(3, "stake", [SITE], parseEther("10"));
  await t.grant(7, "MANAGER");
  await t.write(5, "fundRewards", [SITE], parseEther("10"));
  return t;
}
const caseEntity = (validator: Address, bps: number, id: string, evidence: Hex = EVIDENCE) => `${validator.toLowerCase()}#${bps}#${id}#${evidence}`;
const openCase = async (t: T, id: string, o: { tester?: number; validator?: number; bps?: number; acceptance?: string; signedBps?: number } = {}) => {
  const [tester, validator, bps] = [o.tester ?? 3, o.validator ?? 1, o.bps ?? 3000];
  const sig = await t.sign(tester, "case.open", caseEntity(t.acct[validator]!, o.signedBps ?? bps, id));
  return t.write(4, "openCase", [SITE, id, t.acct[validator], bps, EVIDENCE, o.acceptance ?? "", sig]);
};
const respond = async (t: T, id: string, who = 1) => t.write(4, "respond", [SITE, id, RESPONSE, await t.sign(who, "case.respond", `${id}#${RESPONSE}`)]);
const decide = async (t: T, id: string, uphold: boolean, who = 0) => t.write(4, "decideCase", [SITE, id, uphold, await t.sign(who, "case.decide", `${id}#${uphold ? "uphold" : "reject"}`)]);
const caseOf = async (t: T, id: string) => t.read<CaseRow>("cases", [await t.read("siteKey", [SITE]), await t.read("siteKey", [id])]);
const stakeOf = async (t: T, who: number) => (await t.read<readonly [bigint, bigint]>("stakes", [await t.read("siteKey", [SITE]), t.acct[who]]))[0];
const claimableOf = async (t: T, who: number) => t.read<bigint>("claimable", [await t.read("siteKey", [SITE]), t.acct[who]]);

describe("OrdoTrust: cases against validators", () => {
  it("open, respond, uphold: the slash is split between the tester's bounty and the quality fund", async () => {
    const t = await court();
    const opened = await openCase(t, "case_1");
    const [ev] = parseEventLogs({ abi: t.trust.abi, logs: opened.logs, eventName: "CaseOpened" }) as unknown as { args: { tester: Address; validator: Address; bps: number } }[];
    expect([ev!.args.tester, ev!.args.validator, ev!.args.bps]).toEqual([t.acct[3], t.acct[1], 3000]);
    let c = await caseOf(t, "case_1");
    expect([c[0], c[1], c[2], c[3], c[7]]).toEqual([t.acct[3], t.acct[1], 3000, EVIDENCE, CASE.OPEN]);
    expect(c[6] - c[5]).toBe(48n * 3600n);
    const k = await t.read<Hex>("siteKey", [SITE]);
    expect(await t.read<bigint>("openCases", [k, t.acct[1]])).toBe(1n);
    // only the accused responds
    await reverts(t.write(4, "respond", [SITE, "case_1", RESPONSE, await t.sign(2, "case.respond", `case_1#${RESPONSE}`)]), "NotAuthorized");
    await respond(t, "case_1");
    c = await caseOf(t, "case_1");
    expect([c[4], c[7]]).toEqual([RESPONSE, CASE.RESPONDED]);
    // a responded case can be decided at once
    const fund = await t.pub.getBalance({ address: t.acct[6]! });
    const r = await decide(t, "case_1", true);
    // 30% of 10 slashed: 1.5 to the tester (claimable), 1.5 to the quality fund
    expect(await stakeOf(t, 1)).toBe(parseEther("7"));
    expect(await claimableOf(t, 3)).toBe(parseEther("1.5"));
    expect((await t.pub.getBalance({ address: t.acct[6]! })) - fund).toBe(parseEther("1.5"));
    expect(await t.read<boolean>("isActiveValidator", [SITE, t.acct[1]])).toBe(false);
    c = await caseOf(t, "case_1");
    expect([c[7], c[8]]).toEqual([CASE.UPHELD, parseEther("3")]);
    const [d] = parseEventLogs({ abi: t.trust.abi, logs: r.logs, eventName: "CaseDecided" }) as unknown as { args: { upheld: boolean; amount: bigint; bounty: bigint; treasury: Address } }[];
    expect([d!.args.upheld, d!.args.amount, d!.args.bounty, d!.args.treasury]).toEqual([true, parseEther("3"), parseEther("1.5"), t.acct[6]]);
    expect(await t.read<bigint>("openCases", [k, t.acct[1]])).toBe(0n);
    expect(await t.read<bigint>("openCases", [k, t.acct[3]])).toBe(0n);
    // decided once
    await reverts(decide(t, "case_1", false), "CaseNotOpen");
    // the tester collects the bounty (relayed, paid to the tester)
    const before = await t.pub.getBalance({ address: t.acct[3]! });
    await t.write(4, "claimFor", [SITE, t.acct[3]]);
    expect((await t.pub.getBalance({ address: t.acct[3]! })) - before).toBe(parseEther("1.5"));
    await reverts(t.write(3, "claim", [SITE]), "NothingToClaim");
  });

  it("reject: a share of the tester's stake goes to the validator's claimable balance", async () => {
    const t = await court();
    await openCase(t, "case_2");
    await respond(t, "case_2");
    await decide(t, "case_2", false);
    expect(await stakeOf(t, 3)).toBe(parseEther("9"));
    expect(await stakeOf(t, 1)).toBe(parseEther("10"));
    expect(await claimableOf(t, 1)).toBe(parseEther("1"));
    const c = await caseOf(t, "case_2");
    expect([c[7], c[8]]).toEqual([CASE.REJECTED, parseEther("1")]);
    const before = await t.pub.getBalance({ address: t.acct[1]! });
    await t.write(4, "claimFor", [SITE, t.acct[1]]);
    expect((await t.pub.getBalance({ address: t.acct[1]! })) - before).toBe(parseEther("1"));
  });

  it("a validator who does not respond can be decided against once the response window closes", async () => {
    const t = await court();
    await openCase(t, "case_3", { bps: 5000 });
    await reverts(decide(t, "case_3", true), "TooEarly");
    await t.increaseTime(48 * 3600);
    await reverts(respond(t, "case_3"), "TooLate");
    await decide(t, "case_3", true);
    expect(await stakeOf(t, 1)).toBe(parseEther("5"));
    expect(await claimableOf(t, 3)).toBe(parseEther("2.5"));
  });

  it("checks who signs: a staked tester, never the accused; a plant manager who is neither party decides", async () => {
    const t = await court();
    // a tester without stake, and a validator accusing itself
    await t.grant(5, "TESTER");
    await reverts(openCase(t, "c_a", { tester: 5 }), "NotAuthorized");
    await t.grant(1, "TESTER");
    await reverts(openCase(t, "c_b", { tester: 1, validator: 1 }), "NotAuthorized");
    // the accused must hold VALIDATOR; bps within 1..maxSlashBps; the signature covers the bps
    await reverts(openCase(t, "c_c", { validator: 5 }), "NotValidator");
    await reverts(openCase(t, "c_d", { bps: 0 }), "BadBps");
    await reverts(openCase(t, "c_e", { bps: 5001 }), "BadBps");
    await reverts(openCase(t, "c_f", { bps: 4000, signedBps: 3000 }), "WrongEntity");
    await reverts(t.write(4, "openCase", ["site_other", "c_g", t.acct[1], 3000, EVIDENCE, "", await t.sign(3, "case.open", caseEntity(t.acct[1]!, 3000, "c_g"))]), "UnknownSite");
    // a nonce is burnt once, whatever it signed
    await t.write(4, "openCase", [SITE, "c_h", t.acct[1], 3000, EVIDENCE, "", await t.sign(3, "case.open", caseEntity(t.acct[1]!, 3000, "c_h"), SITE, "once")]);
    await reverts(t.write(4, "openCase", [SITE, "c_i", t.acct[1], 3000, EVIDENCE, "", await t.sign(3, "case.open", caseEntity(t.acct[1]!, 3000, "c_i"), SITE, "once")]), "NonceUsed");
    await reverts(openCase(t, "c_h"), "CaseExists");
    await respond(t, "c_h");
    // deciders: not a validator without the manager bit, not the accused, and the signature names the outcome
    await reverts(decide(t, "c_h", true, 2), "NotAuthorized");
    await reverts(t.write(4, "decideCase", [SITE, "c_h", true, await t.sign(0, "case.decide", "c_h#reject")]), "WrongEntity");
    // the manager as tester cannot decide its own case; another manager can
    await t.grant(0, "TESTER");
    await openCase(t, "c_j", { tester: 0, validator: 2 });
    await respond(t, "c_j", 2);
    await reverts(decide(t, "c_j", true, 0), "NotAuthorized");
    await decide(t, "c_j", false, 7);
    // the manager as the accused cannot decide either
    await openCase(t, "c_k", { validator: 0 });
    await respond(t, "c_k", 0);
    await reverts(decide(t, "c_k", true, 0), "NotAuthorized");
    await decide(t, "c_k", true, 7);
    expect(await stakeOf(t, 0)).toBe(parseEther("6.3")); // 10 − 1 (false claim as tester) − 30%
  });

  it("no stake leaves while its owner is a party to an undecided case", async () => {
    const t = await court();
    await openCase(t, "case_4");
    for (const who of [1, 3]) await t.write(who, "requestUnstake", [SITE]);
    await t.increaseTime(7 * 24 * 3600 + 1);
    await reverts(t.write(1, "withdraw", [SITE]), "CaseOpen");
    await reverts(t.write(4, "withdrawFor", [SITE, t.acct[3]]), "CaseOpen");
    // a case can still be decided against an unstaking validator
    await decide(t, "case_4", true);
    const before = await t.pub.getBalance({ address: t.acct[1]! });
    await t.write(4, "withdrawFor", [SITE, t.acct[1]]);
    expect((await t.pub.getBalance({ address: t.acct[1]! })) - before).toBe(parseEther("7"));
    await t.write(4, "withdrawFor", [SITE, t.acct[3]]);
  });
});

type AcceptanceRow = readonly [Address, Address, bigint, bigint, bigint, boolean, boolean];
const select = async (t: T, id: string, contributor = 5, validator = 1) => t.write(4, "recordAcceptance", [SITE, id, t.acct[contributor], await t.sign(validator, "contribution.select", `${id}#${t.acct[contributor]!.toLowerCase()}`)]);
const acceptanceOf = async (t: T, id: string) => t.read<AcceptanceRow>("acceptances", [await t.read("siteKey", [SITE]), await t.read("siteKey", [id])]);
const poolOf = async (t: T) => t.read<bigint>("rewardPool", [await t.read("siteKey", [SITE])]);
const CHALLENGE = 3 * 24 * 3600;

describe("OrdoTrust: rewards for selected contributions", () => {
  it("fund, select, settle after the challenge window, claim", async () => {
    const t = await staffed();
    await reverts(select(t, "ctb_1"), "PoolTooLow");
    await t.write(5, "fundRewards", [SITE], DEFAULTS.reward + DEFAULTS.fee + 5n);
    expect(await poolOf(t)).toBe(DEFAULTS.reward + DEFAULTS.fee + 5n);
    const r = await select(t, "ctb_1");
    expect(await poolOf(t)).toBe(5n);
    const a = await acceptanceOf(t, "ctb_1");
    expect(a.slice(0, 4)).toEqual([t.acct[5], t.acct[1], DEFAULTS.reward, DEFAULTS.fee]);
    expect([a[5], a[6]]).toEqual([false, false]);
    const [ev] = parseEventLogs({ abi: t.trust.abi, logs: r.logs, eventName: "AcceptanceRecorded" }) as unknown as { args: { vestAt: bigint } }[];
    expect(ev!.args.vestAt).toBe(a[4]);
    await reverts(t.write(4, "settle", [SITE, "ctb_1"]), "NotVested");
    await reverts(t.write(4, "settle", [SITE, "ctb_x"]), "UnknownAcceptance");
    await t.increaseTime(CHALLENGE);
    await t.write(4, "settle", [SITE, "ctb_1"]);
    await reverts(t.write(4, "settle", [SITE, "ctb_1"]), "AlreadySettled");
    expect(await claimableOf(t, 5)).toBe(DEFAULTS.reward);
    expect(await claimableOf(t, 1)).toBe(DEFAULTS.fee);
    const before = await t.pub.getBalance({ address: t.acct[5]! });
    await t.write(4, "claimFor", [SITE, t.acct[5]]);
    expect((await t.pub.getBalance({ address: t.acct[5]! })) - before).toBe(DEFAULTS.reward);
    await t.write(1, "claim", [SITE]);
    expect(await claimableOf(t, 1)).toBe(0n);
  });

  it("only an active validator other than the contributor selects, once per contribution", async () => {
    const t = await staffed();
    await t.write(6, "fundRewards", [SITE], parseEther("1"));
    await reverts(select(t, "ctb_2", 5, 5), "NotAuthorized"); // no credential
    await reverts(select(t, "ctb_2", 1, 1), "NotAuthorized"); // selecting itself
    await t.grant(3, "VALIDATOR");
    await reverts(select(t, "ctb_2", 5, 3), "NotAuthorized"); // not staked
    await reverts(t.write(4, "recordAcceptance", [SITE, "ctb_2", t.acct[5], await t.sign(1, "contribution.select", `ctb_2#${t.acct[6]!.toLowerCase()}`)]), "WrongEntity");
    await select(t, "ctb_2", 5, 0); // a staked manager holds VALIDATOR
    await reverts(select(t, "ctb_2", 3, 1), "AcceptanceExists");
    await reverts(t.write(4, "fundRewards", ["site_other"], 1n), "UnknownSite");
  });

  it("a case naming an acceptance freezes it; rejected, it unfreezes and pays as usual", async () => {
    const t = await court();
    await select(t, "ctb_3");
    await select(t, "ctb_4", 5, 2);
    // the acceptance must be the accused validator's
    await reverts(openCase(t, "case_5", { acceptance: "ctb_4" }), "UnknownAcceptance");
    await openCase(t, "case_5", { acceptance: "ctb_3" });
    expect((await acceptanceOf(t, "ctb_3"))[5]).toBe(true);
    await reverts(openCase(t, "case_6", { acceptance: "ctb_3" }), "AcceptanceFrozen");
    await t.increaseTime(CHALLENGE);
    await reverts(t.write(4, "settle", [SITE, "ctb_3"]), "AcceptanceFrozen");
    // the challenge window has closed: no new case can freeze ctb_4
    await reverts(openCase(t, "case_7", { validator: 2, acceptance: "ctb_4" }), "ChallengeClosed");
    await decide(t, "case_5", false);
    expect((await acceptanceOf(t, "ctb_3"))[5]).toBe(false);
    await t.write(4, "settle", [SITE, "ctb_3"]);
    expect(await claimableOf(t, 5)).toBe(DEFAULTS.reward);
    expect(await claimableOf(t, 1)).toBe(DEFAULTS.fee + parseEther("1")); // fee + the tester's penalty
  });

  it("upheld, the validator's fee returns to the pool and the contributor is still paid", async () => {
    const t = await court();
    await select(t, "ctb_5");
    const pool = await poolOf(t);
    await openCase(t, "case_8", { acceptance: "ctb_5" });
    await respond(t, "case_8");
    await decide(t, "case_8", true);
    expect(await poolOf(t)).toBe(pool + DEFAULTS.fee);
    const a = await acceptanceOf(t, "ctb_5");
    expect([a[3], a[5]]).toEqual([0n, false]);
    await t.increaseTime(CHALLENGE);
    await t.write(4, "settle", [SITE, "ctb_5"]);
    expect(await claimableOf(t, 5)).toBe(DEFAULTS.reward);
    expect(await claimableOf(t, 1)).toBe(0n);
  });
});

describe("OrdoTrust: deployment", () => {
  it("fits the EIP-170 contract size limit and deploys within the 6M gas deploy-trust.ts sends", async () => {
    const t = await setup();
    const code = await t.pub.getCode({ address: t.trust.address });
    const size = (code!.length - 2) / 2;
    expect(size).toBeLessThanOrEqual(24_576);
    const { abi, bytecode } = artifact("OrdoTrust");
    const data = encodeDeployData({ abi, bytecode, args: [parseEther("10"), 7n * 24n * 3600n, t.acct[4]] });
    expect(await t.pub.estimateGas({ account: t.acct[0], data })).toBeLessThan(6_000_000n);
  });
});
