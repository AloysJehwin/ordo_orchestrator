/**
 * Hedera Consensus Service anchoring of the ledger head. Written against @hiero-ledger/sdk v2.9x.
 * The topic comes from the "Hedera setup" workflow (see docs/contracts-and-deployment.md). Not exercised
 * in CI: the CI sandbox has no route to Hedera; run `pnpm --filter @ordo/server smoke:hedera` locally.
 */
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  PrivateKey,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  ScheduleId,
  Timestamp,
  TopicId,
  TopicMessageSubmitTransaction,
  type Transaction,
} from "@hiero-ledger/sdk";
import { hexToBytes } from "viem";
import type { Config } from "../config.js";
import type { AnchorAdapter, AnchorInput } from "../adapters/rails.js";
import type { ScheduleRail } from "../core/schedules.js";

export const parseHederaKey = (k: string): PrivateKey => {
  const s = k.trim();
  if (s.startsWith("302")) return PrivateKey.fromStringDer(s);
  return PrivateKey.fromStringECDSA(s.replace(/^0x/, ""));
};

export function hederaFromConfig(cfg: Config) {
  if (!cfg.HEDERA_OPERATOR_ID || !cfg.HEDERA_OPERATOR_KEY) throw new Error("Hedera adapters need HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY");
  const network = cfg.HEDERA_NETWORK;
  const operatorId = AccountId.fromString(cfg.HEDERA_OPERATOR_ID);
  const operatorKey = parseHederaKey(cfg.HEDERA_OPERATOR_KEY);
  const client = Client.forName(network).setOperator(operatorId, operatorKey);
  const mirror = (cfg.HEDERA_MIRROR_URL ?? `https://${network}.mirrornode.hedera.com`).replace(/\/$/, "");
  const hashscan = `https://hashscan.io/${network}`;

  return {
    /** The operator client, also used to write agent audit entries to the ledger topic. */
    client,
    anchor(): AnchorAdapter {
      if (!cfg.HEDERA_TOPIC_ID) throw new Error("ANCHOR=hedera needs HEDERA_TOPIC_ID");
      const topicId = TopicId.fromString(cfg.HEDERA_TOPIC_ID);
      return {
        kind: "hedera-hcs",
        async anchor(i: AnchorInput) {
          const message = JSON.stringify({ v: 2, app: "ordo", site: i.siteId, toSeq: i.toSeq, entryHash: i.entryHash, subject: i.subject });
          const tx = await new TopicMessageSubmitTransaction({ topicId, message }).execute(client);
          const receipt = await tx.getReceipt(client);
          const sequence = receipt.topicSequenceNumber?.toString() ?? "?";
          return {
            ref: `${topicId.toString()}#${sequence}`,
            url: `${hashscan}/topic/${topicId.toString()}`,
            data: { topicId: topicId.toString(), sequence, transactionId: tx.transactionId.toString() },
          };
        },
        async verify(s) {
          const seq = String(s.data.sequence ?? "");
          const res = await fetch(`${mirror}/api/v1/topics/${String(s.data.topicId)}/messages/${seq}`);
          if (!res.ok) return { ok: false, detail: `Mirror node returned ${res.status}` };
          const body = (await res.json()) as { message: string; consensus_timestamp: string };
          const msg = JSON.parse(Buffer.from(body.message, "base64").toString("utf8")) as { toSeq: number; entryHash: string };
          const ok = msg.toSeq === s.toSeq && msg.entryHash === s.entryHash;
          return { ok, detail: ok ? `Matches HCS message #${seq}, consensus ${body.consensus_timestamp}` : `HCS message #${seq} does not match the stored anchor` };
        },
      };
    },
    /**
     * Hedera Schedule Service with long-term scheduled transactions (HIP-423): each schedule waits for its
     * expiration time and then the network executes it, whether or not Ordo is running. The operator pays and
     * signs at creation and holds the admin key, so Ordo can delete a schedule that is no longer needed.
     */
    scheduler(): ScheduleRail {
      const contractIds = new Map<string, ContractId>();
      const contractId = async (evm: string): Promise<ContractId> => {
        const hit = contractIds.get(evm.toLowerCase());
        if (hit) return hit;
        const res = await fetch(`${mirror}/api/v1/contracts/${evm}`);
        if (!res.ok) throw new Error(`Mirror node has no contract ${evm} (${res.status})`);
        const id = ContractId.fromString(((await res.json()) as { contract_id: string }).contract_id);
        contractIds.set(evm.toLowerCase(), id);
        return id;
      };
      const create = async (inner: Transaction, at: Date, memo: string) => {
        const tx = await new ScheduleCreateTransaction()
          .setScheduledTransaction(inner)
          .setScheduleMemo(memo.slice(0, 100))
          .setPayerAccountId(operatorId)
          .setAdminKey(operatorKey.publicKey)
          .setExpirationTime(Timestamp.fromDate(at))
          .setWaitForExpiry(true)
          .execute(client);
        const receipt = await tx.getReceipt(client);
        return { scheduleId: receipt.scheduleId!.toString(), txId: tx.transactionId.toString() };
      };
      return {
        kind: "hedera-schedule-service",
        async contractCall(i) {
          const inner = new ContractExecuteTransaction().setContractId(await contractId(i.contract)).setGas(i.gas).setFunctionParameters(hexToBytes(i.data));
          return create(inner, i.at, i.memo);
        },
        async topicMessage(i) {
          if (!cfg.HEDERA_TOPIC_ID) throw new Error("Scheduled ledger messages need HEDERA_TOPIC_ID");
          return create(new TopicMessageSubmitTransaction({ topicId: TopicId.fromString(cfg.HEDERA_TOPIC_ID), message: i.message }), i.at, i.memo);
        },
        async cancel(scheduleId) {
          const tx = await new ScheduleDeleteTransaction().setScheduleId(ScheduleId.fromString(scheduleId)).execute(client);
          await tx.getReceipt(client);
        },
        async state(scheduleId) {
          const res = await fetch(`${mirror}/api/v1/schedules/${scheduleId}`);
          if (res.status === 404) return { state: "pending", executedAt: null };
          if (!res.ok) throw new Error(`Mirror node returned ${res.status} for schedule ${scheduleId}`);
          const b = (await res.json()) as { executed_timestamp: string | null; deleted: boolean };
          if (b.executed_timestamp) return { state: "executed", executedAt: new Date(Number(b.executed_timestamp.split(".")[0]) * 1000).toISOString() };
          return { state: b.deleted ? "deleted" : "pending", executedAt: null };
        },
        url: (scheduleId) => `${hashscan}/schedule/${scheduleId}`,
      };
    },
  };
}
