import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { fromUnits } from "../lib/wallet";
import type { FinanceOrder, FinanceParty, FinanceResponse, PackageSummary } from "../types";
import { Action, Empty, Field, Loading, Modal, Tabs, useToast } from "../ui/kit";
import { Name, Ref } from "../ui/Name";
import { MachineBudgets } from "./MachineBudgets";
import { Select } from "../ui/Select";

const STATUS: Record<FinanceOrder["status"], [string, string]> = {
  funding: ["Customer funding…", "warn"],
  open: ["Held · paid on proof", "warn"],
  paid: ["Paid on proof", "ok"],
  refunded: ["Back to the customer", ""],
  failed: ["Failed", "bad"],
};
const TX_LABEL: Record<string, string> = { hold: "Hold", open: "Opened", offer: "Offered", sale: "Sold", paid: "Paid", refund: "Refunded", waive: "Waived" };
const HASHSCAN = "https://hashscan.io/testnet";

const link = (url: string | null | undefined, text: string) =>
  url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span>{text}</span>
  );

/**
 * Pay on proof: a customer's payment for a lot, in Ordo USD (a Stablecoin Studio stablecoin), held by OrdoPayOnProof
 * until OrdoTrust records the lot's three-signature release; until then the plant can sell the receivable for cash now.
 */
function PayOnProof() {
  const { path, can, book } = useApp();
  const [data, setData] = useState<FinanceResponse | null>(null);
  const [adding, setAdding] = useState<"customer" | "financier" | null>(null);
  const [cashIn, setCashIn] = useState<FinanceParty | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [offering, setOffering] = useState<FinanceOrder | null>(null);
  const toast = useToast();
  const load = useCallback(() => api.get<FinanceResponse>(path("/finance")).then(setData), [path]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return <Loading />;
  const coin = data.coin;
  const sym = coin?.symbol ?? "OUSD";
  const unit = (x: string | null) => (x === null ? "—" : `${fromUnits(x, coin?.decimals ?? 6)} ${sym}`);
  const manage = can("manager") && data.live;
  const queued = async (p: Promise<unknown>, msg: string) => {
    await p;
    toast(msg, "ok");
    await load();
  };
  const financiers = data.parties.filter((p) => p.kind === "financier" && p.status === "active");

  return (
    <div>
      {!data.live ? (
        <div className="notice">
          <b>Pay on proof is off.</b> Run <span className="mono">stablecoin</span> and <span className="mono">payonproof</span> in Hedera setup: it creates Ordo USD with Stablecoin Studio and deploys <span className="mono">OrdoPayOnProof</span>.
        </div>
      ) : (
        <div className="notice ok">
          <b>
            {sym} by {coin!.studio}
          </b>{" "}
          <span className="mono small">{link(`${HASHSCAN}/contract/${coin!.address}`, shortAddr(coin!.address))}</span> · held by <span className="mono small">{link(`${HASHSCAN}/contract/${coin!.contract}`, `OrdoPayOnProof ${shortAddr(coin!.contract)}`)}</span>
          <p className="small">
            A customer locks the price of a lot in a Stablecoin Studio hold that only OrdoPayOnProof can release, and only when OrdoTrust records the lot's validation release: performed, reviewed and approved by three different people. Until then the plant can sell the receivable to a financier for cash now; the financier is paid in full on proof. If the lot is
            never proven, the customer has its money back when the hold expires.
          </p>
        </div>
      )}

      <section className="section">
        <div className="section-h">
          <h2>Accounts</h2>
          {manage && (
            <div className="btns">
              <button type="button" className="btn sm" onClick={() => setAdding("customer")}>
                Add customer
              </button>
              <button type="button" className="btn sm" onClick={() => setAdding("financier")}>
                Add financier
              </button>
            </div>
          )}
        </div>
        {data.parties.length === 0 ? (
          <Empty title="No accounts yet">Add a customer: Ordo opens a Hedera account for it, and you cash in Ordo USD for it to pay with. The plant's own account opens with its first order.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Party</th>
                  <th>Account</th>
                  <th className="r">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.parties.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.name}</b>
                      <div className="small">
                        {p.kind === "plant" ? book.org ? <Name name={book.org} link={false} /> : null : <Ref kind={p.kind === "financier" ? "financier" : "customer"} id={p.id} fallback={null} link={false} />}
                      </div>
                      <div className="faint small">{p.kind === "plant" ? "This plant: paid on proof" : p.kind}</div>
                    </td>
                    <td className="small">
                      {p.status === "active" ? (
                        <span className="mono">{link(p.accountUrl, p.accountId ?? shortAddr(p.address ?? ""))}</span>
                      ) : p.status === "opening" ? (
                        <span className="muted">Opening…{p.error && <span className="field-e"> {p.error}</span>}</span>
                      ) : (
                        <span className="field-e">{p.error}</span>
                      )}
                    </td>
                    <td className="r">{unit(p.balance)}</td>
                    <td className="r">
                      {manage && p.status === "active" && p.kind !== "plant" && (
                        <button type="button" className="btn sm" onClick={() => setCashIn(p)}>
                          Cash in
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-h">
          <h2>Paid on proof</h2>
          {manage && (
            <button type="button" className="btn accent sm" onClick={() => setOrdering(true)} disabled={!data.parties.some((p) => p.kind === "customer" && p.status === "active")}>
              New order
            </button>
          )}
        </div>
        {data.orders.length === 0 ? (
          <Empty title="No orders yet">Tie a customer's payment to a lot's validation package: it is paid when the package is released on-chain, and not before.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Lot</th>
                  <th>Customer → paid to</th>
                  <th className="r">Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => {
                  const [label, tone] = STATUS[o.status];
                  return (
                    <tr key={o.id}>
                      <td>
                        <b>{o.packageTitle}</b>
                        {o.runId && (
                          <div className="small">
                            <Ref kind="run" id={o.runId} fallback={null} link={false} />
                          </div>
                        )}
                        <div className="faint small">
                          package {o.packageStatus.replace("_", " ")} · opened {ago(o.createdAt)}
                          {o.runId && (
                            <>
                              {" "}
                              · <a href={`#/passport/${o.runId}`}>passport</a>
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        {o.customer.name} → <b>{o.payee.name}</b>
                        {o.payee.kind === "financier" && <div className="faint small">bought the receivable</div>}
                      </td>
                      <td className="r">
                        {unit(o.amount)}
                        {o.ask && <div className="faint small">for sale at {unit(o.ask)}</div>}
                      </td>
                      <td>
                        <span className={`tag ${tone}`}>{label}</span>
                        <div className="faint small">
                          {o.txs.map((t, i) => (
                            <span key={t.hash + i}>
                              {i > 0 && " · "}
                              {link(t.url, TX_LABEL[t.kind] ?? t.kind)}
                            </span>
                          ))}
                          {o.status === "open" && <> · refunds {dateTime(o.expiresAt)}</>}
                        </div>
                        {o.note && <div className="small muted">{o.note}</div>}
                        {o.error && <div className="small field-e">{o.error}</div>}
                      </td>
                      <td className="r">
                        {manage && o.status === "open" && o.payee.kind === "plant" && (
                          <div className="btns end">
                            {!o.ask ? (
                              <button type="button" className="btn sm" onClick={() => setOffering(o)}>
                                Sell receivable
                              </button>
                            ) : (
                              financiers.map((f) => (
                                <Action key={f.id} className="btn sm accent" onClick={() => queued(api.post(path(`/finance/orders/${o.id}/take`), { financierId: f.id }), `${f.name} is buying it`)}>
                                  {f.name} buys
                                </Action>
                              ))
                            )}
                            <Action className="btn sm" onClick={() => queued(api.post(path(`/finance/orders/${o.id}/waive`)), "Waiving: the customer gets it back")}>
                              Waive
                            </Action>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AddParty kind={adding} onClose={() => setAdding(null)} onDone={load} />
      <AmountModal
        open={Boolean(cashIn)}
        onClose={() => setCashIn(null)}
        eyebrow="Stablecoin Studio cash-in"
        title={`Cash in ${sym} to ${cashIn?.name ?? ""}`}
        hint="The customer's deposit, minted to its account by the stablecoin's cash-in role."
        symbol={sym}
        submit={(amount) => queued(api.post(path(`/finance/parties/${cashIn!.id}/cash-in`), { amount }), `Cashing in ${amount} ${sym}`)}
      />
      <AmountModal
        open={Boolean(offering)}
        onClose={() => setOffering(null)}
        eyebrow="Supply-chain finance"
        title={`Sell the ${offering ? unit(offering.amount) : ""} receivable`}
        hint="The asking price, below the amount: a financier pays it now and is paid the full amount on proof."
        symbol={sym}
        submit={(ask) => queued(api.post(path(`/finance/orders/${offering!.id}/offer`), { ask }), "Offering the receivable")}
      />
      <NewOrder open={ordering} onClose={() => setOrdering(false)} customers={data.parties.filter((p) => p.kind === "customer" && p.status === "active")} symbol={sym} onDone={load} />
    </div>
  );
}

function AddParty({ kind, onClose, onDone }: { kind: "customer" | "financier" | null; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { path } = useApp();
  const [name, setName] = useState("");
  return (
    <Modal
      open={Boolean(kind)}
      onClose={onClose}
      eyebrow="New account"
      title={kind === "financier" ? "Add a financier" : "Add a customer"}
      footer={
        <div className="btns end">
          <Action
            className="btn accent"
            disabled={name.trim().length < 2}
            onClick={async () => {
              await api.post(path("/finance/parties"), { kind, name: name.trim() });
              setName("");
              onClose();
              await onDone();
            }}
          >
            Open account
          </Action>
        </div>
      }
    >
      <p className="small muted">Ordo opens a Hedera account for it, with a little HBAR for gas, that holds Ordo USD. Its key stays sealed in Ordo.</p>
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "financier" ? "Lotus Capital" : "Tata Motors"} />
      </Field>
    </Modal>
  );
}

function AmountModal(p: { open: boolean; onClose: () => void; eyebrow: string; title: string; hint: string; symbol: string; submit: (amount: string) => Promise<unknown> }) {
  const [amount, setAmount] = useState("");
  const valid = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  return (
    <Modal
      open={p.open}
      onClose={p.onClose}
      eyebrow={p.eyebrow}
      title={p.title}
      footer={
        <div className="btns end">
          <Action
            className="btn accent"
            disabled={!valid}
            onClick={async () => {
              await p.submit(amount);
              setAmount("");
              p.onClose();
            }}
          >
            Confirm
          </Action>
        </div>
      }
    >
      <p className="small muted">{p.hint}</p>
      <Field label={`Amount (${p.symbol})`}>
        <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="500" />
      </Field>
    </Modal>
  );
}

function NewOrder({ open, onClose, customers, symbol, onDone }: { open: boolean; onClose: () => void; customers: FinanceParty[]; symbol: string; onDone: () => Promise<unknown> }) {
  const { path } = useApp();
  const [pkgs, setPkgs] = useState<PackageSummary[]>([]);
  const [pkg, setPkg] = useState("");
  const [customer, setCustomer] = useState("");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("30");
  useEffect(() => {
    if (open) void api.get<PackageSummary[]>(path("/validation")).then((l) => setPkgs(l.filter((p) => p.status !== "released" && p.status !== "rejected")));
  }, [open, path]);
  const valid = pkg && customer && /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0 && /^\d+$/.test(days) && Number(days) >= 1;
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Pay on proof"
      title="A customer pays for a lot, on proof"
      footer={
        <div className="btns end">
          <Action
            className="btn accent"
            disabled={!valid}
            onClick={async () => {
              await api.post(path("/finance/orders"), { packageId: pkg, customerId: customer, amount, days: Number(days) });
              onClose();
              await onDone();
            }}
          >
            Hold the payment
          </Action>
        </div>
      }
    >
      <p className="small muted">The customer locks the amount in a Stablecoin Studio hold, committed to this package and this plant. OrdoPayOnProof pays it out only when OrdoTrust records the package's release.</p>
      <Field label="Validation package">
        <Select value={pkg || null} onChange={setPkg} options={pkgs.map((p) => ({ value: p.id, label: `${p.code} ${p.title}` }))} placeholder="Choose a package…" emptyText="No packages yet" />
      </Field>
      <Field label="Customer">
        <Select value={customer || null} onChange={setCustomer} options={customers.map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose a customer…" emptyText="No active customers" />
      </Field>
      <div className="grid2">
        <Field label={`Amount (${symbol})`}>
          <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="500" />
        </Field>
        <Field label="Refunded after (days)">
          <input className="input" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
    </Modal>
  );
}

// ---- Finance: pay on proof, and machine budgets from the org's treasury (OrdoTreasury) ----
type FinanceTab = "pay" | "budgets";
export function Finance() {
  const [tab, setTab] = useState<FinanceTab>("pay");
  return (
    <div>
      <div className="eyebrow">Paid on proof, spent with approval</div>
      <h1>Finance</h1>
      <Tabs<FinanceTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "pay", label: "Pay on proof" },
          { value: "budgets", label: "Machine budgets" },
        ]}
      />
      {tab === "pay" ? <PayOnProof /> : <MachineBudgets />}
    </div>
  );
}
