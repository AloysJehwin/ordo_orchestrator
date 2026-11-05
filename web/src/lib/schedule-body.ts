import type { BudgetSchedule } from "../types";

/**
 * The console's own reading of a Hedera schedule, before a manager signs `budget.approve` for it: the schedule's body
 * comes from Hedera's public mirror node (never from Ordo), and the signature names the hash of the transfer it
 * holds. The same reader as the server's (server/src/chain/schedule-body.ts); keep the two in step.
 */
export interface ScheduledTransfer {
  /** every HBAR amount in the transfer, in tinybars: negative debits, positive credits */
  transfers: { accountId: string; amount: bigint }[];
  /** the body moves tokens or does something other than an HBAR transfer */
  other: boolean;
}

type Field = { no: number; wire: number; v: bigint | Uint8Array };

function fields(b: Uint8Array): Field[] {
  let i = 0;
  const varint = (): bigint => {
    let x = 0n;
    let s = 0n;
    for (;;) {
      if (i >= b.length) throw new Error("truncated protobuf");
      const c = b[i++]!;
      x |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) return x;
      s += 7n;
    }
  };
  const out: Field[] = [];
  while (i < b.length) {
    const tag = Number(varint());
    const [no, wire] = [tag >>> 3, tag & 7];
    if (wire === 0) out.push({ no, wire, v: varint() });
    else if (wire === 2) {
      const len = Number(varint());
      if (i + len > b.length) throw new Error("truncated protobuf");
      out.push({ no, wire, v: b.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return out;
}
const bytes = (f: Field | undefined) => (f && f.v instanceof Uint8Array ? f.v : null);
const num = (f: Field | undefined) => (f && typeof f.v === "bigint" ? f.v : 0n);
/** sint64 is zigzag-encoded */
const zigzag = (n: bigint) => (n >> 1n) ^ -(n & 1n);

/** The HBAR transfers in a scheduled transaction body (base64 SchedulableTransactionBody); null if it is not a transfer. */
export function scheduledTransfer(bodyBase64: string): ScheduledTransfer | null {
  const body = Uint8Array.from(atob(bodyBase64), (c) => c.charCodeAt(0));
  const top = fields(body);
  // SchedulableTransactionBody: 1 transactionFee, 2 memo, 9 cryptoTransfer
  const ct = bytes(top.find((f) => f.no === 9 && f.wire === 2));
  if (!ct) return null;
  const inner = fields(ct);
  // CryptoTransferTransactionBody: 1 transfers (TransferList), 2 tokenTransfers
  const list = bytes(inner.find((f) => f.no === 1));
  const transfers: ScheduledTransfer["transfers"] = [];
  for (const aa of list ? fields(list).filter((f) => f.no === 1) : []) {
    // AccountAmount: 1 accountID, 2 amount (sint64), 3 is_approval
    const a = fields(bytes(aa)!);
    const id = fields(bytes(a.find((f) => f.no === 1)) ?? new Uint8Array());
    // AccountID: 1 shard, 2 realm, 3 accountNum (4 alias: not something Ordo schedules)
    if (id.some((f) => f.no === 4)) return { transfers, other: true };
    transfers.push({ accountId: `${num(id.find((f) => f.no === 1))}.${num(id.find((f) => f.no === 2))}.${num(id.find((f) => f.no === 3))}`, amount: zigzag(num(a.find((f) => f.no === 2))) });
  }
  return { transfers, other: inner.some((f) => f.no !== 1) || top.some((f) => f.no > 2 && f.no !== 9) };
}

/** sha256 of `ordo-budget|<treasury>|<account>:<tinybars>,…` (credits sorted), as the server computes it. */
export async function budgetHash(treasury: string, credits: { accountId: string; amount: bigint | string }[]): Promise<string> {
  const line = [...credits]
    .map((c) => `${c.accountId}:${BigInt(c.amount).toString()}`)
    .sort()
    .join(",");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ordo-budget|${treasury}|${line}`));
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Hedera's public mirror node for the chain a signature is for (295 mainnet, 296 testnet, 297 previewnet). */
export function mirrorFor(chainId: number): string {
  const network = ({ 295: "mainnet", 296: "testnet", 297: "previewnet" } as Record<number, string>)[chainId];
  if (!network) throw new Error(`Chain ${chainId} is not Hedera: a budget is approved only on Hedera`);
  return `https://${network}.mirrornode.hedera.com`;
}

/**
 * Read the schedule from the mirror node and check it is exactly what Ordo shows: not executed or deleted, an HBAR
 * transfer and nothing else, debiting only the org's treasury by the total, crediting exactly the machines listed.
 * Returns the hash of its credits, which the signed entity must end with.
 */
export async function checkSchedule(b: BudgetSchedule, chainId: number): Promise<string> {
  if (!b.scheduleId) throw new Error("This budget has no Hedera schedule");
  const res = await fetch(`${mirrorFor(chainId)}/api/v1/schedules/${b.scheduleId}`);
  if (res.status === 404) throw new Error(`The mirror node does not know schedule ${b.scheduleId} yet; try again in a few seconds`);
  if (!res.ok) throw new Error(`The mirror node answered ${res.status} for schedule ${b.scheduleId}`);
  const s = (await res.json()) as { executed_timestamp: string | null; deleted: boolean; expiration_time: string | null; transaction_body: string };
  if (s.executed_timestamp) throw new Error(`Schedule ${b.scheduleId} has already executed`);
  if (s.deleted) throw new Error(`Schedule ${b.scheduleId} was deleted`);
  if (s.expiration_time && Number(s.expiration_time.split(".")[0]) * 1000 <= Date.now()) throw new Error(`Schedule ${b.scheduleId} has lapsed on Hedera`);
  const t = scheduledTransfer(s.transaction_body);
  if (!t || t.other) throw new Error(`Schedule ${b.scheduleId} is not a plain HBAR transfer: do not sign it`);
  const debits = t.transfers.filter((x) => x.amount < 0n);
  const credits = t.transfers.filter((x) => x.amount > 0n);
  const total = credits.reduce((a, x) => a + x.amount, 0n);
  if (debits.length !== 1 || debits[0]!.accountId !== b.treasuryAccount || -debits[0]!.amount !== total || total !== BigInt(b.total))
    throw new Error(`Schedule ${b.scheduleId} does not debit only the org's treasury ${b.treasuryAccount} by ${b.total} tinybars: do not sign it`);
  const shown = new Map(b.credits.map((c) => [c.accountId, BigInt(c.amount)]));
  if (credits.length !== shown.size || credits.some((c) => shown.get(c.accountId) !== c.amount))
    throw new Error(`Schedule ${b.scheduleId} pays other accounts or amounts than Ordo shows: do not sign it`);
  return budgetHash(b.treasuryAccount, credits);
}
