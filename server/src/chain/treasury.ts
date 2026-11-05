/**
 * Org treasuries on Hedera (OrdoTreasury, HIP-755). An org's treasury is a native account whose key is the org's own
 * OrdoTreasuryKey contract; HBAR leaves it only through a scheduled transfer that the contract signs once one of the
 * org's managers approved it. The operator pays for and creates the schedules (and may delete one a manager declined:
 * deleting moves nothing); the relayer sends the manager's signed approval to OrdoTreasury. Written against
 * @hiero-ledger/sdk v2.9x; checked live on testnet (docs/hedera.md).
 */
import {
  AccountCreateTransaction,
  AccountId,
  ContractId,
  Hbar,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  ScheduleId,
  Timestamp,
  TopicId,
  TopicMessageSubmitTransaction,
  TransferTransaction,
  type Client,
  type PrivateKey,
} from "@hiero-ledger/sdk";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ORDO_TREASURY_ABI } from "./ordo-treasury-abi.js";
import { keyContractId, scheduledTransfer, type ScheduledTransfer } from "./schedule-body.js";
import type { SigArg } from "./trust.js";

/** A schedule as the ledger holds it (mirror node). */
export interface ScheduleOnLedger {
  scheduleId: string;
  memo: string;
  executedAt: string | null;
  deleted: boolean;
  expiresAt: string | null;
  /** the HBAR transfer it carries, as the network will execute it */
  transfer: ScheduledTransfer | null;
  /** once executed, the scheduled transfer's own result: SUCCESS, or why it failed (INSUFFICIENT_ACCOUNT_BALANCE) */
  result?: string | null;
}

/** What Budgets needs from Hedera (hederaTreasury in production). Amounts in tinybars. */
export interface TreasuryRail {
  /** OrdoTreasury's address */
  contract: Address;
  /** The org's key contract, opened in OrdoTreasury if it is not yet (relayed), with its Hedera contract id. */
  openKey(siteId: string): Promise<{ key: Address; contractId: string; tx: Hex | null }>;
  /** A new account whose key is that contract, seeded by the operator. */
  openAccount(keyContractId: string, seed: bigint, memo: string): Promise<{ accountId: string; tx: string }>;
  /** An account's balance and the contract its key names (null when its key is anything else); null if unknown. */
  account(accountId: string): Promise<{ keyContractId: string | null; balance: bigint } | null>;
  /** One ScheduleCreate wrapping a transfer from the treasury to each credit. */
  schedule(i: { treasury: string; credits: { accountId: string; amount: bigint }[]; memo: string; expiresAt: Date }): Promise<{ scheduleId: string; txId: string }>;
  read(scheduleId: string): Promise<ScheduleOnLedger | null>;
  /** Relay a manager's `budget.approve` to OrdoTreasury, which signs the schedule with the org's key. */
  approve(siteId: string, scheduleId: string, entity: string, sig: SigArg): Promise<Hex>;
  /** Delete a schedule (the operator holds its admin key). */
  cancel(scheduleId: string): Promise<void>;
  /** A line on the ledger topic (HCS); null when no topic is configured. */
  audit(message: Record<string, unknown>): Promise<{ txId: string; topicId: string; sequence: string } | null>;
  scheduleUrl(scheduleId: string): string;
  accountUrl(accountId: string): string;
  txUrl(txId: string): string;
  contractUrl(address: string): string;
}

const txPath = (id: string) => (id.startsWith("0x") ? id : id.replace("@", "-").replace(/\.(\d+)$/, "-$1"));
const iso = (consensus: string | null | undefined) => (consensus ? new Date(Number(consensus.split(".")[0]) * 1000).toISOString() : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function hederaTreasury(o: {
  client: Client;
  operatorKey: PrivateKey;
  network: string;
  mirrorUrl: string;
  topicId: string | null;
  contract: Address;
  rpcUrl: string;
  chainId: number;
  relayerKey: Hex;
  transport?: Transport;
}): TreasuryRail {
  const hashscan = `https://hashscan.io/${o.network}`;
  const operatorId = o.client.operatorAccountId!;
  const chain = defineChain({ id: o.chainId, name: `chain-${o.chainId}`, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const t = o.transport ?? http(o.rpcUrl, { timeout: 30_000 });
  const pub = createPublicClient({ chain, transport: t });
  const wallet = createWalletClient({ chain, transport: t, account: privateKeyToAccount(o.relayerKey) });
  const read = <T>(functionName: string, args: unknown[]) => pub.readContract({ address: o.contract, abi: ORDO_TREASURY_ABI, functionName, args } as never) as Promise<T>;
  const send = async (functionName: string, args: unknown[], gas: bigint): Promise<Hex> => {
    // a refusal OrdoTreasury explains (NotAuthorized, WrongEntity, NonceUsed…) surfaces before anything is sent; the
    // simulation may not run the Schedule Service, so anything else is left to the transaction itself
    await pub.simulateContract({ address: o.contract, abi: ORDO_TREASURY_ABI, functionName, args, account: wallet.account } as never).catch((e: unknown) => {
      const name = (e as { cause?: { data?: { errorName?: string } } }).cause?.data?.errorName;
      if (name) throw new Error(`OrdoTreasury refused ${functionName}: ${name}`);
    });
    // an explicit gas price: the relay's fee estimate is sometimes below its own minimum
    const hash = await wallet.writeContract({ address: o.contract, abi: ORDO_TREASURY_ABI, functionName, args, gas, gasPrice: await pub.getGasPrice() } as never);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (r.status !== "success") throw new Error(`OrdoTreasury reverted ${functionName} (${hash})`);
    return hash;
  };
  const mirror = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`${o.mirrorUrl}/api/v1/${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Mirror node returned ${res.status} for ${path}`);
    return (await res.json()) as T;
  };
  return {
    contract: o.contract,
    async openKey(siteId) {
      const k = await read<Hex>("siteKey", [siteId]);
      let tx: Hex | null = null;
      let key = await read<Address>("keyOf", [k]);
      if (/^0x0{40}$/.test(key)) {
        tx = await send("openSite", [siteId], 600_000n);
        key = await read<Address>("keyOf", [k]);
      }
      // the mirror node indexes a new contract a few seconds after it is created
      for (let i = 0; i < 10; i++) {
        const c = await mirror<{ contract_id: string }>(`contracts/${key}`).catch(() => null);
        if (c) return { key, contractId: c.contract_id, tx };
        await sleep(3000);
      }
      throw new Error(`The mirror node does not know the key contract ${key} yet; try again in a minute`);
    },
    async openAccount(keyId, seed, memo) {
      const tx = await new AccountCreateTransaction().setKey(ContractId.fromString(keyId)).setInitialBalance(Hbar.fromTinybars(seed.toString())).setAccountMemo(memo.slice(0, 100)).execute(o.client);
      const receipt = await tx.getReceipt(o.client);
      return { accountId: receipt.accountId!.toString(), tx: tx.transactionId.toString() };
    },
    async account(accountId) {
      const a = await mirror<{ balance: { balance: number }; key: { _type: string; key: string } | null }>(`accounts/${accountId}`);
      if (!a) return null;
      return { keyContractId: a.key?._type === "ProtobufEncoded" ? keyContractId(a.key.key) : null, balance: BigInt(a.balance.balance) };
    },
    async schedule(i) {
      const total = i.credits.reduce((s, c) => s + c.amount, 0n);
      const transfer = new TransferTransaction().addHbarTransfer(AccountId.fromString(i.treasury), Hbar.fromTinybars((-total).toString()));
      for (const c of i.credits) transfer.addHbarTransfer(AccountId.fromString(c.accountId), Hbar.fromTinybars(c.amount.toString()));
      const tx = await new ScheduleCreateTransaction()
        .setScheduledTransaction(transfer)
        .setScheduleMemo(i.memo.slice(0, 100))
        .setPayerAccountId(operatorId)
        .setAdminKey(o.operatorKey.publicKey)
        .setExpirationTime(Timestamp.fromDate(i.expiresAt))
        // it executes the moment the org's key signs, not at its expiry
        .setWaitForExpiry(false)
        .execute(o.client);
      const receipt = await tx.getReceipt(o.client);
      return { scheduleId: receipt.scheduleId!.toString(), txId: tx.transactionId.toString() };
    },
    async read(scheduleId) {
      const s = await mirror<{ memo: string; executed_timestamp: string | null; deleted: boolean; expiration_time: string | null; transaction_body: string }>(`schedules/${scheduleId}`);
      if (!s) return null;
      // a schedule executes when the org's key signs even if the treasury cannot pay: its transfer then fails on its own
      let result: string | null = null;
      if (s.executed_timestamp) {
        const t = await mirror<{ transactions: { scheduled: boolean; result: string }[] }>(`transactions?timestamp=${s.executed_timestamp}`).catch(() => null);
        result = t?.transactions.find((x) => x.scheduled)?.result ?? null;
      }
      return { scheduleId, memo: s.memo, executedAt: iso(s.executed_timestamp), deleted: s.deleted, expiresAt: iso(s.expiration_time), transfer: scheduledTransfer(s.transaction_body), result };
    },
    async approve(siteId, scheduleId, entity, sig) {
      const evm = `0x${ScheduleId.fromString(scheduleId).toSolidityAddress()}` as Address;
      return send("approve", [siteId, evm, entity, sig], 400_000n);
    },
    async cancel(scheduleId) {
      const tx = await new ScheduleDeleteTransaction().setScheduleId(ScheduleId.fromString(scheduleId)).execute(o.client);
      await tx.getReceipt(o.client);
    },
    async audit(message) {
      if (!o.topicId) return null;
      const tx = await new TopicMessageSubmitTransaction({ topicId: TopicId.fromString(o.topicId), message: JSON.stringify({ v: 1, app: "ordo", ...message }) }).execute(o.client);
      const receipt = await tx.getReceipt(o.client);
      return { txId: tx.transactionId.toString(), topicId: o.topicId, sequence: receipt.topicSequenceNumber?.toString() ?? "?" };
    },
    scheduleUrl: (id) => `${hashscan}/schedule/${id}`,
    accountUrl: (id) => `${hashscan}/account/${id}`,
    txUrl: (id) => `${hashscan}/transaction/${txPath(id)}`,
    contractUrl: (a) => `${hashscan}/contract/${a}`,
  };
}
