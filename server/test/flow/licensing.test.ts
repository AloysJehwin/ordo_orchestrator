import { createHash } from "node:crypto";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offlineRecommendation } from "../../src/agents/agents.js";
import { AgentNftChain } from "../../src/chain/inft.js";
import { ORDO_AGENT_NFT_ABI, ORDO_AGENT_NFT_BYTECODE } from "../../src/chain/ordo-agent-nft-abi.js";
import type { BlobStore } from "../../src/chain/zerog.js";
import { ANVIL_KEYS, anvilPath, deployer, startAnvil } from "../fixtures/anvil.js";
import { boot, wallet, type Client, type System } from "./helpers.js";

/** One site licenses another site's proven agent through the agent's iNFT (anvil: the contract is built for Cancun). */
const run = anvilPath() || process.env.CI ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly kind = "memory";
  files = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array) {
    const root = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    this.files.set(root, bytes);
    return { root, tx: `0x${"ab".repeat(32)}`, url: "" };
  }
  async get(root: string) {
    return this.files.get(root)!;
  }
}

run("licensing agents between sites", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let chain: AgentNftChain;
  let contract: Address;
  const store = new MemoryStore();
  let a: Client; // plant manager at the agent's site
  let b: Client; // plant manager at the licensee
  let siteA = "";
  let siteB = "";
  let lic = "";
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      const n = (await sys.agentLicenses.reconcile(5)) + (await sys.agentNfts.reconcile(5));
      if (!n) return;
    }
  };

  /** Give site A's maintenance agent a record: `n` recommendations the policy guard let it carry out. */
  const prove = async (n: number) => {
    await sys.db.query("INSERT INTO assets (id, site_id, name, kind, owning_agent, source_json) VALUES ('AS-A1', $1, 'Spindle 1', 'cnc', 'maintenance', '{}')", [siteA]);
    for (let i = 0; i < n; i++) {
      const inc = `INC-A${i}`;
      await sys.db.query("INSERT INTO incidents (id, site_id, asset_id, status, title, severity, data_json) VALUES ($1,$2,'AS-A1','closed','vibration','alarm',$3)", [
        inc,
        siteA,
        JSON.stringify({ anomaly: { assetId: "AS-A1", signal: "vibration", value: 7.1, limit: 6, level: "alarm", kind: "threshold", trendPerHour: 0.4, minute: 0 } }),
      ]);
      await sys.rec.decide(siteA, {
        agent: "agent:maintenance",
        kind: "incident.recommended",
        incidentId: inc,
        assetId: "AS-A1",
        summary: "Open a high work order",
        data: { actions: [{ tool: "open_work_order", args: { assetId: "AS-A1", priority: "high", windowMinutes: 60 } }, { tool: "notify_operator", args: { assetId: "AS-A1", instruction: "Check the spindle" } }], reason: "Vibration past alarm" },
      });
      await sys.rec.decide(siteA, { agent: "guard:policy", kind: "action.executed", incidentId: inc, assetId: "AS-A1", summary: "Opened work order" });
    }
  };

  beforeAll(async () => {
    anvil = await startAnvil();
    const d = deployer(anvil.url);
    contract = await d.deploy({ abi: ORDO_AGENT_NFT_ABI, bytecode: ORDO_AGENT_NFT_BYTECODE }, [d.account.address]);
    ({ sys, app } = await boot({ ZG_INFT_ADDRESS: contract, ZG_PRIVATE_KEY: ANVIL_KEYS[0]!, ZG_RPC_URL: anvil.url, ZG_CHAIN_ID: "31337" }, { blobStore: store }));
    chain = new AgentNftChain({ rpcUrl: anvil.url, chainId: 31337, address: contract, key: ANVIL_KEYS[0]! });
    a = await wallet(app, generatePrivateKey());
    b = await wallet(app, generatePrivateKey());
    siteA = (await a.call("POST", "/v1/sites", { name: "Pune Plant", timezone: "UTC", lineName: "Line 1", zones: [] })).json.id;
    siteB = (await b.call("POST", "/v1/sites", { name: "Chennai Plant", timezone: "UTC", lineName: "Line 1", zones: [] })).json.id;
    await settle();
  }, 240_000);
  afterAll(async () => {
    await sys?.close();
    anvil?.stop();
  });

  it("lists an agent only once people have accepted enough of what it recommended", async () => {
    expect((await b.call("GET", `/v1/sites/${siteB}/agents/market`)).json).toEqual([]);
    expect((await b.call("POST", `/v1/sites/${siteB}/agents/licenses`, { site: siteA, agent: "maintenance", days: 30 })).status).toBe(409);
    await prove(3);
    const market = (await b.call("GET", `/v1/sites/${siteB}/agents/market`)).json;
    expect(market).toHaveLength(1);
    expect(market[0]).toMatchObject({ site: { id: siteA, name: "Pune Plant" }, agent: "maintenance", record: { decided: 3, accepted: 3, rate: 1, proven: true }, license: null });
    expect(market[0].tokenId).toBeGreaterThan(0);
    const mine = (await a.call("GET", `/v1/sites/${siteA}/agents`)).json.find((x: any) => x.key === "maintenance");
    expect(mine.record).toMatchObject({ proven: true });
  }, 60_000);

  it("a plant manager at the agent's site signs the grant, and OrdoAgentNFT records it", async () => {
    const req = await b.call("POST", `/v1/sites/${siteB}/agents/licenses`, { site: siteA, agent: "maintenance", days: 30 });
    expect(req.status).toBe(201);
    lic = req.json.id;
    // the licensee cannot grant itself
    expect((await b.call("POST", `/v1/sites/${siteB}/agents/licenses/${lic}/sign-request`, { kind: "grant" })).status).toBe(404);

    const typed = (await a.call("POST", `/v1/sites/${siteA}/agents/licenses/${lic}/sign-request`, { kind: "grant" })).json;
    expect(typed.message.action).toBe("agent.license");
    expect(typed.domain.chainId).toBe(31337);
    const g = await a.call("POST", `/v1/sites/${siteA}/agents/licenses/${lic}/grant`, { nonce: typed.message.nonce, signature: await a.sign(typed) });
    expect(g.json).toMatchObject({ status: "signed", cases: 3 });
    await settle();

    const v = (await b.call("GET", `/v1/sites/${siteB}/agents/licenses`)).json.outgoing[0];
    expect(v).toMatchObject({ status: "active", licensor: { id: siteA }, tokenId: expect.any(Number) });
    expect(v.storage.root).toMatch(/^0x/);
    const on = await chain.licenseOf(v.tokenId, siteB);
    expect(on).toMatchObject({ active: true, termsHash: v.termsHash });
    expect(on.expiresAt * 1000).toBe(Date.parse(v.expiresAt));
    // the playbook on 0G Storage is the one the signed terms pin
    const bytes = await store.get(v.storage.root);
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(v.playbookSha256);
  }, 120_000);

  it("the licensee's agent recommends with the playbook, and its own token names the licence", async () => {
    const [pb] = await sys.agentLicenses.playbooksFor(siteB, "maintenance", { assetKind: "cnc", signal: "vibration" });
    expect(pb).toMatchObject({ from: "Pune Plant", record: { proven: true } });
    expect(pb!.cases[0]).toMatchObject({ assetKind: "cnc", signal: "vibration", tools: ["open_work_order", "notify_operator"], settings: [{ priority: "high", windowMinutes: 60 }, {}], acceptedBy: "policy" });

    const r = offlineRecommendation({
      asset: { id: "AS-B1", name: "Spindle 9", kind: "cnc", status: "alarm" },
      anomaly: { assetId: "AS-B1", signal: "vibration", value: 6.8, limit: 6, level: "warn", kind: "threshold", trendPerHour: 0.2, minute: 0 },
      forecast: null,
      diagnosis: { rootCause: "wear", confidence: 0.7 },
      activeStage: null,
      alternativeAssets: [],
      tools: "",
      licensedPlaybook: pb,
    });
    expect(r.reason).toMatch(/licensed playbook from Pune Plant has 3 accepted cases like this, resolved with open work order/);

    const agents = (await b.call("GET", `/v1/sites/${siteB}/agents`)).json;
    const m = agents.find((x: any) => x.key === "maintenance");
    expect(m.licensedFrom).toEqual([expect.objectContaining({ site: "Pune Plant", tokenId: pb!.tokenId })]);
    expect(m.inft.data.at(-1)).toMatchObject({ dataDescription: `license:${siteA}/maintenance#${pb!.tokenId}` });
    expect((await chain.datas(m.inft.tokenId)).at(-1)!.dataDescription).toBe(`license:${siteA}/maintenance#${pb!.tokenId}`);
  }, 60_000);

  it("the agent's memory goes to 0G encrypted, sealed for the licensee, and its iNFT names it on-chain", async () => {
    expect(await sys.agentMemory.reconcile()).toBeGreaterThan(0);
    await settle();
    const mine = (await a.call("GET", `/v1/sites/${siteA}/agents`)).json.find((x: any) => x.key === "maintenance");
    expect(mine.memory).toMatchObject({ version: 1, cases: 3, onchain: true, sealedFor: expect.arrayContaining([expect.objectContaining({ siteId: siteB })]) });
    expect((await chain.datas(mine.inft.tokenId)).find((d) => d.dataDescription === "memory:v1")?.dataHash).toBe(mine.memory.dataHash);
    const [pb] = await sys.agentLicenses.playbooksFor(siteB, "maintenance");
    expect(pb!.memory).toMatchObject({ version: 1, onchain: true });
  }, 120_000);

  it("only the token's authorized users can license it, whoever relays", async () => {
    const tokenId = (await sys.agentLicenses.get(lic)).tokenId!;
    const stranger = privateKeyToAccount(generatePrivateKey());
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
    const termsHash = `0x${"11".repeat(32)}` as const;
    const message = { action: "agent.license", entity: `${siteA}/maintenance>other#${expiresAt}#${termsHash}`, meaning: "x", comment: "", site: siteA, nonce: "n-stranger-1", issuedAt: new Date().toISOString() };
    const signature = await stranger.signTypedData({
      domain: { name: "Ordo", version: "1", chainId: 31337 },
      types: { OrdoSignature: ["action", "entity", "meaning", "comment", "site", "nonce", "issuedAt"].map((name) => ({ name, type: "string" })) },
      primaryType: "OrdoSignature",
      message,
    });
    await expect(chain.grantLicense(tokenId, "other", expiresAt, termsHash, { ...message, signature })).rejects.toThrow(/NotAuthorized/);
  }, 60_000);

  it("revoking ends the licence on-chain and the licensee stops using the playbook", async () => {
    const typed = (await a.call("POST", `/v1/sites/${siteA}/agents/licenses/${lic}/sign-request`, { kind: "revoke" })).json;
    expect(typed.message.action).toBe("agent.unlicense");
    const r = await a.call("POST", `/v1/sites/${siteA}/agents/licenses/${lic}/revoke`, { nonce: typed.message.nonce, signature: await a.sign(typed) });
    expect(r.json.status).toBe("revoking");
    await settle();
    const v = await sys.agentLicenses.get(lic);
    expect(v.status).toBe("revoked");
    expect((await chain.licenseOf(v.tokenId!, siteB)).active).toBe(false);
    expect(await sys.agentLicenses.playbooksFor(siteB, "maintenance")).toEqual([]);
    const m = (await b.call("GET", `/v1/sites/${siteB}/agents`)).json.find((x: any) => x.key === "maintenance");
    expect(m.inft.data.some((d: any) => d.dataDescription.startsWith("license:"))).toBe(false);
    const decisions = (await b.call("GET", `/v1/sites/${siteB}/decisions?limit=100`)).json.map((d: any) => d.kind);
    expect(decisions).toEqual(expect.arrayContaining(["agent.license_requested", "agent.license_granted", "agent.licensed", "agent.license_revoked"]));
  }, 120_000);
});
