import { useState } from "react";
import { api } from "../../api";
import { useDecide } from "../../lib/actions";
import { useApp } from "../../lib/app";
import { AGENT_LABEL, computeProof, dur, num, STATE_LABEL, time } from "../../lib/format";
import { Actor, Ref } from "../../ui/Name";
import { go } from "../../lib/router";
import { signTyped } from "../../lib/wallet";
import { kindOf, signalsOf, targetText } from "../../lib/criteria";
import type { DecisionView, InboxItemView, ReadingTyped, RunView, StageRunView } from "../../types";
import { Action, Drawer, Field, Modal, useToast } from "../../ui/kit";
import { StageContributions } from "./Contribute";
import { StageOutcomes } from "./Outcomes";
import { StageResources } from "./Resources";
import { ParamCard, useStageSeries } from "./ParamCard";

export function useStageActions(run: RunView, inbox: InboxItemView[], reload: () => Promise<void>) {
  const { path, can, refresh } = useApp();
  const decide = useDecide();
  const toast = useToast();
  const gateItem = (s: StageRunView) => inbox.find((i) => i.id === s.gateItemId && i.status === "pending") ?? null;
  return {
    gateItem,
    approve: async (s: StageRunView) => {
      const item = gateItem(s);
      if (!item) throw new Error("This gate has no open decision");
      await decide(item, 0);
      await reload();
    },
    holdGate: async (s: StageRunView) => {
      const item = gateItem(s);
      if (!item) throw new Error("This gate has no open decision");
      const idx = item.options.findIndex((o) => o.action.tool === "hold_stage");
      await decide(item, idx >= 0 ? idx : -1, "Held from the pipeline view");
      await reload();
    },
    holdRunning: async (s: StageRunView, reason: string) => {
      await api.post(path(`/runs/${run.id}/stages/${s.code}/hold`), { reason });
      toast(`${s.code} held`, "ok");
      await Promise.all([reload(), refresh()]);
    },
    validate: async (s: StageRunView) => {
      const p = await api.post<{ id: string }>(path("/validation"), {
        type: "stage_validation",
        title: `${s.name} · ${run.id}`,
        objective: `Prove stage ${s.code} ${s.name} on ${run.id} meets its success criteria.`,
        acceptance: s.criteria.map((c) => `${c.label} ${targetText(c)}`).join("; "),
        runId: run.id,
        stageCode: s.code,
      });
      go(`validation/${p.id}`);
    },
    canRelease: (s: StageRunView) => can(s.escalationRole),
  };
}

/**
 * Proof of work for a stage with no gateway: the operator signs the counts Ordo recorded with their wallet. The
 * signature covers a commitment to the counts, which Ordo uses to prove the stage's criteria without publishing them.
 */
async function signCounts(path: (p: string) => string, address: string, runId: string, code: string) {
  const { run } = await api.get<{ run: RunView }>(path(`/runs/${runId}`));
  const st = run.stages.find((s) => s.code === code);
  if (!st?.workDoneAt) return false;
  const counts = { good: st.unitsGood, scrap: st.unitsScrap };
  const req = await api.post<{ typed: ReadingTyped; salt: string }>(path(`/runs/${runId}/stages/${code}/reading/sign-request`), counts);
  const signature = await signTyped(req.typed, address);
  const m = req.typed.message;
  await api.post(path(`/runs/${runId}/stages/${code}/reading`), { ...counts, salt: req.salt, commitment: m.commitment, anchor: m.anchor, signedAt: Number(m.signedAt), signature });
  return true;
}

export function RecordModal({ run, stage, onClose, onDone }: { run: RunView; stage: StageRunView | null; onClose: () => void; onDone: () => Promise<void> }) {
  const { path, me } = useApp();
  const [sign, setSign] = useState(true);
  const [good, setGood] = useState("");
  const [scrap, setScrap] = useState("0");
  const [complete, setComplete] = useState(true);
  const [note, setNote] = useState("");
  const [readings, setReadings] = useState<Record<string, string>>({});
  const toast = useToast();
  if (!stage) return null;
  const left = run.quantity - stage.unitsGood - stage.unitsScrap;
  // the stage's measured parameters: what a person reads off the instrument, judged against the band like any signal
  const params = stage.criteria.filter((c) => kindOf(c) === "signal" && c.signal);
  const entered = params.flatMap((c) => (readings[c.signal!] !== undefined && readings[c.signal!] !== "" && Number.isFinite(Number(readings[c.signal!])) ? [{ signal: c.signal!, value: Number(readings[c.signal!]) }] : []));
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${run.id} · stage ${stage.code}`}
      title={`Record ${stage.name}`}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={good === "" || Number(good) < 0}
            onClick={async () => {
              await api.post(path(`/runs/${run.id}/stages/${stage.code}/record`), { good: Number(good), scrap: Number(scrap || 0), complete, note: note || undefined, readings: entered.length ? entered : undefined });
              let signed = false;
              if (complete && sign && me.user) {
                try {
                  signed = await signCounts(path, me.user.address, run.id, stage.code);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  // a machine with a gateway signs its own counts
                  if (!/gateway/.test(msg)) toast(`Recorded, but the counts are not signed: ${msg}`, "bad");
                }
              }
              toast(signed ? "Recorded and signed: Ordo is proving the stage's criteria" : "Recorded", "ok");
              onClose();
              await onDone();
            }}
          >
            Record
          </Action>
        </div>
      }
    >
      <p className="muted">{stage.waitingReason ?? "Enter what was actually produced at this stage."}</p>
      <div className="form-grid two">
        <Field label="Good units" hint={`Order quantity ${run.quantity}${left > 0 ? ` · ${left} not yet recorded` : ""}`}>
          <input className="input" type="number" min={0} value={good} onChange={(e) => setGood(e.target.value)} autoFocus />
        </Field>
        <Field label="Scrap units">
          <input className="input" type="number" min={0} value={scrap} onChange={(e) => setScrap(e.target.value)} />
        </Field>
      </div>
      {params.length > 0 && (
        <>
          <div className="section-h">
            <span className="field-l">Parameters</span>
          </div>
          <div className="form-grid two">
            {params.map((c) => (
              <Field key={c.signal} label={`${c.label}${c.unit ? ` (${c.unit})` : ""}`} hint={`target ${targetText(c)} · signal ${c.signal}`}>
                <input className="input" type="number" step="any" value={readings[c.signal!] ?? ""} onChange={(e) => setReadings({ ...readings, [c.signal!]: e.target.value })} />
              </Field>
            ))}
          </div>
        </>
      )}
      <Field label="Note (optional)">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} /> Work on this stage is complete
      </label>
      {complete && (
        <label className="check-row">
          <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} /> Sign these counts with my wallet, so the lot carries a zero-knowledge proof that they meet the stage&apos;s criteria
        </label>
      )}
    </Modal>
  );
}

export function HoldModal({ stage, onClose, onHold }: { stage: StageRunView | null; onClose: () => void; onHold: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  if (!stage) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Hold ${stage.code} ${stage.name}`}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action className="btn danger" disabled={reason.trim().length < 3} onClick={async () => (await onHold(reason.trim()), onClose())}>
            Hold stage
          </Action>
        </div>
      }
    >
      <Field label="Reason" hint="Downstream scheduling pauses until someone with the escalation role releases the hold.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={300} />
      </Field>
    </Modal>
  );
}

/** The side panel with everything known about a stage. */
export function StageDrawer(props: {
  run: RunView;
  stage: StageRunView | null;
  decisions: DecisionView[];
  inbox: InboxItemView[];
  onClose: () => void;
  actions: ReturnType<typeof useStageActions>;
  onRecord: (s: StageRunView) => void;
  onHold: (s: StageRunView) => void;
}) {
  const { can, sees, book } = useApp();
  const s = props.stage;
  const series = useStageSeries(props.run.id, s?.code ?? null, Boolean(s && signalsOf(s.criteria).length));
  if (!s) return null;
  const a = props.actions;
  const gate = a.gateItem(s);
  const own = props.decisions.filter((d) => d.stageCode === s.code);
  const alerts = props.inbox.filter((i) => i.stageCode === s.code);
  return (
    <Drawer open onClose={props.onClose} eyebrow={`Stage ${s.code} · ${STATE_LABEL[s.state]}`} title={s.name} width={480}>
      <dl className="kv">
        {book.of("stage", `${props.run.id}:${s.code}`) && (
          <>
            <dt>ENS name</dt>
            <dd>
              <Ref kind="stage" id={`${props.run.id}:${s.code}`} />
            </dd>
          </>
        )}
        <dt>Agent</dt>
        <dd>{AGENT_LABEL[s.agent]}</dd>
        <dt>Resource</dt>
        <dd>
          {s.assetName ?? <span className="faint">none assigned</span>}
          {s.assetId && book.of("machine", s.assetId) && (
            <div className="small">
              <Ref kind="machine" id={s.assetId} />
            </div>
          )}
        </dd>
        <dt>Mode</dt>
        <dd>{s.mode === "auto" ? "Auto" : s.mode === "approve" ? "Approve" : "Manual"}</dd>
        <dt>Escalation</dt>
        <dd>{s.escalationRole.replaceAll("_", " ")}</dd>
        <dt>Timeout</dt>
        <dd>{s.timeoutMin} min</dd>
      </dl>
      <section className="dsec">
        <h3>Outcome</h3>
        <p>{s.outcome ?? s.waitingReason ?? <span className="faint">Not started</span>}</p>
      </section>
      {(s.state === "awaiting_approval" || s.state === "held") && (
        <section className="dsec gate-box">
          <h3>Human approval gate</h3>
          <p className="muted small">
            {gate ? `${gate.title}. Needs ${gate.requiredRole.replaceAll("_", " ")} or higher.` : "Waiting for the gate item."}
            {!a.canRelease(s) && ` Waiting on ${s.escalationRole.replaceAll("_", " ")}s to release it.`}
          </p>
          <div className="btns">
            {a.canRelease(s) && (
              <>
                <Action className="btn accent" disabled={!gate} onClick={() => a.approve(s)}>
                  {s.state === "held" ? "Release" : "Approve"}
                </Action>
                {s.state === "awaiting_approval" && (
                  <Action className="btn" disabled={!gate} onClick={() => a.holdGate(s)}>
                    Hold
                  </Action>
                )}
              </>
            )}
            {sees(3) && (
              <Action className="btn link" onClick={() => a.validate(s)}>
                Validate with evidence
              </Action>
            )}
          </div>
        </section>
      )}
      {s.state === "running" && can("manager") && (
        <div className="btns">
          <button type="button" className="btn" onClick={() => props.onHold(s)}>
            Hold
          </button>
          <button type="button" className="btn link" title="For a machine that cannot report: a manager records units and readings by hand, signed" onClick={() => props.onRecord(s)}>
            Record manually
          </button>
        </div>
      )}
      <StageOutcomes run={props.run} stage={s} />
      <StageResources run={props.run} stage={s} />
      <section className="dsec">
        <div className="metrics4">
          <div>
            <span className="label">Duration</span>
            <b>{dur(s.durationMin)}</b>
          </div>
          <div>
            <span className="label">Yield</span>
            <b>{s.yieldPct === null ? "—" : `${s.yieldPct.toFixed(1)}%`}</b>
          </div>
          <div>
            <span className="label">Throughput</span>
            <b>{s.throughputPerHour === null ? "—" : `${num(s.throughputPerHour)} u/h`}</b>
          </div>
          <div>
            <span className="label">Progress</span>
            <b>{Math.round(s.progress * 100)}%</b>
          </div>
        </div>
        <div className="progress">
          <span style={{ width: `${s.progress * 100}%` }} />
        </div>
      </section>
      <section className="dsec">
        <h3>Parameters</h3>
        {s.criteriaResults.length === 0 ? (
          <p className="faint">This stage has no success criteria.</p>
        ) : (
          <>
            <p className="muted small">
              {s.criteriaResults.filter((c) => c.ok === true).length} of {s.criteriaResults.length} in spec
              {s.criteriaResults.some((c) => c.ok === null) ? ` · ${s.criteriaResults.filter((c) => c.ok === null).length} not measured` : ""}
            </p>
            {s.criteriaResults.map((c) => (
              <ParamCard key={c.label} c={c} series={c.signal ? series?.signals[c.signal] : undefined} window={series?.window} live={series?.live} />
            ))}
          </>
        )}
      </section>
      <section className="dsec">
        <h3>Units</h3>
        <dl className="kv">
          <dt>Good</dt>
          <dd>
            {s.unitsGood} of {props.run.quantity}
          </dd>
          <dt>Scrap</dt>
          <dd>{s.unitsScrap}</dd>
          {s.reworkUnits > 0 && (
            <>
              <dt>Rework in</dt>
              <dd>{s.reworkUnits}</dd>
            </>
          )}
        </dl>
      </section>
      {alerts.length > 0 && (
        <section className="dsec">
          <h3>Alerts and exceptions</h3>
          {alerts.map((i) => (
            <a key={i.id} className="alert-row" href={`#/approvals/${i.id}`}>
              <span className={`tag ${i.kind}`}>{i.kind === "approval" ? "Approval" : "Exception"}</span> {i.title} <span className="faint small">· {i.status}</span>
            </a>
          ))}
        </section>
      )}
      <StageContributions run={props.run} stage={s} />
      <section className="dsec">
        <h3>Decision log</h3>
        {own.length === 0 && <p className="faint">No decisions yet.</p>}
        {own.map((d) => (
          <div key={d.id} className="dlog">
            <span className="faint">{time(d.ts)}</span>
            <div>
              <b>{d.summary}</b>
              {d.reason && <div className="muted small">{d.reason}</div>}
              <div className="faint small">
                <Actor actor={d.agent} />
                {d.confidence !== null ? ` · conf. ${d.confidence.toFixed(2)}` : ""}
                {computeProof(d)} · ledger #{d.ledgerSeq}
              </div>
            </div>
          </div>
        ))}
      </section>
    </Drawer>
  );
}
