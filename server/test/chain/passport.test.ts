import { TokenAirdropTransaction, TokenMintTransaction, TokenUpdateNftsTransaction } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { MAX_METADATA, passportTx, receiver } from "../../src/chain/passport.js";

/** The HTS transactions a lot passport sends, built offline. */
describe("lot passport HTS transactions", () => {
  const url = "https://aiwarriors.vercel.app/v1/public/passports/run_0123456789ab";

  it("mints one NFT whose metadata is the passport's URL", () => {
    const tx = passportTx.mint("0.0.9001", url);
    expect(tx).toBeInstanceOf(TokenMintTransaction);
    expect(tx.tokenId?.toString()).toBe("0.0.9001");
    expect(tx.metadata.map((m) => Buffer.from(m).toString())).toEqual([url]);
  });

  it("updates one serial's metadata when the lot's status moves on", () => {
    const tx = passportTx.update("0.0.9001", 7, `${url}?s=held`);
    expect(tx).toBeInstanceOf(TokenUpdateNftsTransaction);
    // no public getters: read the body the transaction would send
    const body = (tx as unknown as { _makeTransactionData(): { token: { tokenNum: unknown }; serialNumbers: unknown[]; metadata: { value: Uint8Array } } })._makeTransactionData();
    expect(body.serialNumbers.map(Number)).toEqual([7]);
    expect(Buffer.from(body.metadata.value).toString()).toBe(`${url}?s=held`);
  });

  it("airdrops the NFT from the treasury to a Hedera account or an EVM address", () => {
    const tx = passportTx.ship("0.0.9001", 7, "0.0.2", "0.0.4242");
    expect(tx).toBeInstanceOf(TokenAirdropTransaction);
    const nft = tx.nftTransfers.get("0.0.9001")![0]! as unknown as { sender: object; recipient: object; serial: unknown };
    expect([Number(nft.serial), nft.sender.toString(), nft.recipient.toString()]).toEqual([7, "0.0.2", "0.0.4242"]);
    expect(receiver("0xab5801a7d398351b8be11c439e05c5b3259aec9b").evmAddress?.toString()).toBe("ab5801a7d398351b8be11c439e05c5b3259aec9b");
  });

  it("refuses metadata over the 100-byte HTS limit", () => {
    expect(() => passportTx.mint("0.0.9001", "x".repeat(MAX_METADATA + 1))).toThrow(/100/);
  });
});
