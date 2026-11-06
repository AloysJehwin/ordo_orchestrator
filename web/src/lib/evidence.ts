import type { DecisionView } from "../types";

/** A link to what backs a decision on-chain: a payment, a schedule, an HCS record, a transaction. */
export interface EvidenceLink {
  label: string;
  url: string;
}
/** What a decision says about its signature, when it was signed. */
export interface SignedMark {
  label: string;
  /** who signed it: an address, or null when the actor did (the decision's own actor) */
  signer: string | null;
  /** the hover text: what was signed, and how */
  detail: string;
}

const HEDERA_TX = /^\d+\.\d+\.\d+@\d+\.\d+$/;
const HEDERA_ID = /^\d+\.\d+\.\d+$/;
/** HashScan writes a transaction id 0.0.5@1700000000.123 as 0.0.5-1700000000-123. */
const txPath = (id: string) => id.replace("@", "-").replace(/\.(\d+)$/, "-$1");
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const https = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https:\/\//.test(s) ? s : null;
};

/** The on-chain records a decision points at, from the ids and links its data carries. */
export function evidenceOf(d: DecisionView, network: string | null | undefined): EvidenceLink[] {
  const x = (d.data && typeof d.data === "object" ? d.data : {}) as Record<string, unknown>;
  const hs = (path: string) => (network ? `https://hashscan.io/${network}/${path}` : null);
  const out: EvidenceLink[] = [];
  const add = (label: string, url: string | null) => {
    if (url && !out.some((l) => l.url === url)) out.push({ label, url });
  };
  const spend = d.kind === "resource.bought" || d.kind.startsWith("budget.") || d.kind.startsWith("finance.");
  // links the server already built
  add("Schedule", https(x.scheduleUrl));
  add(/schedul/.test(d.kind) ? "Schedule" : "Record", https(x.url));
  add(spend ? "Payment" : "Transaction", https(x.txUrl));
  add("Approval", https(x.approveTxUrl));
  // Hedera ids, linked on HashScan
  const tx = str(x.tx) ?? str(x.transactionId);
  if (tx && HEDERA_TX.test(tx)) add(d.kind === "resource.bought" ? "Payment" : /schedul/.test(d.kind) ? "Schedule transaction" : "Transaction", hs(`transaction/${txPath(tx)}`));
  const audit = str(x.audit);
  if (audit && HEDERA_TX.test(audit)) add("HCS record", hs(`transaction/${txPath(audit)}`));
  const hcs = (x.hcs && typeof x.hcs === "object" ? x.hcs : null) as { txId?: unknown; url?: unknown } | null;
  if (hcs) add("HCS record", https(hcs.url) ?? (str(hcs.txId) && HEDERA_TX.test(str(hcs.txId)!) ? hs(`transaction/${txPath(str(hcs.txId)!)}`) : null));
  const schedule = str(x.scheduleId);
  if (schedule && HEDERA_ID.test(schedule) && !out.some((l) => l.label === "Schedule")) add("Schedule", hs(`schedule/${schedule}`));
  return out;
}

/** Whether a decision records a signature, and whose. */
export function signedOf(d: DecisionView): SignedMark | null {
  const x = (d.data && typeof d.data === "object" ? d.data : {}) as Record<string, unknown>;
  if (d.kind === "stage.reading_signed")
    return { label: "Signed", signer: str(x.signer), detail: `${x.signerKind === "device" ? "The gateway's key" : "The operator's wallet"} signed a commitment to the counts (EIP-712)${str(x.commitment) ? `: ${str(x.commitment)!.slice(0, 18)}…` : ""}` };
  if (d.kind === "resource.bought" && str(x.receiptSigner)) return { label: "Receipt signed", signer: null, detail: `Ordo signed the delivery receipt (EIP-712) with ${str(x.receiptSigner)}` };
  if (str(x.signatureId)) return { label: "Signed", signer: str(x.contributor), detail: `Signed with the person's wallet (EIP-712)${str(x.recordSha256) ? ` over the record ${str(x.recordSha256)!.slice(0, 16)}…` : ""}` };
  if (/\.signed$|_signed$/.test(d.kind)) return { label: "Signed", signer: null, detail: "Signed by the actor (EIP-712)" };
  return null;
}
