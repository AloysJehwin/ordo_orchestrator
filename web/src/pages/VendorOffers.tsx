import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import type { OfferView, SupplierView } from "../types";
import { Action, Field, Loading, Modal, useToast } from "../ui/kit";
import { Ref, Who } from "../ui/Name";

interface Form {
  kind: string;
  sku: string;
  label: string;
  unit: string;
  price: string;
  leadMin: string;
}
const blank: Form = { kind: "", sku: "", label: "", unit: "", price: "", leadMin: "0" };
const KIND_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SKU_RE = /^[A-Za-z0-9][\w.-]{0,47}$/;
const PRICE_RE = /^\d{1,10}(\.\d{1,8})?$/;

/**
 * What vendors sell for stages to consume: each offer a kind (what a stage's resource names), a SKU, a price in HBAR
 * per unit and a lead time. Machines buy them over x402 at the storefront, paid straight to the vendor's Hedera
 * account; the demo supplier is paid to the operator. A manager adds, edits and archives offers.
 */
export function VendorOffers() {
  const { path, can, sees } = useApp();
  const toast = useToast();
  const [data, setData] = useState<{ suppliers: SupplierView[]; storefront: boolean; receiptSigner: string } | null>(null);
  const [edit, setEdit] = useState<{ vendor: SupplierView; offer: OfferView | null } | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const load = useCallback(
    () =>
      api
        .get<{ suppliers: SupplierView[]; storefront: boolean; receiptSigner: string }>(path("/vendors/offers"))
        .then(setData)
        .catch(() => setData({ suppliers: [], storefront: false, receiptSigner: "" })),
    [path],
  );
  useEffect(() => {
    if (sees(4)) void load();
  }, [load, sees]);
  if (!sees(4)) return null;
  if (!data) return <Loading />;
  const manager = can("manager");
  const open = (vendor: SupplierView, offer: OfferView | null) => {
    setForm(offer ? { kind: offer.kind, sku: offer.sku, label: offer.label, unit: offer.unit, price: offer.price, leadMin: String(offer.leadMin) } : blank);
    setEdit({ vendor, offer });
  };
  const valid = KIND_RE.test(form.kind) && SKU_RE.test(form.sku) && form.label.trim().length > 0 && PRICE_RE.test(form.price.trim()) && Number(form.price) > 0 && /^\d+$/.test(form.leadMin || "0");
  const save = async () => {
    if (!edit) return;
    const body = { kind: form.kind, label: form.label.trim(), unit: form.unit.trim(), price: form.price.trim(), leadMin: Number(form.leadMin || 0) };
    const base = path(`/vendors/${edit.vendor.id}/offers`);
    if (edit.offer) await api.patch(`${base}/${edit.offer.id}`, body);
    else await api.post(base, { ...body, sku: form.sku.trim() });
    toast(edit.offer ? "Offer updated" : "Offer added", "ok");
    setEdit(null);
    await load();
  };
  const archive = async (v: SupplierView, o: OfferView) => {
    await api.del(path(`/vendors/${v.id}/offers/${o.id}`));
    toast(`${o.sku} archived`, "ok");
    await load();
  };
  return (
    <section className="section offers">
      <div className="section-h">
        <h2>Offers</h2>
      </div>
      <p className="muted lede">
        What vendors sell for stages to consume. A stage&apos;s machine buys the cheapest offer of each resource&apos;s kind over x402, paid straight to the vendor&apos;s Hedera account
        {data.storefront ? "" : " (the storefront is off on this deployment: it needs a Hedera network and operator)"}. Every delivery comes with a receipt Ordo signs.
      </p>
      {data.suppliers.map((v) => (
        <div key={v.id} className="card offers-card">
          <div className="row-between">
            <div>
              <b>{v.company}</b> {v.demo && <span className="tag">Demo supplier</span>}
              <div className="small">
                <Ref kind="vendor" id={v.id} fallback={null} />
              </div>
              <div className="faint small">
                {v.payTo ? (
                  <>
                    Paid to <Who hedera={/^0\.0\.\d+$/.test(v.payTo) ? v.payTo : null} address={/^0x/i.test(v.payTo) ? v.payTo : null} link={false} />
                  </>
                ) : (
                  "No Hedera account: its offers cannot be bought"
                )}
              </div>
            </div>
            {manager && (
              <button type="button" className="btn sm" onClick={() => open(v, null)}>
                Add offer
              </button>
            )}
          </div>
          {v.offers.length === 0 ? (
            <p className="faint small">No offers yet.</p>
          ) : (
            <div className="scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Offer</th>
                    <th>SKU</th>
                    <th>Price</th>
                    <th>Lead</th>
                    {manager && <th />}
                  </tr>
                </thead>
                <tbody>
                  {v.offers.map((o) => (
                    <tr key={o.id}>
                      <td className="mono small">{o.kind}</td>
                      <td>{o.label}</td>
                      <td className="mono small">{o.sku}</td>
                      <td className="num">
                        {o.price} HBAR / {o.unit || "unit"}
                      </td>
                      <td>{o.leadMin ? `${o.leadMin} min` : "—"}</td>
                      {manager && (
                        <td className="offers-act">
                          <button type="button" className="link" onClick={() => open(v, o)}>
                            Edit
                          </button>
                          <Action className="link danger" onClick={() => archive(v, o)}>
                            Archive
                          </Action>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      <Modal
        open={Boolean(edit)}
        onClose={() => setEdit(null)}
        eyebrow={edit?.vendor.company ?? "Offers"}
        title={edit?.offer ? `Edit ${edit.offer.sku}` : "Add an offer"}
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <Action className="btn primary" disabled={!valid} onClick={save}>
              {edit?.offer ? "Save" : "Add offer"}
            </Action>
          </div>
        }
      >
        <div className="form-grid two">
          <Field label="Kind" hint="What a stage's resource names, e.g. argon" error={form.kind && !KIND_RE.test(form.kind) ? "Lowercase letters, digits and _" : null}>
            <input className="input mono" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value.trim().toLowerCase() })} autoFocus />
          </Field>
          <Field label="SKU" error={form.sku && !SKU_RE.test(form.sku) ? "Letters, digits, dots, dashes and _" : null}>
            <input className="input mono" value={form.sku} disabled={Boolean(edit?.offer)} onChange={(e) => setForm({ ...form, sku: e.target.value.trim() })} />
          </Field>
        </div>
        <Field label="Description">
          <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Argon 5.0 (99.999 %)" />
        </Field>
        <div className="form-grid two">
          <Field label="Price (HBAR per unit)" error={form.price && !PRICE_RE.test(form.price.trim()) ? "A positive amount, at most 8 decimals" : null}>
            <input className="input" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="Unit">
            <input className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="m³, kg, L, h, pcs" />
          </Field>
        </div>
        <Field label="Lead time (min)" hint="How long after payment it arrives; the stage waits for it">
          <input className="input" type="number" min={0} value={form.leadMin} onChange={(e) => setForm({ ...form, leadMin: e.target.value })} />
        </Field>
      </Modal>
    </section>
  );
}
