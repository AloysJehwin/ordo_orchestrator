import { AccountId, Client, ContractExecuteTransaction, PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { AgentMode, HederaAgentAPI, ToolDiscovery, type Context } from "@hashgraph/hedera-agent-kit";
import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ESCROW_TOOL, OrdoWorkOrderPolicy, ordoWorkOrdersPlugin } from "../../src/chain/agent-kit.js";
import { ORDO_WORK_ORDERS_ABI } from "../../src/chain/ordo-contracts-abi.js";

/**
 * The maintenance agent's Hedera Agent Kit tool, offline: in RETURN_BYTES mode Agent Kit freezes the
 * transaction instead of submitting it, so we can read exactly what the agent would sign.
 */
const CONTRACT = "0x00000000000000000000000000000000000a1b2c" as Hex;
const VENDOR = "0x1111111111111111111111111111111111111111";
const params = { siteId: "site_1", workOrderId: "wo_1", vendor: VENDOR, amount: "400000000", ttlSeconds: 259200, incidentHash: `0x${"ab".repeat(32)}` };

function api(check: (p: typeof params) => Promise<string | null>) {
  const key = PrivateKey.generateECDSA();
  const client = Client.forTestnet().setOperator(AccountId.fromString("0.0.5005"), key);
  const context: Context = { mode: AgentMode.RETURN_BYTES, accountId: "0.0.5005", hooks: [new OrdoWorkOrderPolicy(check as never)] };
  const configuration = { plugins: [ordoWorkOrdersPlugin(CONTRACT)], context };
  return new HederaAgentAPI(client, context, ToolDiscovery.createFromConfiguration(configuration).getAllTools(context, configuration));
}

describe("Ordo's Hedera Agent Kit plugin", () => {
  it("exposes the escrow tool to agents", () => {
    expect(api(async () => null).listTools()).toEqual([expect.objectContaining({ method: ESCROW_TOOL, toolType: "transaction" })]);
  });

  it("builds OrdoWorkOrders.escrow as a contract call signed by the agent's account", async () => {
    const out = JSON.parse(await api(async () => null).run(ESCROW_TOOL, params));
    // RETURN_BYTES result: the frozen bytes plus who pays and signs
    expect(out).toMatchObject({ status: "SUCCESS", payerAccountId: "0.0.5005", type: "ContractExecuteTransaction" });
    const tx = Transaction.fromBytes(Uint8Array.from(out.bytes.data as number[])) as ContractExecuteTransaction; // a JSON-serialised Buffer
    expect(tx).toBeInstanceOf(ContractExecuteTransaction);
    expect(tx.transactionId?.accountId?.toString()).toBe("0.0.5005");
    const call = decodeFunctionData({ abi: ORDO_WORK_ORDERS_ABI, data: `0x${Buffer.from(tx.functionParameters!).toString("hex")}` });
    expect(call.functionName).toBe("escrow");
    expect(call.args).toEqual(["site_1", "wo_1", VENDOR, 400000000n, 259200n, params.incidentHash]);
  });

  it("the Ordo policy blocks an escrow Ordo did not open, before any transaction is built", async () => {
    const out = JSON.parse(await api(async (p) => (p.workOrderId === "wo_1" ? "amount 400000000 differs from the agreed 100" : null)).run(ESCROW_TOOL, params));
    expect(out.raw.status).toBe("ERROR");
    expect(out.humanMessage).toMatch(/Blocked by Ordo work order policy: amount 400000000 differs/);
  });

  it("rejects malformed parameters", async () => {
    const out = JSON.parse(await api(async () => null).run(ESCROW_TOOL, { ...params, vendor: "not-an-address" }));
    expect(out.raw.status).toBe("ERROR");
  });
});
