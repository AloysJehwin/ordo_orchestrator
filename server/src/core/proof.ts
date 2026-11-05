import type { AnchorAdapter } from "../adapters/rails.js";
import type { Db } from "../db/db.js";
import type { LedgerStore } from "../db/ledger-store.js";
import { verifyChain } from "../domain/ledger.js";
import type { AnchorDto } from "../domain/types.js";

interface AnchorRow {
  id: number;
  kind: string;
  to_seq: number;
  entry_hash: string;
  ref: string;
  url: string | null;
  data_json: string;
  ts: string;
}
const toDto = (r: AnchorRow): AnchorDto => ({ id: Number(r.id), kind: r.kind, toSeq: Number(r.to_seq), entryHash: r.entry_hash, ref: r.ref, url: r.url, ts: r.ts });

/** Checkpoints of the ledger head outside the database, and independent verification. */
export class Proof {
  constructor(
    private db: Db,
    private ledger: LedgerStore,
    private anchorAdapter: AnchorAdapter,
  ) {}

  get kind() {
    return this.anchorAdapter.kind;
  }

  async anchors(limit = 20): Promise<AnchorDto[]> {
    return (await this.db.query<AnchorRow>("SELECT * FROM anchors ORDER BY id DESC LIMIT $1", [limit])).rows.map(toDto);
  }

  /** Anchor the current head unless it already is. Returns the anchor (new or existing). */
  async anchorHead(siteId: string | null, subject: string | null): Promise<AnchorDto | null> {
    const head = await this.ledger.head();
    if (!head) return null;
    const last = (await this.db.query<AnchorRow>("SELECT * FROM anchors WHERE kind = $1 ORDER BY id DESC LIMIT 1", [this.anchorAdapter.kind])).rows[0];
    if (last && Number(last.to_seq) === head.seq) return toDto(last);
    const r = await this.anchorAdapter.anchor({ toSeq: head.seq, entryHash: head.entryHash, siteId, subject });
    const ts = new Date().toISOString();
    const ins = await this.db.query<AnchorRow>("INSERT INTO anchors (kind, to_seq, entry_hash, ref, url, data_json, ts) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [
      this.anchorAdapter.kind,
      head.seq,
      head.entryHash,
      r.ref,
      r.url,
      JSON.stringify(r.data),
      ts,
    ]);
    await this.ledger.append({ ts, actor: "system:anchor", type: "ledger.anchored", subject, payload: { kind: this.anchorAdapter.kind, toSeq: head.seq, entryHash: head.entryHash, ref: r.ref, url: r.url } });
    return toDto(ins.rows[0]!);
  }

  /**
   * The first anchor at or after `seq` and whether it holds: its hash matches the ledger entry it names, and the
   * external record (HCS message or signed checkpoint) matches too. This is what proves entries up to `seq`.
   */
  async covering(seq: number) {
    const a = (await this.db.query<AnchorRow>("SELECT * FROM anchors WHERE to_seq >= $1 ORDER BY to_seq, id LIMIT 1", [seq])).rows[0];
    if (!a) return null;
    const entry = (await this.ledger.range(Number(a.to_seq), Number(a.to_seq)))[0];
    const external =
      a.kind === this.anchorAdapter.kind
        ? await this.anchorAdapter
            .verify({ toSeq: Number(a.to_seq), entryHash: a.entry_hash, ref: a.ref, data: JSON.parse(a.data_json) })
            .catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
        : { ok: false, detail: `Anchored with ${a.kind}; this deployment uses ${this.anchorAdapter.kind}` };
    return { ...toDto(a), matchesChain: entry?.entryHash === a.entry_hash, external };
  }

  /**
   * Re-walk the whole chain from genesis, then check each anchor against the chain and its
   * external record. `subject` narrows the report to the entries of one run or incident.
   */
  async verify(subject?: string) {
    const head = await this.ledger.head();
    const entries = head ? await this.ledger.range(1, head.seq) : [];
    const chain = verifyChain(entries);
    const broken = chain.checks.filter((c) => !c.ok);
    const anchorRows = (await this.db.query<AnchorRow>("SELECT * FROM anchors ORDER BY id DESC LIMIT 5")).rows;
    const anchors = [];
    for (const a of anchorRows) {
      const inChain = entries.find((e) => e.seq === Number(a.to_seq));
      const matches = inChain?.entryHash === a.entry_hash;
      let external = { ok: false, detail: "not checked" };
      if (a.kind === this.anchorAdapter.kind) {
        external = await this.anchorAdapter
          .verify({ toSeq: Number(a.to_seq), entryHash: a.entry_hash, ref: a.ref, data: JSON.parse(a.data_json) })
          .catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
      } else external = { ok: false, detail: `Anchored with ${a.kind}; this deployment uses ${this.anchorAdapter.kind}` };
      anchors.push({ ...toDto(a), matchesChain: matches, external });
    }
    const scoped = subject ? entries.filter((e) => e.subject === subject || e.subject?.startsWith(`${subject}/`)) : [];
    return {
      ok: chain.ok && anchors.every((a) => a.matchesChain),
      entries: entries.length,
      headSeq: head?.seq ?? 0,
      headHash: head?.entryHash ?? null,
      broken: broken.slice(0, 20),
      anchors,
      subject: subject
        ? { id: subject, entries: scoped.map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type, entryHash: e.entryHash, ok: chain.checks.find((c) => c.seq === e.seq)?.ok ?? false })) }
        : null,
    };
  }
}
