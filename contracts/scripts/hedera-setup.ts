/**
 * Creates Ordo's Hedera testnet resources with the operator account. Run from the "Hedera setup" workflow
 * (.github/workflows/hedera-setup.yml), or locally:
 *
 *   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=0x… pnpm --filter @ordo/contracts setup:hedera topic
 *   … setup:hedera agent        SECRET_OUT=<file> receives HEDERA_AGENT_KEY; the key is never printed
 *   … setup:hedera contracts    TRUST_CONTRACT_ADDRESS=0x… (OrdoTrust) is required
 *   … setup:hedera passport     the HTS NFT collection for lot passports
 *   … setup:hedera fund 0x… 25  sends HBAR from the operator to a wallet (an EVM address; Hedera opens its account on first use)
 *   … setup:hedera check 0x… site_… 10  read-only: why a wallet's stake would fail (balance, account, credential, a simulated stake)
 *   … setup:hedera payonproof   OrdoPayOnProof: needs STABLECOIN_ADDRESS and STABLECOIN_TOKEN_ADDRESS (Ordo USD, made with
 *                               Stablecoin Studio by tools/stablecoin/create.cjs) and TRUST_CONTRACT_ADDRESS
 *   … setup:hedera treasury     OrdoTreasury against TRUST_CONTRACT_ADDRESS (run budgets and top-ups, HIP-755)
 *   … setup:hedera treasury site_… 50   an org's treasury: opens its key contract in OrdoTreasury
 *                               (TREASURY_CONTRACT_ADDRESS), creates a Hedera account whose key is that contract and
 *                               funds it with 50 HBAR from the operator; link it in Finance → Machine budgets
 *
 * Prints only public values: the variables to set in Vercel.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AccountCreateTransaction, AccountId, Client, ContractId, Hbar, PrivateKey, TransferTransaction, TokenCreateTransaction, TokenSupplyType, TokenType, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatUnits, http, parseAbi, parseUnits, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { need } from "./env.js";

const parseKey = (k: string) => (k.trim().startsWith("302") ? PrivateKey.fromStringDer(k.trim()) : PrivateKey.fromStringECDSA(k.trim().replace(/^0x/, "")));
const operatorId = need("HEDERA_OPERATOR_ID");
const operatorKey = parseKey(need("HEDERA_OPERATOR_KEY"));
const task = process.argv[2];

if (task === "fund") {
  const to = process.argv[3] ?? "";
  const hbar = Number(process.argv[4] ?? 25);
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error(`fund: "${to}" is not an EVM address`);
  // a typo should not drain the operator: testnet wallets need tens of HBAR, not thousands
  if (!(hbar > 0 && hbar <= 100)) throw new Error(`fund: send between 0 and 100 HBAR, not ${process.argv[4]}`);
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  const tx = await new TransferTransaction()
    .addHbarTransfer(operatorId, new Hbar(-hbar))
    .addHbarTransfer(AccountId.fromEvmAddress(0, 0, to), new Hbar(hbar))
    .setTransactionMemo("ordo:fund")
    .execute(client);
  const receipt = await tx.getReceipt(client);
  client.close();
  console.log(`Sent ${hbar} HBAR to ${to}: ${receipt.status.toString()}
Transaction: https://hashscan.io/testnet/transaction/${tx.transactionId.toString()}
Wallet: https://hashscan.io/testnet/account/${to}
`);
} else if (task === "check") {
  const [who, site, amount = "10"] = process.argv.slice(3) as [Hex, string, string?];
  const trust = (process.env.TRUST_CONTRACT_ADDRESS ?? "0xbb744b4a87aef7996537f5583e71ec14e093ffc0") as Hex;
  const rpc = process.env.TRUST_RPC_URL ?? "https://testnet.hashio.io/api";
  const pub = createPublicClient({ transport: http(rpc) });
  const acct = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${who}`).then((r) => (r.ok ? r.json() : null));
  console.log(`mirror: account ${acct?.account ?? "none"} · ${acct ? (Number(acct.balance.balance) / 1e8).toFixed(4) : "?"} HBAR · key ${acct?.key?._type ?? "none (hollow until it pays for a transaction)"} · ethereum nonce ${acct?.ethereum_nonce ?? "?"}`);
  console.log(`rpc: balance ${formatUnits(await pub.getBalance({ address: who }), 18)} HBAR · gas price ${formatUnits(await pub.getGasPrice(), 9)} gwei · nonce ${await pub.getTransactionCount({ address: who })}`);
  const abi = parseAbi(["function minStake() view returns (uint256)", "function hasRole(string,address,uint8) view returns (bool)", "function isActiveValidator(string,address) view returns (bool)", "function stakes(bytes32,address) view returns (uint256,uint64)", "function siteKey(string) pure returns (bytes32)", "function sites(bytes32) view returns (bool,address)", "function stake(string) payable"]);
  const read = (functionName: string, args: unknown[] = []) => pub.readContract({ address: trust, abi, functionName, args } as never).catch((e: Error) => `error: ${e.message.split("\n")[0]}`);
  const key = (await read("siteKey", [site])) as Hex;
  console.log(`OrdoTrust ${trust}: minStake ${String(await read("minStake"))} (tinybars) · site registered ${JSON.stringify(await read("sites", [key]), (_k, v) => (typeof v === "bigint" ? v.toString() : v))} · VALIDATOR ${await read("hasRole", [site, who, 4])} · active ${await read("isActiveValidator", [site, who])} · stake ${JSON.stringify(await read("stakes", [key, who]), (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  // the same call the wallet makes: value in 18-decimal units, as wallets send it to the relay
  const data = encodeFunctionData({ abi, functionName: "stake", args: [site] });
  for (const [label, value] of [[`${amount} HBAR`, parseUnits(amount, 18)]] as const) {
    const gas = await pub.estimateGas({ account: who, to: trust, data, value }).then(String).catch((e: Error & { details?: string }) => `error: ${e.details ?? e.message.split("\n")[0]}`);
    console.log(`estimateGas stake(${site}) with ${label}: ${gas}`);
    const raw = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: who, to: trust, data, value: `0x${value.toString(16)}` }, "latest"] }) });
    console.log(`eth_call stake: HTTP ${raw.status} ${(await raw.text()).slice(0, 400)}`);
  }
} else if (task === "topic") {
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  const tx = await new TopicCreateTransaction().setTopicMemo("ordo:ledger:v2").setSubmitKey(operatorKey.publicKey).setAdminKey(operatorKey.publicKey).execute(client);
  const id = (await tx.getReceipt(client)).topicId!.toString();
  client.close();
  console.log(`Ledger topic created: https://hashscan.io/testnet/topic/${id}

# ---- set in Vercel (Production and Preview) ----
ANCHOR=hedera
HEDERA_NETWORK=testnet
HEDERA_TOPIC_ID=${id}
`);
} else if (task === "agent") {
  const out = need("SECRET_OUT");
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  const key = PrivateKey.generateECDSA();
  const hbar = Number(process.env.AGENT_HBAR ?? 20);
  const tx = await new AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(new Hbar(hbar)).setAccountMemo("ordo:maintenance-agent").execute(client);
  const id = (await tx.getReceipt(client)).accountId!.toString();
  client.close();
  writeFileSync(out, `HEDERA_AGENT_KEY=0x${key.toStringRaw()}\n`, { mode: 0o600 });
  console.log(`Maintenance agent account created with ${hbar} HBAR: https://hashscan.io/testnet/account/${id}
Its EVM address (give it caps in Ordo): ${privateKeyToAccount(`0x${key.toStringRaw()}`).address}

# ---- set in Vercel (Production and Preview); HEDERA_AGENT_KEY was written to ${out} ----
HEDERA_AGENT_ID=${id}
`);
} else if (task === "contracts") {
  const trust = need("TRUST_CONTRACT_ADDRESS") as Hex;
  const rpc = process.env.TRUST_RPC_URL ?? "https://testnet.hashio.io/api";
  const chainId = Number(process.env.TRUST_CHAIN_ID ?? 296);
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(`0x${operatorKey.toStringRaw()}`);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  const deployed: Record<string, Hex> = {};
  for (const name of ["OrdoWorkOrders", "OrdoPolicies"]) {
    const { abi, bytecode } = JSON.parse(readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
    const hash = await wallet.deployContract({ abi, bytecode, args: [trust], gas: 4_000_000n } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
    deployed[name] = r.contractAddress;
    console.log(`${name} deployed at ${r.contractAddress} (tx ${hash})`);
  }
  console.log(`
# ---- set in Vercel (Production and Preview) ----
TRUST_WORKORDERS_ADDRESS=${deployed.OrdoWorkOrders}
TRUST_POLICIES_ADDRESS=${deployed.OrdoPolicies}
`);
} else if (task === "payonproof") {
  const [coin, trust] = [need("STABLECOIN_ADDRESS") as Hex, need("TRUST_CONTRACT_ADDRESS") as Hex];
  const rpc = process.env.TRUST_RPC_URL ?? "https://testnet.hashio.io/api";
  const chainId = Number(process.env.TRUST_CHAIN_ID ?? 296);
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(`0x${operatorKey.toStringRaw()}`);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  // the stablecoin's HTS token, read from its proxy when not given
  const token = (process.env.STABLECOIN_TOKEN_ADDRESS ||
    (await pub.readContract({ address: coin, abi: parseAbi(["function getTokenAddress() view returns (address)"]), functionName: "getTokenAddress" }))) as Hex;
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  const { abi, bytecode } = JSON.parse(readFileSync(new URL("../artifacts/OrdoPayOnProof.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
  const hash = await wallet.deployContract({ abi, bytecode, args: [coin, token, trust], gas: 3_000_000n } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`OrdoPayOnProof deploy failed: ${hash}`);
  console.log(`OrdoPayOnProof deployed at ${r.contractAddress} (tx ${hash}): https://hashscan.io/testnet/contract/${r.contractAddress}
It holds Ordo USD (${coin}) for a lot until OrdoTrust (${trust}) records its release.

# ---- set in Vercel (Production and Preview) ----
PAY_ON_PROOF_ADDRESS=${r.contractAddress}
`);
} else if (task === "passport") {
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  // The operator is treasury, mints (supply key) and updates metadata as the lot moves on (metadata key, HIP-657).
  const tx = await new TokenCreateTransaction()
    .setTokenName("Ordo Lot Passport")
    .setTokenSymbol("ORDOLOT")
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setTreasuryAccountId(operatorId)
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .setMetadataKey(operatorKey.publicKey)
    .setTokenMemo("One NFT per production lot: its passport, from Ordo")
    .execute(client);
  const id = (await tx.getReceipt(client)).tokenId!.toString();
  client.close();
  console.log(`Lot passport collection created: https://hashscan.io/testnet/token/${id}

# ---- set in Vercel (Production and Preview) ----
HEDERA_PASSPORT_TOKEN_ID=${id}
PUBLIC_URL=<the deployment's public URL, e.g. https://aiwarriors.vercel.app>
`);
} else if (task === "treasury") {
  const rpc = process.env.TRUST_RPC_URL ?? "https://testnet.hashio.io/api";
  const chainId = Number(process.env.TRUST_CHAIN_ID ?? 296);
  const mirror = (process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(`0x${operatorKey.toStringRaw()}`);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account });
  const { abi, bytecode } = JSON.parse(readFileSync(new URL("../artifacts/OrdoTreasury.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
  const [site, hbarArg] = process.argv.slice(3);
  if (!site) {
    const trust = need("TRUST_CONTRACT_ADDRESS") as Hex;
    // an explicit gas price: the relay's fee estimate is sometimes below its own minimum
    const hash = await wallet.deployContract({ abi, bytecode, args: [trust], gas: 3_000_000n, gasPrice: await pub.getGasPrice() } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`OrdoTreasury deploy failed: ${hash}`);
    console.log(`OrdoTreasury deployed at ${r.contractAddress} (tx ${hash}): https://hashscan.io/testnet/contract/${r.contractAddress}
It approves each org's run budgets and top-ups against OrdoTrust (${trust}) admins.

# ---- set in server/.env and the host's environment ----
TREASURY_CONTRACT_ADDRESS=${r.contractAddress}
`);
  } else {
    const treasury = need("TREASURY_CONTRACT_ADDRESS") as Hex;
    const hbar = Number(hbarArg ?? 50);
    if (!(hbar >= 0 && hbar <= 500)) throw new Error(`treasury: fund it with 0 to 500 HBAR, not ${hbarArg}`);
    // the org's key contract: anyone may open it once the org is registered in OrdoTrust
    const hash = await wallet.writeContract({ address: treasury, abi, functionName: "openSite", args: [site], gas: 600_000n, gasPrice: await pub.getGasPrice() } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`openSite failed (is ${site} registered in OrdoTrust?): ${hash}`);
    const key = (await pub.readContract({ address: treasury, abi, functionName: "keyOf", args: [await pub.readContract({ address: treasury, abi, functionName: "siteKey", args: [site] })] } as never)) as Hex;
    let contractId: string | null = null;
    for (let i = 0; i < 20 && !contractId; i++) {
      const res = await fetch(`${mirror}/api/v1/contracts/${key}`);
      if (res.ok) contractId = ((await res.json()) as { contract_id: string }).contract_id;
      else await new Promise((ok) => setTimeout(ok, 3000));
    }
    if (!contractId) throw new Error(`The mirror node does not know ${key} yet; run this again in a minute`);
    const client = Client.forName(process.env.HEDERA_NETWORK ?? "testnet").setOperator(operatorId, operatorKey);
    const tx = await new AccountCreateTransaction().setKey(ContractId.fromString(contractId)).setInitialBalance(new Hbar(hbar)).setAccountMemo(`ordo:treasury:${site}`.slice(0, 100)).execute(client);
    const id = (await tx.getReceipt(client)).accountId!.toString();
    client.close();
    console.log(`${site}'s treasury: https://hashscan.io/testnet/account/${id} with ${hbar} HBAR
Its key is the contract ${contractId} (OrdoTreasuryKey ${key}): only OrdoTreasury can sign for it, and only for a
schedule one of the org's managers approved. Anyone can fund it.

Link it in the console (Finance → Machine budgets → Link treasury): ${id}
`);
  }
} else {
  console.error("usage: hedera-setup.ts topic | agent | contracts | passport | payonproof | treasury [site amount]");
  process.exit(1);
}
