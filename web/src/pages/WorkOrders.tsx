import { useCallback, useEffect, useState } from "react";
import { parseUnits } from "viem";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { useSign } from "../lib/sign";
import { fromUnits, fundTx } from "../lib/wallet";
import type { AssessmentView, TypedSignature, WorkOrderStatus, WorkOrdersResponse, WorkOrderView } from "../types";
import { Action, Empty, Field, Loading, Modal, useToast } from "../ui/kit";
import { Ref } from "../ui/Name";

const STATUS: Record<WorkOrderStatus, [string, string]> = {
  unassigned: ["No vendor", "warn"],
  assigned: ["Vendor assigned · not escrowed", ""],
  escrowing: ["Escrowing…", "warn"],
  escrowed: ["Escrowed · awaiting sign-off", "warn"],
  escrow_failed: ["Escrow failed", "bad"],
  releasing: ["Paying…", "warn"],
  released: ["Paid", "ok"],
  refunded: ["Expired · refunded", ""],
};

const link = (url: string | null | undefined, text: string) =>
  url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span>{text}</span>
  );

/** The maintenance agent's spending: the site's fund, caps an admin signed, the kill switch, and every work order it paid for. */
const ZONE_TONE = { A: "ok", B: "ok", C: "warn", D: "bad" } as const;

/** The vibration assessment the agent bought for the work order, and the HBAR payment it made for it over x402. */
function Assessment({ a }: { a: AssessmentView | null }) {
  if (!a) return null;
  if (a.status === "pending") return <div className="small muted">Buying a vibration assessment over x402…</div>;
  if (a.status === "failed") return <div className="small field-e">x402 assessment failed: {a.error}</div>;
  if (a.skipped || !a.assessment) return <div className="small faint">No assessment: {a.skipped}</div>;
  const x = a.assessment;
  return (
    <div className="small" title={`${x.standard} · ${x.samples} readings · peak ${x.peak} mm/s · trend ${x.slopePerHour} mm/s per hour`}>
      <span className={`tag ${ZONE_TONE[x.zone]}`}>Zone {x.zone}</span> {x.level} mm/s · {x.verdict}
      {a.payment && <> · {link(a.payment.url, "paid via x402")}</>}
    </div>
  );
}

export function WorkOrders() {
  const { path, me, siteId, status, can, names } = useApp();
  const [data, setData] = useState<WorkOrdersResponse | null>(null);
  const [capsOpen, setCapsOpen] = useState(false);
  const [fundOpen, setFundOpen] = useState(false);
  const sign = useSign();
  const toast = useToast();
  const load = useCallback(() => api.get<WorkOrdersResponse>(path("/work-orders")).then(setData), [path]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return <Loading />;
  const { setup, items } = data;
  const dec = setup.decimals ?? 8;
  const sym = setup.symbol ?? "";
  const unit = (x: string | null) => (x === null ? "—" : setup.configured ? `${fromUnits(x, dec)} ${sym}` : x);
  const onchain = setup.onchain && "funds" in setup.onchain ? setup.onchain : null;
  const explorer = setup.explorerUrl?.replace(/\/$/, "");

  const release = async (w: WorkOrderView) => {
    const r = await sign({
      title: `Work done: pay ${w.vendor?.company} ${unit(w.amount)}`,
      request: () => api.post<TypedSignature>(path(`/work-orders/${w.id}/release/sign-request`)),
      submit: (proof) => api.post(path(`/work-orders/${w.id}/release`), proof),
    });
    if (r) await load();
  };
  const pause = async (stop: boolean) => {
    const r = await sign({
      title: stop ? "Stop the maintenance agent from spending" : "Let the maintenance agent spend again",
      request: () => api.post<TypedSignature>(path("/work-orders/pause/sign-request"), { stop }),
      submit: (proof) => api.put(path("/work-orders/pause"), { stop, ...proof }),
    });
    if (r) await load();
  };

  return (
    <div>
      {!setup.configured ? (
        <div className="notice">
          <b>Agent payments are off.</b> Work orders still assign a vendor, but nothing is escrowed. Deploy <span className="mono">OrdoWorkOrders</span> and set <span className="mono">TRUST_WORKORDERS_ADDRESS</span> and the agent's account to let the agent pay.
        </div>
      ) : (
        <div className={`notice ${onchain && !onchain.paused && setup.agent && setup.caps ? "ok" : "warn"}`}>
          <b>OrdoWorkOrders on {setup.chainName}</b> <span className="mono small">{link(explorer && setup.contract ? `${explorer}/contract/${setup.contract}` : null, shortAddr(setup.contract ?? ""))}</span>
          <p className="small">
            The maintenance agent escrows from its own account
            {setup.agent ? (
              <>
                {" "}
                <span className="mono">{link(explorer ? `${explorer}/account/${setup.agent.address}` : null, names.get(setup.agent.address.toLowerCase()) ?? shortAddr(setup.agent.address))}</span>
                {setup.agent.via === "hedera-agent-kit" ? " through Hedera Agent Kit" : ""}
              </>
            ) : (
              " (no agent account configured)"
            )}
            , only to vendors holding this site's vendor credential, within the caps below. A maintenance lead's signature pays the vendor; an escrow nobody releases returns to the fund after 72 hours.
          </p>
          {!setup.siteRegistered && <p className="small">Register the org on-chain first (Settings → On-chain).</p>}
          {setup.onchain && "error" in setup.onchain && <p className="small field-e">Chain unreachable: {setup.onchain.error}</p>}
        </div>
      )}

      {setup.configured && (
        <div className="kpis three">
          <div className="kpi">
            <div className="label">Site fund</div>
            <div className="v">{onchain ? unit(onchain.funds) : "—"}</div>
            <div className="s">
              <button type="button" className="btn sm" onClick={() => setFundOpen(true)} disabled={!setup.siteRegistered || !status.trust?.workOrders}>
                Add funds
              </button>
            </div>
          </div>
          <div className="kpi">
            <div className="label">Agent caps</div>
            <div className="v">{onchain && onchain.perOrder !== "0" ? `${unit(onchain.perOrder)} / order` : "Not set"}</div>
            <div className="s">
              {onchain && onchain.perDay !== "0" ? `${unit(onchain.perDay)} a day · ${unit(onchain.spentToday)} used today` : "The agent cannot spend until an admin signs caps"}
              {can("manager") && (
                <button type="button" className="btn sm" onClick={() => setCapsOpen(true)} disabled={!setup.agent || !setup.siteRegistered}>
                  Set caps
                </button>
              )}
            </div>
          </div>
          <div className="kpi">
            <div className="label">Agent spending</div>
            <div className="v">{onchain ? (onchain.paused ? "Stopped" : "Allowed") : "—"}</div>
            <div className="s">
              {setup.capsRelay?.status === "failed" && <span className="field-e">Caps not on-chain: {setup.capsRelay.error}</span>}
              {can("manager") && onchain && (
                <Action className={`btn sm${onchain.paused ? " accent" : ""}`} onClick={() => pause(!onchain.paused)}>
                  {onchain.paused ? "Resume agent" : "Stop agent"}
                </Action>
              )}
            </div>
          </div>
        </div>
      )}

      <section className="section">
        <div className="section-h">
          <h2>Work orders</h2>
        </div>
        {items.length === 0 ? (
          <Empty title="No work orders yet">When an asset drifts toward a limit, the maintenance agent proposes a work order; once approved (or on its own at L4) it assigns an onboarded vendor and escrows the payment.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Work order</th>
                  <th>Vendor</th>
                  <th className="r">Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((w) => {
                  const [label, tone] = STATUS[w.status];
                  return (
                    <tr key={w.id}>
                      <td>
                        <b>{w.title}</b>
                        <div className="faint small">
                          <Ref kind="workorder" id={w.id} link={false} /> · {w.priority} · opened {ago(w.createdAt)}
                          {w.runId && (
                            <>
                              {" "}
                              · <a href={`#/pipelines/${w.runId}`}>run</a>
                            </>
                          )}
                        </div>
                        <Assessment a={w.assessment} />
                      </td>
                      <td>{w.vendor ? w.vendor.company : <span className="faint">Onboard a vendor</span>}</td>
                      <td className="r">{unit(w.amount)}</td>
                      <td>
                        <span className={`tag ${tone}`}>{label}</span>
                        <div className="faint small">
                          {w.escrow && link(w.escrow.url, "Escrow tx")}
                          {w.escrow?.expiresAt && w.status === "escrowed" && ` · refundable ${dateTime(w.escrow.expiresAt)}`}
                          {w.refundSchedule?.url && (w.status === "escrowed" || w.status === "refunded") && (
                            <>
                              {" · "}
                              {link(w.refundSchedule.url, w.status === "refunded" && w.refundSchedule.status === "executed" ? "Refunded by Hedera schedule" : "Refund scheduled on Hedera")}
                            </>
                          )}
                          {w.release?.txUrl && <> · {link(w.release.txUrl, "Payment tx")}</>}
                          {w.release?.status === "failed" && <span className="field-e"> {w.release.error}</span>}
                          {w.error && w.status === "escrow_failed" && <span className="field-e"> {w.error}</span>}
                        </div>
                      </td>
                      <td className="r">
                        {w.status === "escrowed" && can("manager") && w.vendor?.address !== me.user!.address && (
                          <Action className="btn accent sm" onClick={() => release(w)}>
                            Sign off and pay
                          </Action>
                        )}
                        {w.assessment?.status === "failed" && can("manager") && (
                          <Action
                            className="btn sm"
                            onClick={async () => {
                              await api.post(path(`/work-orders/${w.id}/assessment/retry`));
                              await load();
                            }}
                          >
                            Retry assessment
                          </Action>
                        )}
                        {w.status === "escrow_failed" && can("manager") && (
                          <Action
                            className="btn sm"
                            onClick={async () => {
                              await api.post(path(`/work-orders/${w.id}/retry`));
                              await load();
                            }}
                          >
                            Retry escrow
                          </Action>
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

      <CapsModal open={capsOpen} onClose={() => setCapsOpen(false)} decimals={dec} symbol={sym} onDone={load} />
      <Modal
        open={fundOpen}
        onClose={() => setFundOpen(false)}
        eyebrow="Site fund"
        title="Add funds for the maintenance agent"
        footer={<FundButton siteId={siteId} onDone={async () => (setFundOpen(false), await load())} toast={toast} expected={me.user!.address} />}
      >
        <p className="small muted">Sent from your wallet to OrdoWorkOrders and held for this site. Only the agent can spend it, within its caps, and only into escrow a maintenance lead releases. An admin can withdraw what is not escrowed.</p>
        <Field label={`Amount (${sym})`}>
          <input className="input" id="fund-amount" inputMode="decimal" placeholder="25" />
        </Field>
      </Modal>
    </div>
  );
}

function FundButton({ siteId, expected, onDone, toast }: { siteId: string; expected: string; onDone: () => Promise<unknown>; toast: ReturnType<typeof useToast> }) {
  const { status } = useApp();
  return (
    <div className="btns end">
      <Action
        className="btn accent"
        onClick={async () => {
          const amount = (document.getElementById("fund-amount") as HTMLInputElement | null)?.value.trim() ?? "";
          if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter an amount");
          const hash = await fundTx(status.trust!, expected, siteId, amount);
          toast(`Transaction sent: ${hash.slice(0, 10)}…`, "ok");
          setTimeout(() => void onDone(), 4000);
        }}
      >
        Send from wallet
      </Action>
    </div>
  );
}

function CapsModal({ open, onClose, decimals, symbol, onDone }: { open: boolean; onClose: () => void; decimals: number; symbol: string; onDone: () => Promise<unknown> }) {
  const { path } = useApp();
  const sign = useSign();
  const [perOrder, setPerOrder] = useState("5");
  const [perDay, setPerDay] = useState("15");
  const valid = /^\d+(\.\d+)?$/.test(perOrder) && /^\d+(\.\d+)?$/.test(perDay) && Number(perOrder) > 0 && Number(perOrder) <= Number(perDay);
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Agent spending caps"
      title="How much may the agent escrow?"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!valid}
            onClick={async () => {
              const body = { perOrder: parseUnits(perOrder, decimals).toString(), perDay: parseUnits(perDay, decimals).toString() };
              const r = await sign({
                title: `Agent caps: ${perOrder} ${symbol} per order, ${perDay} ${symbol} a day`,
                request: () => api.post<TypedSignature>(path("/work-orders/caps/sign-request"), body),
                submit: (proof) => api.put(path("/work-orders/caps"), { ...body, ...proof }),
              });
              if (r) {
                await onDone();
                onClose();
              }
            }}
          >
            Sign caps
          </Action>
        </div>
      }
    >
      <p className="small muted">Your signature is checked by the contract: no one, Ordo's relayer included, can raise these limits without a site admin signing again.</p>
      <div className="grid2">
        <Field label={`Per work order (${symbol})`}>
          <input className="input" value={perOrder} onChange={(e) => setPerOrder(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label={`Per day (${symbol})`}>
          <input className="input" value={perDay} onChange={(e) => setPerDay(e.target.value)} inputMode="decimal" />
        </Field>
      </div>
      {!valid && <p className="field-e">Both caps are positive, and the per-order cap is at most the daily cap.</p>}
    </Modal>
  );
}
