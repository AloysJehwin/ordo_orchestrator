import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { keccak256, type Hex } from "viem";
import type { IntelligentData } from "../chain/inft.js";
import type { BlobStore } from "../chain/zerog.js";
import type { Db } from "../db/db.js";
import { AGENT_INFO, AGENTS, type AgentKey } from "../domain/types.js";
import { newId } from "../plant/plant.js";
import type { AgentLicenses, Playbook } from "./agent-licenses.js";
import { KeyBox } from "./keybox.js";
import type { Recorder } from "./recorder.js";

/** A new memory version at most this often per agent, and only when what it learned changed */
export const MEMORY_EVERY_MS = 30 * 60_000;
const READ_TIMEOUT_MS = 8_000;

interface MemoryRow {
  id: string;
  site_id: string;
  agent: AgentKey;
  version: number;
  root: string;
  tx: string | null;
  data_hash: string;
  content_sha: string;
  cases: number;
  record_json: string;
  created_at: string;
}
export interface MemoryView {
  version: number;
  cases: number;
  record: Playbook["record"];
  root: string;
  txUrl: string | null;
  dataHash: string;
  /** the sites that hold a sealed key for this version: the agent's own and its licensees' */
  sealedFor: { siteId: string; name: string }[];
  /** whether the agent's iNFT carries this version's hash on-chain */
  onchain: boolean;
  at: string;
}
/** A licensor's memory as a licensee's agent reads it: decrypted with the licensee's own key, checked against the iNFT */
export interface LiveMemory {
  version: number;
  playbook: Playbook;
  root: string;
  onchain: boolean;
}

/** ECIES on X25519: the content key, sealed for one site's vault key */
function seal(contentKey: Buffer, recipient: KeyObject) {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const epk = eph.publicKey.export({ type: "spki", format: "der" });
  const kek = Buffer.from(hkdfSync("sha256", shared, epk, "ordo:agent-memory-key", 32));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([c.update(contentKey), c.final()]);
  return [epk, iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
function unseal(sealed: string, key: KeyObject): Buffer {
  const [epk, iv, tag, ct] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  const shared = diffieHellman({ privateKey: key, publicKey: createPublicKey({ key: epk!, type: "spki", format: "der" }) });
  const kek = Buffer.from(hkdfSync("sha256", shared, epk!, "ordo:agent-memory-key", 32));
  const d = createDecipheriv("aes-256-gcm", kek, iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(ct!), d.final()]);
}
/** The memory itself: AES-256-GCM under a fresh key per version; the envelope is what goes to 0G and what the iNFT hashes */
function encrypt(plain: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from("OM1"), iv, c.getAuthTag(), ct]);
}
function decrypt(envelope: Uint8Array, key: Buffer) {
  const b = Buffer.from(envelope);
  if (b.subarray(0, 3).toString() !== "OM1") throw new Error("Not an Ordo agent memory");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(3, 15));
  d.setAuthTag(b.subarray(15, 31));
  return Buffer.concat([d.update(b.subarray(31)), d.final()]);
}

/**
 * Agent memory on 0G that travels with the agent's iNFT, ERC-7857 style. What an agent has learned at its site (the
 * cases people accepted, and its track record) is snapshotted as versions: each one encrypted under a fresh key, the
 * ciphertext stored on 0G Storage, and its hash written to the agent's iNFT as `memory:v<n>`, so the token always names
 * its current memory. The key is never stored in the clear: it is sealed for each site entitled to the memory, the
 * agent's own and every site holding an active licence on the token, with that site's vault key (X25519). When a licence
 * starts, the current memory is sealed for the licensee too: the re-encryption step of an ERC-7857 transfer, with Ordo
 * as the oracle. A licensee's agent then reads the licensor's live memory from 0G, checks it against the iNFT and
 * decrypts it with its own key; a licence that ends gets no key for later versions.
 */
export class AgentMemory {
  private keys: KeyBox;
  private cache = new Map<string, Playbook>();

  constructor(
    private db: Db,
    private rec: Recorder,
    private licenses: AgentLicenses,
    readonly store: BlobStore | null,
    private txUrl: (hash: string) => string | null,
    secret: string,
    private now: () => number,
  ) {
    this.keys = new KeyBox("agent-memory-vaults", secret);
  }

  get live() {
    return Boolean(this.store);
  }

  // ---------------- Site vault keys ----------------

  private async vault(siteId: string): Promise<{ pub: KeyObject; priv: KeyObject }> {
    let v = (await this.db.query<{ public_key: string; private_enc: string }>("SELECT public_key, private_enc FROM memory_vaults WHERE site_id = $1", [siteId])).rows[0];
    if (!v) {
      const k = generateKeyPairSync("x25519");
      const row = { public_key: k.publicKey.export({ type: "spki", format: "der" }).toString("base64"), private_enc: this.keys.seal(k.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")) };
      await this.db.query("INSERT INTO memory_vaults (site_id, public_key, private_enc) VALUES ($1,$2,$3) ON CONFLICT (site_id) DO NOTHING", [siteId, row.public_key, row.private_enc]);
      v = (await this.db.query<{ public_key: string; private_enc: string }>("SELECT public_key, private_enc FROM memory_vaults WHERE site_id = $1", [siteId])).rows[0]!;
    }
    return {
      pub: createPublicKey({ key: Buffer.from(v.public_key, "base64"), type: "spki", format: "der" }),
      priv: createPrivateKey({ key: Buffer.from(this.keys.unseal(v.private_enc), "base64"), type: "pkcs8", format: "der" }),
    };
  }

  // ---------------- Versions ----------------

  private async latest(siteId: string, agent: AgentKey): Promise<MemoryRow | null> {
    return (await this.db.query<MemoryRow>("SELECT *, created_at::text AS created_at FROM agent_memories WHERE site_id = $1 AND agent = $2 ORDER BY version DESC LIMIT 1", [siteId, agent])).rows[0] ?? null;
  }
  /** Sites that may read an agent's memory now: its own, and each holding an active licence on it */
  private async entitled(siteId: string, agent: AgentKey): Promise<string[]> {
    const l = await this.db.query<{ licensee_site: string }>("SELECT DISTINCT licensee_site FROM agent_licenses WHERE licensor_site = $1 AND agent = $2 AND status = 'active' AND expires_at > $3", [
      siteId,
      agent,
      new Date(this.now()).toISOString(),
    ]);
    return [siteId, ...l.rows.map((r) => r.licensee_site)];
  }
  private async sealFor(memoryId: string, contentKey: Buffer, siteId: string) {
    await this.db.query("INSERT INTO agent_memory_keys (memory_id, site_id, sealed_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [memoryId, siteId, seal(contentKey, (await this.vault(siteId)).pub)]);
  }
  private async contentKey(memoryId: string, siteId: string): Promise<Buffer | null> {
    const k = (await this.db.query<{ sealed_key: string }>("SELECT sealed_key FROM agent_memory_keys WHERE memory_id = $1 AND site_id = $2", [memoryId, siteId])).rows[0];
    return k ? unseal(k.sealed_key, (await this.vault(siteId)).priv) : null;
  }

  /**
   * In the engine cycle: seal the current memory for licensees that do not have it yet (cheap, no network), then take at
   * most `limit` new snapshots where an agent learned something since its last one.
   */
  async reconcile(limit = 1): Promise<number> {
    if (!this.store) return 0;
    let n = 0;
    const lic = await this.db.query<{ licensor_site: string; licensee_site: string; agent: AgentKey; name: string }>(
      `SELECT l.licensor_site, l.licensee_site, l.agent, b.name FROM agent_licenses l JOIN sites b ON b.id = l.licensee_site
       WHERE l.status = 'active' AND l.expires_at > $1`,
      [new Date(this.now()).toISOString()],
    );
    for (const l of lic.rows) {
      const m = await this.latest(l.licensor_site, l.agent);
      if (!m || (await this.db.query("SELECT 1 FROM agent_memory_keys WHERE memory_id = $1 AND site_id = $2", [m.id, l.licensee_site])).rows.length) continue;
      const key = await this.contentKey(m.id, l.licensor_site);
      if (!key) continue;
      await this.sealFor(m.id, key, l.licensee_site);
      await this.rec.decide(l.licensor_site, { agent: `agent:${l.agent}`, kind: "agent.memory_shared", summary: `${AGENT_INFO[l.agent].label} agent's memory v${m.version} sealed for ${l.name} under its licence`, data: { memoryId: m.id, version: m.version, licensee: l.licensee_site, root: m.root } });
      n++;
    }
    let snaps = 0;
    for (const s of (await this.db.query<{ id: string }>("SELECT id FROM sites ORDER BY created_at")).rows) {
      for (const agent of AGENTS) {
        if (snaps >= limit) return n;
        if (await this.snapshot(s.id, agent)) (snaps++, n++);
      }
    }
    return n;
  }

  /** A new version if the agent learned something and the last one is old enough. Returns whether it made one. */
  async snapshot(siteId: string, agent: AgentKey, force = false): Promise<boolean> {
    const last = await this.latest(siteId, agent);
    if (!force && last && this.now() - Date.parse(last.created_at) < MEMORY_EVERY_MS) return false;
    const pb = await this.licenses.playbook(siteId, agent);
    if (!pb.cases.length && !pb.record.decided) return false;
    const plain = Buffer.from(JSON.stringify({ v: 1, ...pb }));
    const sha = createHash("sha256").update(plain).digest("hex");
    if (last?.content_sha === sha) return false;
    const key = randomBytes(32);
    const envelope = encrypt(plain, key);
    const put = await this.store!.put(envelope);
    const id = newId("mem");
    const version = (last?.version ?? 0) + 1;
    await this.db.query(
      "INSERT INTO agent_memories (id, site_id, agent, version, root, tx, data_hash, content_sha, cases, record_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id, siteId, agent, version, put.root, put.tx, keccak256(envelope), sha, pb.cases.length, JSON.stringify(pb.record), new Date(this.now()).toISOString()],
    );
    for (const site of await this.entitled(siteId, agent)) await this.sealFor(id, key, site);
    await this.rec.decide(siteId, {
      agent: `agent:${agent}`,
      kind: "agent.memory_saved",
      summary: `${AGENT_INFO[agent].label} agent's memory v${version} (${pb.cases.length} accepted cases) encrypted to 0G Storage`,
      data: { memoryId: id, version, root: put.root, tx: put.tx, dataHash: keccak256(envelope) },
    });
    return true;
  }

  /** Intelligent data for each agent's iNFT: its current memory version and the hash of its ciphertext */
  async latestData(siteId: string): Promise<Map<AgentKey, IntelligentData[]>> {
    const rows = await this.db.query<{ agent: AgentKey; version: number; data_hash: string }>(
      "SELECT DISTINCT ON (agent) agent, version, data_hash FROM agent_memories WHERE site_id = $1 ORDER BY agent, version DESC",
      [siteId],
    );
    return new Map(rows.rows.map((r) => [r.agent, [{ dataDescription: `memory:v${r.version}`, dataHash: r.data_hash as Hex }]]));
  }

  /** Whether the agent's iNFT, as last confirmed on-chain, names this memory version */
  private async onchain(siteId: string, agent: AgentKey, m: MemoryRow) {
    const r = (await this.db.query<{ have_json: string | null }>("SELECT have_json FROM agent_nfts WHERE site_id = $1 AND agent = $2", [siteId, agent])).rows[0];
    const have = r?.have_json ? (JSON.parse(r.have_json) as { datas: IntelligentData[] }).datas : [];
    return have.some((d) => d.dataDescription === `memory:v${m.version}` && d.dataHash.toLowerCase() === m.data_hash.toLowerCase());
  }

  /**
   * The licensor's current memory, as `readerSite` may read it: fetched from 0G, checked against the hash Ordo recorded
   * (and that the iNFT carries), decrypted with the reader's own sealed key. Null when it holds no key for it.
   */
  async read(readerSite: string, licensorSite: string, agent: AgentKey): Promise<LiveMemory | null> {
    if (!this.store) return null;
    const m = await this.latest(licensorSite, agent);
    if (!m) return null;
    const key = await this.contentKey(m.id, readerSite);
    if (!key) return null;
    const cacheKey = `${m.id}:${readerSite}`;
    let pb = this.cache.get(cacheKey);
    if (!pb) {
      const envelope = await Promise.race([this.store.get(m.root), new Promise<never>((_, no) => setTimeout(() => no(new Error("0G Storage did not answer in time")), READ_TIMEOUT_MS))]);
      if (keccak256(envelope).toLowerCase() !== m.data_hash.toLowerCase()) throw new Error(`Memory v${m.version} on 0G does not match its recorded hash`);
      pb = JSON.parse(decrypt(envelope, key).toString("utf8")) as Playbook;
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(cacheKey, pb);
    }
    return { version: m.version, playbook: pb, root: m.root, onchain: await this.onchain(licensorSite, agent, m) };
  }

  /** Each agent's current memory at a site, for the agents page */
  async ofSite(siteId: string): Promise<Map<AgentKey, MemoryView>> {
    const rows = await this.db.query<MemoryRow>("SELECT DISTINCT ON (agent) *, created_at::text AS created_at FROM agent_memories WHERE site_id = $1 ORDER BY agent, version DESC", [siteId]);
    const out = new Map<AgentKey, MemoryView>();
    for (const m of rows.rows) {
      const sealed = await this.db.query<{ site_id: string; name: string }>("SELECT k.site_id, s.name FROM agent_memory_keys k JOIN sites s ON s.id = k.site_id WHERE k.memory_id = $1 ORDER BY k.created_at", [m.id]);
      out.set(m.agent, {
        version: m.version,
        cases: m.cases,
        record: JSON.parse(m.record_json),
        root: m.root,
        txUrl: m.tx ? this.txUrl(m.tx) : null,
        dataHash: m.data_hash,
        sealedFor: sealed.rows.map((r) => ({ siteId: r.site_id, name: r.name })),
        onchain: await this.onchain(siteId, m.agent, m),
        at: new Date(m.created_at).toISOString(),
      });
    }
    return out;
  }
}
