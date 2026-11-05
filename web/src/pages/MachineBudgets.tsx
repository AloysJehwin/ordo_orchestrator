import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { checkSchedule } from "../lib/schedule-body";
import { useSign } from "../lib/sign";
import type { BudgetSchedule, BudgetStatus, BudgetsResponse, TypedSignature } from "../types";
import { Action, Empty, Field, Loading, Modal, useToast } from "../ui/kit";

const STATUS: Record<BudgetStatus, [string, string]> = {
  pending: ["Waiting for a manager", "warn"],
  approving: ["Approved · executing on Hedera", "warn"],
  executed: ["Executed", "ok"],
  expired: ["Lapsed unapproved", ""],
  declined: ["Declined", ""],
  failed: ["Not scheduled", "bad"],
  skipped: ["Nothing to fund", ""],
};
const hbar = (tinybars: string | null) => (tinybars === null ? "—" : `${(Number(tinybars) / 1e8).toFixed(8).replace(/\.?0+$/, "")} HBAR`);
const link = (url: string | null | undefined, text: string) =>
  url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span>{text}</span>
  );

/**
 * Finance → Machine budgets: the org's treasury on Hedera, keyed to its own contract in OrdoTreasury, and what leaves
 * it: one scheduled transfer per run (its machines' resource budget) and machines' over-budget top-ups. A manager
 * approves each with a signature OrdoTreasury checks; before the wallet opens, the console reads the schedule from
 * Hedera's mirror node itself and refuses to sign a transfer other than the one shown here.
 */
export function MachineBudgets() {
  const { path, can } = useApp();
  const [data, setData] = useState<BudgetsResponse | null>(null);
  const [declining, setDeclining] = useState<BudgetSchedule | null>(null);
  const [linking, setLinking] = useState(false);
  const sign = useSign();
  const toast = useToast();
  const load = useCallback(() => api.get<BudgetsResponse>(path("/budgets")).then(setData), [path]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return <Loading />;
  const manage = can("manager") && data.configured;

  const approve = async (b: BudgetSchedule) => {
    await sign({
      title: `Approve ${hbar(b.total)} from the org's treasury`,
      request: async () => {
        const typed = await api.post<TypedSignature>(path(`/budgets/${b.id}/approve/sign-request`));
        if (typed.primaryType !== "OrdoSignature") throw new Error("Ordo asked for an unexpected signature");
        // the schedule as Hedera holds it, not as Ordo describes it
        const hash = await checkSchedule(b, typed.domain.chainId);
        if (typed.message.entity !== `${b.scheduleId}#${hash}`) throw new Error("The signature Ordo asks for does not name this schedule's transfer: do not sign it");
        if (data.contract && typed.domain.verifyingContract?.toLowerCase() !== data.contract.toLowerCase()) throw new Error("The signature is not for OrdoTreasury: do not sign it");
        return typed;
      },
      submit: (proof) => api.post<BudgetSchedule>(path(`/budgets/${b.id}/approve`), proof),
      done: "Approved: OrdoTreasury signed the schedule with the org's key",
    });
    await load();
  };

  const actions = (b: BudgetSchedule) =>
    manage && b.status === "pending" && b.scheduleId && Date.parse(b.expiresAt) > Date.now() ? (
      <div className="btns end">
        <button type="button" className="btn sm accent" onClick={() => void approve(b)}>
          Approve
        </button>
        <button type="button" className="btn sm" onClick={() => setDeclining(b)}>
          Decline
        </button>
      </div>
    ) : null;

  const state = (b: BudgetSchedule) => {
    const [label, tone] = STATUS[b.status];
    return (
      <>
        <span className={`tag ${tone}`}>{label}</span>
        <div className="faint small">
          {b.scheduleId ? <span className="mono">{link(b.scheduleUrl, b.scheduleId)}</span> : "no schedule"}
          {b.status === "pending" && <> · lapses {dateTime(b.expiresAt)}</>}
          {b.executedAt && <> · {dateTime(b.executedAt)}</>}
          {b.approveTxUrl && <> · {link(b.approveTxUrl, "approval")}</>}
          {b.heldAt && <> · stage held</>}
        </div>
        {b.error && <div className="small field-e">{b.error}</div>}
      </>
    );
  };

  const pendingTopups = data.topups.filter((t) => t.status === "pending").length;
  return (
    <div>
      {!data.configured ? (
        <div className="notice">
          <b>Org treasuries are off.</b> {data.note}. Deploy it with <span className="mono">setup:hedera treasury</span> and set <span className="mono">TREASURY_CONTRACT_ADDRESS</span>: machines then spend only what a manager approved, from a treasury no server key can move.
        </div>
      ) : !data.treasury ? (
        <div className="notice warn">
          <b>No treasury yet.</b> {data.note}. The treasury is a Hedera account whose key is this org's own contract in OrdoTreasury: HBAR leaves it only through a scheduled transfer a manager approves here.
          {manage && data.registered && (
            <div className="btns" style={{ marginTop: 10 }}>
              <Action
                className="btn sm accent"
                onClick={async () => {
                  await api.post(path("/treasury"), {});
                  toast("Opened the org's treasury", "ok");
                  await load();
                }}
              >
                Open treasury
              </Action>
              <button type="button" className="btn sm" onClick={() => setLinking(true)}>
                Link an account
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="notice ok">
          <b>Treasury {link(data.treasury.accountUrl, data.treasury.accountId)}</b> · {hbar(data.treasury.balance)}
          <div className="small">
            Its key is this org&apos;s contract {link(data.treasury.keyUrl, data.treasury.keyContractId)} ({shortAddr(data.treasury.keyAddress)}), which signs only what{" "}
            {link(data.treasury.contractUrl, `OrdoTreasury ${shortAddr(data.treasury.contract)}`)} verified a manager approved (HIP-755). No server key can move it; anyone can fund it with a plain transfer. Each run&apos;s budget and each top-up is a Hedera schedule: approved, it executes at once; otherwise it lapses at its expiry.
          </div>
        </div>
      )}

      <section className="section">
        <div className="section-h">
          <h2>Over-budget requests{pendingTopups ? ` · ${pendingTopups} waiting` : ""}</h2>
        </div>
        {data.topups.length === 0 ? (
          <Empty title="No requests">A machine whose purchase is over its budget explains why here: its reasoning goes to the HCS topic first, then Ordo schedules the top-up for a manager.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Machine and purchase</th>
                  <th>Why</th>
                  <th className="r">Top-up</th>
                  <th>Schedule</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.topups.map((b) => {
                  const line = b.lines[0];
                  return (
                    <tr key={b.id}>
                      <td>
                        <b>{b.credits[0]?.assetName ?? b.assetId}</b>
                        <div className="faint small">
                          {line?.label ?? b.resource} for stage {b.stageCode} of {b.orderRef ?? b.runId}
                          {line && (
                            <>
                              {" "}
                              · costs {hbar(line.tinybars)}
                              {line.reason === "price_above_max" ? ` (above the stage's ${line.maxPrice} HBAR per ${line.unit || "unit"})` : ""}
                            </>
                          )}
                        </div>
                        {line?.detail && <div className="faint small">{line.detail}</div>}
                      </td>
                      <td style={{ maxWidth: 420 }}>
                        <div className="small">{b.reasoning}</div>
                        <div className="faint small">
                          {b.requestId ? (
                            <>
                              0G request <span className="mono">{b.requestId}</span>
                            </>
                          ) : (
                            "no 0G brain: the machine's own report"
                          )}
                          {b.valueAtRisk && <> · value at risk {b.valueAtRisk}</>}
                          {b.hcs && (
                            <>
                              {" "}
                              · {link(b.hcs.url, `HCS ${b.hcs.topicId} #${b.hcs.sequence}`)}
                            </>
                          )}
                          {" "}· {ago(b.createdAt)}
                        </div>
                      </td>
                      <td className="r">
                        {hbar(b.total)}
                        <div className="faint small mono">{b.credits[0]?.accountId}</div>
                      </td>
                      <td>{state(b)}</td>
                      <td className="r">{actions(b)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-h">
          <h2>Run budgets</h2>
        </div>
        {data.budgets.length === 0 ? (
          <Empty title="No run budgets">When a run starts, Ordo schedules one transfer from the treasury to its machines: what each may spend on the resources its stages consume (quantity × max price, plus a margin).</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Machines</th>
                  <th className="r">Budget</th>
                  <th>Schedule</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.budgets.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <b>{b.orderRef ?? b.runId}</b>
                      <div className="faint small">
                        {b.templateName ?? "run"} · {ago(b.createdAt)}
                      </div>
                    </td>
                    <td className="small">
                      {b.credits.map((c) => (
                        <div key={c.accountId}>
                          {c.assetName} <span className="mono faint">{c.accountId}</span> · {hbar(c.amount)}
                          <span className="faint"> · buys for {c.stages.join(", ")}</span>
                        </div>
                      ))}
                      {b.lines.length > 0 && (
                        <details>
                          <summary className="faint">{b.lines.length} resources</summary>
                          {b.lines.map((l) => (
                            <div key={`${l.stage}-${l.resource}`} className="faint">
                              {l.stage} · {l.label}: {l.qty} {l.unit} × {l.maxPrice} HBAR = {hbar(l.tinybars)}
                              {!l.funded && <span className="field-e"> · its machine has no Hedera account</span>}
                            </div>
                          ))}
                        </details>
                      )}
                    </td>
                    <td className="r">{hbar(b.total)}</td>
                    <td>{state(b)}</td>
                    <td className="r">{actions(b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Decline
        budget={declining}
        onClose={() => setDeclining(null)}
        submit={async (reason) => {
          await api.post(path(`/budgets/${declining!.id}/decline`), { reason });
          toast("Declined: the schedule is deleted on Hedera, nothing moved", "ok");
          await load();
        }}
      />
      <LinkAccount
        open={linking}
        onClose={() => setLinking(false)}
        submit={async (accountId) => {
          await api.post(path("/treasury"), { accountId });
          toast(`Linked ${accountId} as the org's treasury`, "ok");
          await load();
        }}
      />
    </div>
  );
}

function Decline({ budget, onClose, submit }: { budget: BudgetSchedule | null; onClose: () => void; submit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [budget]);
  return (
    <Modal
      open={Boolean(budget)}
      onClose={onClose}
      eyebrow="Machine budgets"
      title={`Decline ${budget ? hbar(budget.total) : ""}`}
      footer={
        <div className="btns end">
          <Action
            className="btn accent"
            onClick={async () => {
              await submit(reason.trim());
              onClose();
            }}
          >
            Decline
          </Action>
        </div>
      }
    >
      <p className="small muted">
        Ordo deletes the Hedera schedule, so nothing leaves the treasury.{budget?.kind === "topup" ? ` Stage ${budget.stageCode} is held as not approved when it starts.` : ""}
      </p>
      <Field label="Reason">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Buy from the next vendor" maxLength={500} />
      </Field>
    </Modal>
  );
}

function LinkAccount({ open, onClose, submit }: { open: boolean; onClose: () => void; submit: (accountId: string) => Promise<void> }) {
  const [id, setId] = useState("");
  const valid = /^0\.0\.\d+$/.test(id.trim());
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Org treasury"
      title="Link an account made by setup:hedera"
      footer={
        <div className="btns end">
          <Action
            className="btn accent"
            disabled={!valid}
            onClick={async () => {
              await submit(id.trim());
              onClose();
            }}
          >
            Link
          </Action>
        </div>
      }
    >
      <p className="small muted">
        <span className="mono">pnpm setup:hedera treasury &lt;site&gt; &lt;hbar&gt;</span> opens this org&apos;s key contract and an account keyed to it. Ordo checks the account&apos;s key is exactly that contract before it links it.
      </p>
      <Field label="Hedera account">
        <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="0.0.123456" />
      </Field>
    </Modal>
  );
}
