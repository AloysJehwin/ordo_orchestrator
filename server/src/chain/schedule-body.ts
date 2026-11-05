import { createHash } from "node:crypto";

/**
 * A scheduled HBAR transfer as the mirror node holds it (`/api/v1/schedules/{id}` → `transaction_body`, a base64
 * SchedulableTransactionBody): enough protobuf to read who it pays and who it debits, and nothing else. The console
 * has the same reader (web/src/lib/schedule-body.ts) and checks a schedule's body itself before a manager signs.
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

/** The HBAR transfers in a scheduled transaction body; null if it is not a transfer at all. */
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

/**
 * What a manager's `budget.approve` signature names besides the schedule: sha256 of the treasury and every credit,
 * sorted by account (`ordo-budget|<treasury>|<account>:<tinybars>,…`). The console computes it from the mirror node's
 * copy of the schedule, so a signature only ever matches the transfer the manager was shown.
 */
export function budgetHash(treasury: string, credits: { accountId: string; amount: bigint | string }[]): `0x${string}` {
  const line = [...credits]
    .map((c) => `${c.accountId}:${BigInt(c.amount).toString()}`)
    .sort()
    .join(",");
  return `0x${createHash("sha256").update(`ordo-budget|${treasury}|${line}`).digest("hex")}`;
}

/**
 * The contract an account's key names, from the mirror node's `key` of type ProtobufEncoded (hex of a Key whose only
 * field is `contractID`, field 1); null for any other key. A treasury's key must be exactly its org's key contract.
 */
export function keyContractId(protobufHex: string): string | null {
  const b = Uint8Array.from((protobufHex.replace(/^0x/, "").match(/../g) ?? []).map((h) => parseInt(h, 16)));
  try {
    const key = fields(b);
    if (key.length !== 1 || key[0]!.no !== 1) return null;
    const id = fields(bytes(key[0])!);
    return `${num(id.find((f) => f.no === 1))}.${num(id.find((f) => f.no === 2))}.${num(id.find((f) => f.no === 3))}`;
  } catch {
    return null;
  }
}
