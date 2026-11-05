/**
 * The maintenance agent pays through Hedera Agent Kit. Ordo ships an Agent Kit plugin with one transaction
 * tool, `ordo_escrow_work_order_tool`, that calls OrdoWorkOrders.escrow from the agent's own Hedera account.
 * Three layers stand between the agent and the money:
 *  1. an Agent Kit policy that blocks any escrow Ordo did not open as a work order (vendor, amount, id);
 *  2. the contract's caps, vendor credential check and pause, which no software can bypass;
 *  3. a person's signature to release the escrow to the vendor.
 * With a ledger topic configured, Agent Kit's audit hook writes each call to it.
 */
import { AccountId, Client, ContractExecuteTransaction, ContractId, type Transaction } from "@hiero-ledger/sdk";
import { AbstractPolicy, AgentMode, BaseTransactionTool, HederaAgentAPI, ToolDiscovery, handleTransaction, type Context, type Plugin, type PostParamsNormalizationParams } from "@hashgraph/hedera-agent-kit";
import { HcsAuditTrailHook } from "@hashgraph/hedera-agent-kit/hooks";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod/v3";
import type { AgentPayer, EscrowRequest, EscrowResult } from "./agent.js";
import { parseHederaKey } from "./hedera.js";
import { ORDO_WORK_ORDERS_ABI } from "./ordo-contracts-abi.js";

export const ESCROW_TOOL = "ordo_escrow_work_order_tool";

const escrowParameters = z.object({
  siteId: z.string().describe("Ordo site id"),
  workOrderId: z.string().describe("The work order Ordo opened, e.g. WO-12"),
  vendor: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Vendor's EVM address; it must hold the site's VENDOR credential"),
  amount: z.string().regex(/^\d+$/).describe("Amount in tinybars"),
  ttlSeconds: z.number().int().positive().describe("Seconds until an unreleased escrow can be refunded"),
  incidentHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("Hash of the Ordo ledger entry that justified the work order"),
});
type EscrowParams = z.infer<typeof escrowParameters>;

/** Agent Kit transaction tool: OrdoWorkOrders.escrow as a ContractExecuteTransaction signed by the agent. */
export class EscrowWorkOrderTool extends BaseTransactionTool {
  method = ESCROW_TOOL;
  name = "Escrow a work order payment";
  description = "Hold HBAR in OrdoWorkOrders for a maintenance work order. The vendor is paid only when a supervisor signs that the work is done.";
  // Agent Kit bundles its own zod; the schema is only read for descriptions, normalizeParams validates.
  parameters = escrowParameters as unknown as BaseTransactionTool["parameters"];

  constructor(private contract: Address) {
    super();
  }
  async normalizeParams(params: EscrowParams): Promise<EscrowParams> {
    return escrowParameters.parse(params);
  }
  async coreAction(p: EscrowParams): Promise<Transaction> {
    const data = encodeFunctionData({
      abi: ORDO_WORK_ORDERS_ABI,
      functionName: "escrow",
      args: [p.siteId, p.workOrderId, p.vendor as Address, BigInt(p.amount), BigInt(p.ttlSeconds), p.incidentHash as Hex],
    });
    return new ContractExecuteTransaction()
      .setContractId(ContractId.fromEvmAddress(0, 0, this.contract))
      .setGas(400_000)
      .setFunctionParameters(Buffer.from(data.slice(2), "hex"));
  }
  async secondaryAction(tx: Transaction, client: Client, context: Context) {
    return handleTransaction(tx, client, context);
  }
}

export const ordoWorkOrdersPlugin = (contract: Address): Plugin => ({
  name: "ordo-work-orders",
  version: "1.0.0",
  description: "Pay maintenance vendors through OrdoWorkOrders escrow",
  tools: () => [new EscrowWorkOrderTool(contract)],
});

/** Blocks an escrow unless Ordo opened that work order for that vendor and amount (the check returns why not). */
export class OrdoWorkOrderPolicy extends AbstractPolicy {
  name = "Ordo work order policy";
  description = "The agent may only escrow for work orders Ordo opened, to the assigned vendor, for the agreed amount";
  relevantTools = [ESCROW_TOOL];

  constructor(private check: (p: EscrowParams) => Promise<string | null>) {
    super();
  }
  protected async shouldBlockPostParamsNormalization(params: PostParamsNormalizationParams, method: string): Promise<boolean> {
    if (method !== ESCROW_TOOL) return false;
    const reason = await this.check(params.normalisedParams as EscrowParams);
    if (reason) throw new Error(`Blocked by ${this.name}: ${reason}`);
    return false;
  }
}

export interface AgentKitOptions {
  network: "testnet" | "mainnet" | "previewnet";
  agentId: string;
  agentKey: string;
  workOrders: Address;
  check: (p: EscrowParams) => Promise<string | null>;
  /** Write each escrow call to this HCS topic, submitted by the operator client (the topic's submit key). */
  audit?: { topicId: string; client: Client };
}

export class HederaAgentKitPayer implements AgentPayer {
  readonly kind = "hedera-agent-kit";
  readonly address: Address;
  private api: HederaAgentAPI;
  private hashscan: string;

  constructor(o: AgentKitOptions) {
    const key = parseHederaKey(o.agentKey);
    this.address = privateKeyToAccount(`0x${key.toStringRaw()}`).address;
    this.hashscan = `https://hashscan.io/${o.network}`;
    const client = Client.forName(o.network).setOperator(AccountId.fromString(o.agentId), key);
    const hooks = [new OrdoWorkOrderPolicy(o.check), ...(o.audit ? [new HcsAuditTrailHook([ESCROW_TOOL], o.audit.topicId, o.audit.client)] : [])];
    const context: Context = { mode: AgentMode.AUTONOMOUS, accountId: o.agentId, hooks };
    const configuration = { plugins: [ordoWorkOrdersPlugin(o.workOrders)], context };
    this.api = new HederaAgentAPI(client, context, ToolDiscovery.createFromConfiguration(configuration).getAllTools(context, configuration));
  }

  async escrow(r: EscrowRequest): Promise<EscrowResult> {
    const out = JSON.parse(
      await this.api.run(ESCROW_TOOL, {
        siteId: r.siteId,
        workOrderId: r.workOrderId,
        vendor: r.vendor,
        amount: r.amount.toString(),
        ttlSeconds: r.ttlSeconds,
        incidentHash: r.incidentHash,
      }),
    ) as { raw?: { status?: string; transactionId?: string; error?: string }; humanMessage?: string };
    if (out.raw?.status !== "SUCCESS" || !out.raw.transactionId) throw new Error(out.raw?.error ?? out.humanMessage ?? "Agent Kit escrow failed");
    const id = out.raw.transactionId; // 0.0.123@1700000000.000000000 → HashScan's 0.0.123-1700000000-000000000
    return { txId: id, url: `${this.hashscan}/transaction/${id.replace("@", "-").replace(/\.(\d+)$/, "-$1")}` };
  }
}
