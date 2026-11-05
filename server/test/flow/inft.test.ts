import { keccak256, toBytes, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentNftChain } from "../../src/chain/inft.js";
import { ORDO_AGENT_NFT_ABI, ORDO_AGENT_NFT_BYTECODE } from "../../src/chain/ordo-agent-nft-abi.js";
import { AGENTS } from "../../src/domain/types.js";
import { ANVIL_KEYS, anvilPath, deployer, startAnvil } from "../fixtures/anvil.js";
import { boot, enlist, wallet, type Client, type System } from "./helpers.js";

/** Agents as ERC-7857 iNFTs on the real contract (anvil: it is compiled for Cancun, as 0G Galileo runs). */
const run = anvilPath() || process.env.CI ? describe : describe.skip;

run("agent iNFTs", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let admin: Client;
  let pm: Client;
  let chain: AgentNftChain;
  let contract: Address;
  let site = "";
  const S = () => `/v1/sites/${site}`;
  const settle = async () => {
    for (let i = 0; i < 40 && (await sys.agentNfts.reconcile(5)) > 0; i++);
  };

  beforeAll(async () => {
    anvil = await startAnvil();
    const d = deployer(anvil.url);
    contract = await d.deploy({ abi: ORDO_AGENT_NFT_ABI, bytecode: ORDO_AGENT_NFT_BYTECODE }, [d.account.address]);
    ({ sys, app } = await boot({ ZG_INFT_ADDRESS: contract, ZG_PRIVATE_KEY: ANVIL_KEYS[0]!, ZG_RPC_URL: anvil.url, ZG_CHAIN_ID: "31337" }));
    chain = new AgentNftChain({ rpcUrl: anvil.url, chainId: 31337, address: contract, key: ANVIL_KEYS[0]! });
    admin = await wallet(app, generatePrivateKey());
    pm = await wallet(app, generatePrivateKey());
    site = (await admin.call("POST", "/v1/sites", { name: "Agent Plant", timezone: "UTC", lineName: "Line 1", zones: [] })).json.id;
  }, 60_000);
  afterAll(async () => {
    await sys?.close();
    anvil?.stop();
  });

  it("mints each agent with its policy, model, autonomy and scope, and authorizes the managers", async () => {
    await settle();
    const agents = (await admin.call("GET", `${S()}/agents`)).json;
    expect(agents).toHaveLength(AGENTS.length);
    const m = agents.find((a: any) => a.key === "maintenance").inft;
    expect(m).toMatchObject({ status: "synced", contract, authorizedUsers: [admin.address] });
    expect(m.data.map((x: any) => x.dataDescription)).toEqual(["policy:ordo-guard", "model:offline", "autonomy:Line 1=L2", expect.stringMatching(/^scope:/)]);
    expect(m.data[0].dataHash).toBe(`0x${sys.policy.hash.replace("sha256:", "")}`);

    const onchain = await chain.datas(m.tokenId);
    expect(onchain.map((x) => x.dataHash)).toEqual(m.data.map((x: any) => x.dataHash));
    expect((await chain.authorizedUsers(m.tokenId)).map((a) => a.toLowerCase())).toEqual([admin.address]);
    expect(await chain.tokenOf(`${site}/maintenance`)).toBe(m.tokenId);
    expect((await admin.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "agent iNFTs")).toMatchObject({ live: true });
  }, 120_000);

  it("updates the token when autonomy changes, and follows the managers", async () => {
    const lineId = (await admin.call("GET", `${S()}`)).json.lines[0].id;
    await sys.plant.setAutonomy(site, lineId, "L3");
    await enlist(admin, S(), pm, "manager");
    await settle();
    const m = (await admin.call("GET", `${S()}/agents`)).json.find((a: any) => a.key === "maintenance").inft;
    expect(m.status).toBe("synced");
    expect((await chain.datas(m.tokenId))[2]).toMatchObject({ dataDescription: "autonomy:Line 1=L3", dataHash: keccak256(toBytes("autonomy:Line 1=L3")) });
    expect((await chain.authorizedUsers(m.tokenId)).map((a) => a.toLowerCase()).sort()).toEqual([admin.address, pm.address].sort());
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.some((d: any) => d.kind === "agent.inft_updated" && /autonomy/.test(d.summary))).toBe(true);
  }, 120_000);

  it("keeps tokens the current contract has, and mints again those from an earlier contract", async () => {
    const before = (await admin.call("GET", `${S()}/agents`)).json;
    const tokenOf = (list: any[], k: string) => list.find((a: any) => a.key === k).inft.tokenId;
    await sys.db.query("UPDATE agent_nfts SET contract = NULL WHERE site_id = $1 AND agent = 'planning'", [site]);
    await sys.db.query("UPDATE agent_nfts SET contract = '0x0000000000000000000000000000000000000001' WHERE site_id = $1 AND agent = 'supply'", [site]);
    await settle();
    const after = (await admin.call("GET", `${S()}/agents`)).json;
    expect(tokenOf(after, "planning")).toBe(tokenOf(before, "planning"));
    // forgotten and queued to mint again (this test reuses one contract, which still holds the name, so it stays unminted)
    expect(after.find((a: any) => a.key === "supply").inft).toMatchObject({ tokenId: null, error: expect.stringMatching(/AgentExists/) });
  }, 120_000);

  it("keeps agents with their site: tokens do not transfer", async () => {
    const d = deployer(anvil.url);
    await expect(
      d.pub.simulateContract({ address: contract, abi: ORDO_AGENT_NFT_ABI, functionName: "transferFrom", args: [d.account.address, privateKeyToAccount(ANVIL_KEYS[1]!).address, 1n], account: d.account }),
    ).rejects.toThrow(/NotTransferable/);
  });
});
