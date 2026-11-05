import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../../src/db/db.js";
import { LedgerStore } from "../../src/db/ledger-store.js";
import { verifyChain } from "../../src/domain/ledger.js";

describe("ledger store", () => {
  it("serializes concurrent appends into one valid chain", async () => {
    const db = await openDb({ dataDir: "memory" });
    await migrate(db);
    const ledger = new LedgerStore(db);
    await Promise.all(Array.from({ length: 60 }, (_, i) => ledger.append({ ts: new Date().toISOString(), actor: "t", type: "x", subject: null, payload: { i, v: 0.1 + i / 3 } })));
    const all = await ledger.range(1, 1000);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(verifyChain(all).ok).toBe(true);
    await db.close();
  });
});
