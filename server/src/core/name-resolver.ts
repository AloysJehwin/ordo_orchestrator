/**
 * Names where people type addresses: a ship-to, an invite, a vendor's wallet, a treasury link. A name resolves
 * through Ordo's own names first (instant, before they are on-chain), otherwise through ENS's Universal Resolver on
 * Sepolia: its Hedera record (ENSIP-11, coin type 2147483944 on testnet), read as an account (a long-zero address is
 * the account itself; any other EVM address is looked up on the mirror node), else its addr(60). Addresses and
 * accounts typed as they are resolve to the name Ordo knows them by.
 */
import type { Address, Hex } from "viem";
import { hederaAccountOf, type EnsV2 } from "../chain/ensv2.js";
import { HttpError } from "../engine/errors.js";
import { hederaCoin, isEnsName } from "./name-scheme.js";
import type { NameKind, Names } from "./names.js";

export interface Resolved {
  query: string;
  /** the name, when there is one */
  name: string | null;
  /** what it names in this org, when it is one of Ordo's */
  kind: NameKind | null;
  ref: string | null;
  address: Address | null;
  hedera: string | null;
  source: "ordo" | "ens" | "address" | "account";
}

export class NameResolver {
  constructor(
    private names: Names,
    private rail: Pick<EnsV2, "resolveName"> | null,
    private mirrorUrl: string,
    private hederaNetwork?: string,
  ) {}

  async resolve(siteId: string, q: string): Promise<Resolved> {
    const query = q.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(query)) {
      const address = query.toLowerCase() as Address;
      const name = (await this.names.byAddress(siteId)).get(address) ?? null;
      const hit = name ? await this.names.lookup(name) : null;
      return { query, name, kind: hit?.kind ?? null, ref: hit?.ref ?? null, address, hedera: hit?.hedera ?? null, source: "address" };
    }
    if (/^0\.0\.\d+$/.test(query)) {
      const name = (await this.names.byHedera(siteId)).get(query) ?? null;
      const hit = name ? await this.names.lookup(name) : null;
      return { query, name, kind: hit?.kind ?? null, ref: hit?.ref ?? null, address: (hit?.address as Address | null) ?? null, hedera: query, source: "account" };
    }
    const name = query.toLowerCase();
    if (!isEnsName(name)) throw new HttpError(400, "Enter an ENS name (priya.acme.ordo.eth), a 0x address or a Hedera account (0.0.1234)");
    const own = await this.names.lookup(name);
    if (own && own.siteId === siteId && own.status !== "revoked") return { query, name, kind: own.kind, ref: own.ref, address: (own.address as Address | null) ?? null, hedera: own.hedera, source: "ordo" };
    if (!this.rail) throw new HttpError(404, `${name} is not a name in this org, and ENS is not configured to look it up`);
    const r = await this.rail.resolveName(name, hederaCoin(this.hederaNetwork)).catch(() => null);
    if (!r || (!r.addr && !r.coin)) throw new HttpError(404, `${name} does not resolve to an address`);
    return { query, name, kind: null, ref: null, address: r.addr, hedera: r.coin ? await this.account(r.coin) : null, source: "ens" };
  }

  /** The Hedera account an ENSIP-11 record stands for. */
  private async account(coin: Hex): Promise<string | null> {
    const long = hederaAccountOf(coin);
    if (long) return long;
    if (!/^0x[0-9a-fA-F]{40}$/.test(coin)) return null;
    const res = await fetch(`${this.mirrorUrl}/api/v1/accounts/${coin}`).catch(() => null);
    if (!res?.ok) return null;
    const j = (await res.json().catch(() => null)) as { account?: string } | null;
    return j?.account ?? null;
  }

  /**
   * An input that may be a name: the address it resolves to (for EVM fields), or the input as it was when it is
   * already an address.
   */
  async toAddress(siteId: string, q: string): Promise<Address> {
    const r = await this.resolve(siteId, q);
    if (!r.address) throw new HttpError(400, `${q} has no EVM address`);
    return r.address;
  }
  /** An input that may be a name: the Hedera account it resolves to, or the input when it is already one. */
  async toAccount(siteId: string, q: string): Promise<string> {
    const r = await this.resolve(siteId, q);
    if (!r.hedera) throw new HttpError(400, `${q} has no Hedera account`);
    return r.hedera;
  }
}
