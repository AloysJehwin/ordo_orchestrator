/**
 * How Ordo names things under its ENSv2 root (ordo.eth):
 *
 *   <org>.<root>                                   org (own registry)
 *   <handle>.<org>.<root>                          a person, owned by their wallet
 *   <handle>.<role collection>.<org>.<root>        holding it is holding the role
 *   <label>.<collection>.<org>.<root>              machines, agents, lines, vendors, customers, financiers, pipelines, work orders
 *   treasury.<org>.<root>                          the org's treasury
 *   <run>.runs.<org>.<root>                        a run (own registry)
 *   <stage>.<run>.runs.<org>.<root>                its stages, its budget and its top-ups
 *
 * Labels are [a-z0-9-], at most 40 characters, and do not change once issued. Handles are chosen by people and are
 * public for good, so they are checked strictly; display names never go on-chain.
 */
import { toLabel } from "../chain/ensv2.js";
import type { AgentKey, MachineRole, Role } from "../domain/types.js";

export { toLabel };

/** ENSIP-11 coin types for Hedera's EVM chains: 0x80000000 | chain id (296 testnet, 295 mainnet). */
export const HEDERA_COIN_TESTNET = 2147483944;
export const HEDERA_COIN_MAINNET = 2147483943;
export const hederaCoin = (network: string | undefined) => (network === "mainnet" ? HEDERA_COIN_MAINNET : HEDERA_COIN_TESTNET);

/** The names an org holds others under. */
export const COLLECTIONS = ["managers", "validators", "testers", "contributors", "machines", "attesters", "buyers", "runners", "agents", "lines", "vendors", "customers", "financiers", "pipelines", "workorders", "runs"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const COLLECTION_LABEL: Record<Collection, string> = {
  managers: "Managers",
  validators: "Validators",
  testers: "Testers",
  contributors: "Contributors",
  machines: "Machines",
  attesters: "Machine attesters",
  buyers: "Machine buyers",
  runners: "Machine runners",
  agents: "Agents",
  lines: "Lines",
  vendors: "Vendors",
  customers: "Customers",
  financiers: "Financiers",
  pipelines: "Pipelines",
  workorders: "Work orders",
  runs: "Runs",
};

/** The registries OrdoNames keeps per org, which roles are read from (the numbers are OrdoNames' slot constants). */
export const SLOT = { org: 1, managers: 2, validators: 3, testers: 4, contributors: 5, machines: 6, vendors: 7, runs: 8, attesters: 9, buyers: 10, runners: 11 } as const;
export const slotOf = (c: Collection | "org"): number => (SLOT as Record<string, number>)[c] ?? 0;

/** Whose label a name is, for OrdoNames' account → name lookups (its member constants). */
export const MEMBER = { person: 1, machine: 2, supplier: 3 } as const;

/** Holding a name in this collection is holding the role. */
export const ROLE_COLLECTION: Record<Role, Collection> = { manager: "managers", validator: "validators", tester: "testers", contributor: "contributors" };
export const COLLECTION_ROLE: Partial<Record<Collection, Role>> = { managers: "manager", validators: "validator", testers: "tester", contributors: "contributor" };
/** A machine holds a role while its label is held in this collection (cnc-07.attesters.acme.ordo.eth). */
export const MACHINE_ROLE_COLLECTION: Record<MachineRole, Collection> = { attester: "attesters", buyer: "buyers", runner: "runners" };

/** The role bits OrdoNames gives for each name (OrdoTrust's bits). */
export const ROLE_BITS: Record<Role, number> = { manager: 31, validator: 4, tester: 128, contributor: 1 };
export const DEVICE_BIT = 64;
export const VENDOR_BIT = 32;

/** Ordo's own actors that act for an org and get a name under its agents collection, beside the eight line agents. */
export const SYSTEM_AGENTS = ["ens", "hedera", "relayer", "scheduler", "treasury", "passport", "anchor", "zk", "bodies", "pay-on-proof", "policy-guard", "0g"] as const;
export type SystemAgent = (typeof SYSTEM_AGENTS)[number];
export const agentLabel = (k: AgentKey | SystemAgent | string) => toLabel(k.replace(/_/g, "-"));
/** an actor string's agent label: "agent:vision_qa" → "vision-qa", "system:pay-on-proof" → "pay-on-proof", "guard:policy" → "policy-guard" */
export function actorAgent(actor: string): string | null {
  const [kind, rest] = [actor.slice(0, actor.indexOf(":")), actor.slice(actor.indexOf(":") + 1)];
  if (kind === "agent" || kind === "system") return rest ? agentLabel(rest) : null;
  if (kind === "guard") return "policy-guard";
  return null;
}

// ---------- Handles ----------

/** Words a handle cannot be: the collections, Ordo's own labels, and names people would mistake for Ordo. */
export const RESERVED = new Set<string>([...COLLECTIONS, "treasury", "org", "orgs", "ordo", "admin", "root", "system", "ens", "www", "api", "app", "eth", "support", "help", "security", "official", "null", "undefined"]);

const HANDLE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** Why a handle cannot be used, or null if it can (format and reserved words only; uniqueness is the caller's). */
export function handleProblem(h: string): string | null {
  if (!HANDLE.test(h)) return "3 to 32 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit";
  if (h.includes("--")) return "No double hyphens";
  if (RESERVED.has(h)) return "That word is reserved";
  if (h.startsWith("member-")) return "Handles starting with member- are kept for wallets without one";
  return null;
}

/** A handle to suggest from a display name ("Priya Raman" → "priya-raman"), or null when nothing usable is left. */
export function suggestHandle(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const l = toLabel(displayName).replace(/-+/g, "-").slice(0, 32).replace(/-+$/, "");
  const h = l.length < 3 ? null : l;
  if (!h) return null;
  return handleProblem(h) ? (handleProblem(`${h}-1`) ? null : `${h}-1`) : h;
}

/** The handle the server assigns someone who never chose one: "member-" and six hex digits of their wallet. */
export const fallbackHandle = (address: string) => `member-${address.toLowerCase().replace(/^0x/, "").slice(0, 6)}`;

// ---------- Run, stage, budget and work-order labels ----------

/** A run's label: its order ref, else its id ("r-1003"). */
export const runLabel = (orderRef: string | null | undefined, runId: string) => toLabel(orderRef?.trim() ? orderRef : runId);
/** A stage's label: its code and name, "01-wax-pattern-injection". */
export const stageLabel = (code: string, name: string | null | undefined) => toLabel(name ? `${code}-${name}` : code);
export const BUDGET_LABEL = "budget";
/** An over-budget top-up's label: "topup-01-ceramic-cores". */
export const topupLabel = (stageCode: string, resource: string) => toLabel(`topup-${stageCode}-${resource}`);
/** A work order's label: "wo-12". */
export const workOrderLabel = (number: number | string) => toLabel(`wo-${number}`);

/** A label with a collision suffix: "acme", "acme-2", "acme-3"… (kept within 40 characters). */
export function withSuffix(label: string, n: number): string {
  if (n <= 1) return label;
  const s = `-${n}`;
  return `${label.slice(0, 40 - s.length).replace(/-+$/, "")}${s}`;
}

/** "priya.acme.ordo.eth" → ["priya", ".acme.ordo.eth"]: the part to show strong and the rest. */
export function splitName(name: string): [string, string] {
  const i = name.indexOf(".");
  return i < 0 ? [name, ""] : [name.slice(0, i), name.slice(i)];
}

/** Is this an ENS name (labels joined by dots, ending in .eth)? */
export const isEnsName = (s: string) => /^([a-z0-9-]{1,63}\.)+eth$/.test(s.trim().toLowerCase());
