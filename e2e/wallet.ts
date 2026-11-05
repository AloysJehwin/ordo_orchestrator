import type { Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Injects a browser wallet into the page: an EIP-1193 provider announced through EIP-6963.
 * Signing happens in the test process with a real secp256k1 key, so the server verifies
 * genuine SIWE and EIP-712 signatures.
 */
export async function injectWallet(page: Page, key = generatePrivateKey(), other = generatePrivateKey()) {
  // the wallet holds two accounts; its account picker (wallet_requestPermissions) moves to the other one
  const accounts = [privateKeyToAccount(key), privateKeyToAccount(other)];
  let account = accounts[0]!;
  const picks = { count: 0 };
  await page.exposeFunction("__ordoWallet", async (method: string, params: unknown[]) => {
    switch (method) {
      case "wallet_requestPermissions":
        picks.count++;
        account = accounts[picks.count % 2]!;
        return [{ parentCapability: "eth_accounts" }];
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return "0x128";
      case "personal_sign":
        return account.signMessage({ message: { raw: params[0] as `0x${string}` } });
      case "eth_signTypedData_v4": {
        const typed = JSON.parse(params[1] as string);
        delete typed.types.EIP712Domain;
        // like a real wallet, take uint fields as decimal strings
        for (const f of typed.types[typed.primaryType] ?? []) if (/^uint/.test(f.type) && typeof typed.message[f.name] !== "bigint") typed.message[f.name] = BigInt(typed.message[f.name]);
        return account.signTypedData(typed);
      }
      default:
        throw new Error(`test wallet: unsupported ${method}`);
    }
  });
  await page.addInitScript(() => {
    const provider = {
      request: ({ method, params }: { method: string; params?: unknown[] }) => (window as unknown as { __ordoWallet: (m: string, p: unknown[]) => Promise<unknown> }).__ordoWallet(method, params ?? []),
      on: () => undefined,
      removeListener: () => undefined,
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info: { uuid: "test-wallet", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "dev.ordo.test" }, provider }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  return { address: accounts[0]!.address.toLowerCase(), key, otherAddress: accounts[1]!.address.toLowerCase(), picks };
}
