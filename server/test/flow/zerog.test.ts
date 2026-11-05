import { createHash } from "node:crypto";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlobStore } from "../../src/chain/zerog.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

/** A 0G Storage stand-in: content-addressed, and it can be made to return different bytes. */
class FakeZeroG implements BlobStore {
  readonly kind = "0g-storage";
  files = new Map<string, Uint8Array>();
  failNext = 0;
  async put(bytes: Uint8Array) {
    if (this.failNext-- > 0) throw new Error("indexer unavailable");
    const root = `0x${createHash("sha256").update("0g").update(bytes).digest("hex")}`;
    this.files.set(root, bytes);
    return { root, tx: "0xfeed", url: "https://chainscan-galileo.0g.ai/tx/0xfeed" };
  }
  async get(root: string) {
    return this.files.get(root)!;
  }
}

let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
let admin: Client;
let site = "";
const store = new FakeZeroG();
const S = () => `/v1/sites/${site}`;
let skew = 0;

beforeAll(async () => {
  ({ sys, app } = await boot({}, { blobStore: store, now: () => Date.now() + skew }));
  admin = await wallet(app, generatePrivateKey());
  site = (await admin.call("POST", "/v1/sites", { name: "Evidence Plant", timezone: "UTC", lineName: "L1", zones: [] })).json.id;
});
afterAll(async () => sys.close());

describe("evidence copies on 0G Storage", () => {
  let pkg = "";
  let slot = "";
  it("copies an attached file to 0G and records its root in the ledger", async () => {
    pkg = (await admin.call("POST", `${S()}/validation`, { type: "proof_of_concept", title: "Fixture concept", objective: "Prove the fixture", acceptance: "Holds tolerance" })).json.id;
    slot = (await admin.call("GET", `${S()}/validation/${pkg}`)).json.evidence.find((e: any) => e.name === "Concept report").id;
    const form = new FormData();
    form.set("file", new File(["Concept report: fixture holds ±0.01 mm"], "concept.txt", { type: "text/plain" }));
    form.set("slotId", slot);
    store.failNext = 1;
    expect((await admin.upload(`${S()}/validation/${pkg}/evidence`, form)).status).toBe(200);

    let e = (await admin.call("GET", `${S()}/validation/${pkg}`)).json.evidence.find((x: any) => x.id === slot);
    expect(e.zeroG).toMatchObject({ status: "pending", root: null });
    await sys.jobs.run(); // the first upload fails and is retried later
    e = (await admin.call("GET", `${S()}/validation/${pkg}`)).json.evidence.find((x: any) => x.id === slot);
    expect(e.zeroG).toMatchObject({ status: "pending", error: "indexer unavailable" });
    skew += 61_000;
    await sys.jobs.run();
    e = (await admin.call("GET", `${S()}/validation/${pkg}`)).json.evidence.find((x: any) => x.id === slot);
    expect(e.zeroG).toMatchObject({ status: "done", root: expect.stringMatching(/^0x[0-9a-f]{64}$/), url: expect.stringContaining("chainscan-galileo") });
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=50`)).json;
    expect(decisions.find((d: any) => d.kind === "evidence.replicated").data).toMatchObject({ sha256: e.sha256, root: e.zeroG.root });
    expect((await admin.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "evidence copies")).toMatchObject({ live: true });
  });

  it("verifies the copy byte for byte, and catches one that differs", async () => {
    expect((await admin.call("GET", `${S()}/validation/${pkg}/evidence/${slot}/0g`)).json).toMatchObject({ ok: true });
    const root = [...store.files.keys()][0]!;
    store.files.set(root, new TextEncoder().encode("Concept report: fixture holds ±0.10 mm"));
    expect((await admin.call("GET", `${S()}/validation/${pkg}/evidence/${slot}/0g`)).json).toMatchObject({ ok: false, root });
  });
});
