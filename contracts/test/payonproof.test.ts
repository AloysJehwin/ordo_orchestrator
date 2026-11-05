import { describe, expect, it } from "vitest";
import { decodeErrorResult, decodeEventLog, encodeAbiParameters, keccak256, type Abi, type Address, type Hex } from "viem";
import { artifact, chain } from "./chain.js";

const SITE = "site_pune1";
const PKG = "vp_lot42";
const DAY = 24 * 3600;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** 0 Ordo (deploys, opens, settles) · 1 customer · 2 supplier · 3 financier · 4 stranger */
async function setup(releases = "MockReleases") {
  const c = await chain();
  const coin = await c.deploy("MockStablecoin", []);
  const trust = await c.deploy(releases, []);
  const pay = await c.deploy("OrdoPayOnProof", [coin.address, coin.address, trust.address]);
  const [, customer, supplier, financier] = c.accounts as [Address, Address, Address, Address];
  const write = async (contract: { address: Address; abi: Abi }, from: number, fn: string, args: unknown[]) => {
    const account = c.wallet(from).account;
    await c.pub.simulateContract({ account, address: contract.address, abi: contract.abi, functionName: fn, args } as never);
    const hash = await c.wallet(from).writeContract({ address: contract.address, abi: contract.abi, functionName: fn, args } as never);
    return c.pub.waitForTransactionReceipt({ hash: hash as Hex });
  };
  const read = <T>(contract: { address: Address; abi: Abi }, fn: string, args: unknown[]) => c.pub.readContract({ address: contract.address, abi: contract.abi, functionName: fn, args }) as Promise<T>;
  const balance = (a: Address) => read<bigint>(coin, "balanceOf", [a]);
  await write(coin, 0, "mint", [customer, 1_000_000_000n]); // 1000 OUSD at 6 decimals: Stablecoin Studio's cash-in
  await write(coin, 0, "mint", [financier, 1_000_000_000n]);

  /** The customer locks `amount` in a hold for this contract, committed to the terms; returns its hold id */
  const hold = async (amount: bigint, payee: Address = supplier, ttl = 30 * DAY, pkg = PKG, escrow: Address = pay.address) => {
    const block = await c.pub.getBlock();
    const data = await read<Hex>(pay, "terms", [SITE, pkg, payee]);
    const r = await write(coin, 1, "createHold", [{ amount, expirationTimestamp: block.timestamp + BigInt(ttl), escrow, to: ZERO, data }]);
    for (const l of r.logs) {
      const e = decodeEventLog({ abi: coin.abi, data: l.data, topics: l.topics });
      if (e.eventName === "HoldCreated") return (e.args as unknown as { holdId: bigint }).holdId;
    }
    throw new Error("no hold");
  };
  const open = async (holdId: bigint, payee: Address = supplier, pkg = PKG) => {
    await write(pay, 4, "open", [customer, holdId, SITE, pkg, payee]); // anyone can register it
    return read<Hex>(pay, "keyOf", [customer, holdId]);
  };
  const order = (key: Hex) => read<readonly [Address, bigint, bigint, bigint, Hex, Hex, Address, bigint, number]>(pay, "orders", [key]).then(([buyer, holdId, amount, expiresAt, , , payee, ask, state]) => ({ buyer, holdId, amount, expiresAt, payee, ask, state }));
  return { ...c, coin, trust, pay, write, read, balance, hold, open, order, customer, supplier, financier };
}

const ERRORS = [...artifact("OrdoPayOnProof").abi, ...artifact("MockStablecoin").abi] as Abi;
const reverts = async (p: Promise<unknown>, name: string) => {
  let got = "no revert";
  try {
    await p;
  } catch (e) {
    got = e instanceof Error ? e.message : String(e);
    for (let cur: any = e, i = 0; i < 8 && cur; i++, cur = cur.cause) {
      const data = cur.data ?? cur.details?.match?.(/0x[0-9a-f]{8,}/i)?.[0];
      if (typeof data === "string" && /^0x[0-9a-f]{8,}$/i.test(data)) {
        try {
          got = decodeErrorResult({ abi: ERRORS, data: data as Hex }).errorName;
          break;
        } catch {
          /* keep walking */
        }
      }
    }
  }
  expect(got).toBe(name);
};

describe("OrdoPayOnProof: an order is a customer's hold, committed to the terms", () => {
  it("opens only a hold that names this contract as escrow and carries exactly the terms", async () => {
    const t = await setup();
    const id = await t.hold(500_000_000n);
    expect(await t.balance(t.customer)).toBe(500_000_000n); // the rest is held, not spent
    await reverts(t.open(id, t.financier), "WrongTerms"); // a different payee than the customer agreed to
    await reverts(t.open(id, t.supplier, "vp_other"), "WrongTerms");
    const elsewhere = await t.hold(1_000_000n, t.supplier, 30 * DAY, PKG, t.accounts[4]!);
    await reverts(t.open(elsewhere), "NotEscrow");
    const key = await t.open(id);
    expect(await t.order(key)).toMatchObject({ buyer: t.customer, amount: 500_000_000n, payee: t.supplier, ask: 0n, state: 1 });
    await reverts(t.open(id), "AlreadyOpen");
  });
});

describe("OrdoPayOnProof: paid on proof", () => {
  it("pays the supplier only once OrdoTrust records the package's release, and only once", async () => {
    const t = await setup();
    const key = await t.open(await t.hold(500_000_000n));
    await reverts(t.write(t.pay, 4, "settle", [key]), "NotReleased");
    expect(await t.read<bigint>(t.pay, "releasedAt", [key])).toBe(0n);
    await t.write(t.trust, 0, "release", [SITE, PKG]);
    expect(await t.read<bigint>(t.pay, "releasedAt", [key])).toBeGreaterThan(0n);
    await t.write(t.pay, 4, "settle", [key]); // anyone can settle
    expect(await t.balance(t.supplier)).toBe(500_000_000n);
    expect((await t.order(key)).state).toBe(2);
    await reverts(t.write(t.pay, 4, "settle", [key]), "NotOpen");
  });

  it("reads a release from OrdoTrust as first deployed too", async () => {
    const t = await setup("MockOldReleases");
    const key = await t.open(await t.hold(10n));
    await reverts(t.write(t.pay, 4, "settle", [key]), "NotReleased");
    await t.write(t.trust, 0, "release", [SITE, PKG]);
    await t.write(t.pay, 4, "settle", [key]);
    expect(await t.balance(t.supplier)).toBe(10n);
  });

  it("another package's release pays nothing", async () => {
    const t = await setup();
    const key = await t.open(await t.hold(10n));
    await t.write(t.trust, 0, "release", [SITE, "vp_other"]);
    await reverts(t.write(t.pay, 4, "settle", [key]), "NotReleased");
  });
});

describe("OrdoPayOnProof: the receivable", () => {
  it("a financier buys it at a discount now and is paid the full amount on proof", async () => {
    const t = await setup();
    const key = await t.open(await t.hold(500_000_000n));
    await reverts(t.write(t.pay, 3, "offer", [key, 485_000_000n]), "NotPayee");
    await reverts(t.write(t.pay, 2, "offer", [key, 500_000_000n]), "BadPrice"); // must be a discount
    await t.write(t.pay, 2, "offer", [key, 485_000_000n]); // 3% off
    await t.write(t.coin, 3, "approve", [t.pay.address, 485_000_000n]);
    await reverts(t.write(t.pay, 3, "take", [key, 480_000_000n]), "BadPrice"); // not the price on offer
    await t.write(t.pay, 3, "take", [key, 485_000_000n]);
    expect(await t.balance(t.supplier)).toBe(485_000_000n); // cash before the lot is proven
    expect(await t.order(key)).toMatchObject({ payee: t.financier, ask: 0n });
    await reverts(t.write(t.pay, 2, "offer", [key, 1n]), "NotPayee"); // the supplier sold it
    await t.write(t.trust, 0, "release", [SITE, PKG]);
    await t.write(t.pay, 4, "settle", [key]);
    expect(await t.balance(t.financier)).toBe(1_000_000_000n - 485_000_000n + 500_000_000n);
  });
});

describe("OrdoPayOnProof: refunds", () => {
  it("the supplier waives a rejected lot and the customer has its money back", async () => {
    const t = await setup();
    const key = await t.open(await t.hold(500_000_000n));
    await reverts(t.write(t.pay, 4, "waive", [key]), "NotPayee");
    await t.write(t.pay, 2, "waive", [key]);
    expect(await t.balance(t.customer)).toBe(1_000_000_000n);
    expect((await t.order(key)).state).toBe(3);
    await t.write(t.trust, 0, "release", [SITE, PKG]);
    await reverts(t.write(t.pay, 4, "settle", [key]), "NotOpen");
  });

  it("an unreleased hold goes back to the customer once it expires", async () => {
    const t = await setup();
    const key = await t.open(await t.hold(500_000_000n, t.supplier, DAY));
    await reverts(t.write(t.pay, 4, "refundExpired", [key]), "NotExpired");
    await t.increaseTime(DAY + 60);
    await t.write(t.pay, 4, "refundExpired", [key]);
    expect(await t.balance(t.customer)).toBe(1_000_000_000n);
  });
});

it("terms hash the site, package and payee", async () => {
  const t = await setup();
  const want = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }, { type: "address" }], ["OrdoPayOnProof", SITE, PKG, t.supplier]));
  expect(await t.read<Hex>(t.pay, "terms", [SITE, PKG, t.supplier])).toBe(want);
});
