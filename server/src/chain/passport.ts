/**
 * Lot passports as Hedera Token Service NFTs. One NFT per production lot, minted by the operator (treasury,
 * supply and metadata key). The metadata is a URL to the passport's HIP-412 JSON; when the lot is held, released,
 * completed or shipped the metadata is updated (HIP-657), so the NFT's history on HashScan follows the lot. Shipping
 * airdrops the NFT to the customer's account (HIP-904): delivered if associated, otherwise pending until claimed.
 */
import { AccountId, Client, NftId, TokenAirdropTransaction, TokenId, TokenMintTransaction, TokenUpdateNftsTransaction } from "@hiero-ledger/sdk";
import Long from "long";

/** HTS caps NFT metadata at 100 bytes. */
export const MAX_METADATA = 100;

export interface PassportRail {
  readonly kind: "hedera-hts";
  readonly tokenId: string;
  mint(metadata: string): Promise<{ serial: number; txId: string }>;
  update(serial: number, metadata: string): Promise<{ txId: string }>;
  ship(serial: number, to: string): Promise<{ txId: string; pending: boolean }>;
  nftUrl(serial: number): string;
  txUrl(txId: string): string;
}

const bytes = (metadata: string) => {
  const b = Buffer.from(metadata, "utf8");
  if (b.length > MAX_METADATA) throw new Error(`NFT metadata is ${b.length} bytes; HTS allows ${MAX_METADATA}`);
  return b;
};
/** "0.0.123" or an EVM address of an existing account. */
export const receiver = (to: string): AccountId => (/^0x[0-9a-fA-F]{40}$/.test(to) ? AccountId.fromEvmAddress(0, 0, to) : AccountId.fromString(to));

/** Unsigned, unfrozen transactions: what the rail sends, testable without a network. */
export const passportTx = {
  mint: (tokenId: string, metadata: string) => new TokenMintTransaction().setTokenId(TokenId.fromString(tokenId)).addMetadata(bytes(metadata)),
  update: (tokenId: string, serial: number, metadata: string) =>
    new TokenUpdateNftsTransaction().setTokenId(TokenId.fromString(tokenId)).setSerialNumbers([Long.fromNumber(serial)]).setMetadata(bytes(metadata)),
  ship: (tokenId: string, serial: number, treasury: string, to: string) =>
    new TokenAirdropTransaction().addNftTransfer(new NftId(TokenId.fromString(tokenId), serial), AccountId.fromString(treasury), receiver(to)),
};

export function hederaPassports(client: Client, network: string, tokenId: string): PassportRail {
  const treasury = client.operatorAccountId!.toString();
  const hashscan = `https://hashscan.io/${network}`;
  // 0.0.123@1700000000.000000000 → HashScan's 0.0.123-1700000000-000000000
  const txPath = (id: string) => id.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  return {
    kind: "hedera-hts",
    tokenId,
    async mint(metadata) {
      const tx = await passportTx.mint(tokenId, metadata).execute(client);
      const receipt = await tx.getReceipt(client);
      return { serial: Number(receipt.serials[0]!.toString()), txId: tx.transactionId.toString() };
    },
    async update(serial, metadata) {
      const tx = await passportTx.update(tokenId, serial, metadata).execute(client);
      await tx.getReceipt(client);
      return { txId: tx.transactionId.toString() };
    },
    async ship(serial, to) {
      const tx = await passportTx.ship(tokenId, serial, treasury, to).execute(client);
      const record = await tx.getRecord(client);
      return { txId: tx.transactionId.toString(), pending: record.newPendingAirdrops.length > 0 };
    },
    nftUrl: (serial) => `${hashscan}/token/${tokenId}/${serial}`,
    txUrl: (id) => `${hashscan}/transaction/${txPath(id)}`,
  };
}
