import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

/** anvil's first two well-known dev accounts */
export const ANVIL_KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"] as Hex[];

/** Foundry's anvil: an EVM that runs Cancun bytecode, which ganache cannot. CI installs it; locally see foundry.paradigm.xyz. */
export function anvilPath(): string | null {
  const candidates = [process.env.ANVIL_PATH, join(homedir(), ".foundry/bin/anvil"), ...(process.env.PATH ?? "").split(":").map((d) => join(d, "anvil"))];
  return candidates.find((p): p is string => Boolean(p && existsSync(p))) ?? null;
}

export async function startAnvil(): Promise<{ url: string; stop: () => void }> {
  const bin = anvilPath();
  if (!bin) throw new Error("anvil not found: install Foundry (curl -L https://foundry.paradigm.xyz | bash && foundryup) or set ANVIL_PATH");
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const proc: ChildProcess = spawn(bin, ["--port", String(port), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return { url, stop: () => proc.kill() };
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("anvil did not start");
}

export function deployer(url: string, key: Hex = ANVIL_KEYS[0]!) {
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: foundry, transport: http(url) });
  const wallet = createWalletClient({ chain: foundry, transport: http(url), account });
  const deploy = async (c: { abi: unknown; bytecode: string }, args: unknown[] = []): Promise<Address> =>
    (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: c.abi as Abi, bytecode: c.bytecode as Hex, args } as never) })).contractAddress!;
  return { account, pub, wallet, deploy };
}
