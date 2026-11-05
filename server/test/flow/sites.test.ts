import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, wallet, type System } from "./helpers.js";

let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];

beforeAll(async () => {
  ({ sys, app } = await boot());
}, 60_000);
afterAll(async () => sys.close());

describe("two sites on one deployment", () => {
  it("each starts runs with ids of its own, and sees only its own ledger", async () => {
    const a = await wallet(app);
    const b = await wallet(app);
    const siteA = (await a.call("POST", "/v1/sites", { name: "Site A", timezone: "UTC", lineName: "Line 1", zones: ["Z"] })).json.id as string;
    const siteB = (await b.call("POST", "/v1/sites", { name: "Site B", timezone: "UTC", lineName: "Line 1", zones: ["Z"] })).json.id as string;
    expect(siteB).toBeTruthy();

    const start = async (c: typeof a, site: string, orderRef: string) => {
      const tpl = (await c.call("GET", `/v1/sites/${site}/templates`)).json[0];
      return c.call("POST", `/v1/sites/${site}/runs`, { templateVersionId: tpl.versionId, orderRef, quantity: 5 });
    };
    const runA = await start(a, siteA, "SO-SECRET-A");
    const runB = await start(b, siteB, "SO-B");
    expect(runA.status).toBe(200);
    expect(runB.status).toBe(200);
    expect(runB.json.id).not.toBe(runA.json.id);

    const ledgerB = (await b.call("GET", `/v1/sites/${siteB}/ledger?limit=500`)).json.entries as { subject: string | null; payload: unknown }[];
    expect(ledgerB.some((e) => e.subject === runB.json.id)).toBe(true);
    expect(JSON.stringify(ledgerB)).not.toContain("SO-SECRET-A");
    expect((await b.call("GET", `/v1/sites/${siteB}/verify?subject=${runA.json.id}`)).status).toBe(404);
  });

  it("answers unknown API paths in JSON", async () => {
    const r = await app.request("/v1/nope", { headers: { host: "localhost" } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "Not found" });
  });
});
