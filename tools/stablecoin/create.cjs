/**
 * Creates Ordo USD (OUSD) with Stablecoin Studio's SDK on Hedera testnet, through Stablecoin Studio's own factory:
 *   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=<ecdsa hex> node tools/stablecoin/create.cjs
 * The operator gets every role (cash-in without limit, burn, wipe, rescue, pause, freeze, delete, hold creator) and owns
 * the proxy; the token's freeze, wipe, pause and supply keys are the stablecoin contract's, so holds work. No KYC.
 * The factory is STABLECOIN_FACTORY_ID (default: Stablecoin Studio's testnet factory); its resolver and the latest
 * stablecoin configuration version are read from the chain. Prints only public values.
 */
const sdk = require("@hashgraph/stablecoin-npm-sdk");
const { ethers } = require("ethers");

const MIRROR = (process.env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const RPC = process.env.TRUST_RPC_URL || "https://testnet.hashio.io/api";
const FACTORY = process.env.STABLECOIN_FACTORY_ID || "0.0.7353542";
const STABLECOIN_CONFIG = "0x0000000000000000000000000000000000000000000000000000000000000002";
const opId = process.env.HEDERA_OPERATOR_ID;
const opKey = (process.env.HEDERA_OPERATOR_KEY || "").trim().replace(/^0x/, "");
if (!opId || !opKey) throw new Error("Needs HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY");
if (opKey.startsWith("302")) throw new Error("Stablecoin Studio needs the operator key in hex, not DER");

const mirror = async (path) => {
  const r = await fetch(`${MIRROR}/api/v1/${path}`);
  if (!r.ok) throw new Error(`mirror ${path}: ${r.status}`);
  return r.json();
};
const longZero = (id) => `0x${BigInt(id.split(".")[2]).toString(16).padStart(40, "0")}`;

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const factory = await mirror(`contracts/${FACTORY}`);
  const [resolverEvm] = await new ethers.Contract(factory.evm_address, ["function getConfigInfo() view returns (address, bytes32, uint256)"], provider).getConfigInfo();
  const resolver = await mirror(`contracts/${resolverEvm}`);
  const version = await new ethers.Contract(resolverEvm, ["function getLatestVersionByConfiguration(bytes32) view returns (uint256)"], provider).getLatestVersionByConfiguration(STABLECOIN_CONFIG);
  console.log(`Stablecoin Studio factory ${FACTORY} (${factory.evm_address}), resolver ${resolver.contract_id}, stablecoin configuration v${version}`);

  const mirrorNode = { name: "testnet", baseUrl: `${MIRROR}/api/v1/` };
  const rpcNode = { name: "hashio", baseUrl: RPC };
  await sdk.Network.init(new sdk.InitializationRequest({ network: "testnet", mirrorNode, rpcNode, configuration: { factoryAddress: FACTORY, resolverAddress: resolver.contract_id } }));
  await sdk.Network.connect(new sdk.ConnectRequest({ account: { accountId: opId, privateKey: { key: opKey, type: "ECDSA" } }, network: "testnet", mirrorNode, rpcNode, wallet: sdk.SupportedWallets.CLIENT }));

  const contractKey = sdk.Account.NullPublicKey; // the key is the stablecoin contract's
  const { coin } = await sdk.StableCoin.create(
    new sdk.CreateRequest({
      name: "Ordo USD",
      symbol: "OUSD",
      decimals: 6,
      initialSupply: "0",
      supplyType: sdk.TokenSupplyType.INFINITE,
      createReserve: false,
      freezeKey: contractKey,
      wipeKey: contractKey,
      pauseKey: contractKey,
      freezeDefault: false,
      grantKYCToOriginalSender: false,
      burnRoleAccount: opId,
      wipeRoleAccount: opId,
      rescueRoleAccount: opId,
      pauseRoleAccount: opId,
      freezeRoleAccount: opId,
      deleteRoleAccount: opId,
      cashInRoleAccount: opId,
      cashInRoleAllowance: "0", // unlimited
      holdCreatorRoleAccount: opId,
      proxyOwnerAccount: opId,
      metadata: "Ordo USD: lots paid on proof of quality",
      configId: STABLECOIN_CONFIG,
      configVersion: Number(version),
    }),
  );
  const tokenId = coin.tokenId.toString();
  let proxy = coin.evmProxyAddress ? coin.evmProxyAddress.toString() : null;
  if (!proxy && coin.proxyAddress) proxy = (await mirror(`contracts/${coin.proxyAddress.toString()}`)).evm_address;
  if (!proxy) throw new Error(`Created ${tokenId}, but the SDK did not report its proxy`);
  const token = await new ethers.Contract(proxy, ["function getTokenAddress() view returns (address)"], provider).getTokenAddress().catch(() => longZero(tokenId));
  console.log(`Ordo USD created with Stablecoin Studio: token ${tokenId} https://hashscan.io/testnet/token/${tokenId}
Stablecoin proxy ${proxy}${coin.proxyAddress ? ` (${coin.proxyAddress})` : ""}

# ---- set in Vercel (Production and Preview) ----
STABLECOIN_ADDRESS=${proxy}
STABLECOIN_TOKEN_ADDRESS=${token}
STABLECOIN_TOKEN_ID=${tokenId}
`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
