import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { ago, num, shortAddr } from "../../lib/format";
import { Ref, Who } from "../../ui/Name";
import { useSign } from "../../lib/sign";
import type { RunView, StageResourceView, StageResourcesView, StageRunView, TypedSignature } from "../../types";
import { Field, Modal } from "../../ui/kit";

const STATUS: Record<StageResourceView["status"], { label: string; tag: string }> = {
  delivered: { label: "● Delivered", tag: "ok" },
  partial: { label: "◐ Partly bought", tag: "warn" },
  waiting: { label: "○ Waiting", tag: "" },
  waived: { label: "Waived", tag: "warn" },
};
const qty = (n: number, unit: string) => `${num(n, 3)}${unit ? ` ${unit}` : ""}`;

/**
 * What the stage consumes, and how it was bought: the machine of the stage before it buys each resource ahead over
 * x402, from the best vendor's offer within the stage's max price, and the stage starts once each has arrived. A
 * manager can sign a waiver to start without them. Offers and purchases (finance) need level 4.
 */
export function StageResources({ run, stage }: { run: RunView; stage: StageRunView }) {
  const { path, sees, can, live, refresh, book } = useApp();
  const sign = useSign();
  const [view, setView] = useState<StageResourcesView | null>(null);
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const head = live?.headSeq ?? 0;
  const has = (stage.resources ?? []).length > 0;
  const load = useCallback(
    () =>
      api
        .get<StageResourcesView>(path(`/runs/${run.id}/stages/${stage.code}/resources`))
        .then(setView)
        .catch(() => setView(null)),
    [path, run.id, stage.code],
  );
  useEffect(() => {
    if (has && sees(2)) void load();
  }, [load, has, sees, head, stage.state]);
  if (!has || !sees(2)) return null;
  const list = view?.resources ?? [];
  const arrived = list.filter((r) => r.status === "delivered").length;
  const missing = list.some((r) => r.status !== "delivered");
  const canWaive = can("manager") && run.status === "running" && stage.state === "queued" && view && !view.waived && missing;
  const waive = async () => {
    const body = { reason: reason.trim() };
    const r = await sign({
      title: `Start ${stage.code} ${stage.name} without waiting for its resources`,
      request: (chainId) => api.post<TypedSignature>(path(`/runs/${run.id}/stages/${stage.code}/resources/waive/sign-request`), { ...body, chainId }),
      submit: (proof) => api.post(path(`/runs/${run.id}/stages/${stage.code}/resources/waive`), { ...body, ...proof }),
      done: "Waived: the stage may start",
    });
    if (!r) return;
    setWaiving(false);
    setReason("");
    await Promise.all([load(), refresh()]);
  };
  return (
    <section className="dsec">
      <div className="row-between res-head">
        <h3>Resources</h3>
        {view && (
          <span className="faint small">
            {arrived} of {list.length} delivered{view.waived ? " · waived" : ""}
          </span>
        )}
      </div>
      <p className="faint small">The machine of the stage before buys these ahead over x402 from its own Hedera account, within each one&apos;s max price. The stage starts once each has arrived.</p>
      {!view && <p className="faint small">Loading what the stage has received…</p>}
      {view?.waived && (
        <p className="small res-waived">
          <span className="tag warn">Waived</span> <Who address={view.waived.by} fallback={shortAddr(view.waived.by)} /> signed to start without them {ago(view.waived.at)}: <i>{view.waived.reason}</i>
        </p>
      )}
      <div className="oc-grid">
        {list.map((r) => {
          const s = STATUS[r.status];
          const pct = r.need > 0 ? Math.min(1, r.delivered / r.need) : 1;
          return (
            <div key={r.key} className={`oc-card res-card s-${r.status === "delivered" ? "ok" : r.status === "waived" ? "bad" : "na"}`}>
              <div className="pc-h">
                <b>{r.label}</b>
                <span className={`tag ${s.tag}`}>{s.label}</span>
              </div>
              <div className="faint small">
                <span className="mono">{r.kind}</span> · {qty(r.qty, r.unit)} per {r.per === "unit" ? "unit" : "batch"} · at most {r.maxPrice} HBAR per {r.unit || "unit"}
              </div>
              <div className="res-bar" aria-label={`${r.delivered} of ${r.need} delivered`}>
                <div className="progress">
                  <span style={{ width: `${pct * 100}%` }} />
                </div>
                <span className="small mono">
                  {qty(r.delivered, r.unit)} / {qty(r.need, r.unit)}
                  {r.pending > 0 ? ` · ${qty(r.pending, r.unit)} on the way` : ""}
                </span>
              </div>
              {r.bestOffer && (
                <div className="small res-offer">
                  Best offer: <b>{r.bestOffer.vendor}</b>
                  {book.of("vendor", r.bestOffer.vendorId) && (
                    <>
                      {" "}
                      <Ref kind="vendor" id={r.bestOffer.vendorId} link={false} />
                    </>
                  )}{" "}
                  · {r.bestOffer.label} · {r.bestOffer.price} HBAR per {r.bestOffer.unit || "unit"}
                  {r.bestOffer.leadMin ? ` · ${r.bestOffer.leadMin} min lead` : ""}{" "}
                  <span
                    className={`tag ${r.bestOffer.withinMax ? "ok" : "bad"}`}
                    title={
                      r.bestOffer.withinMax
                        ? r.bestOffer.approvedTinybar
                          ? "Above the stage's max price, within a top-up a manager approved: the machine buys it on its own"
                          : "The machine buys it on its own"
                        : "Above the stage's max price: the machine asks the treasury for a top-up the manager approves"
                    }
                  >
                    {r.bestOffer.withinMax ? (r.bestOffer.approvedTinybar ? "top-up approved" : "within max") : "above max"}
                  </span>
                </div>
              )}
              {!r.bestOffer && !view?.redacted && r.status !== "delivered" && <p className="small warn-t">No vendor offers {r.kind}: add an offer in Team → Vendors.</p>}
              {r.purchases.length > 0 && (
                <ul className="res-buys">
                  {r.purchases.map((p) => (
                    <li key={p.id} className="small">
                      <span className={`tag ${p.status === "delivered" ? (p.arrived ? "ok" : "warn") : p.status === "expired" ? "bad" : ""}`}>{p.status === "delivered" ? (p.arrived ? "Delivered" : "Arriving") : p.status === "expired" ? "Not settled" : "Paying"}</span>{" "}
                      {qty(p.qty, p.unit)} · <b>{p.amount} HBAR</b> to {p.vendor}
                      {p.byAsset ? (
                        <>
                          {" "}
                          · bought by <Ref kind="machine" id={p.byAsset} fallback={p.byAssetName ?? p.byAsset} link={false} />
                        </>
                      ) : p.buyer ? (
                        <>
                          {" "}
                          · by <Who hedera={p.buyer} fallback={p.buyer} link={false} />
                        </>
                      ) : (
                        ""
                      )}
                      {p.buyer && p.byAssetName ? <span className="faint mono"> ({p.buyer})</span> : null}
                      <span className="faint"> · {ago(p.at)}</span>
                      <span className="res-links">
                        {p.txUrl && (
                          <a className="link" href={p.txUrl} target="_blank" rel="noreferrer" title={p.txId ?? ""}>
                            HashScan ↗
                          </a>
                        )}
                        {p.auditUrl && (
                          <a className="link" href={p.auditUrl} target="_blank" rel="noreferrer" title="The purchase on the HCS audit topic">
                            HCS audit ↗
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {view?.redacted && <p className="faint small">Offers and purchases need level 4.</p>}
      {canWaive && (
        <div className="btns">
          <button type="button" className="btn" onClick={() => setWaiving(true)} title="Signed: the stage starts without the resources that have not arrived">
            Start without them…
          </button>
        </div>
      )}
      <Modal
        open={waiving}
        onClose={() => setWaiving(false)}
        eyebrow={`Stage ${stage.code} · resources`}
        title="Start without waiting for its resources"
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setWaiving(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={reason.trim().length < 3} onClick={() => void waive()}>
              Sign and waive
            </button>
          </div>
        }
      >
        <p className="muted small">
          {stage.name} is waiting for {list.filter((r) => r.status !== "delivered").map((r) => r.label).join(", ")}. Your signature lets it start without them; the waiver and its reason go on the ledger.
        </p>
        <Field label="Why" hint="For example: stock already on site, or bought outside Ordo">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </Field>
      </Modal>
    </section>
  );
}
