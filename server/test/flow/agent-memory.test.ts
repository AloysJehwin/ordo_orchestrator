import { createHash } from "node:crypto";
import { keccak256 } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlobStore } from "../../src/chain/zerog.js";
import { MEMORY_EVERY_MS } from "../../src/core/agent-memory.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

class MemoryStore implements BlobStore {
  readonly kind = "memory";
  files = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array) {
    const root = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    this.files.set(root, bytes);
    return { root, tx: `0x${"cd".repeat(32)}`, url: "" };
  }
  async get(root: string) {
    return this.files.get(root)!;
  }
}

/** An agent's memory on 0G: encrypted versions, keys sealed only for its own site and the sites licensing it. */
let sys: System;
let app: Awaited<ReturnType<typeof boot>>["app"];
const store = new MemoryStore();
let skew = 0;
let a: Client;
const site = { A: "", B: "", C: "" };
let n = 0;

/** `count` more recommendations by site A's maintenance agent that the policy guard carried out */
const prove = async (count: number) => {
  await sys.db.query("INSERT INTO assets (id, site_id, name, kind, owning_agent, source_json) VALUES ('AS-M1', $1, 'Spindle 1', 'cnc', 'maintenance', '{}') ON CONFLICT DO NOTHING", [site.A]);
  for (let i = 0; i < count; i++) {
    const inc = `INC-M${++n}`;
    await sys.db.query("INSERT INTO incidents (id, site_id, asset_id, status, title, severity, data_json) VALUES ($1,$2,'AS-M1','closed','vibration','alarm',$3)", [
      inc,
      site.A,
      JSON.stringify({ anomaly: { assetId: "AS-M1", signal: "vibration", value: 7, limit: 6, level: "alarm", kind: "threshold", trendPerHour: 0.4, minute: 0 } }),
    ]);
    await sys.rec.decide(site.A, { agent: "agent:maintenance", kind: "incident.recommended", incidentId: inc, assetId: "AS-M1", summary: "Open a work order", data: { actions: [{ tool: "open_work_order", args: { assetId: "AS-M1", priority: "high" } }], reason: `case ${n}` } });
    await sys.rec.decide(site.A, { agent: "guard:policy", kind: "action.executed", incidentId: inc, assetId: "AS-M1", summary: "Opened" });
  }
};
const license = (to: string, status = "active") =>
  sys.db.query("INSERT INTO agent_licenses (id, licensor_site, licensee_site, agent, token_id, status, days, expires_at, playbook_json, requested_by) VALUES ($1,$2,$3,'maintenance',1,$4,30,$5,$6,'0x0')", [
    `lic_${to}`,
    site.A,
    to,
    status,
    new Date(Date.now() + 30 * 86_400_000).toISOString(),
    JSON.stringify({ agent: "maintenance", site: site.A, record: { recommended: 0, decided: 0, accepted: 0, overridden: 0, rate: null, proven: false }, cases: [] }),
  ]);
const later = () => (skew += MEMORY_EVERY_MS + 60_000);
const sealedFor = async (version: number) =>
  (await sys.db.query<{ site_id: string }>("SELECT k.site_id FROM agent_memory_keys k JOIN agent_memories m ON m.id = k.memory_id WHERE m.site_id = $1 AND m.agent = 'maintenance' AND m.version = $2 ORDER BY k.site_id", [site.A, version])).rows.map((r) => r.site_id).sort();

beforeAll(async () => {
  ({ sys, app } = await boot({}, { blobStore: store, now: () => Date.now() + skew }));
  a = await wallet(app, generatePrivateKey());
  for (const k of ["A", "B", "C"] as const) site[k] = (await a.call("POST", "/v1/sites", { name: `Plant ${k}`, timezone: "UTC", lineName: "L1", zones: [] })).json.id;
});
afterAll(async () => sys?.close());

describe("agent memory on 0G", () => {
  it("saves what an agent learned as an encrypted version, sealed for its site and its licensee only", async () => {
    expect(await sys.agentMemory.reconcile()).toBe(0); // nothing learned yet
    await prove(3);
    await license(site.B);
    expect(await sys.agentMemory.reconcile()).toBe(1);
    const [m] = (await sys.db.query<{ root: string; data_hash: string; version: number }>("SELECT root, data_hash, version FROM agent_memories WHERE site_id = $1", [site.A])).rows;
    expect(m).toMatchObject({ version: 1 });
    const bytes = store.files.get(m!.root)!;
    expect(keccak256(bytes)).toBe(m!.data_hash);
    expect(Buffer.from(bytes).toString("utf8")).not.toContain("case 1"); // ciphertext, not the cases
    expect(await sealedFor(1)).toEqual([site.A, site.B].sort());

    const b = await sys.agentMemory.read(site.B, site.A, "maintenance");
    expect(b).toMatchObject({ version: 1, playbook: { agent: "maintenance", record: { accepted: 3 } } });
    expect(b!.playbook.cases.map((c) => c.reason)).toEqual(["case 3", "case 2", "case 1"]);
    expect(await sys.agentMemory.read(site.C, site.A, "maintenance")).toBeNull(); // no licence, no key
    // the agent's iNFT names the version by the hash of its ciphertext
    expect((await sys.agentMemory.latestData(site.A)).get("maintenance")).toEqual([{ dataDescription: "memory:v1", dataHash: m!.data_hash }]);
  });

  it("the licensee's agent reads the licensor's live memory, not the snapshot its licence pinned", async () => {
    const [pb] = await sys.agentLicenses.playbooksFor(site.B, "maintenance");
    expect(pb).toMatchObject({ from: "Plant A", memory: { version: 1 }, record: { accepted: 3 } });
    expect(pb!.cases).toHaveLength(3);
  });

  it("a new version only when the agent learned something, and not more often than every half hour", async () => {
    later();
    expect(await sys.agentMemory.reconcile()).toBe(0); // nothing new
    await prove(1);
    skew -= MEMORY_EVERY_MS; // too soon after v1
    expect(await sys.agentMemory.reconcile()).toBe(0);
    later();
    expect(await sys.agentMemory.reconcile()).toBe(1);
    expect((await sys.agentMemory.read(site.B, site.A, "maintenance"))!.playbook.cases).toHaveLength(4);
  });

  it("a licence that starts later gets the current memory sealed for it: the re-encryption", async () => {
    await license(site.C);
    expect(await sys.agentMemory.reconcile()).toBe(1);
    expect(await sealedFor(2)).toEqual([site.A, site.B, site.C].sort());
    expect((await sys.agentMemory.read(site.C, site.A, "maintenance"))!.version).toBe(2);
    const kinds = (await a.call("GET", `/v1/sites/${site.A}/decisions?limit=50`)).json.map((d: any) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(["agent.memory_saved", "agent.memory_shared"]));
  });

  it("a licence that ends gets no key for what the agent learns next", async () => {
    await sys.db.query("UPDATE agent_licenses SET status = 'expired' WHERE id = $1", [`lic_${site.B}`]);
    await prove(1);
    later();
    expect(await sys.agentMemory.reconcile()).toBe(1);
    expect(await sealedFor(3)).toEqual([site.A, site.C].sort());
    expect(await sys.agentMemory.read(site.B, site.A, "maintenance")).toBeNull();
    expect((await sys.agentMemory.read(site.C, site.A, "maintenance"))!.version).toBe(3);
  });

  it("refuses a memory whose bytes on 0G do not match the hash the iNFT carries", async () => {
    await prove(1);
    later();
    await sys.agentMemory.reconcile();
    const [m] = (await sys.db.query<{ root: string }>("SELECT root FROM agent_memories WHERE site_id = $1 AND version = 4", [site.A])).rows;
    const good = store.files.get(m!.root)!;
    const bad = Uint8Array.from(good);
    bad[bad.length - 1]! ^= 1;
    store.files.set(m!.root, bad);
    await expect(sys.agentMemory.read(site.C, site.A, "maintenance")).rejects.toThrow(/does not match/);
    store.files.set(m!.root, good);
    expect((await sys.agentMemory.read(site.C, site.A, "maintenance"))!.version).toBe(4);
  });

  it("shows each agent's memory on the agents page", async () => {
    const m = (await a.call("GET", `/v1/sites/${site.A}/agents`)).json.find((x: any) => x.key === "maintenance").memory;
    expect(m).toMatchObject({ version: 4, cases: 6, root: expect.stringMatching(/^0x/), onchain: false, sealedFor: [{ name: "Plant A" }, { name: "Plant C" }] });
    expect((await a.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "agent memory")).toMatchObject({ live: true });
  });
});
