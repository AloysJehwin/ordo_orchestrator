import { readFileSync } from "node:fs";
import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, toHex, parseEther, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  return JSON.parse(readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8"));
}

export async function chain() {
  // Fixed test keys, signed locally (viem sends raw transactions).
  const keys = Array.from({ length: 8 }, (_, i) => toHex(BigInt(i + 1) * 0x1111111111111111111111111111111111111111111111111111111111n, { size: 32 }));
  const signers = keys.map((k) => privateKeyToAccount(k));
  const provider = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: 31337 },
    wallet: { accounts: keys.map((secretKey) => ({ secretKey, balance: toHex(parseEther("1000")) })) },
  });
  const transport = custom(provider as never);
  const pub = createPublicClient({ chain: foundry, transport });
  const accounts = signers.map((s) => s.address) as Address[];
  const wallet = (i: number) => createWalletClient({ chain: foundry, transport, account: signers[i]! });
  const deploy = async (name: string, args: unknown[], from = 0, value?: bigint) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(from).deployContract({ abi, bytecode, args, value } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    return { address: r.contractAddress!, abi };
  };
  const increaseTime = async (s: number) => {
    await provider.request({ method: "evm_increaseTime", params: [s] });
    await provider.request({ method: "evm_mine", params: [] });
  };
  return { pub, wallet, accounts, deploy, increaseTime };
}
