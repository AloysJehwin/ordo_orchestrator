import { describe, expect, it } from "vitest";
import { decodeErrorResult, encodeFunctionData, parseEther, type Abi, type Address, type Hex } from "viem";
import { artifact, chain } from "./chain.js";
import { trustDomain } from "./sigs.js";

const TYPES = {
  OrdoSignature: [
    { name: "action", type: "string" },
    { name: "entity", type: "string" },
    { name: "meaning", type: "string" },
    { name: "comment", type: "string" },
    { name: "site", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
  ],
} as const;
const SITE = "site_pune1";
const ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, VENDOR: 32 } as const;
const HASH = `0x${"ab".repeat(32)}` as Hex;
let nonce = 0;

/** 0 admin + plant manager · 1 maintenance lead (SUPERVISOR) · 2 vendor · 3 agent · 4 relayer · 5 stranger · 6 second plant manager */
async function setup() {
  const c = await chain();
  const trust = await c.deploy("OrdoTrust", [parseEther("10"), 7 * 24 * 3600, c.accounts[4]]);
  const orders = await c.deploy("OrdoWorkOrders", [trust.address]);
  const policies = await c.deploy("OrdoPolicies", [trust.address]);
  const acct = c.accounts;
  const sign = async (who: number, action: string, entity: string, site = SITE) => {
    const message = { action, entity, meaning: action, comment: "", site, nonce: `w${++nonce}`, issuedAt: new Date().toISOString() };
    const signature = await c.wallet(who).signTypedData({ domain: { name: "Ordo", version: "1", chainId: 31337 }, types: TYPES, primaryType: "OrdoSignature", message });
    return { ...message, signature };
  };
  // OrdoTrust's own signatures name its deployment (domain version 2)
  const signTrust = async (who: number, action: string, entity: string) => {
    const message = { action, entity, meaning: action, comment: "", site: SITE, nonce: `w${++nonce}`, issuedAt: new Date().toISOString() };
    const signature = await c.wallet(who).signTypedData({ domain: trustDomain(31337, trust.address), types: TYPES, primaryType: "OrdoSignature", message });
    return { ...message, signature };
  };
  const write = async (contract: { address: Address; abi: Abi }, from: number, fn: string, args: unknown[], value?: bigint) => {
    const account = c.wallet(from).account;
    await c.pub.simulateContract({ account, address: contract.address, abi: contract.abi, functionName: fn, args, value } as never);
    const hash = await c.wallet(from).writeContract({ address: contract.address, abi: contract.abi, functionName: fn, args, value } as never);
    return c.pub.waitForTransactionReceipt({ hash: hash as Hex });
  };
  const read = <T>(contract: { address: Address; abi: Abi }, fn: string, args: unknown[]) =>
    c.pub.readContract({ address: contract.address, abi: contract.abi, functionName: fn, args }) as Promise<T>;
  const grant = async (who: number, role: keyof typeof ROLE) =>
    write(trust, 4, "grantRole", [SITE, acct[who], ROLE[role], await signTrust(0, "role.grant", `${acct[who]!.toLowerCase()}#${role}`)]);

  await write(trust, 4, "registerSite", [SITE, acct[0], await signTrust(0, "site.register", `${SITE}#${acct[0]!.toLowerCase()}`)]);
  await grant(1, "SUPERVISOR");
  await grant(2, "VENDOR");
  await grant(6, "PLANT_MANAGER");
  return { ...c, trust, orders, policies, sign, signTrust, write, read, grant, acct };
}
type T = Awaited<ReturnType<typeof setup>>;

const ERRORS = [...artifact("OrdoWorkOrders").abi, ...artifact("OrdoPolicies").abi] as Abi;
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

/** Agent 3 may spend 5 per order and 8 per day; the site fund holds 20. */
async function funded(): Promise<T> {
  const t = await setup();
  const [perOrder, perDay] = [parseEther("5"), parseEther("8")];
  await t.write(t.orders, 4, "setAgent", [SITE, t.acct[3], perOrder, perDay, await t.sign(0, "agent.caps", `${t.acct[3]!.toLowerCase()}#${perOrder}#${perDay}`)]);
  await t.write(t.orders, 5, "fund", [SITE], parseEther("20"));
  return t;
}
const escrow = (t: T, id: string, amount: bigint, vendor = 2, ttl = 3600) => t.write(t.orders, 3, "escrow", [SITE, id, t.acct[vendor], amount, ttl, HASH]);
const releaseSig = (t: T, who: number, id: string, amount: bigint, vendor = 2) => t.sign(who, "workorder.release", `${id}#${t.acct[vendor]!.toLowerCase()}#${amount}`);

describe("OrdoWorkOrders: setting up an agent", () => {
  it("sets caps only with a site admin's signature for exactly those caps", async () => {
    const t = await setup();
    const ent = `${t.acct[3]!.toLowerCase()}#5#8`;
    await reverts(t.write(t.orders, 4, "setAgent", [SITE, t.acct[3], 5n, 8n, await t.sign(1, "agent.caps", ent)]), "NotAuthorized");
    await reverts(t.write(t.orders, 4, "setAgent", [SITE, t.acct[3], 6n, 8n, await t.sign(0, "agent.caps", ent)]), "WrongEntity");
    await t.write(t.orders, 4, "setAgent", [SITE, t.acct[3], 5n, 8n, await t.sign(0, "agent.caps", ent)]);
    expect(await t.read<readonly [bigint, bigint]>(t.orders, "caps", [await t.read(t.orders, "siteKey", [SITE]), t.acct[3]])).toEqual([5n, 8n]);
    await reverts(t.write(t.orders, 5, "fund", ["site_unknown"], 1n), "UnknownSite");
  });
});

describe("OrdoWorkOrders: the agent escrows within limits", () => {
  it("escrows for a credentialed vendor and refuses everything outside the caps", async () => {
    const t = await funded();
    await escrow(t, "WO-1", parseEther("4"));
    const k = await t.read<Hex>(t.orders, "siteKey", [SITE]);
    expect(await t.read<bigint>(t.orders, "funds", [k])).toBe(parseEther("16"));
    await reverts(escrow(t, "WO-1", parseEther("1")), "WorkOrderExists");
    await reverts(escrow(t, "WO-2", parseEther("6")), "OverOrderCap");
    await reverts(escrow(t, "WO-2", parseEther("5")), "OverDailyCap"); // 4 + 5 > 8
    await reverts(escrow(t, "WO-2", parseEther("1"), 5), "NotVendor");
    await reverts(t.write(t.orders, 5, "escrow", [SITE, "WO-2", t.acct[2], 1n, 3600, HASH]), "NotAgent");
    await t.increaseTime(24 * 3600);
    await escrow(t, "WO-2", parseEther("5")); // a new day
    await escrow(t, "WO-3", parseEther("3"));
    await reverts(escrow(t, "WO-4", parseEther("5")), "OverDailyCap");
  });

  it("cannot spend more than the site's fund", async () => {
    const t = await setup();
    await t.write(t.orders, 4, "setAgent", [SITE, t.acct[3], parseEther("5"), parseEther("8"), await t.sign(0, "agent.caps", `${t.acct[3]!.toLowerCase()}#${parseEther("5")}#${parseEther("8")}`)]);
    await t.write(t.orders, 5, "fund", [SITE], parseEther("2"));
    await reverts(escrow(t, "WO-1", parseEther("3")), "InsufficientFunds");
  });

  it("stops at once when an admin or plant manager pauses the agent", async () => {
    const t = await funded();
    await reverts(t.write(t.orders, 4, "setPaused", [SITE, true, await t.sign(1, "agent.pause", SITE)]), "NotAuthorized");
    await t.write(t.orders, 4, "setPaused", [SITE, true, await t.sign(6, "agent.pause", SITE)]);
    await reverts(escrow(t, "WO-1", parseEther("1")), "AgentPaused");
    await t.write(t.orders, 4, "setPaused", [SITE, false, await t.sign(0, "agent.resume", SITE)]);
    await escrow(t, "WO-1", parseEther("1"));
  });
});

describe("OrdoWorkOrders: people release, expiry refunds", () => {
  it("pays the vendor only on a supervisor's or plant manager's signature for that order and amount", async () => {
    const t = await funded();
    const amount = parseEther("4");
    await escrow(t, "WO-1", amount);
    await reverts(t.write(t.orders, 4, "release", [SITE, "WO-1", await releaseSig(t, 5, "WO-1", amount)]), "NotAuthorized"); // stranger
    await reverts(t.write(t.orders, 4, "release", [SITE, "WO-1", await releaseSig(t, 1, "WO-1", parseEther("5"))]), "WrongEntity"); // other amount
    const before = await t.pub.getBalance({ address: t.acct[2]! });
    await t.write(t.orders, 4, "release", [SITE, "WO-1", await releaseSig(t, 1, "WO-1", amount)]);
    expect((await t.pub.getBalance({ address: t.acct[2]! })) - before).toBe(amount);
    await reverts(t.write(t.orders, 4, "release", [SITE, "WO-1", await releaseSig(t, 0, "WO-1", amount)]), "NotEscrowed");
  });

  it("returns an unreleased escrow to the fund after it expires, and lets an admin withdraw", async () => {
    const t = await funded();
    await escrow(t, "WO-1", parseEther("4"), 2, 3600);
    await reverts(t.write(t.orders, 5, "refund", [SITE, "WO-1"]), "NotExpired");
    await t.increaseTime(3601);
    await t.write(t.orders, 5, "refund", [SITE, "WO-1"]);
    const k = await t.read<Hex>(t.orders, "siteKey", [SITE]);
    expect(await t.read<bigint>(t.orders, "funds", [k])).toBe(parseEther("20"));
    await reverts(t.write(t.orders, 4, "release", [SITE, "WO-1", await releaseSig(t, 1, "WO-1", parseEther("4"))]), "NotEscrowed");
    const to = t.acct[7]!;
    await reverts(t.write(t.orders, 4, "withdraw", [SITE, to, parseEther("5"), await t.sign(6, "fund.withdraw", `${to.toLowerCase()}#${parseEther("5")}`)]), "NotAuthorized");
    await t.write(t.orders, 4, "withdraw", [SITE, to, parseEther("5"), await t.sign(0, "fund.withdraw", `${to.toLowerCase()}#${parseEther("5")}`)]);
    expect(await t.read<bigint>(t.orders, "funds", [k])).toBe(parseEther("15"));
  });
});

describe("OrdoWorkOrders: reentrancy", () => {
  it("a malicious vendor cannot call back into release while being paid", async () => {
    const t = await funded();
    const evil = await t.deploy("ReentrantVendor", []);
    const ent = `${evil.address.toLowerCase()}#VENDOR`;
    await t.write(t.trust, 4, "grantRole", [SITE, evil.address, ROLE.VENDOR, await t.signTrust(0, "role.grant", ent)]);
    const amount = parseEther("2");
    await t.write(t.orders, 3, "escrow", [SITE, "WO-5", evil.address, amount, 3600, HASH]);
    await t.write(t.orders, 3, "escrow", [SITE, "WO-6", evil.address, amount, 3600, HASH]);
    const ent6 = `WO-6#${evil.address.toLowerCase()}#${amount}`;
    const sig6 = await t.sign(6, "workorder.release", ent6); // a valid release of WO-6 by the second plant manager
    await t.write(evil, 0, "arm", [t.orders.address, encodeFunctionData({ abi: t.orders.abi, functionName: "release", args: [SITE, "WO-6", sig6] })]);
    await t.write(t.orders, 4, "release", [SITE, "WO-5", await t.sign(1, "workorder.release", `WO-5#${evil.address.toLowerCase()}#${amount}`)]);
    expect(await t.read<boolean>(evil, "attempted", [])).toBe(true);
    expect(await t.read<boolean>(evil, "reentered", [])).toBe(false);
    const w6 = await t.read<readonly unknown[]>(t.orders, "workOrders", [await t.read(t.orders, "orderKey", [SITE, "WO-6"])]);
    expect(w6[4]).toBe(1); // still escrowed
  });
});

describe("OrdoPolicies: one plant manager publishes", () => {
  const LINE = "line_1";
  const upd = (level: number, version: number, hash: Hex = HASH) => ({ lineId: LINE, level, policyHash: hash, version });
  const sigs = (t: T, who: number[], level: number, version: number, hash: Hex = HASH) =>
    Promise.all(who.map((w) => t.sign(w, "policy.publish", `${LINE}#L${level}#${hash}#${version}`)));

  it("needs one plant manager to publish, raise or lower; extra signers must be different plant managers", async () => {
    const t = await setup();
    await reverts(t.write(t.policies, 4, "publish", [SITE, upd(4, 1), []]), "NotEnoughSigners");
    await reverts(t.write(t.policies, 4, "publish", [SITE, upd(4, 1), await sigs(t, [1], 4, 1)]), "NotAuthorized"); // 1 is a supervisor
    await reverts(t.write(t.policies, 4, "publish", [SITE, upd(4, 1), await sigs(t, [0, 0], 4, 1)]), "DuplicateSigner");
    await reverts(t.write(t.policies, 4, "publish", [SITE, upd(4, 1), await sigs(t, [0, 1], 4, 1)]), "NotAuthorized");
    await t.write(t.policies, 4, "publish", [SITE, upd(4, 1), await sigs(t, [0], 4, 1)]);
    const p = await t.read<{ level: number; version: number }>(t.policies, "current", [SITE, LINE]);
    expect([p.level, p.version]).toEqual([4, 1]);
    // lowering, raising again and changing the policy file: one plant manager each
    await t.write(t.policies, 4, "publish", [SITE, upd(2, 2), await sigs(t, [6], 2, 2)]);
    await t.write(t.policies, 4, "publish", [SITE, upd(3, 3), await sigs(t, [6], 3, 3)]);
    const other = `0x${"cd".repeat(32)}` as Hex;
    await t.write(t.policies, 4, "publish", [SITE, upd(1, 4, other), await sigs(t, [0, 6], 1, 4, other)]);
    const q = await t.read<{ level: number; version: number; policyHash: Hex }>(t.policies, "current", [SITE, LINE]);
    expect([q.level, q.version, q.policyHash]).toEqual([1, 4, other]);
    await reverts(t.write(t.policies, 4, "publish", [SITE, upd(1, 4), await sigs(t, [0], 1, 4)]), "VersionNotIncreasing");
    await reverts(t.write(t.policies, 4, "publish", [SITE, upd(5, 5), await sigs(t, [0], 5, 5)]), "InvalidLevel");
  });
});
