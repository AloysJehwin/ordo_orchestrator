import { describe, expect, it } from "vitest";
import { Jobs } from "../../src/core/jobs.js";
import { migrate, openDb } from "../../src/db/db.js";

describe("jobs on other networks", () => {
  it("runs due jobs, retries failures with back-off, and does not queue the same work twice", async () => {
    const db = await openDb({ dataDir: "memory" });
    await migrate(db);
    let clock = Date.parse("2026-11-05T09:00:00Z");
    const jobs = new Jobs(db, () => clock);
    let calls = 0;
    jobs.register("ens.register", async (p: { name: string }) => {
      calls += 1;
      if (calls === 1) throw new Error("rpc timeout");
      return { name: p.name, tx: "0xabc" };
    });
    const id = await jobs.enqueue("site_1", "ens.register", "user_1", { name: "priya.plant.ordo.eth" });
    expect(await jobs.enqueue("site_1", "ens.register", "user_1", { name: "again" })).toBe(id);
    await jobs.enqueue("site_1", "unknown.kind", "x", {}); // no handler: left alone

    expect(await jobs.run()).toBe(1);
    expect(await jobs.latest("ens.register", "user_1")).toMatchObject({ status: "pending", attempts: 1, error: "rpc timeout" });
    expect(await jobs.run()).toBe(0); // backing off for a minute
    clock += 61_000;
    await jobs.run();
    expect(await jobs.latest("ens.register", "user_1")).toMatchObject({ status: "done", result: { name: "priya.plant.ordo.eth", tx: "0xabc" } });
    expect((await jobs.latestMany("ens.register", ["user_1", "user_2"])).get("user_1")?.status).toBe("done");
    await db.close();
  });

  it("gives up after six attempts and can be retried by hand", async () => {
    const db = await openDb({ dataDir: "memory" });
    await migrate(db);
    let clock = 0;
    const jobs = new Jobs(db, () => clock);
    jobs.register("og.upload", async () => {
      throw new Error("indexer down");
    });
    await jobs.enqueue(null, "og.upload", "blob_1", {});
    for (let i = 0; i < 6; i++) {
      await jobs.run();
      clock += 3_600_000;
    }
    expect(await jobs.latest("og.upload", "blob_1")).toMatchObject({ status: "failed", attempts: 6 });
    expect(await jobs.retry("og.upload", "blob_1")).toMatchObject({ status: "pending", attempts: 0 });
    await db.close();
  });
});
