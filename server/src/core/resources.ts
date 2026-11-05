import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import { PROOF_DOMAIN, type Signatures, type TypedSignature, type User } from "../auth/auth.js";
import type { MachineBank } from "../chain/machine-bank.js";
import type { Db } from "../db/db.js";
import { canApproveAny } from "../domain/policy.js";
import type { AccessLevel, AssetView, Role, StageResource, StageRunView } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import type { RunEngine } from "../pipelines/engine.js";
import { predecessors } from "../pipelines/graph.js";
import { newId, type PlantService } from "../plant/plant.js";
import type { Recorder } from "./recorder.js";
import { amountFor, hbarToTinybar, resourceNeed, roundQty, runBudget, tinybarToHbar, type RunBudget } from "./run-budget.js";

/** A purchase that verified but has not settled holds its quantity this long, so two machines don't buy the same thing */
const PENDING_MS = 5 * 60_000;
/** quantities closer than this count as equal */
const EPS = 1e-6;
const DONE = ["completed", "done_deviation", "skipped"];
const ACTIVE = ["running", "awaiting_approval", "held"];
export const DEMO_SUPPLIER = "Ordo demo supplier";

/**
 * What the demo supplier sells, at small testnet prices (HBAR per unit): the consumables and machine time of the
 * library's biologics and aerospace templates. Its pay-to is the operator, so every sale is a real HBAR transfer.
 */
export const DEMO_OFFERS: { kind: string; sku: string; label: string; unit: string; price: string; leadMin: number }[] = [
  { kind: "protein_a_resin", sku: "PA-RESIN-L", label: "Protein A affinity resin", unit: "L", price: "0.5", leadMin: 0 },
  { kind: "buffer", sku: "BUF-GLY-L", label: "Elution buffer, 0.1 M glycine pH 3.5", unit: "L", price: "0.002", leadMin: 0 },
  { kind: "culture_media", sku: "CD-CHO-L", label: "Chemically defined CHO medium", unit: "L", price: "0.004", leadMin: 0 },
  { kind: "feed", sku: "FEED-CHO-L", label: "CHO fed-batch feed", unit: "L", price: "0.006", leadMin: 0 },
  { kind: "filters", sku: "FLT-02-CAP", label: "0.2 µm sterilising filter capsule", unit: "pcs", price: "0.05", leadMin: 0 },
  { kind: "depth_filters", sku: "FLT-DEPTH", label: "Depth filter module", unit: "m²", price: "0.08", leadMin: 0 },
  { kind: "viral_filters", sku: "FLT-VIRAL", label: "Parvovirus retentive filter", unit: "m²", price: "0.2", leadMin: 0 },
  { kind: "vials", sku: "VIAL-2R", label: "2R Type I glass vials, sterile", unit: "pcs", price: "0.001", leadMin: 0 },
  { kind: "argon", sku: "AR-50-M3", label: "Argon 5.0 (99.999 %)", unit: "m³", price: "0.02", leadMin: 0 },
  { kind: "nitrogen", sku: "N2-50-M3", label: "Nitrogen 5.0 (99.999 %)", unit: "m³", price: "0.01", leadMin: 0 },
  { kind: "helium", sku: "HE-M3", label: "Helium, leak-test grade", unit: "m³", price: "0.05", leadMin: 0 },
  { kind: "ln2", sku: "LN2-L", label: "Liquid nitrogen", unit: "L", price: "0.004", leadMin: 0 },
  { kind: "ti64_powder", sku: "TI64-G23-KG", label: "Ti-6Al-4V Grade 23 powder, 15–45 µm", unit: "kg", price: "0.3", leadMin: 0 },
  { kind: "nickel_superalloy", sku: "CMSX4-KG", label: "Single-crystal nickel superalloy (CMSX-4 class)", unit: "kg", price: "0.4", leadMin: 0 },
  { kind: "build_plates", sku: "PLATE-TI", label: "LPBF build plate, titanium", unit: "pcs", price: "0.2", leadMin: 0 },
  { kind: "prepreg", sku: "PREPREG-IM7", label: "Carbon/epoxy prepreg, IM7 class", unit: "m²", price: "0.15", leadMin: 0 },
  { kind: "bagging_film", sku: "BAG-FILM-M2", label: "Vacuum bagging film and breather", unit: "m²", price: "0.003", leadMin: 0 },
  { kind: "sealant_tape", sku: "SEAL-TAPE-M", label: "Bagging sealant tape", unit: "m", price: "0.001", leadMin: 0 },
  { kind: "fasteners", sku: "HILOK-TI", label: "Titanium Hi-Lok fasteners", unit: "pcs", price: "0.002", leadMin: 0 },
  { kind: "wax", sku: "WAX-PATTERN-KG", label: "Investment-casting pattern wax", unit: "kg", price: "0.02", leadMin: 0 },
  { kind: "slurry", sku: "SLURRY-ZR-L", label: "Ceramic shell slurry (zircon)", unit: "L", price: "0.03", leadMin: 0 },
  { kind: "ceramic_core", sku: "CORE-SIO2", label: "Silica ceramic core", unit: "pcs", price: "0.05", leadMin: 0 },
  { kind: "edm_wire", sku: "EDM-BRASS-025", label: "EDM brass wire, 0.25 mm", unit: "kg", price: "0.05", leadMin: 0 },
  { kind: "ysz_ingot", sku: "YSZ-7-INGOT", label: "7YSZ ingot for EB-PVD", unit: "ingot", price: "0.5", leadMin: 0 },
  { kind: "penetrant", sku: "FPI-L4", label: "Fluorescent penetrant, level 4", unit: "L", price: "0.01", leadMin: 0 },
  { kind: "coolant", sku: "COOLANT-L", label: "Machining coolant concentrate", unit: "L", price: "0.002", leadMin: 0 },
  { kind: "esd_bags", sku: "ESD-BAG", label: "ESD shielding bags", unit: "pcs", price: "0.001", leadMin: 0 },
  { kind: "chamber_hours", sku: "TVAC-H", label: "Thermal-vacuum chamber time", unit: "h", price: "0.5", leadMin: 0 },
  { kind: "furnace_hours", sku: "FURNACE-H", label: "Vacuum furnace time", unit: "h", price: "0.3", leadMin: 0 },
  { kind: "autoclave_hours", sku: "AUTOCLAVE-H", label: "Autoclave time", unit: "h", price: "0.4", leadMin: 0 },
  { kind: "shaker_hours", sku: "SHAKER-H", label: "Electrodynamic shaker time", unit: "h", price: "0.4", leadMin: 0 },
];

const Hbar = z.union([z.number().positive().max(1e9), z.string().regex(/^\d{1,10}(\.\d{1,8})?$/, "a price in HBAR, at most 8 decimals")]);
export const OfferBody = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "a kind is lowercase letters, digits and _, like the stage resources it serves"),
  sku: z.string().regex(/^[A-Za-z0-9][\w.-]{0,47}$/, "a SKU is letters, digits, dots, dashes and _"),
  label: z.string().trim().min(1).max(120),
  unit: z.string().trim().max(16).default(""),
  /** HBAR per unit */
  price: Hbar,
  leadMin: z.number().int().min(0).max(525_600).default(0),
});
export type OfferBody = z.infer<typeof OfferBody>;
export const OfferPatch = OfferBody.omit({ sku: true }).partial();

/** What Ordo signs when a purchase settles: what was sold, to whom, for what, and the transfer that paid for it. */
export const DELIVERY_TYPES = {
  OrdoDelivery: [
    { name: "site", type: "string" },
    { name: "purchase", type: "string" },
    { name: "vendor", type: "string" },
    { name: "sku", type: "string" },
    { name: "kind", type: "string" },
    { name: "qty", type: "string" },
    { name: "unit", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "resource", type: "string" },
    { name: "payTo", type: "string" },
    { name: "buyer", type: "string" },
    { name: "tx", type: "string" },
    { name: "deliveredAt", type: "uint64" },
  ],
} as const;

export interface OfferView {
  id: string;
  vendorId: string;
  vendor: string;
  kind: string;
  sku: string;
  label: string;
  unit: string;
  /** HBAR per unit */
  price: string;
  priceTinybar: string;
  leadMin: number;
  createdAt: string;
  archivedAt: string | null;
}
export interface SupplierView {
  id: string;
  company: string;
  status: string;
  demo: boolean;
  /** the Hedera account sales are paid to; null when the vendor has none (its offers cannot be bought) */
  payTo: string | null;
  offers: OfferView[];
}
export interface ResourcePurchaseView {
  id: string;
  runId: string | null;
  stage: string | null;
  resource: string | null;
  kind: string;
  qty: number;
  unit: string;
  amount: string;
  amountTinybar: string;
  vendorId: string;
  vendor: string;
  sku: string;
  buyer: string | null;
  byAsset: string | null;
  byAssetName: string | null;
  status: "pending" | "delivered" | "expired";
  /** a delivery that is paid for but still on its way (the offer's lead time) */
  arrived: boolean;
  txId: string | null;
  txUrl: string | null;
  auditTx: string | null;
  auditUrl: string | null;
  at: string;
  deliveredAt: string | null;
}
export interface StageResourceView extends StageResource {
  /** what the run consumes at this stage */
  need: number;
  delivered: number;
  pending: number;
  remaining: number;
  status: "delivered" | "partial" | "waiting" | "waived";
  /** `approvedTinybar`: above the stage's maxPrice, the most an executed top-up approved for it (null when none has) */
  bestOffer: (OfferView & { withinMax: boolean; amountTinybar: string; approvedTinybar: string | null }) | null;
  purchases: ResourcePurchaseView[];
}
export interface StageResourcesView {
  runId: string;
  stage: string;
  quantity: number;
  state: string;
  waived: { by: string; reason: string; at: string; signatureId: string } | null;
  resources: StageResourceView[];
  /** below level 4 the offers and purchases (finance) are left out */
  redacted: boolean;
}
/** One resource a machine should buy ahead: for a stage after its own, or for its own stage waiting to start. */
export interface NeededResource {
  runId: string;
  stage: string;
  stageName: string;
  /** the machine that buys it (one of the device's assets) */
  buyerAsset: string;
  resource: string;
  label: string;
  kind: string;
  unit: string;
  per: StageResource["per"];
  need: number;
  delivered: number;
  pending: number;
  remaining: number;
  /** the most it may pay, HBAR per unit, and in tinybars */
  maxPrice: number;
  maxPriceTinybar: string;
  /** the cheapest offer of its kind from a vendor that can be paid; null when none sells it */
  offer: {
    vendorId: string;
    vendor: string;
    sku: string;
    label: string;
    unit: string;
    price: string;
    priceTinybar: string;
    leadMin: number;
    /** price × remaining, what the storefront will ask */
    amountTinybar: string;
    /** at or below the stage's maxPrice, or within a top-up a manager approved for it */
    withinMax: boolean;
    /** the most an executed top-up approved for this purchase, in tinybars; null when none has */
    approvedTinybar: string | null;
    /** the storefront path to buy exactly what is missing */
    path: string;
  } | null;
}
export interface NeededView {
  /** each of the device's machines with a Hedera account, and its balance */
  wallets: { assetId: string; accountId: string; balanceTinybar: string | null }[];
  needed: NeededResource[];
}
export interface DeliveryView {
  purchaseId: string;
  status: "pending" | "delivered";
  site: string;
  vendor: { id: string; company: string; payTo: string };
  offer: { sku: string; label: string; kind: string; unit: string; price: string; leadMin: number };
  qty: number;
  amount: string;
  amountTinybar: string;
  runId: string | null;
  stage: string | null;
  resource: string | null;
  buyer: string | null;
  byAsset: string | null;
  txId: string | null;
  txUrl: string | null;
  auditTx: string | null;
  deliveredAt: string | null;
  /** Ordo's EIP-712 OrdoDelivery over the sale, once it settled */
  receipt: { domain: typeof PROOF_DOMAIN; types: typeof DELIVERY_TYPES; primaryType: "OrdoDelivery"; message: Record<string, string>; signature: Hex; signer: string } | null;
}

interface OfferRow {
  id: string;
  site_id: string;
  vendor_id: string;
  company: string;
  kind: string;
  sku: string;
  label: string;
  unit: string;
  price: string;
  lead_min: number;
  created_at: string;
  archived_at: string | null;
}
interface PurchaseRow {
  id: string;
  site_id: string;
  run_id: string | null;
  stage_code: string | null;
  resource_key: string | null;
  kind: string;
  qty: number | string;
  unit: string;
  amount_tinybar: string;
  vendor_id: string;
  company: string | null;
  sku: string;
  buyer_account: string | null;
  tx_id: string | null;
  audit_tx: string | null;
  receipt_json: string | null;
  status: string;
  by_asset: string | null;
  asset_name: string | null;
  created_at: string;
  delivered_at: string | null;
}
interface Binding {
  runId: string;
  stage: string;
  resource: string;
}

const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);
const offerView = (r: OfferRow): OfferView => ({
  id: r.id,
  vendorId: r.vendor_id,
  vendor: r.company,
  kind: r.kind,
  sku: r.sku,
  label: r.label,
  unit: r.unit,
  price: tinybarToHbar(r.price),
  priceTinybar: r.price,
  leadMin: Number(r.lead_min),
  createdAt: iso(r.created_at)!,
  archivedAt: iso(r.archived_at),
});
/** A Hedera account as an EVM address (its long-zero form), for a vendor known only by its account */
const longZero = (account: string | null) => {
  const m = account ? /^(\d+)\.(\d+)\.(\d+)$/.exec(account) : null;
  if (!m) return `0x${"0".repeat(40)}`;
  return `0x${BigInt(m[1]!).toString(16).padStart(8, "0")}${BigInt(m[2]!).toString(16).padStart(16, "0")}${BigInt(m[3]!).toString(16).padStart(16, "0")}`;
};
export const storefrontPath = (vendorId: string, sku: string, qty: number, b?: Binding) =>
  `/v1/x402/vendors/${vendorId}/offers/${encodeURIComponent(sku)}?qty=${roundQty(qty)}${b ? `&run=${encodeURIComponent(b.runId)}&stage=${encodeURIComponent(b.stage)}&resource=${encodeURIComponent(b.resource)}` : ""}`;

/**
 * The resources a stage consumes, and how machines buy them ahead of the stage.
 *
 * Vendors list offers (a kind, a SKU, a price in HBAR per unit and a lead time); a demo supplier paid to the operator
 * covers the library's resource kinds. Ordo sells each offer over x402 at `/v1/x402/vendors/:vendor/offers/:sku?qty=`,
 * priced at price × qty and paid straight to the vendor's Hedera account; tagged with `run`, `stage` and `resource`,
 * the sale counts toward that stage. On settlement the purchase is recorded with the paying account (a machine's own
 * account marks the machine as the buyer), written to the HCS topic, and answered with a delivery receipt Ordo signs.
 *
 * A machine asks (device-signed) which resources the stages after its running stage still need, with the best offer
 * for each; it buys what is within the stage's maxPrice and its balance, and reports the rest as over budget. Once a
 * top-up for that purchase has executed (a manager approved it, budgets.ts), the offer counts as within budget up to
 * the amount approved. A stage with resources starts only once each is delivered, unless a manager signs a waiver.
 */
export class Resources {
  private receiptKey: PrivateKeyAccount;
  private accounts = new Map<string, { account: string | null; at: number }>();
  private seeded = new Set<string>();
  /** the storefront's x402 middleware, when Ordo sells over x402 (a Hedera network and a pay-to account are set) */
  store: import("hono").MiddlewareHandler | null = null;

  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private engine: RunEngine,
    private plant: PlantService,
    private bank: MachineBank | null,
    private o: { payTo: string | null; network: string; chainId: number },
    secret: string,
    private now: () => number,
  ) {
    this.receiptKey = privateKeyToAccount(keccak256(toBytes(`ordo:resource-receipts:${secret}`)));
  }

  /** the address that signs delivery receipts */
  get receiptSigner() {
    return this.receiptKey.address;
  }
  private txUrl(id: string | null) {
    if (!id) return null;
    return this.bank?.txUrl(id) ?? `https://hashscan.io/${this.o.network}/transaction/${id.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;
  }

  // ---------------------------------------------------------------- the demo supplier
  /** Seed the org's demo supplier and its offers once (an offer a manager archived stays archived). */
  async ensureDemo(siteId: string) {
    if (this.seeded.has(siteId)) return;
    const id = `vnd_demo_${siteId}`;
    await this.db.query("INSERT INTO vendors (id, site_id, address, company, categories, status, hedera_account, response_minutes) VALUES ($1,$2,$3,$4,$5,'supplier',$6,0) ON CONFLICT (id) DO NOTHING", [
      id,
      siteId,
      longZero(this.o.payTo),
      DEMO_SUPPLIER,
      "stage resources",
      this.o.payTo,
    ]);
    if (this.o.payTo) await this.db.query("UPDATE vendors SET hedera_account = $1, address = $2 WHERE id = $3 AND hedera_account IS NULL", [this.o.payTo, longZero(this.o.payTo), id]);
    const values: unknown[] = [];
    const rows = DEMO_OFFERS.map((o, i) => {
      values.push(`off_demo_${siteId}_${o.sku}`, siteId, id, o.kind, o.sku, o.label, o.unit, hbarToTinybar(o.price).toString(), o.leadMin);
      const b = i * 9;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    });
    await this.db.query(`INSERT INTO vendor_offers (id, site_id, vendor_id, kind, sku, label, unit, price, lead_min) VALUES ${rows.join(",")} ON CONFLICT (id) DO NOTHING`, values);
    this.seeded.add(siteId);
  }

  // ---------------------------------------------------------------- managers list offers
  async suppliers(siteId: string, archived = false): Promise<SupplierView[]> {
    await this.ensureDemo(siteId);
    const vendors = await this.db.query<{ id: string; company: string; status: string; hedera_account: string | null }>(
      "SELECT id, company, status, hedera_account FROM vendors WHERE site_id = $1 AND status IN ('approved', 'supplier') ORDER BY status DESC, created_at",
      [siteId],
    );
    const offers = await this.offerRows(siteId, archived);
    const out: SupplierView[] = [];
    for (const v of vendors.rows)
      out.push({ id: v.id, company: v.company, status: v.status, demo: v.id === `vnd_demo_${siteId}`, payTo: await this.payTo(v.id), offers: offers.filter((o) => o.vendor_id === v.id).map(offerView) });
    return out;
  }

  private async offerRows(siteId: string, archived: boolean) {
    return (
      await this.db.query<OfferRow>(
        `SELECT o.id, o.site_id, o.vendor_id, v.company, o.kind, o.sku, o.label, o.unit, o.price, o.lead_min, o.created_at::text, o.archived_at::text
         FROM vendor_offers o JOIN vendors v ON v.id = o.vendor_id WHERE o.site_id = $1 ${archived ? "" : "AND o.archived_at IS NULL"} ORDER BY o.kind, o.price::numeric`,
        [siteId],
      )
    ).rows;
  }

  private async vendorOf(siteId: string, vendorId: string) {
    const v = (await this.db.query<{ id: string; company: string }>("SELECT id, company FROM vendors WHERE id = $1 AND site_id = $2 AND status IN ('approved', 'supplier')", [vendorId, siteId])).rows[0];
    if (!v) throw new HttpError(404, "No such vendor");
    return v;
  }
  private need(roles: Role[]) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager edits vendors' offers");
  }

  async addOffer(siteId: string, user: User, roles: Role[], vendorId: string, i: OfferBody): Promise<OfferView> {
    this.need(roles);
    const v = await this.vendorOf(siteId, vendorId);
    const dup = await this.db.query("SELECT 1 FROM vendor_offers WHERE vendor_id = $1 AND sku = $2 AND archived_at IS NULL", [vendorId, i.sku]);
    if (dup.rows.length) throw new HttpError(409, `${v.company} already offers ${i.sku}`);
    const id = newId("off");
    const price = hbarToTinybar(i.price);
    if (price <= 0n) throw new HttpError(400, "The price must be at least one tinybar");
    await this.db.query("INSERT INTO vendor_offers (id, site_id, vendor_id, kind, sku, label, unit, price, lead_min) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, siteId, vendorId, i.kind, i.sku, i.label, i.unit, price.toString(), i.leadMin]);
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "vendor.offer_added", summary: `${v.company} offers ${i.label} (${i.kind}) at ${tinybarToHbar(price)} HBAR per ${i.unit || "unit"}`, data: { offerId: id, vendorId, ...i, priceTinybar: price.toString() } });
    return this.offer(siteId, id);
  }

  async editOffer(siteId: string, user: User, roles: Role[], vendorId: string, offerId: string, p: z.infer<typeof OfferPatch>): Promise<OfferView> {
    this.need(roles);
    const v = await this.vendorOf(siteId, vendorId);
    const cur = await this.offer(siteId, offerId);
    if (cur.vendorId !== vendorId || cur.archivedAt) throw new HttpError(404, "No such offer");
    const price = p.price !== undefined ? hbarToTinybar(p.price) : BigInt(cur.priceTinybar);
    if (price <= 0n) throw new HttpError(400, "The price must be at least one tinybar");
    await this.db.query("UPDATE vendor_offers SET kind = $1, label = $2, unit = $3, price = $4, lead_min = $5 WHERE id = $6", [p.kind ?? cur.kind, p.label ?? cur.label, p.unit ?? cur.unit, price.toString(), p.leadMin ?? cur.leadMin, offerId]);
    const next = await this.offer(siteId, offerId);
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "vendor.offer_changed", summary: `${v.company} ${next.sku}: ${next.label} at ${next.price} HBAR per ${next.unit || "unit"}`, data: { offerId, before: cur, after: next } });
    return next;
  }

  async archiveOffer(siteId: string, user: User, roles: Role[], vendorId: string, offerId: string) {
    this.need(roles);
    const v = await this.vendorOf(siteId, vendorId);
    const r = await this.db.query<{ sku: string }>("UPDATE vendor_offers SET archived_at = now() WHERE id = $1 AND vendor_id = $2 AND site_id = $3 AND archived_at IS NULL RETURNING sku", [offerId, vendorId, siteId]);
    if (!r.rows[0]) throw new HttpError(404, "No such offer");
    await this.rec.decide(siteId, { agent: `user:${user.address}`, kind: "vendor.offer_archived", summary: `${v.company} no longer offers ${r.rows[0].sku}`, data: { offerId, vendorId } });
    return { ok: true };
  }

  private async offer(siteId: string, offerId: string): Promise<OfferView> {
    const r = await this.db.query<OfferRow>(
      "SELECT o.id, o.site_id, o.vendor_id, v.company, o.kind, o.sku, o.label, o.unit, o.price, o.lead_min, o.created_at::text, o.archived_at::text FROM vendor_offers o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = $1 AND o.site_id = $2",
      [offerId, siteId],
    );
    if (!r.rows[0]) throw new HttpError(404, "No such offer");
    return offerView(r.rows[0]);
  }

  // ---------------------------------------------------------------- the storefront (x402)
  /** The Hedera account a vendor is paid at: its own, or the one behind its wallet address. Cached for 10 minutes. */
  async payTo(vendorId: string): Promise<string | null> {
    const hit = this.accounts.get(vendorId);
    if (hit && this.now() - hit.at < 600_000) return hit.account;
    const v = (await this.db.query<{ address: string; hedera_account: string | null }>("SELECT address, hedera_account FROM vendors WHERE id = $1 AND status IN ('approved', 'supplier')", [vendorId])).rows[0];
    const account = !v ? null : v.hedera_account ?? (this.bank ? await this.bank.accountOf(v.address).catch(() => null) : null);
    this.accounts.set(vendorId, { account, at: this.now() });
    return account;
  }

  /** A vendor's active offers, as anyone sees them (the x402 catalog). */
  async catalog(vendorId: string) {
    const v = (await this.db.query<{ site_id: string; company: string }>("SELECT site_id, company FROM vendors WHERE id = $1 AND status IN ('approved', 'supplier')", [vendorId])).rows[0];
    if (!v) throw new HttpError(404, "No such vendor");
    const payTo = await this.payTo(vendorId);
    const offers = (await this.offerRows(v.site_id, false)).filter((o) => o.vendor_id === vendorId).map(offerView);
    return { vendor: v.company, payTo, offers: offers.map((o) => ({ sku: o.sku, kind: o.kind, label: o.label, unit: o.unit, price: o.price, priceTinybar: o.priceTinybar, leadMin: o.leadMin, path: `/v1/x402/vendors/${vendorId}/offers/${encodeURIComponent(o.sku)}?qty=` })) };
  }

  private async activeOffer(vendorId: string, sku: string) {
    const r = await this.db.query<OfferRow>(
      "SELECT o.id, o.site_id, o.vendor_id, v.company, o.kind, o.sku, o.label, o.unit, o.price, o.lead_min, o.created_at::text, o.archived_at::text FROM vendor_offers o JOIN vendors v ON v.id = o.vendor_id WHERE o.vendor_id = $1 AND o.sku = $2 AND o.archived_at IS NULL AND v.status IN ('approved', 'supplier') ORDER BY o.created_at DESC LIMIT 1",
      [vendorId, sku],
    );
    return r.rows[0] ?? null;
  }

  /** What `qty` of an offer costs, in tinybars (what the 402 asks for). */
  async price(vendorId: string, sku: string, qty: number): Promise<bigint> {
    const o = await this.activeOffer(vendorId, sku);
    if (!o) throw new Error("No such offer");
    return amountFor(BigInt(o.price), qty);
  }

  /**
   * Check a sale before asking for payment (and again before recording it): the offer exists and can be paid, the
   * quantity is sane, and a sale tagged with a run's stage is for a resource that stage still needs.
   */
  async check(vendorId: string, sku: string, q: { qty?: string; run?: string; stage?: string; resource?: string }) {
    const o = await this.activeOffer(vendorId, sku);
    if (!o) throw new HttpError(404, "This vendor has no such offer");
    const payTo = await this.payTo(vendorId);
    if (!payTo) throw new HttpError(404, "This vendor has no Hedera account: its offers cannot be bought");
    const qty = Number(q.qty ?? "1");
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6 || roundQty(qty) <= 0) throw new HttpError(400, "qty is a positive quantity, at most 1,000,000");
    let binding: Binding | null = null;
    if (q.run || q.stage || q.resource) {
      if (!q.run || !q.stage || !q.resource) throw new HttpError(400, "A purchase for a stage names its run, stage and resource");
      binding = { runId: q.run, stage: q.stage, resource: q.resource };
      const run = (await this.db.query<{ site_id: string; status: string; quantity: number }>("SELECT site_id, status, quantity FROM runs WHERE id = $1", [q.run])).rows[0];
      if (!run || run.site_id !== o.site_id) throw new HttpError(404, "No such run here");
      if (run.status !== "running") throw new HttpError(409, `The run is ${run.status}`);
      const view = await this.engine.view(run.site_id, q.run, undefined, false);
      const st = view.stages.find((s) => s.code === q.stage);
      const r = st?.resources.find((x) => x.key === q.resource);
      if (!st || !r) throw new HttpError(404, "That stage consumes no such resource");
      if (r.kind !== o.kind) throw new HttpError(409, `${o.label} is ${o.kind}; the stage needs ${r.kind}`);
      if (st.state !== "queued") throw new HttpError(409, `Stage ${st.code} has already started`);
      if (await this.waiver(q.run, st.code)) throw new HttpError(409, `Stage ${st.code} was waived to start without its resources`);
      const have = await this.counts(q.run, st.code, r.key);
      const remaining = roundQty(resourceNeed(r, Number(run.quantity)) - have.delivered - have.pending);
      if (remaining <= EPS) throw new HttpError(409, `${r.label} for ${st.code} is already bought`);
      if (qty > remaining + EPS) throw new HttpError(409, `${st.code} needs only ${remaining} ${r.unit} more of ${r.label}`);
    }
    return { offer: o, payTo, qty: roundQty(qty), binding };
  }

  /** After the payment is verified: hold the sale as pending until it settles. Returns what the buyer receives. */
  async sell(vendorId: string, sku: string, q: { qty?: string; run?: string; stage?: string; resource?: string }): Promise<DeliveryView> {
    const { offer, payTo, qty, binding } = await this.check(vendorId, sku, q);
    const id = newId("rp");
    const amount = amountFor(BigInt(offer.price), qty);
    await this.db.query(
      "INSERT INTO resource_purchases (id, site_id, run_id, stage_code, resource_key, kind, qty, unit, amount_tinybar, vendor_id, sku, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')",
      [id, offer.site_id, binding?.runId ?? null, binding?.stage ?? null, binding?.resource ?? null, offer.kind, qty, offer.unit, amount.toString(), vendorId, offer.sku],
    );
    return this.delivery(id, payTo);
  }

  /** The payment settled: record it, write it to HCS, open the stage's gate if this was the last thing it waited for, and sign the receipt. */
  async settled(s: { vendorId: string; sku: string; payer: string | null; transaction: string; network: string; body: Uint8Array }): Promise<Uint8Array | null> {
    const pending = JSON.parse(new TextDecoder().decode(s.body)) as DeliveryView;
    const row = await this.purchaseRow(pending.purchaseId);
    if (!row || row.vendor_id !== s.vendorId || row.status !== "pending") return null;
    const byAsset = s.payer ? ((await this.db.query<{ asset_id: string }>("SELECT asset_id FROM machine_wallets WHERE account_id = $1 AND site_id = $2", [s.payer, row.site_id])).rows[0]?.asset_id ?? null) : null;
    const offer = await this.activeOffer(s.vendorId, s.sku);
    const deliveredAt = new Date(this.now() + (offer ? Number(offer.lead_min) : 0) * 60_000);
    await this.db.query("UPDATE resource_purchases SET status = 'delivered', buyer_account = $1, tx_id = $2, by_asset = $3, delivered_at = $4 WHERE id = $5", [s.payer, s.transaction || null, byAsset, deliveredAt.toISOString(), row.id]);
    const audit = this.bank
      ? await this.bank
          .audit({ kind: "resource.purchase", site: row.site_id, run: row.run_id, stage: row.stage_code, resource: row.resource_key, vendor: s.vendorId, sku: s.sku, qty: Number(row.qty), amount: row.amount_tinybar, buyer: s.payer, asset: byAsset, tx: s.transaction })
          .catch(() => null)
      : null;
    const payTo = (await this.payTo(s.vendorId)) ?? "";
    const message = {
      site: row.site_id,
      purchase: row.id,
      vendor: s.vendorId,
      sku: s.sku,
      kind: row.kind,
      qty: String(Number(row.qty)),
      unit: row.unit,
      amount: BigInt(row.amount_tinybar),
      runId: row.run_id ?? "",
      stage: row.stage_code ?? "",
      resource: row.resource_key ?? "",
      payTo,
      buyer: s.payer ?? "",
      tx: s.transaction,
      deliveredAt: BigInt(Math.floor(deliveredAt.getTime() / 1000)),
    };
    const signature = await this.receiptKey.signTypedData({ domain: PROOF_DOMAIN, types: DELIVERY_TYPES, primaryType: "OrdoDelivery", message });
    const receipt = { domain: PROOF_DOMAIN, types: DELIVERY_TYPES, primaryType: "OrdoDelivery" as const, message: { ...message, amount: message.amount.toString(), deliveredAt: message.deliveredAt.toString() }, signature, signer: this.receiptKey.address };
    await this.db.query("UPDATE resource_purchases SET audit_tx = $1, receipt_json = $2 WHERE id = $3", [audit, JSON.stringify(receipt), row.id]);
    const asset = byAsset ? await this.plant.asset(row.site_id, byAsset).catch(() => null) : null;
    await this.rec.decide(row.site_id, {
      agent: asset ? `machine:${asset.name}` : `x402:${s.payer ?? "unknown"}`,
      kind: "resource.bought",
      runId: row.run_id,
      stageCode: row.stage_code,
      assetId: byAsset,
      summary: `${asset ? asset.name : (s.payer ?? "A buyer")} bought ${Number(row.qty)} ${row.unit} of ${offer?.label ?? row.sku} from ${pending.vendor.company} for ${tinybarToHbar(row.amount_tinybar)} HBAR over x402${row.stage_code ? ` for stage ${row.stage_code}` : ""}`,
      data: { purchaseId: row.id, vendorId: s.vendorId, sku: s.sku, qty: Number(row.qty), amountTinybar: row.amount_tinybar, buyer: s.payer, tx: s.transaction, audit, receiptSigner: this.receiptKey.address },
    });
    if (row.run_id) await this.engine.tickRun(row.site_id, row.run_id).catch((e) => console.error(`[ordo] run ${row.run_id} after a delivery`, e));
    return new TextEncoder().encode(JSON.stringify(await this.delivery(row.id, payTo)));
  }

  private async purchaseRow(id: string) {
    return (
      await this.db.query<PurchaseRow>(
        `SELECT p.id, p.site_id, p.run_id, p.stage_code, p.resource_key, p.kind, p.qty::text AS qty, p.unit, p.amount_tinybar, p.vendor_id, v.company, p.sku, p.buyer_account, p.tx_id, p.audit_tx,
                p.receipt_json, p.status, p.by_asset, a.name AS asset_name, p.created_at::text, p.delivered_at::text
         FROM resource_purchases p LEFT JOIN vendors v ON v.id = p.vendor_id LEFT JOIN assets a ON a.id = p.by_asset WHERE p.id = $1`,
        [id],
      )
    ).rows[0];
  }

  private async delivery(id: string, payTo: string): Promise<DeliveryView> {
    const p = (await this.purchaseRow(id))!;
    const o = await this.activeOffer(p.vendor_id, p.sku);
    return {
      purchaseId: p.id,
      status: p.status === "delivered" ? "delivered" : "pending",
      site: p.site_id,
      vendor: { id: p.vendor_id, company: p.company ?? "", payTo },
      offer: { sku: p.sku, label: o?.label ?? p.sku, kind: p.kind, unit: p.unit, price: o ? tinybarToHbar(o.price) : "", leadMin: o ? Number(o.lead_min) : 0 },
      qty: Number(p.qty),
      amount: tinybarToHbar(p.amount_tinybar),
      amountTinybar: p.amount_tinybar,
      runId: p.run_id,
      stage: p.stage_code,
      resource: p.resource_key,
      buyer: p.buyer_account,
      byAsset: p.by_asset,
      txId: p.tx_id,
      txUrl: this.txUrl(p.tx_id),
      auditTx: p.audit_tx,
      deliveredAt: iso(p.delivered_at),
      receipt: p.receipt_json ? (JSON.parse(p.receipt_json) as DeliveryView["receipt"]) : null,
    };
  }

  // ---------------------------------------------------------------- what a stage has, and the gate
  /** Delivered (arrived) and pending quantities of one resource of a run's stage. */
  private async counts(runId: string, stage: string, resource: string) {
    const r = await this.db.query<{ delivered: string | null; pending: string | null }>(
      `SELECT SUM(CASE WHEN status = 'delivered' AND delivered_at <= $4 THEN qty ELSE 0 END)::text AS delivered,
              SUM(CASE WHEN status = 'delivered' AND delivered_at > $4 OR status = 'pending' AND created_at > $5 THEN qty ELSE 0 END)::text AS pending
       FROM resource_purchases WHERE run_id = $1 AND stage_code = $2 AND resource_key = $3`,
      [runId, stage, resource, new Date(this.now()).toISOString(), new Date(this.now() - PENDING_MS).toISOString()],
    );
    return { delivered: roundQty(Number(r.rows[0]?.delivered ?? 0)), pending: roundQty(Number(r.rows[0]?.pending ?? 0)) };
  }

  private async waiver(runId: string, stage: string) {
    const r = await this.db.query<{ by_user: string; reason: string; signature_id: string; created_at: string }>("SELECT by_user, reason, signature_id, created_at::text FROM resource_waivers WHERE run_id = $1 AND stage_code = $2", [runId, stage]);
    const w = r.rows[0];
    return w ? { by: w.by_user, reason: w.reason, signatureId: w.signature_id, at: iso(w.created_at)! } : null;
  }

  /** For the engine: the resources a stage still waits for (empty once each has arrived, or a manager waived the wait). */
  async missing(runId: string, quantity: number, resources: StageResource[], stage: string): Promise<string[]> {
    if (!resources.length || (await this.waiver(runId, stage))) return [];
    const out: string[] = [];
    for (const r of resources) {
      const need = resourceNeed(r, quantity);
      const { delivered } = await this.counts(runId, stage, r.key);
      if (delivered + EPS < need) out.push(`${r.label} (${delivered} of ${need}${r.unit ? ` ${r.unit}` : ""})`);
    }
    return out;
  }

  /**
   * What managers approved above the stages' maxPrice: for each `<stage>/<resource>` of a run, the largest purchase an
   * executed top-up was for (the treasury's scheduled transfer ran, budgets.ts), in tinybars.
   */
  private async approvals(runId: string): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    const r = await this.db.query<{ stage_code: string | null; resource: string | null; lines_json: string }>(
      "SELECT stage_code, resource, lines_json FROM budget_schedules WHERE run_id = $1 AND kind = 'topup' AND status = 'executed'",
      [runId],
    );
    for (const t of r.rows) {
      if (!t.stage_code || !t.resource) continue;
      const lines = JSON.parse(t.lines_json) as { resource?: string; tinybars?: string }[];
      for (const l of lines.filter((x) => x.resource === t.resource && /^\d+$/.test(x.tinybars ?? ""))) {
        const k = `${t.stage_code}/${t.resource}`;
        const v = BigInt(l.tinybars!);
        if (v > (out.get(k) ?? 0n)) out.set(k, v);
      }
    }
    return out;
  }
  /** An offer is within budget at or below the stage's maxPrice, or when what it costs is within an approved top-up. */
  private within(priceTinybar: bigint, maxTinybar: bigint, amountTinybar: bigint, approved: bigint | undefined) {
    return priceTinybar <= maxTinybar || (approved !== undefined && amountTinybar <= approved);
  }

  /** The best offer for a resource kind: the cheapest from a vendor that can be paid. */
  private async bestOffer(siteId: string, kind: string): Promise<OfferRow | null> {
    const rows = (await this.offerRows(siteId, false)).filter((o) => o.kind === kind).sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
    for (const o of rows) if (await this.payTo(o.vendor_id)) return o;
    return null;
  }

  private async purchases(runId: string, stage: string): Promise<ResourcePurchaseView[]> {
    const r = await this.db.query<PurchaseRow>(
      `SELECT p.id, p.site_id, p.run_id, p.stage_code, p.resource_key, p.kind, p.qty::text AS qty, p.unit, p.amount_tinybar, p.vendor_id, v.company, p.sku, p.buyer_account, p.tx_id, p.audit_tx,
              NULL AS receipt_json, p.status, p.by_asset, a.name AS asset_name, p.created_at::text, p.delivered_at::text
       FROM resource_purchases p LEFT JOIN vendors v ON v.id = p.vendor_id LEFT JOIN assets a ON a.id = p.by_asset WHERE p.run_id = $1 AND p.stage_code = $2 ORDER BY p.created_at DESC LIMIT 100`,
      [runId, stage],
    );
    const now = this.now();
    return r.rows.map((p) => ({
      id: p.id,
      runId: p.run_id,
      stage: p.stage_code,
      resource: p.resource_key,
      kind: p.kind,
      qty: Number(p.qty),
      unit: p.unit,
      amount: tinybarToHbar(p.amount_tinybar),
      amountTinybar: p.amount_tinybar,
      vendorId: p.vendor_id,
      vendor: p.company ?? p.vendor_id,
      sku: p.sku,
      buyer: p.buyer_account,
      byAsset: p.by_asset,
      byAssetName: p.asset_name,
      status: p.status === "delivered" ? "delivered" : Date.parse(p.created_at) > now - PENDING_MS ? "pending" : "expired",
      arrived: p.status === "delivered" && Boolean(p.delivered_at) && Date.parse(p.delivered_at!) <= now,
      txId: p.tx_id,
      txUrl: this.txUrl(p.tx_id),
      auditTx: p.audit_tx,
      auditUrl: this.txUrl(p.audit_tx),
      at: iso(p.created_at)!,
      deliveredAt: iso(p.delivered_at),
    }));
  }

  /** A stage's resources for the stage drawer: what it needs, what arrived, the best offer and each purchase. */
  async stageView(siteId: string, run: { id: string; quantity: number }, stage: StageRunView, level: AccessLevel): Promise<StageResourcesView> {
    await this.ensureDemo(siteId);
    const waived = await this.waiver(run.id, stage.code);
    const finance = level >= 4;
    const all = finance ? await this.purchases(run.id, stage.code) : [];
    const approved = finance ? await this.approvals(run.id) : new Map<string, bigint>();
    const resources: StageResourceView[] = [];
    for (const r of stage.resources) {
      const need = resourceNeed(r, run.quantity);
      const c = await this.counts(run.id, stage.code, r.key);
      const best = finance ? await this.bestOffer(siteId, r.kind) : null;
      const remaining = Math.max(0, roundQty(need - c.delivered - c.pending));
      resources.push({
        ...r,
        need,
        delivered: c.delivered,
        pending: c.pending,
        remaining,
        status: c.delivered + EPS >= need ? "delivered" : waived ? "waived" : c.delivered > 0 || c.pending > 0 ? "partial" : "waiting",
        bestOffer: best
          ? (() => {
              const amount = amountFor(BigInt(best.price), remaining || need);
              const [maxTb, ok] = [hbarToTinybar(r.maxPrice), approved.get(`${stage.code}/${r.key}`)];
              return { ...offerView(best), withinMax: this.within(BigInt(best.price), maxTb, amount, ok), amountTinybar: amount.toString(), approvedTinybar: BigInt(best.price) > maxTb ? (ok?.toString() ?? null) : null };
            })()
          : null,
        purchases: all.filter((p) => p.resource === r.key),
      });
    }
    return { runId: run.id, stage: stage.code, quantity: run.quantity, state: stage.state, waived, resources, redacted: !finance };
  }

  /** A run's resource budget (run-budget.ts), with the machines the run has bound or the template pins. */
  async budget(siteId: string, runId: string, marginPct?: number): Promise<RunBudget> {
    const v = await this.engine.view(siteId, runId, undefined, false);
    return runBudget(v.stages, v.quantity, { marginPct, machineOf: (code) => { const s = v.stages.find((x) => x.code === code); return s?.assetId ?? s?.machine ?? null; } });
  }

  // ---------------------------------------------------------------- a manager waives the wait (signed)
  private async waivable(siteId: string, roles: Role[], runId: string, code: string) {
    if (!canApproveAny(roles, "manager")) throw new HttpError(403, "A manager waives a stage's resources");
    const v = await this.engine.view(siteId, runId, undefined, false);
    if (v.status !== "running") throw new HttpError(409, `The run is ${v.status}`);
    const st = v.stages.find((s) => s.code === code);
    if (!st) throw new HttpError(404, "Stage not found");
    if (!st.resources.length) throw new HttpError(409, `Stage ${code} consumes no resources`);
    if (st.state !== "queued") throw new HttpError(409, `Stage ${code} has already started`);
    if (await this.waiver(runId, code)) throw new HttpError(409, `Stage ${code} was already waived`);
    return { v, st };
  }
  async waiveRequest(siteId: string, user: User, roles: Role[], runId: string, code: string, reason: string, chainId?: number): Promise<TypedSignature> {
    const { st } = await this.waivable(siteId, roles, runId, code);
    return this.sigs.request(user, { action: "stage.waive_resources", entity: `${runId}#${code}`, meaning: `Start ${code} ${st.name} without waiting for its resources`, comment: reason, site: siteId, chainId: chainId ?? this.o.chainId });
  }
  async waive(siteId: string, user: User, roles: Role[], runId: string, code: string, i: { reason: string; nonce: string; signature: Hex }) {
    const { v, st } = await this.waivable(siteId, roles, runId, code);
    const missing = await this.missing(runId, v.quantity, st.resources, code);
    const sig = await this.db.tx(async (q) => {
      const s = await this.sigs.consume(q, user, { action: "stage.waive_resources", entity: `${runId}#${code}` }, i);
      await q.query("INSERT INTO resource_waivers (run_id, stage_code, site_id, by_user, reason, signature_id) VALUES ($1,$2,$3,$4,$5,$6)", [runId, code, siteId, user.address, i.reason, s.id]);
      return s;
    });
    await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "stage.resources_waived",
      runId,
      stageCode: code,
      summary: `${code} ${st.name} may start without ${missing.length ? missing.join(", ") : "its resources"}`,
      reason: i.reason,
      data: { signatureId: sig.id, missing },
    });
    await this.engine.tickRun(siteId, runId);
    return { ok: true, signatureId: sig.id };
  }

  // ---------------------------------------------------------------- machines buy ahead
  /**
   * What a device's machines should buy now: for each running run, the resources of the stages right after a stage
   * running on one of them, and of a stage ready to start on one of them that still waits for its resources. Each
   * comes with the cheapest payable offer of its kind and the storefront path to buy exactly what is missing.
   */
  async needed(assets: { id: string; site_id: string }[]): Promise<NeededView> {
    const mine = new Set(assets.map((a) => a.id));
    const wallets: NeededView["wallets"] = [];
    const w = await this.db.query<{ asset_id: string; account_id: string; status: string }>("SELECT asset_id, account_id, status FROM machine_wallets WHERE account_id IS NOT NULL AND status = 'active'");
    for (const x of w.rows.filter((r) => mine.has(r.asset_id))) wallets.push({ assetId: x.asset_id, accountId: x.account_id, balanceTinybar: this.bank ? await this.bank.balance(x.account_id).then(String).catch(() => null) : null });
    const needed: NeededResource[] = [];
    for (const siteId of [...new Set(assets.map((a) => a.site_id))]) {
      await this.ensureDemo(siteId);
      const views = new Map<string, AssetView>((await this.plant.views(siteId)).map((a) => [a.id, a]));
      const kinds = new Map([...mine].filter((id) => views.has(id)).map((id) => [id, views.get(id)!.kind]));
      const runs = await this.db.query<{ id: string }>("SELECT id FROM runs WHERE site_id = $1 AND status = 'running' ORDER BY started_at", [siteId]);
      for (const { id: runId } of runs.rows) {
        const v = await this.engine.view(siteId, runId, views, false);
        const approved = await this.approvals(runId);
        const preds = predecessors(v.stages);
        const byCode = new Map(v.stages.map((s) => [s.code, s]));
        for (const s of v.stages) {
          if (s.state !== "queued" || s.resourceKind === "system" || !s.resources.length) continue;
          const ps = (preds.get(s.code) ?? []).map((c) => byCode.get(c)!);
          // the machine of the stage before it buys ahead; a stage ready to start with nothing bought buys for itself
          const before = ps.find((p) => p.assetId && mine.has(p.assetId) && ACTIVE.includes(p.state));
          const ready = ps.every((p) => DONE.includes(p.state));
          const own = ready ? (s.machine ? (mine.has(s.machine) ? s.machine : null) : ([...kinds].find(([, k]) => k === s.resourceKind)?.[0] ?? null)) : null;
          const buyer = before?.assetId ?? own;
          if (!buyer || (await this.waiver(runId, s.code))) continue;
          for (const r of s.resources) {
            const need = resourceNeed(r, v.quantity);
            const c = await this.counts(runId, s.code, r.key);
            const remaining = roundQty(need - c.delivered - c.pending);
            if (remaining <= EPS) continue;
            const best = await this.bestOffer(siteId, r.kind);
            const maxTb = hbarToTinybar(r.maxPrice);
            const amount = best ? amountFor(BigInt(best.price), remaining) : 0n;
            const ok = approved.get(`${s.code}/${r.key}`);
            needed.push({
              runId,
              stage: s.code,
              stageName: s.name,
              buyerAsset: buyer,
              resource: r.key,
              label: r.label,
              kind: r.kind,
              unit: r.unit,
              per: r.per,
              need,
              delivered: c.delivered,
              pending: c.pending,
              remaining,
              maxPrice: r.maxPrice,
              maxPriceTinybar: maxTb.toString(),
              offer: best
                ? {
                    vendorId: best.vendor_id,
                    vendor: best.company,
                    sku: best.sku,
                    label: best.label,
                    unit: best.unit,
                    price: tinybarToHbar(best.price),
                    priceTinybar: best.price,
                    leadMin: Number(best.lead_min),
                    amountTinybar: amount.toString(),
                    withinMax: this.within(BigInt(best.price), maxTb, amount, ok),
                    approvedTinybar: ok?.toString() ?? null,
                    path: storefrontPath(best.vendor_id, best.sku, remaining, { runId, stage: s.code, resource: r.key }),
                  }
                : null,
            });
          }
        }
      }
    }
    return { wallets, needed };
  }
}
