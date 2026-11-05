import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { KEY_RE, outcomeKey } from "../lib/outcomes";
import type { OfferView, StageResource, SupplierView } from "../types";
import { Select } from "../ui/Select";

const KIND_RE = /^[a-z][a-z0-9_]{1,39}$/;
const cache = new Map<string, Promise<OfferView[]>>();

/** The offers vendors list for this org (Team → Vendors), to suggest kinds and show what each costs. Managers only. */
function useOffers(): OfferView[] {
  const { path, can } = useApp();
  const [offers, setOffers] = useState<OfferView[]>([]);
  useEffect(() => {
    if (!can("manager")) return;
    const url = path("/vendors/offers");
    if (!cache.has(url)) cache.set(url, api.get<{ suppliers: SupplierView[] }>(url).then((r) => r.suppliers.filter((s) => s.payTo).flatMap((s) => s.offers)).catch(() => []));
    let on = true;
    void cache.get(url)!.then((o) => on && setOffers(o));
    return () => {
      on = false;
    };
  }, [path, can]);
  return offers;
}

/** What is wrong with a stage's resources, as the builder blocks publishing on it. */
export function resourceErrors(resources: StageResource[] = []): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const r of resources) {
    const name = r.label || r.key || "A resource";
    if (!r.label.trim()) out.push("Every resource has a name");
    if (!KEY_RE.test(r.key)) out.push(`${name}: its key is lowercase letters, digits and _`);
    if (keys.has(r.key)) out.push(`Two resources use the key ${r.key}`);
    keys.add(r.key);
    if (!KIND_RE.test(r.kind)) out.push(`${name}: its kind is lowercase letters, digits and _ (what vendors file their offers under)`);
    if (!(r.qty > 0)) out.push(`${name}: its quantity must be above zero`);
    if (!(r.maxPrice > 0)) out.push(`${name}: its max price must be above zero`);
  }
  return out;
}

/**
 * What a stage consumes: each resource's kind (what vendors' offers are filed under), quantity per batch or per unit
 * of the run, and the most the machine may pay per unit in HBAR. The machine of the stage before buys them ahead over
 * x402; the stage starts once each has arrived.
 */
export function ResourcesEditor({ resources = [], editable, onChange }: { resources?: StageResource[]; editable: boolean; onChange: (r: StageResource[]) => void }) {
  const offers = useOffers();
  const cheapest = useMemo(() => {
    const m = new Map<string, OfferView>();
    for (const o of offers) if (!m.has(o.kind) || Number(o.price) < Number(m.get(o.kind)!.price)) m.set(o.kind, o);
    return m;
  }, [offers]);
  const kinds = [...cheapest.keys()].sort();
  const set = (i: number, p: Partial<StageResource>) => onChange(resources.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const taken = (i: number) => resources.filter((_, j) => j !== i).map((x) => x.key);
  const add = () => onChange([...resources, { key: outcomeKey("resource", resources.map((r) => r.key)), label: "", kind: "", unit: "", qty: 1, per: "batch", maxPrice: 1 }]);
  /** picking a kind with an offer fills the unit and a max price a little above the cheapest offer */
  const pickKind = (i: number, kind: string) => {
    const r = resources[i]!;
    const o = cheapest.get(kind);
    set(i, { kind, ...(o && !r.unit ? { unit: o.unit } : {}), ...(o && r.maxPrice === 1 ? { maxPrice: Math.ceil(Number(o.price) * 1.25 * 1e6) / 1e6 } : {}), ...(o && !r.label ? { label: o.label, key: outcomeKey(o.label, taken(i)) } : {}) });
  };
  return (
    <div className="outcomes-ed">
      <div className="section-h spread">
        <span className="field-l">Resources it consumes</span>
        <span className="small faint">{resources.length || "none"}</span>
      </div>
      <p className="faint small">The machine of the stage before buys these ahead over x402, from its own Hedera account, at no more than the max price. The stage starts once each has arrived.</p>
      <datalist id="ordo-resource-kinds">
        {kinds.map((k) => (
          <option key={k} value={k}>
            {cheapest.get(k)!.label}
          </option>
        ))}
      </datalist>
      {resources.map((r, i) => {
        const o = cheapest.get(r.kind);
        return (
          <div key={i} className="oc-ed">
            <div className="crit">
              <input
                className="input sm"
                value={r.label}
                placeholder="Name, e.g. Shielding argon"
                aria-label="Resource name"
                onChange={(e) => set(i, { label: e.target.value, ...(r.key === outcomeKey(r.label || "resource", taken(i)) ? { key: outcomeKey(e.target.value || "resource", taken(i)) } : {}) })}
              />
              {editable && (
                <button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(resources.filter((_, j) => j !== i))}>
                  ×
                </button>
              )}
            </div>
            <div className="crit">
              <input className="input sm sig" list="ordo-resource-kinds" value={r.kind} placeholder="kind, e.g. argon" aria-label="Kind" title="What vendors' offers of it are filed under" onChange={(e) => pickKind(i, e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40))} />
              <input className="input sm sig" value={r.key} aria-label="Key" title="The key purchases are recorded under" onChange={(e) => set(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32) })} />
            </div>
            <div className="crit">
              <input className="input sm num" type="number" min={0} step="any" value={r.qty} aria-label="Quantity" onChange={(e) => set(i, { qty: Number(e.target.value) })} />
              <input className="input sm unit" value={r.unit} placeholder="unit" aria-label="Unit" onChange={(e) => set(i, { unit: e.target.value })} />
              <Select size="sm" width={104} value={r.per} onChange={(v) => set(i, { per: v as StageResource["per"] })} options={[{ value: "batch", label: "per batch" }, { value: "unit", label: "per unit" }]} searchable={false} disabled={!editable} />
            </div>
            <div className="crit">
              <span className="faint small">at most</span>
              <input className="input sm num" type="number" min={0} step="any" value={r.maxPrice} aria-label="Max price, HBAR per unit" onChange={(e) => set(i, { maxPrice: Number(e.target.value) })} />
              <span className="faint small">HBAR per {r.unit || "unit"}</span>
            </div>
            {o && (
              <p className={`small ${Number(o.price) > r.maxPrice ? "warn-t" : "faint"}`}>
                Cheapest offer: {o.vendor} at {o.price} HBAR per {o.unit || "unit"}
                {Number(o.price) > r.maxPrice ? ": above the max price, so the machine asks the treasury for a top-up the manager approves" : ""}
              </p>
            )}
            {r.kind && !o && offers.length > 0 && <p className="small warn-t">No vendor offers {r.kind} yet: add an offer in Team → Vendors, or the stage waits for a waiver.</p>}
          </div>
        );
      })}
      {editable && resources.length < 12 && (
        <div className="oc-add">
          <button type="button" className="chip-btn" onClick={add}>
            + Resource
          </button>
        </div>
      )}
    </div>
  );
}
