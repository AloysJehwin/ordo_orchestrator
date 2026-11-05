import { describe, expect, it } from "vitest";
import { decodeErrorResult, keccak256, parseEther, parseEventLogs, toBytes, type Abi, type Address, type Hex } from "viem";
import { artifact, chain } from "./chain.js";
import { ORDO_SIGNATURE, trustDomain } from "./sigs.js";

const SITE = "site_pune1";
const OTHER = "site_other";
const HSS = "0x000000000000000000000000000000000000016b" as Address;
const ROLE = { VALIDATOR: 4 } as const;
let nonce = 0;
/** A schedule's long-zero EVM address (shard 0, realm 0) */
const scheduleAt = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hashOf = (b: string) => `0x${b.repeat(32)}`;

/** OrdoTrust with two registered sites (0 manages SITE, 7 manages OTHER), OrdoTreasury, and the HSS stub at 0x16b. */
async function setup() {
  const c = await chain();
  const trust = await c.deploy("OrdoTrust", [parseEther("10"), 7 * 24 * 3600, c.accounts[4]]);
  const treasury = await c.deploy("OrdoTreasury", [trust.address]);
  const stub = await c.deploy("HssStub", []);
  await c.pub.request({ method: "evm_setAccountCode", params: [HSS, await c.pub.getCode({ address: stub.address })] } as never);
  const sign = async (who: number, action: string, entity: string, site = SITE, verifyingContract: Address = treasury.address) => {
    const message = { action, entity, meaning: action, comment: "", site, nonce: `n${++nonce}`, issuedAt: new Date().toISOString() };
    const signature = await c.wallet(who).signTypedData({ domain: trustDomain(31337, verifyingContract), types: ORDO_SIGNATURE, primaryType: "OrdoSignature", message });
    return { ...message, signature };
  };
  const send = async (from: number, to: { address: Address; abi: Abi }, fn: string, args: unknown[]) => {
    const account = c.wallet(from).account;
    await c.pub.simulateContract({ account, address: to.address, abi: to.abi, functionName: fn, args } as never);
    const hash = await c.wallet(from).writeContract({ address: to.address, abi: to.abi, functionName: fn, args } as never);
    return c.pub.waitForTransactionReceipt({ hash: hash as Hex });
  };
  const read = <T>(to: { address: Address; abi: Abi }, fn: string, args: unknown[]) => c.pub.readContract({ address: to.address, abi: to.abi, functionName: fn, args }) as Promise<T>;
  for (const [site, admin] of [[SITE, 0], [OTHER, 7]] as const) {
    const register = await sign(admin, "site.register", `${site}#${c.accounts[6]!.toLowerCase()}`, site, trust.address);
    await send(4, trust, "registerSite", [site, c.accounts[6], register]);
  }
  const approve = (from: number, site: string, schedule: Address, entity: string, sig: Awaited<ReturnType<typeof sign>>) => send(from, treasury, "approve", [site, schedule, entity, sig]);
  const authorizedBy = (schedule: Address) => read<Address>({ address: HSS, abi: stub.abi }, "authorizedBy", [schedule]);
  return { ...c, trust, treasury, stub, sign, send, read, approve, authorizedBy };
}

const ERRORS = [...artifact("OrdoTreasury").abi, ...artifact("OrdoTreasuryKey").abi] as Abi;
function revertName(e: unknown): string {
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++) {
    const data = cur.data ?? cur.details?.match?.(/0x[0-9a-f]{8,}/i)?.[0];
    if (typeof data === "string" && /^0x[0-9a-f]{8,}$/i.test(data)) {
      try {
        return decodeErrorResult({ abi: ERRORS, data: data as Hex }).errorName;
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

describe("OrdoTreasury: each org's treasury key", () => {
  it("opens one key contract per registered site, once, at a fixed address", async () => {
    const t = await setup();
    await reverts(t.send(5, t.treasury, "openSite", ["site_unknown"]), "UnknownSite");
    const r = await t.send(5, t.treasury, "openSite", [SITE]);
    const [ev] = parseEventLogs({ abi: t.treasury.abi, logs: r.logs, eventName: "KeyOpened" }) as unknown as { args: { siteId: string; key: Address } }[];
    const k = await t.read<Hex>(t.treasury, "siteKey", [SITE]);
    expect(await t.read<Address>(t.treasury, "keyOf", [k])).toBe(ev!.args.key);
    expect(ev!.args.siteId).toBe(SITE);
    // opening again changes nothing
    const again = await t.send(4, t.treasury, "openSite", [SITE]);
    expect(parseEventLogs({ abi: t.treasury.abi, logs: again.logs, eventName: "KeyOpened" })).toHaveLength(0);
    await t.send(4, t.treasury, "openSite", [OTHER]);
    expect(await t.read<Address>(t.treasury, "keyOf", [await t.read<Hex>(t.treasury, "siteKey", [OTHER])])).not.toBe(ev!.args.key);
    // the key answers to OrdoTreasury alone
    const key = { address: ev!.args.key, abi: artifact("OrdoTreasuryKey").abi };
    expect((await t.read<Address>(key, "treasury", [])).toLowerCase()).toBe(t.treasury.address.toLowerCase());
    await reverts(t.send(5, key, "authorize", [scheduleAt(4242)]), "NotTreasury");
  });

  it("names schedules by their Hedera id and refuses an address outside shard 0, realm 0", async () => {
    const t = await setup();
    expect(await t.read<string>(t.treasury, "scheduleId", [scheduleAt(11328693)])).toBe("0.0.11328693");
    await reverts(t.read(t.treasury, "scheduleId", [`0x${"1".padStart(24, "0")}${"0".repeat(16)}` as Address]), "BadSchedule");
    await reverts(t.read(t.treasury, "scheduleId", [scheduleAt(0)]), "BadSchedule");
  });
});

describe("OrdoTreasury: approving a schedule", () => {
  it("has the org's own key sign the schedule once a manager signed budget.approve for exactly it", async () => {
    const t = await setup();
    await t.send(4, t.treasury, "openSite", [SITE]);
    const schedule = scheduleAt(5001);
    const entity = `0.0.5001#${hashOf("ab")}`;
    // anyone may relay the manager's signature
    const r = await t.approve(5, SITE, schedule, entity, await t.sign(0, "budget.approve", entity));
    const key = await t.read<Address>(t.treasury, "keyOf", [await t.read<Hex>(t.treasury, "siteKey", [SITE])]);
    expect(await t.authorizedBy(schedule)).toBe(key);
    expect(await t.read<Hex>(t.treasury, "approvedFor", [schedule])).toBe(await t.read<Hex>(t.treasury, "siteKey", [SITE]));
    const [ev] = parseEventLogs({ abi: t.treasury.abi, logs: r.logs, eventName: "BudgetApproved" }) as unknown as { args: { schedule: Address; entity: string; manager: Address } }[];
    expect(ev!.args).toMatchObject({ schedule, entity, manager: t.accounts[0] });
  });

  it("refuses anyone but the org's admin, another schedule, another site or action, and a replay", async () => {
    const t = await setup();
    const schedule = scheduleAt(5002);
    const entity = `0.0.5002#${hashOf("cd")}`;
    await reverts(t.approve(4, SITE, schedule, entity, await t.sign(0, "budget.approve", entity)), "NoKey");
    await t.send(4, t.treasury, "openSite", [SITE]);
    // a validator holds a credential but is no admin; a stranger holds none
    const validator = await t.sign(0, "role.grant", `${t.accounts[1]!.toLowerCase()}#VALIDATOR`, SITE, t.trust.address);
    await t.send(4, t.trust, "grantRole", [SITE, t.accounts[1], ROLE.VALIDATOR, validator]);
    await reverts(t.approve(4, SITE, schedule, entity, await t.sign(1, "budget.approve", entity)), "NotAuthorized");
    await reverts(t.approve(4, SITE, schedule, entity, await t.sign(5, "budget.approve", entity)), "NotAuthorized");
    // the signature names one schedule: it cannot approve another, and the entity must name the schedule sent
    const sig = await t.sign(0, "budget.approve", entity);
    await reverts(t.approve(4, SITE, scheduleAt(5003), entity, sig), "WrongEntity");
    await reverts(t.approve(4, SITE, scheduleAt(5003), `0.0.5003#${hashOf("cd")}`, sig), "WrongEntity");
    await reverts(t.approve(4, SITE, schedule, `0.0.5002#0x1234`, await t.sign(0, "budget.approve", `0.0.5002#0x1234`)), "WrongEntity");
    await reverts(t.approve(4, SITE, schedule, entity, await t.sign(0, "role.grant", entity)), "WrongAction");
    await reverts(t.approve(4, SITE, schedule, entity, await t.sign(0, "budget.approve", entity, OTHER)), "WrongSite");
    await t.approve(4, SITE, schedule, entity, sig);
    await reverts(t.approve(4, SITE, schedule, entity, sig), "NonceUsed");
  });

  it("refuses a signature made for another OrdoTreasury deployment", async () => {
    const t = await setup();
    await t.send(4, t.treasury, "openSite", [SITE]);
    const other = await t.deploy("OrdoTreasury", [t.trust.address]);
    const entity = `0.0.5004#${hashOf("ef")}`;
    // the domain names the deployment: the signer recovered here is nobody with a role
    await reverts(t.approve(4, SITE, scheduleAt(5004), entity, await t.sign(0, "budget.approve", entity, SITE, other.address)), "NotAuthorized");
  });

  it("signs with each org's own key: another org's manager can only sign with theirs", async () => {
    const t = await setup();
    await t.send(4, t.treasury, "openSite", [SITE]);
    await t.send(4, t.treasury, "openSite", [OTHER]);
    const schedule = scheduleAt(5005);
    const entity = `0.0.5005#${hashOf("12")}`;
    // OTHER's manager cannot sign for SITE
    await reverts(t.approve(4, SITE, schedule, entity, await t.sign(7, "budget.approve", entity)), "NotAuthorized");
    // and signing as OTHER uses OTHER's key, which is not the key of SITE's treasury account
    await t.approve(4, OTHER, schedule, entity, await t.sign(7, "budget.approve", entity, OTHER));
    const otherKey = await t.read<Address>(t.treasury, "keyOf", [await t.read<Hex>(t.treasury, "siteKey", [OTHER])]);
    const siteKey = await t.read<Address>(t.treasury, "keyOf", [await t.read<Hex>(t.treasury, "siteKey", [SITE])]);
    expect(await t.authorizedBy(schedule)).toBe(otherKey);
    expect(otherKey).not.toBe(siteKey);
  });

  it("reverts, keeping the nonce, when the Schedule Service refuses", async () => {
    const t = await setup();
    await t.send(4, t.treasury, "openSite", [SITE]);
    const schedule = scheduleAt(5006);
    const entity = `0.0.5006#${hashOf("34")}`;
    await t.approve(4, SITE, schedule, entity, await t.sign(0, "budget.approve", entity));
    // the stub answers SCHEDULE_ALREADY_EXECUTED for a schedule it saw before
    const again = await t.sign(0, "budget.approve", entity);
    await reverts(t.approve(4, SITE, schedule, entity, again), "ScheduleRefused");
    expect(await t.read<boolean>(t.treasury, "usedNonces", [keccak256(toBytes(again.nonce))])).toBe(false);
  });
});
