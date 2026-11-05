import { Transaction, TransferTransaction } from "@hiero-ledger/sdk";
import type { FacilitatorClient } from "@x402/core/server";

export const FEE_PAYER = "0.0.9001";

/** A facilitator in the test process: checks the agent's signed transfer the way a real one does, then "submits" it. */
export function fakeFacilitator(payer: string) {
  const settled: string[] = [];
  /** Each settled payment's HBAR movements: [account, tinybars] (negative for the payer) */
  const transfersOf: (readonly (readonly [string, string])[])[] = [];
  const transfers = (b64: string) => {
    const tx = Transaction.fromBytes(Buffer.from(b64, "base64"));
    if (!(tx instanceof TransferTransaction)) throw new Error("not a transfer");
    return { tx, hbar: [...tx.hbarTransfers].map(([acct, h]) => [acct.toString(), h.toTinybars().toString()] as const) };
  };
  const f: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} };
    },
    async verify(p, r) {
      const { tx, hbar } = transfers((p.payload as { transaction: string }).transaction);
      const ok = tx.transactionId?.accountId?.toString() === FEE_PAYER && hbar.some(([a, v]) => a === r.payTo && v === r.amount) && tx.getSignatures().size > 0;
      return { isValid: ok, invalidReason: ok ? undefined : "bad_transfer", payer };
    },
    async settle(p) {
      const { tx, hbar } = transfers((p.payload as { transaction: string }).transaction);
      settled.push(tx.transactionId!.toString());
      transfersOf.push(hbar);
      return { success: true, transaction: tx.transactionId!.toString(), network: "hedera:testnet", payer };
    },
  };
  return { f, settled, transfers: transfersOf };
}
