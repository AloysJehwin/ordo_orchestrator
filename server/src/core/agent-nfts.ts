import { keccak256, toBytes, type Address, type Hex } from "viem";
import type { IntelligentData } from "../chain/inft.js";
import { chainErrorMessage } from "../chain/errors.js";
import type { Db } from "../db/db.js";
import { AGENT_INFO, AGENTS, type AgentKey } from "../domain/types.js";
import type { Recorder } from "./recorder.js";

/** What AgentNfts needs from OrdoAgentNFT (AgentNftChain in production). */
export interface AgentNftRail {
  readonly cfg: { address: Address };
  tokenOf(agent: string): Promise<number>;
  mint(agent: string, datas: IntelligentData[]): Promise<{ tokenId: number; hash: Hex }>;
  update(tokenId: number, datas: IntelligentData[]): Promise<Hex>;
  authorize(tokenId: number, user: Address): Promise<Hex>;
  revoke(tokenId: number, user: Address): Promise<Hex>;
  txUrl(hash: string): string | null;
  tokenUrl(tokenId: number): string | null;
}

interface Want {
  datas: IntelligentData[];
  users: string[];
}
interface Row {
  site_id: string;
  agent: AgentKey;
  token_id: number | null;
  want_json: string;
  have_json: string | null;
  status: "pending" | "synced" | "failed";
  tx_hash: string | null;
  mint_tx: string | null;
  error: string | null;
  attempts: number;
}
export interface AgentNftView {
  contract: string;
  tokenId: number | null;
  status: Row["status"];
  error: string | null;
  url: string | null;
  txUrl: string | null;
  data: IntelligentData[];
  authorizedUsers: string[];
}

const MAX_ATTEMPTS = 6;
const datum = (dataDescription: string, hash?: string): IntelligentData => ({
  dataDescription,
  dataHash: hash ? (`0x${hash.replace(/^(sha256:|0x)/, "").padStart(64, "0").slice(0, 64)}` as Hex) : keccak256(toBytes(dataDescription)),
});

/**
 * Each agent of each site as an ERC-7857 iNFT on 0G: its intelligent data is the policy hash it acts under, its
 * model, the autonomy each line gives it and its scope; its authorized users are the site's plant managers. The
 * engine cycle keeps the tokens in line with Ordo, one transaction per cycle, so a policy, model or autonomy change
 * shows up as an `Updated` event on the agent's token.
 */
export class AgentNfts {
  /** Licences the site runs, as extra intelligent data on its own agents' tokens (set by the wiring) */
  licensed: ((siteId: string) => Promise<Map<AgentKey, IntelligentData[]>>) | null = null;

  constructor(
    private db: Db,
    private rec: Recorder,
    readonly rail: AgentNftRail | null,
    private policyHash: string,
    private model: () => string,
    private now: () => number,
  ) {}

  get live() {
    return Boolean(this.rail);
  }

  private async wanted(siteId: string): Promise<Map<AgentKey, Want>> {
    const lines = (await this.db.query<{ name: string; autonomy: string }>("SELECT name, autonomy FROM lines WHERE site_id = $1 ORDER BY created_at", [siteId])).rows;
    const users = (await this.db.query<{ address: string }>("SELECT DISTINCT u.address FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 AND m.role = 'manager' ORDER BY u.address", [siteId])).rows.map((r) => r.address.toLowerCase());
    const licensed = (await this.licensed?.(siteId)) ?? new Map<AgentKey, IntelligentData[]>();
    const out = new Map<AgentKey, Want>();
    for (const a of AGENTS)
      out.set(a, {
        datas: [datum("policy:ordo-guard", this.policyHash), datum(`model:${this.model()}`), datum(`autonomy:${lines.map((l) => `${l.name}=${l.autonomy}`).join(",")}`), datum(`scope:${AGENT_INFO[a].scope}`), ...(licensed.get(a) ?? [])],
        users: users.slice(0, 100),
      });
    return out;
  }

  async reconcile(limit = 1): Promise<number> {
    if (!this.rail) return 0;
    await this.forgetOtherContracts();
    for (const s of (await this.db.query<{ id: string }>("SELECT id FROM sites")).rows) {
      const have = new Map((await this.db.query<{ agent: string; want_json: string }>("SELECT agent, want_json FROM agent_nfts WHERE site_id = $1", [s.id])).rows.map((r) => [r.agent, r.want_json]));
      for (const [agent, want] of await this.wanted(s.id)) {
        const w = JSON.stringify(want);
        if (!have.has(agent)) await this.db.query("INSERT INTO agent_nfts (site_id, agent, want_json, status, next_try_at, contract) VALUES ($1,$2,$3,'pending',$4,$5) ON CONFLICT DO NOTHING", [s.id, agent, w, this.iso(), this.rail.cfg.address.toLowerCase()]);
        else if (have.get(agent) !== w) await this.db.query("UPDATE agent_nfts SET want_json = $1, status = 'pending', attempts = 0, error = NULL, next_try_at = $2, updated_at = now() WHERE site_id = $3 AND agent = $4", [w, this.iso(), s.id, agent]);
      }
    }
    const due = await this.db.query<Row>(`SELECT ${COLS} FROM agent_nfts WHERE status = 'pending' AND next_try_at <= $1 ORDER BY updated_at LIMIT ${limit}`, [this.iso()]);
    for (const r of due.rows) {
      try {
        await this.step(r);
      } catch (e) {
        const attempts = Number(r.attempts) + 1;
        await this.db.query("UPDATE agent_nfts SET status = $1, error = $2, attempts = $3, next_try_at = $4, updated_at = now() WHERE site_id = $5 AND agent = $6", [
          attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          chainErrorMessage(e),
          attempts,
          this.iso(60_000 * 2 ** (attempts - 1)),
          r.site_id,
          r.agent,
        ]);
      }
    }
    return due.rows.length;
  }

  /**
   * Tokens minted on an earlier OrdoAgentNFT (ZG_INFT_ADDRESS changed) are forgotten so the agents mint again on the
   * current one. Rows from before the contract was recorded are kept only if the current contract has that token.
   */
  private async forgetOtherContracts() {
    const addr = this.rail!.cfg.address.toLowerCase();
    await this.db.query("DELETE FROM agent_nfts WHERE contract IS NOT NULL AND contract <> $1", [addr]);
    await this.db.query("UPDATE agent_licenses SET status = 'failed', error = 'The agent was minted again on a new OrdoAgentNFT', updated_at = now() WHERE contract IS NOT NULL AND contract <> $1 AND status IN ('requested','signed','active','revoking')", [addr]);
    const legacy = await this.db.query<{ site_id: string; agent: string; token_id: number | null }>("SELECT site_id, agent, token_id FROM agent_nfts WHERE contract IS NULL LIMIT 8");
    for (const r of legacy.rows) {
      if (r.token_id === null || (await this.rail!.tokenOf(`${r.site_id}/${r.agent}`)) === Number(r.token_id)) await this.db.query("UPDATE agent_nfts SET contract = $1 WHERE site_id = $2 AND agent = $3", [addr, r.site_id, r.agent]);
      else await this.db.query("DELETE FROM agent_nfts WHERE site_id = $1 AND agent = $2", [r.site_id, r.agent]);
    }
  }

  /** One transaction: mint, then update the data, then add or remove one authorized user. */
  private async step(r: Row) {
    const rail = this.rail!;
    const want = JSON.parse(r.want_json) as Want;
    const have: Want = r.have_json ? JSON.parse(r.have_json) : { datas: [], users: [] };
    const save = (h: Want, tx: Hex, extra = "") =>
      this.db.query(`UPDATE agent_nfts SET have_json = $1, tx_hash = $2, status = CASE WHEN want_json = $1 THEN 'synced' ELSE 'pending' END, error = NULL, attempts = 0, next_try_at = $3, updated_at = now()${extra} WHERE site_id = $4 AND agent = $5`, [
        JSON.stringify(h),
        tx,
        this.iso(),
        r.site_id,
        r.agent,
      ]);

    if (r.token_id === null) {
      const { tokenId, hash } = await rail.mint(`${r.site_id}/${r.agent}`, want.datas);
      await this.db.query("UPDATE agent_nfts SET token_id = $1, mint_tx = $2 WHERE site_id = $3 AND agent = $4", [tokenId, hash, r.site_id, r.agent]);
      await save({ datas: want.datas, users: [] }, hash);
      await this.rec.decide(r.site_id, { agent: `agent:${r.agent}`, kind: "agent.inft_minted", summary: `${AGENT_INFO[r.agent].label} agent minted as iNFT #${tokenId} on 0G`, data: { tokenId, contract: rail.cfg.address, tx: hash, datas: want.datas } });
      return;
    }
    if (JSON.stringify(have.datas) !== JSON.stringify(want.datas)) {
      const hash = await rail.update(r.token_id, want.datas);
      await save({ ...have, datas: want.datas }, hash);
      await this.rec.decide(r.site_id, { agent: `agent:${r.agent}`, kind: "agent.inft_updated", summary: `${AGENT_INFO[r.agent].label} agent's iNFT #${r.token_id} updated: ${want.datas.map((d) => d.dataDescription.split(":")[0]).filter((k, i) => have.datas[i]?.dataHash !== want.datas[i]?.dataHash).join(", ") || "data"}`, data: { tokenId: r.token_id, tx: hash, datas: want.datas } });
      return;
    }
    const add = want.users.find((u) => !have.users.includes(u));
    if (add) return save({ ...have, users: [...have.users, add] }, await rail.authorize(r.token_id, add as Address));
    const drop = have.users.find((u) => !want.users.includes(u));
    if (drop) return save({ ...have, users: have.users.filter((u) => u !== drop) }, await rail.revoke(r.token_id, drop as Address));
    await this.db.query("UPDATE agent_nfts SET have_json = want_json, status = 'synced', updated_at = now() WHERE site_id = $1 AND agent = $2", [r.site_id, r.agent]);
  }

  async ofSite(siteId: string): Promise<Map<string, AgentNftView>> {
    const rows = (await this.db.query<Row>(`SELECT ${COLS} FROM agent_nfts WHERE site_id = $1`, [siteId])).rows;
    return new Map(
      rows.map((r) => {
        const have: Want = r.have_json ? JSON.parse(r.have_json) : { datas: [], users: [] };
        return [
          r.agent,
          {
            contract: this.rail?.cfg.address ?? "",
            tokenId: r.token_id === null ? null : Number(r.token_id),
            status: r.status,
            error: r.error,
            url: r.token_id === null ? null : this.rail?.tokenUrl(Number(r.token_id)) ?? null,
            txUrl: r.tx_hash ? this.rail?.txUrl(r.tx_hash) ?? null : null,
            data: have.datas,
            authorizedUsers: have.users,
          },
        ];
      }),
    );
  }

  private iso(plus = 0) {
    return new Date(this.now() + plus).toISOString();
  }
}

const COLS = "site_id, agent, token_id, want_json, have_json, status, tx_hash, mint_tx, error, attempts";
