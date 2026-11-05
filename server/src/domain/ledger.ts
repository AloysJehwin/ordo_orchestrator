import { hashOf } from "./canonical.js";

export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

export interface LedgerDraft {
  ts: string;
  actor: string;
  type: string;
  subject: string | null;
  payload: unknown;
}

export interface LedgerEntry extends LedgerDraft {
  seq: number;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
}

export function entryHashOf(e: Omit<LedgerEntry, "entryHash" | "payload">): string {
  return hashOf({
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    type: e.type,
    subject: e.subject,
    payloadHash: e.payloadHash,
    prevHash: e.prevHash,
  });
}

/** Build the next entry in the chain. `prev` is null for the genesis entry. */
export function buildEntry(prev: Pick<LedgerEntry, "seq" | "entryHash"> | null, draft: LedgerDraft): LedgerEntry {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.entryHash : GENESIS_HASH;
  const payloadHash = hashOf(draft.payload);
  const base = { ...draft, seq, payloadHash, prevHash };
  return { ...base, entryHash: entryHashOf(base) };
}

export interface EntryCheck {
  seq: number;
  ok: boolean;
  reason?: string;
}

/** Re-walk the chain from genesis. Entries must be ordered by seq starting at 1. */
export function verifyChain(entries: LedgerEntry[]): { ok: boolean; checks: EntryCheck[] } {
  const checks: EntryCheck[] = [];
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let broken = false;
  for (const e of entries) {
    const reasons: string[] = [];
    if (e.seq !== expectedSeq) reasons.push(`expected seq ${expectedSeq}, found ${e.seq}`);
    if (hashOf(e.payload) !== e.payloadHash) reasons.push("payload does not match its hash");
    if (e.prevHash !== prevHash) reasons.push("link to previous entry is broken");
    if (entryHashOf(e) !== e.entryHash) reasons.push("entry hash does not match its fields");
    if (broken && reasons.length === 0) reasons.push("an earlier entry is broken");
    const ok = reasons.length === 0;
    if (!ok) broken = true;
    checks.push(ok ? { seq: e.seq, ok } : { seq: e.seq, ok, reason: reasons.join("; ") });
    prevHash = e.entryHash;
    expectedSeq = e.seq + 1;
  }
  return { ok: !broken, checks };
}
