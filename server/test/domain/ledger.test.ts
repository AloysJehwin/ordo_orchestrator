import { describe, expect, it } from "vitest";
import { canonicalize, hashOf } from "../../src/domain/canonical.js";
import { buildEntry, GENESIS_HASH, verifyChain, type LedgerEntry } from "../../src/domain/ledger.js";

const draft = (i: number) => ({ ts: `2026-10-19T10:00:0${i}Z`, actor: "agent:line", type: "test", subject: "INC-1", payload: { i, nested: { b: 2, a: 1 } } });

function chain(n: number): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (let i = 0; i < n; i++) out.push(buildEntry(out.at(-1) ?? null, draft(i)));
  return out;
}

describe("canonical JSON", () => {
  it("sorts keys and drops undefined", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
  });
  it("is key-order independent", () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
  });
});

describe("ledger chain", () => {
  it("links entries from genesis", () => {
    const c = chain(3);
    expect(c[0]!.prevHash).toBe(GENESIS_HASH);
    expect(c[1]!.prevHash).toBe(c[0]!.entryHash);
    expect(c.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(verifyChain(c).ok).toBe(true);
  });

  it("detects a tampered payload and marks everything after it", () => {
    const c = chain(5);
    c[2] = { ...c[2]!, payload: { i: 99 } };
    const r = verifyChain(c);
    expect(r.ok).toBe(false);
    expect(r.checks.map((x) => x.ok)).toEqual([true, true, false, false, false]);
    expect(r.checks[2]!.reason).toContain("payload");
  });

  it("detects a rewritten entry even if its own hashes are recomputed", () => {
    const c = chain(4);
    const forged = buildEntry(c[0]!, { ...draft(1), payload: { forged: true } });
    c[1] = forged; // valid on its own, but entry 3 still points at the old entry 2
    const r = verifyChain(c);
    expect(r.checks[1]!.ok).toBe(true);
    expect(r.checks[2]!.ok).toBe(false);
  });

  it("detects a deleted entry", () => {
    const c = chain(4);
    c.splice(1, 1);
    expect(verifyChain(c).ok).toBe(false);
  });
});
