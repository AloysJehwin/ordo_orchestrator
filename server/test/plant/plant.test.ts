import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb } from "../../src/db/db.js";
import { PlantService } from "../../src/plant/plant.js";

const xml = readFileSync(new URL("../fixtures/mtconnect-current.xml", import.meta.url), "utf8");

async function setup() {
  const db = await openDb({ dataDir: "memory" });
  await migrate(db);
  await db.query("INSERT INTO users (id, address) VALUES ('usr_1', '0xabc')");
  const clock = { t: Date.parse("2026-10-19T10:00:00Z") };
  const plant = new PlantService(db, () => clock.t);
  const siteId = await plant.createSite({ name: "Plant 03", timezone: "Asia/Kolkata", lineName: "Line A", zones: ["Machining", "Assembly"] }, "usr_1");
  return { db, plant, siteId, clock };
}
afterEach(() => vi.unstubAllGlobals());

describe("plant registry and real data", () => {
  it("creating a site makes the creator its manager, with a line and zones, open to new members", async () => {
    const { db, plant, siteId } = await setup();
    const site = await plant.site(siteId);
    expect(site.lines.map((l) => l.name)).toEqual(["Line A"]);
    expect(site.zones.map((z) => z.name)).toEqual(["Machining", "Assembly"]);
    expect(site.openJoin).toBe(true);
    expect((await plant.team(siteId)).members[0]!.roles).toEqual(["manager"]);
    await db.close();
  });

  it("an org keeps at least one manager", async () => {
    const { db, plant, siteId } = await setup();
    await expect(plant.removeRole(siteId, "usr_1", "manager")).rejects.toThrow(/at least one manager/);
    await expect(plant.removeMember(siteId, "usr_1")).rejects.toThrow(/at least one manager/);
    await db.query("INSERT INTO users (id, address) VALUES ('usr_2', '0xdef')");
    expect(await plant.join(siteId, "usr_2")).toEqual({ joined: true });
    await plant.addRole(siteId, "usr_2", "manager", "usr_1");
    await plant.removeMember(siteId, "usr_1");
    expect((await plant.team(siteId)).members.map((m) => [m.userId, m.roles.sort()])).toEqual([["usr_2", ["contributor", "manager"]]]);
    await db.close();
  });

  it("a manual asset has no data until someone records a reading", async () => {
    const { db, plant, siteId } = await setup();
    const id = await plant.createAsset(siteId, { zoneId: null, name: "Line L-1", kind: "manual_station", description: null, owningAgent: "line", source: { type: "manual" }, limits: {}, idealCycleS: null }, "usr_1");
    expect((await plant.views(siteId))[0]!.status).toBe("no_data");
    await plant.manualReading(siteId, id, { signal: "State", value: null, text: "ACTIVE" });
    const v = (await plant.views(siteId))[0]!;
    expect(v.status).toBe("running");
    expect(v.latest.state!.text).toBe("ACTIVE");
    await db.close();
  });

  it("aggregates one asset's signals over a stage window, good-quality points only", async () => {
    const { db, plant, siteId, clock } = await setup();
    const id = await plant.createAsset(siteId, { zoneId: null, name: "BR-01 Bioreactor", kind: "process_vessel", description: null, owningAgent: "process", source: { type: "manual" }, limits: {}, idealCycleS: null }, "usr_1");
    const t0 = clock.t;
    for (const v of [36.5, 37.2, 38.1]) {
      clock.t += 60_000;
      await plant.manualReading(siteId, id, { signal: "Temperature", value: v, text: null });
    }
    clock.t += 60_000;
    await plant.manualReading(siteId, id, { signal: "od600", value: 0.7, text: null });
    await db.query("INSERT INTO telemetry (asset_id, signal, ts, value, text_value, quality) VALUES ($1, 'temperature', $2, 99, NULL, 'bad')", [id, new Date(clock.t + 1000).toISOString()]);
    const st = await plant.windowStats(id, ["temperature", "od600", "ph"], t0, clock.t + 120_000);
    expect(st.temperature).toEqual({ last: 38.1, min: 36.5, max: 38.1, mean: expect.closeTo(37.27, 2), n: 3 });
    expect(st.od600).toEqual({ last: 0.7, min: 0.7, max: 0.7, mean: 0.7, n: 1 });
    expect(st.ph).toBeUndefined();
    // only the window counts
    expect((await plant.windowStats(id, ["temperature"], t0 + 90_000, clock.t)).temperature).toMatchObject({ min: 37.2, max: 38.1, last: 38.1, n: 2 });
    expect(await plant.seriesBetween(id, "temperature", t0, clock.t + 120_000)).toEqual([
      { ts: t0 + 60_000, value: 36.5 },
      { ts: t0 + 120_000, value: 37.2 },
      { ts: t0 + 180_000, value: 38.1 },
    ]);
    await db.close();
  });

  it("ingests an MTConnect agent once per poll interval and derives status", async () => {
    const { db, plant, siteId, clock } = await setup();
    const fetchMock = vi.fn(async () => new Response(xml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await plant.createAsset(siteId, { zoneId: null, name: "Mazak VTC", kind: "cnc", description: null, owningAgent: "scheduler", source: { type: "mtconnect", agentUrl: "https://demo.mtconnect.org", device: "Mazak", pollSeconds: 10 }, limits: { load_pct: { warn: 80, alarm: 95, unit: "%" } }, idealCycleS: 30 }, "usr_1");
    await plant.createAsset(siteId, { zoneId: null, name: "Okuma", kind: "cnc", description: null, owningAgent: "scheduler", source: { type: "mtconnect", agentUrl: "https://demo.mtconnect.org", device: "OKUMA", pollSeconds: 10 }, limits: {}, idealCycleS: null }, "usr_1");
    const r1 = await plant.ingest();
    expect(fetchMock).toHaveBeenCalledTimes(1); // one /current for both devices
    expect(r1.inserted).toBeGreaterThan(5);
    expect((await plant.ingest()).polled).toBe(0); // not due yet
    clock.t += 11_000;
    const r3 = await plant.ingest();
    expect(r3.polled).toBe(1);
    expect(r3.inserted).toBe(0); // same timestamps: nothing new stored
    clock.t = Date.parse("2026-10-19T10:00:30Z");
    const views = await plant.views(siteId);
    const mazak = views.find((v) => v.name === "Mazak VTC")!;
    expect(mazak.status).toBe("running");
    expect(mazak.currentJob).toBe("O1234-BRACKET");
    expect(views.find((v) => v.name === "Okuma")!.status).toBe("idle");
    await db.close();
  });

  it("records source errors and shows the asset offline", async () => {
    const { db, plant, siteId } = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await plant.createAsset(siteId, { zoneId: null, name: "Remote", kind: "cnc", description: null, owningAgent: "scheduler", source: { type: "mtconnect", agentUrl: "https://agent.example.com", device: "X", pollSeconds: 10 }, limits: {}, idealCycleS: null }, "usr_1");
    expect((await plant.ingest()).errors).toBe(1);
    const v = (await plant.views(siteId))[0]!;
    expect(v.status).toBe("no_data");
    expect(v.sourceError).toMatch(/503/);
    await db.close();
  });



});
