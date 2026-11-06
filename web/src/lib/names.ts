import type { Directory, DirectoryEntry, NameKind } from "../types";

/**
 * Every entity of the org by its ENS name (ENSv2 under ordo.eth): people by handle, machines, agents, lines, vendors,
 * runs, stages, budgets, work orders. Read from `/directory`, so a name shows wherever an id, address or account
 * appears, even before it is on-chain.
 */
export interface NameBook {
  live: boolean;
  /** the root all names sit under (ordo.eth) */
  root: string | null;
  /** the org's own name (acme.ordo.eth) */
  org: string | null;
  of(kind: NameKind, ref: string | null | undefined): DirectoryEntry | null;
  name(kind: NameKind, ref: string | null | undefined): string | null;
  byAddress(address: string | null | undefined): DirectoryEntry | null;
  byHedera(account: string | null | undefined): DirectoryEntry | null;
  /** the name an actor string goes by: "user:0x…", "agent:vision_qa", "system:treasury", "machine:CNC-07", "x402:0.0.123" */
  actor(actor: string): string | null;
  entries: DirectoryEntry[];
}

const AGENT_REF: Record<string, string> = { guard: "policy-guard" };
const rank: Partial<Record<NameKind, number>> = { person: 0, machine: 1, vendor: 2, agent: 3, treasury: 0, org: 5 };

export function nameBook(dir: Directory | null, assets: { id: string; name: string }[] = []): NameBook {
  const entries = (dir?.entries ?? []).filter((e) => e.status !== "revoked");
  const byKey = new Map(entries.map((e) => [`${e.kind}:${e.ref}`, e]));
  const byAddr = new Map<string, DirectoryEntry>();
  const byAcct = new Map<string, DirectoryEntry>();
  for (const e of [...entries].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9))) {
    if (e.address && !byAddr.has(e.address.toLowerCase())) byAddr.set(e.address.toLowerCase(), e);
    if (e.hedera && !byAcct.has(e.hedera)) byAcct.set(e.hedera, e);
  }
  const assetByName = new Map(assets.map((a) => [a.name, a.id]));
  const of = (kind: NameKind, ref: string | null | undefined) => (ref ? (byKey.get(`${kind}:${ref}`) ?? null) : null);
  const byAddress = (a: string | null | undefined) => (a ? (byAddr.get(a.toLowerCase()) ?? null) : null);
  const byHedera = (a: string | null | undefined) => (a ? (byAcct.get(a) ?? null) : null);
  return {
    live: Boolean(dir?.live),
    root: dir?.root ?? null,
    org: dir?.org ?? null,
    entries,
    of,
    name: (kind, ref) => of(kind, ref)?.name ?? null,
    byAddress,
    byHedera,
    actor(actor) {
      const i = actor.indexOf(":");
      const [kind, rest] = i < 0 ? [actor, ""] : [actor.slice(0, i), actor.slice(i + 1)];
      if (kind === "user" || kind === "device") return byAddress(rest)?.name ?? null;
      if (kind === "agent" || kind === "system") return of("agent", rest)?.name ?? of("agent", rest.replace(/_/g, "-"))?.name ?? null;
      if (AGENT_REF[kind]) return of("agent", AGENT_REF[kind])?.name ?? null;
      if (kind === "machine") return of("machine", assetByName.get(rest) ?? rest)?.name ?? null;
      if (kind === "x402") return byHedera(rest)?.name ?? byAddress(rest)?.name ?? null;
      return null;
    },
  };
}

/** A name split for display: the first label, then the rest up to the org, then the root (muted). */
export function splitName(name: string, root: string | null): { head: string; mid: string; root: string } {
  const r = root && name.endsWith(`.${root}`) ? `.${root}` : "";
  const body = r ? name.slice(0, -r.length) : name;
  const dot = body.indexOf(".");
  return dot < 0 ? { head: body, mid: "", root: r } : { head: body.slice(0, dot), mid: body.slice(dot), root: r };
}

export const ensAppUrl = (name: string) => `https://sepolia.app.ens.domains/${name}`;
export const isEnsName = (s: string) => /^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(s.trim()) && s.includes(".") && !/^0\.0\.\d+$/.test(s.trim());
