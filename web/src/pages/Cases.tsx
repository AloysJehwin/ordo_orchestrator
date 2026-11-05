import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { useSign } from "../lib/sign";
import type { CaseCandidate, CaseView, RelayView, RewardsView, SealedRecordView, TypedSignature } from "../types";
import { Drawer, Empty, Field, Loading, Modal, Tabs, useToast } from "../ui/kit";

const STATUS: Record<CaseView["status"], [string, string]> = {
  open: ["Waiting for the validator", "warn"],
  responded: ["Answered · for the manager", "warn"],
  upheld: ["Upheld · stake cut", "bad"],
  rejected: ["Rejected", ""],
};
const pctOf = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

function Relay({ r, label }: { r: RelayView | null; label: string }) {
  if (!r) return null;
  const cls = r.status === "done" ? "ok" : r.status === "failed" ? "bad" : "warn";
  const text = r.status === "done" ? `${label} on-chain` : r.status === "failed" ? `${label}: OrdoTrust refused` : `${label}: pending`;
  return r.txUrl ? (
    <a className={`tag ${cls}`} href={r.txUrl} target="_blank" rel="noreferrer" title={r.error ?? undefined}>
      {text}
    </a>
  ) : (
    <span className={`tag ${cls}`} title={r.error ?? undefined}>
      {text}
    </span>
  );
}

/**
 * Testers examine selected proofs of work, the ones whose stage went wrong first, and open a case against the validator
 * who selected one. The validator answers within the response window; the manager upholds (part of the validator's
 * stake is cut, half to the tester) or rejects (the tester loses a share of theirs to the validator).
 */
export function Cases() {
  const { path, roles, sees, me } = useApp();
  const tester = roles.includes("tester");
  const [tab, setTab] = useState<"cases" | "selected">("cases");
  const [cases, setCases] = useState<CaseView[] | null>(null);
  const [cands, setCands] = useState<CaseCandidate[] | null>(null);
  const [rewards, setRewards] = useState<RewardsView | null>(null);
  const [openFor, setOpenFor] = useState<CaseCandidate | null>(null);
  const [view, setView] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [k, c, r] = await Promise.all([
      api.get<CaseView[]>(path("/cases")),
      sees(3) ? api.get<CaseCandidate[]>(path("/cases/candidates")).catch(() => []) : Promise.resolve([]),
      api.get<RewardsView>(path("/rewards")).catch(() => null),
    ]);
    setCases(k);
    setCands(c);
    setRewards(r);
  }, [path, sees]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!cases || !cands) return <Loading />;
  const open = cases.filter((k) => k.status === "open" || k.status === "responded");
  const mine = (a: string) => a === me.user!.address;
  return (
    <div>
      <div className="eyebrow">Testers and validators</div>
      <h1>Cases</h1>
      <p className="muted lede">
        A tester who finds that a validator selected the wrong proof of work opens a case with evidence and proposes a share of the validator's stake. The validator answers within{" "}
        {rewards ? `${Math.round(rewards.settings.responseWindow / 3600)} hours` : "the response window"}; then a manager decides. Every step is signed{rewards?.v3 ? " and enforced by OrdoTrust" : ""}.
      </p>
      {sees(3) && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "cases", label: "Cases", count: open.length },
            { value: "selected", label: "Selected work", count: cands.filter((c) => c.wentWrong.length > 0 && !c.openCase).length },
          ]}
        />
      )}
      {tab === "cases" ? (
        cases.length === 0 ? (
          <Empty title="No cases">{tester ? "Open one from Selected work when a validator picked the wrong proof of work." : "Cases you are a party to, or decide as a manager, show here."}</Empty>
        ) : (
          <ul className="pow-list section">
            {cases.map((k) => (
              <li key={k.id} className="card">
                <button type="button" className="card-b case-row" onClick={() => setView(k.id)}>
                  <div className="row-between">
                    <span>
                      Stage <b>{k.stageCode}</b> <span className="faint small mono">{k.runId}</span>
                    </span>
                    <span className={`tag ${STATUS[k.status][1]}`}>{STATUS[k.status][0]}</span>
                  </div>
                  <div className="small muted">
                    {mine(k.tester.address) ? "You" : (k.tester.name ?? shortAddr(k.tester.address))} against {mine(k.validator.address) ? "you" : (k.validator.name ?? shortAddr(k.validator.address))} ·{" "}
                    <span className="num">{pctOf(k.bps)}</span> of the stake · {ago(k.createdAt)}
                  </div>
                  {(k.can.respond || k.can.decide) && <span className="tag warn">{k.can.respond ? "Your answer is due " + dateTime(k.respondBy) : "Ready for your decision"}</span>}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : cands.length === 0 ? (
        <Empty title="Nothing selected yet">When a validator selects a proof of work for a stage, it shows here.</Empty>
      ) : (
        <div className="card scroll-x section">
          <table className="t">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Selected by</th>
                <th>What went wrong</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cands.map((c) => (
                <tr key={c.contributionId}>
                  <td data-label="Stage">
                    <b>{c.stageCode}</b> {c.stageName}
                    <div className="faint small">
                      {c.orderRef} · from {c.contributor.name ?? shortAddr(c.contributor.address)}
                    </div>
                  </td>
                  <td data-label="Selected by">
                    {c.validator.name ?? shortAddr(c.validator.address)}
                    <div className="faint small">{ago(c.selectedAt)}</div>
                  </td>
                  <td data-label="What went wrong">{c.wentWrong.length ? <span className="tag bad">{c.wentWrong.join(" · ")}</span> : <span className="faint small">Nothing flagged</span>}</td>
                  <td className="r">
                    {c.openCase ? (
                      <button type="button" className="btn sm" onClick={() => (setTab("cases"), setView(c.openCase))}>
                        Open case
                      </button>
                    ) : (
                      tester &&
                      !mine(c.validator.address) && (
                        <button type="button" className="btn sm primary" onClick={() => setOpenFor(c)}>
                          Open a case
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openFor && rewards && <OpenCase c={openFor} rewards={rewards} onClose={() => setOpenFor(null)} onDone={(id) => (setOpenFor(null), setTab("cases"), setView(id), void load())} />}
      {view && <CaseDrawer id={view} onClose={() => setView(null)} onChange={load} />}
    </div>
  );
}

function OpenCase({ c, rewards, onClose, onDone }: { c: CaseCandidate; rewards: RewardsView; onClose: () => void; onDone: (id: string) => void }) {
  const { path } = useApp();
  const sign = useSign();
  const [evidence, setEvidence] = useState(c.wentWrong.length ? `The stage ${c.wentWrong.join(", ")}. ` : "");
  const [pct, setPct] = useState(String(rewards.settings.defaultSlashBps / 100));
  const bps = Math.round(Number(pct) * 100);
  const max = rewards.settings.maxSlashBps;
  const ok = evidence.trim().length >= 10 && bps >= 1 && bps <= max;
  const go = async () => {
    let caseId = "";
    const r = await sign<CaseView>({
      title: `Open a case against ${c.validator.name ?? shortAddr(c.validator.address)}`,
      request: async (chainId) => {
        const x = await api.post<{ caseId: string; typed: TypedSignature }>(path("/cases/sign-request"), { contributionId: c.contributionId, bps, evidence, chainId });
        caseId = x.caseId;
        return x.typed;
      },
      submit: (proof) => api.post(path("/cases"), { caseId, contributionId: c.contributionId, bps, evidence, ...proof }),
      done: "Case opened",
    });
    if (r) onDone(r.id);
  };
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${c.orderRef} · stage ${c.stageCode}`}
      title="Open a case"
      width={600}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!ok} onClick={() => void go()}>
            Sign and open
          </button>
        </div>
      }
    >
      <div className="stack">
        <p className="small">
          Against <b>{c.validator.name ?? shortAddr(c.validator.address)}</b>, who selected {c.contributor.name ?? shortAddr(c.contributor.address)}'s proof of work. While the case is open you can read the sealed record. If the manager upholds
          it, you receive {pctOf(rewards.settings.bountyBps)} of what is cut; if they reject it, {pctOf(rewards.settings.falseClaimBps)} of your own stake goes to the validator.
        </p>
        <Field label="Evidence" hint="What is wrong with the selected record. Its hash is signed; the text stays with the org.">
          <textarea className="input" rows={6} maxLength={8000} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        <Field label="Share of the validator's stake" hint={`Up to ${pctOf(max)}`}>
          <input className="input num" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Percent of stake" />
        </Field>
      </div>
    </Modal>
  );
}

function CaseDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { path } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [k, setK] = useState<CaseView | null>(null);
  const [record, setRecord] = useState<SealedRecordView | null>(null);
  const [response, setResponse] = useState("");
  const [comment, setComment] = useState("");
  const load = useCallback(() => api.get<CaseView>(path(`/cases/${id}`)).then(setK), [path, id]);
  useEffect(() => {
    setRecord(null);
    void load();
  }, [load]);
  const respond = async () => {
    const r = await sign<CaseView>({
      title: "Answer the case",
      request: (chainId) => api.post<TypedSignature>(path(`/cases/${id}/respond/sign-request`), { response, chainId }),
      submit: (proof) => api.post(path(`/cases/${id}/respond`), { response, ...proof }),
      done: "Answer recorded",
    });
    if (r) (setK(r), onChange());
  };
  const decide = async (uphold: boolean) => {
    const r = await sign<CaseView>({
      title: uphold ? "Uphold the case" : "Reject the case",
      request: (chainId) => api.post<TypedSignature>(path(`/cases/${id}/decide/sign-request`), { uphold, comment, chainId }),
      submit: (proof) => api.post(path(`/cases/${id}/decide`), { uphold, comment, ...proof }),
      done: uphold ? "Case upheld" : "Case rejected",
    });
    if (r) (setK(r), onChange(), r.chain.decide?.status === "failed" && toast(`Decided in Ordo; OrdoTrust refused it: ${r.chain.decide.error ?? ""}`, "bad"));
  };
  const waiting = k?.status === "open" && Date.parse(k.respondBy) > Date.now();
  return (
    <Drawer open onClose={onClose} eyebrow={k ? `Stage ${k.stageCode} · ${k.runId}` : ""} title="Case">
      {!k ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="chips">
            <span className={`tag ${STATUS[k.status][1]}`}>{STATUS[k.status][0]}</span>
            <span className="tag">
              <span className="num">{pctOf(k.bps)}</span> of the stake
            </span>
            <Relay r={k.chain.open} label="Opened" />
            <Relay r={k.chain.respond} label="Answer" />
            <Relay r={k.chain.decide} label="Decision" />
          </div>
          <section className="dsec">
            <h3>Evidence</h3>
            <p className="small muted">
              {k.tester.name ?? shortAddr(k.tester.address)} · {dateTime(k.createdAt)}
            </p>
            <p className="prewrap">{k.evidence}</p>
          </section>
          <section className="dsec">
            <h3>The validator's answer</h3>
            {k.response ? (
              <>
                <p className="small muted">
                  {k.validator.name ?? shortAddr(k.validator.address)} · {dateTime(k.respondedAt)}
                </p>
                <p className="prewrap">{k.response}</p>
              </>
            ) : (
              <p className="small muted">{k.status === "open" ? (waiting ? `Due by ${dateTime(k.respondBy)}.` : "The response window closed without an answer.") : "No answer."}</p>
            )}
            {k.can.respond && (
              <div className="stack">
                <Field label="Your answer" hint="Its hash is signed and, with OrdoTrust v3, recorded on-chain">
                  <textarea className="input" rows={5} maxLength={8000} value={response} onChange={(e) => setResponse(e.target.value)} />
                </Field>
                <div className="btns">
                  <button type="button" className="btn primary" disabled={response.trim().length < 10} onClick={() => void respond()}>
                    Sign and answer
                  </button>
                </div>
              </div>
            )}
          </section>
          {k.can.readRecord && (
            <section className="dsec">
              <h3>Sealed record</h3>
              {!record ? (
                <button type="button" className="btn sm" onClick={() => void api.get<SealedRecordView>(path(`/cases/${id}/record`)).then(setRecord)}>
                  Open the record
                </button>
              ) : (
                <SealedRecord r={record} />
              )}
            </section>
          )}
          {k.status === "upheld" || k.status === "rejected" ? (
            <p className="small muted">
              Decided by {k.decidedBy ? shortAddr(k.decidedBy) : "a manager"} {ago(k.decidedAt)}.
            </p>
          ) : (
            k.can.decide && (
              <section className="dsec">
                <h3>Decision</h3>
                {waiting ? (
                  <p className="small muted">The validator can answer until {dateTime(k.respondBy)}.</p>
                ) : (
                  <div className="stack">
                    <Field label="Comment (optional)">
                      <input className="input" maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
                    </Field>
                    <div className="btns">
                      <button type="button" className="btn danger" onClick={() => void decide(true)}>
                        Uphold · cut {pctOf(k.bps)}
                      </button>
                      <button type="button" className="btn" onClick={() => void decide(false)}>
                        Reject
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )
          )}
        </div>
      )}
    </Drawer>
  );
}

/** The contributor's full record: the values, notes, evidence hashes and the interview. */
export function SealedRecord({ r }: { r: SealedRecordView }) {
  return (
    <div className="stack">
      {r.summary && <p>{r.summary}</p>}
      <dl className="kv small">
        {r.measurements.map((m) => (
          <div key={m.criterion} className="kv-row">
            <dt>{m.criterion}</dt>
            <dd className="num">
              {m.value}
              {m.unit ? ` ${m.unit}` : ""}
            </dd>
          </div>
        ))}
      </dl>
      {r.notes.length > 0 && (
        <ul className="small">
          {r.notes.map((n, i) => (
            <li key={i}>{n.text}</li>
          ))}
        </ul>
      )}
      {r.evidence.length > 0 && (
        <ul className="small mono">
          {r.evidence.map((e) => (
            <li key={e.sha256}>
              {e.name} · {e.sha256.slice(0, 16)}…
            </li>
          ))}
        </ul>
      )}
      {r.transcript.length > 0 && (
        <details>
          <summary className="small">Interview ({r.transcript.length} messages)</summary>
          <ol className="transcript small">
            {r.transcript.map((t, i) => (
              <li key={i} className={t.role === "user" ? "you" : ""}>
                <b>{t.role === "user" ? "Contributor" : "Agent"}:</b> {t.content}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
