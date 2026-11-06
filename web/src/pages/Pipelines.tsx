import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { AGENT_LABEL, dateTime, dur, LEVEL_LABEL, LEVEL_TEXT, num, pct, STATE_LABEL, time } from "../lib/format";
import { go, href, useRoute } from "../lib/router";
import { useSign } from "../lib/sign";
import type { AutonomyLevel, AutonomyProposalView, DecisionView, InboxItemView, PassportView, RunView, StageRunView, TemplateView, TypedSignature } from "../types";
import { QR } from "../ui/QR";
import { DateTimePicker } from "../ui/Calendar";
import { Action, Empty, Field, Loading, Menu, Modal, Segmented, useToast } from "../ui/kit";
import { MoreHorizontal, SkipForward, X } from "lucide-react";
import { Select } from "../ui/Select";
import { Actor, NameInput, Ref, Who } from "../ui/Name";
import { SpecBand } from "../ui/SpecBand";
import { machineless, outcomeCount, outcomesFirst } from "../lib/outcomes";
import { HoldModal, RecordModal, StageDrawer, useStageActions } from "./pipeline/StageParts";
import { FlowView, GraphView, LedgerView } from "./pipeline/Views";
import { DecisionStream } from "./pipeline/Stream";
import { Attention } from "./pipeline/Attention";
import { atGate, roleWords } from "./pipeline/layout";

type View = "flow" | "graph" | "ledger";

export function Pipelines() {
  const { live, path, site } = useApp();
  const route = useRoute();
  const [startOpen, setStartOpen] = useState(route.query.get("start"));
  const runs = live?.runs ?? [];
  const runId = route.id ?? runs.find((r) => r.status === "running")?.id ?? runs[0]?.id ?? null;
  useEffect(() => setStartOpen(route.query.get("start")), [route.query]);
  if (!live) return <Loading />;
  return (
    <>
      {runId ? (
        <RunScreen key={runId} runId={runId} runs={runs} onNew={() => setStartOpen("")} />
      ) : (
        <div>
          <div className="eyebrow">Pipelines · {site.name}</div>
          <h1>No runs yet</h1>
          <Empty title="Start your first pipeline run" action={<button type="button" className="btn accent" onClick={() => setStartOpen("")}>Start a run</button>}>
            A run executes a template against an order. Stages are assigned to your registered assets and progress from their real part counters or from what operators record.
            {live.assets.length === 0 && (
              <>
                {" "}
                You have no assets yet: <a href={href("floor")}>register machines first</a>.
              </>
            )}
          </Empty>
        </div>
      )}
      <StartRun open={startOpen !== null} templateId={startOpen || null} onClose={() => setStartOpen(null)} onStarted={(id) => (setStartOpen(null), go(`pipelines/${id}`))} path={path} />
    </>
  );
}

function RunScreen({ runId, runs, onNew }: { runId: string; runs: RunView[]; onNew: () => void }) {
  const { path, live, can, sees, refresh, site, book } = useApp();
  const [data, setData] = useState<{ run: RunView; decisions: DecisionView[]; inbox: InboxItemView[] } | null>(null);
  const [view, setView] = useState<View>("flow");
  const [sel, setSel] = useState<{ code: string; left: number; right: number; top: number; h: number } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [record, setRecord] = useState<StageRunView | null>(null);
  const [hold, setHold] = useState<StageRunView | null>(null);
  const [autonomy, setAutonomy] = useState(false);
  const [passport, setPassport] = useState(false);
  const toast = useToast();
  const load = useCallback(async () => setData(await api.get(path(`/runs/${runId}`))), [path, runId]);
  useEffect(() => {
    void load().catch((e) => toast(String(e instanceof Error ? e.message : e), "bad"));
  }, [load, live?.headSeq, toast]);
  const actions = useStageActions(data?.run ?? (runs[0] as RunView), data?.inbox ?? [], load);
  const runOptions = useMemo(
    () =>
      runs.map((r) => ({
        value: r.id,
        label: `${r.id} · ${r.templateName}`,
        hint: `${book.name("run", r.id) ?? r.orderRef} · ${r.status === "running" ? `${r.metrics.completed}/${r.metrics.total} stages` : r.status}`,
        group: r.status === "running" ? "Running" : "Last 7 days",
      })),
    [runs, book],
  );
  if (!data) return <Loading text="Loading run…" />;
  const { run, decisions, inbox } = data;
  const line = site.lines.find((l) => l.id === run.lineId) ?? site.lines[0]!;
  const stage = (code: string | null) => run.stages.find((s) => s.code === code) ?? null;
  const s = stage(sel?.code ?? null);
  const latest = s ? decisions.find((d) => d.stageCode === s.code) : null;
  const isManager = can("manager");
  const running = run.status === "running";
  // gates the signed-in person may release, oldest column first
  const myGates = run.stages.filter((x) => atGate(x) && can(x.escalationRole));
  const openStage = (code: string) => (setSel(null), setDrawer(code));

  // place the stage's block beside the node, inside the canvas, flipping to the left when there is no room on the right
  const pick = (code: string, el: Element) => {
    const c = canvas.current;
    if (!c) return;
    if (sel?.code === code) return setSel(null);
    const node = c.querySelector(`[data-code="${code}"]`) ?? el;
    const cr = c.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    setSel({ code, left: r.left - cr.left, right: r.right - cr.left, top: r.top - cr.top, h: r.height });
  };
  const blockW = 352;
  const cw = canvas.current?.clientWidth ?? 9999;
  const blockLeft = sel ? (sel.right + 14 + blockW <= cw ? sel.right + 14 : sel.left - blockW - 14 >= 0 ? sel.left - blockW - 14 : Math.max(0, cw - blockW)) : 0;
  const blockTop = sel ? Math.max(8, sel.top + sel.h / 2 - 110) : 0;

  const step = async () => {
    const r = await api.post<{ started: string[]; gateItemId: string | null }>(path(`/runs/${run.id}/step`));
    if (r.gateItemId) {
      const g = run.stages.find((x) => x.gateItemId === r.gateItemId);
      if (g) setDrawer(g.code);
      toast("A gate is waiting: open it to continue", "info");
    } else toast(r.started.length ? `Started ${r.started.join(", ")}` : "Nothing to start: running stages are waiting on data or operators", r.started.length ? "ok" : "info");
    await Promise.all([load(), refresh()]);
  };

  // the one action that matters most for this person gets the accent; the rest are secondary and fold into a menu on a phone
  const reviewLabel = myGates.length === 1 ? `Review gate ${myGates[0]!.code}` : `Review gates (${myGates.length})`;
  const primary =
    isManager && running ? (
      <Action className="btn accent" onClick={step} title="Advance the run one column; stops at a gate and opens it">
        <SkipForward size={16} aria-hidden /> Step run
      </Action>
    ) : myGates.length ? (
      <button type="button" className="btn accent" onClick={() => openStage(myGates[0]!.code)}>
        {reviewLabel}
      </button>
    ) : null;
  const secondary: { label: string; onClick: () => void }[] = [];
  if (isManager && running && myGates.length) secondary.push({ label: reviewLabel, onClick: () => openStage(myGates[0]!.code) });
  if (sees(3)) secondary.push({ label: "Lot passport", onClick: () => setPassport(true) });
  secondary.push({ label: isManager ? "Edit in builder" : "View template", onClick: () => go(`builder/${run.templateId}`) });
  if (isManager) secondary.push({ label: "New run", onClick: onNew });
  const statusTag = running ? <span className="tag accent">Running</span> : <span className={`tag ${run.status === "completed" ? "ok" : "bad"}`}>{run.status}</span>;
  const ordered = [...run.stages].sort((a, b) => a.column - b.column || a.code.localeCompare(b.code));

  return (
    <div className="pipeline">
      <header className="run-head">
        <div className="rh-text">
          <div className="rh-title">
            <h1>{run.templateName}</h1>
            {statusTag}
          </div>
          <div className="rh-meta">
            <span className="mono">{run.id}</span>
            {book.of("run", run.id) ? <Ref kind="run" id={run.id} /> : <span>{run.orderRef}</span>}
            <span className="num">{run.quantity} units</span>
            <span>{run.templateCategory}</span>
            <span>started {dateTime(run.startedAt)}</span>
          </div>
          {run.templateDescription && <p className="lede rh-desc">{run.templateDescription}</p>}
        </div>
        <div className="rh-side">
          <Select width={300} value={run.id} onChange={(id) => go(`pipelines/${id}`)} options={runOptions} searchable />
          <div className="rh-actions">
            {primary}
            <span className="ra-wide">
              {secondary.map((b) =>
                b.label === "Edit in builder" || b.label === "View template" ? (
                  <a key={b.label} className="btn" href={href(`builder/${run.templateId}`)}>
                    {b.label}
                  </a>
                ) : (
                  <button key={b.label} type="button" className="btn" onClick={b.onClick}>
                    {b.label}
                  </button>
                ),
              )}
            </span>
            <span className="ra-narrow">
              <Menu
                title="Run actions"
                items={secondary}
                trigger={(open, toggle) => (
                  <button type="button" className="btn" aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
                    <MoreHorizontal size={16} aria-hidden /> More
                  </button>
                )}
              />
            </span>
          </div>
        </div>
      </header>

      <section className="runband card" aria-label="Run status">
        <div className="rb-strip">
          <div className="rb-strip-h">
            <span>
              <b className="num">
                {run.metrics.completed} of {run.metrics.total}
              </b>{" "}
              stages complete
            </span>
            <span className="muted small">
              {run.status === "running" ? (run.metrics.eta ? `ETA ${time(run.metrics.eta)}` : "No ETA yet") : `Finished ${run.finishedAt ? dateTime(run.finishedAt) : ""}`}
              {run.dueAt ? ` · due ${dateTime(run.dueAt)}` : ""}
              {run.metrics.onTrack !== null && (run.metrics.onTrack ? " · on track" : " · late")}
            </span>
          </div>
          <ol className="rb-segs" aria-label="Stages in order">
            {ordered.map((x) => (
              <li key={x.code}>
                <button type="button" className={`rb-seg s-${x.state}`} title={`${x.code} ${x.name} · ${STATE_LABEL[x.state]}`} aria-label={`${x.code} ${x.name}, ${STATE_LABEL[x.state]}`} onClick={() => openStage(x.code)}>
                  {x.state === "running" && <span style={{ width: `${Math.round(x.progress * 100)}%` }} />}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="kpis band">
          {isManager ? (
            <button type="button" className="kpi kpi-auto" onClick={() => setAutonomy(true)} title="Change how much agents may do on their own">
              <AutonomyTile level={line.autonomy} editable />
            </button>
          ) : (
            <div className="kpi">
              <AutonomyTile level={line.autonomy} />
            </div>
          )}
          <div className="kpi">
            <span className="label">Rolled yield</span>
            <div className="v">{pct(run.metrics.rolledYield)}</div>
            <div className="s">across measured stages</div>
          </div>
          <div className="kpi">
            <span className="label">Throughput</span>
            <div className="v">{num(run.metrics.throughputPerHour)}</div>
            <div className="s">units / hour shipped</div>
          </div>
          <div className="kpi">
            <span className="label">{running ? "Run ETA" : "Finished"}</span>
            <div className="v">{running ? (run.metrics.eta ? time(run.metrics.eta) : "—") : run.finishedAt ? time(run.finishedAt) : "—"}</div>
            <div className="s">{run.dueAt ? `due ${dateTime(run.dueAt)}` : "no due date"}</div>
          </div>
          <div className="kpi">
            <span className="label">Agent decisions</span>
            <div className="v">{run.metrics.decisions}</div>
            <div className="s">{run.metrics.escalated} escalated to people</div>
          </div>
          <div className="kpi">
            <span className="label">Gates pending</span>
            <div className={`v${run.metrics.gatesPending ? " accent-text" : ""}`}>{run.metrics.gatesPending}</div>
            <div className="s">{myGates.length ? `${myGates.length} you can release` : "need sign-off"}</div>
          </div>
        </div>
      </section>

      <section className="map card" aria-label="Stage map">
        <div className="map-bar">
          <Segmented<View>
            label="View"
            value={view}
            onChange={(v) => (setView(v), setSel(null))}
            options={[
              { value: "flow", label: "Flow" },
              { value: "graph", label: "Graph" },
              { value: "ledger", label: "Ledger" },
            ]}
          />
          {view !== "ledger" && (
            <div className="legend" aria-label="Legend">
              <span>
                <i className="lg done" /> Completed
              </span>
              <span>
                <i className="lg run" /> Running
              </span>
              <span>
                <i className="lg gate" /> Awaiting approval
              </span>
              <span>
                <i className="lg held" /> Held
              </span>
              <span>
                <i className="lg dev" /> Done · deviation
              </span>
              <span>
                <i className="lg queued" /> Queued
              </span>
            </div>
          )}
          <span className="faint small map-hint">{view === "ledger" ? "Select a row for its full details" : "Select a stage, or move with the arrow keys"}</span>
        </div>
        <div className={`canvas v-${view}`} ref={canvas} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
          {view === "flow" && <FlowView run={run} selected={sel?.code ?? null} onSelect={pick} />}
          {view === "graph" && <GraphView run={run} selected={sel?.code ?? null} onSelect={pick} />}
          {view === "ledger" && <LedgerView run={run} onOpen={openStage} />}
          {s && sel && view !== "ledger" && (
            <div className="block" style={{ left: blockLeft, top: blockTop }} role="dialog" aria-label={`Stage ${s.code}`}>
              <div className="block-h">
                <span className="mono block-code">{s.code}</span>
                <span className={`tag st-${s.state}`}>{STATE_LABEL[s.state]}</span>
                <button type="button" className="icon-btn" aria-label="Close" onClick={() => setSel(null)}>
                  <X size={16} aria-hidden />
                </button>
              </div>
              <h3 className="block-title">{s.name}</h3>
              {book.of("stage", `${run.id}:${s.code}`) && (
                <div className="small">
                  <Ref kind="stage" id={`${run.id}:${s.code}`} />
                </div>
              )}
              <div className="faint small">
                {AGENT_LABEL[s.agent]} · {s.assetId ? <Ref kind="machine" id={s.assetId} fallback={s.assetName ?? "no asset"} link={false} /> : (s.assetName ?? "no asset")}
              </div>
              <p className="block-body">{s.outcome ?? s.waitingReason ?? (s.state === "queued" ? "Waiting on upstream stages." : "In progress.")}</p>
              {atGate(s) && s.criteriaResults.some((c) => c.ok !== true) && (
                <ul className="gate-why">
                  {s.criteriaResults
                    .filter((c) => c.ok !== true)
                    .map((c) => (
                      <li key={c.label} className={c.ok === false ? "bad-text" : ""}>
                        {c.ok === false ? `Out of target: ${c.label} ${c.actual} (target ${c.target})` : `Not measured: ${c.label} (target ${c.target}), confirm before release`}
                      </li>
                    ))}
                </ul>
              )}
              {s.criteriaResults.length > 0 && (
                <ul className="band-list" aria-label="Parameters against their bands">
                  {s.criteriaResults.map((c) => (
                    <li key={c.label}>
                      <span className="bl-name" title={c.label}>
                        {c.label}
                      </span>
                      <SpecBand compact lo={c.band?.lo ?? null} hi={c.band?.hi ?? null} value={c.measured?.value ?? null} valueMax={c.measuredMax?.value ?? null} ok={c.ok} unit={c.unit} label={c.label} />
                      <span className={`bl-val ${c.ok === false ? "bad-text" : c.ok === null ? "faint" : ""}`}>{c.actual ?? "not measured"}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="metrics3">
                <div>
                  <span className="label">Duration</span>
                  <b>{dur(s.durationMin)}</b>
                </div>
                <div>
                  <span className="label">Yield</span>
                  <b>{s.yieldPct === null ? "—" : `${s.yieldPct.toFixed(1)}%`}</b>
                </div>
                <div>
                  <span className="label">Output</span>
                  <b>{s.throughputPerHour === null ? `${s.unitsGood}/${run.quantity}` : `${num(s.throughputPerHour)} u/h`}</b>
                </div>
              </div>
              {latest && (
                <div className="block-dec">
                  <span className="label">Latest decision</span>
                  <b>{latest.summary}</b>
                  <div className="faint small">
                    <Actor actor={latest.agent} /> · {time(latest.ts)}
                  </div>
                </div>
              )}
              {atGate(s) && !actions.canRelease(s) && <p className="small muted gate-who">Waiting on {roleWords(s.escalationRole)}s to release this gate.</p>}
              <div className="btns">
                {atGate(s) && actions.canRelease(s) && (
                  <>
                    <Action className="btn accent" disabled={!actions.gateItem(s)} onClick={() => actions.approve(s)}>
                      {s.state === "held" ? "Release" : "Approve"}
                    </Action>
                    {s.state === "awaiting_approval" && (
                      <Action className="btn" disabled={!actions.gateItem(s)} onClick={() => actions.holdGate(s)}>
                        Hold
                      </Action>
                    )}
                  </>
                )}
                {atGate(s) && sees(3) && (
                  <Action className="btn link" onClick={() => actions.validate(s)}>
                    Validate
                  </Action>
                )}
                {s.state === "running" && isManager && (
                  <>
                    <button type="button" className="btn" onClick={() => setHold(s)}>
                      Hold
                    </button>
                    <button type="button" className="btn link" title="For a machine that cannot report: record units and readings by hand, signed" onClick={() => setRecord(s)}>
                      Record manually
                    </button>
                  </>
                )}
              </div>
              <button type="button" className="link right" onClick={() => openStage(s.code)}>
                Full details →
              </button>
            </div>
          )}
        </div>
      </section>

      <div className="run-lower">
        <DecisionStream decisions={decisions} onStage={openStage} />
        <Attention run={run} inbox={inbox} onOpen={openStage} />
      </div>

      <StageDrawer run={run} stage={stage(drawer)} decisions={decisions} inbox={inbox} onClose={() => setDrawer(null)} actions={actions} onRecord={setRecord} onHold={setHold} />
      <RecordModal run={run} stage={record} onClose={() => setRecord(null)} onDone={async () => (await load(), await refresh())} />
      <HoldModal stage={hold} onClose={() => setHold(null)} onHold={(reason) => actions.holdRunning(hold!, reason)} />
      <AutonomyModal open={autonomy} onClose={() => setAutonomy(false)} lineId={line.id} current={line.autonomy} />
      {sees(3) && <PassportModal open={passport} onClose={() => setPassport(false)} runId={run.id} orderRef={run.orderRef} />}
    </div>
  );
}

/** The line's autonomy: its level, a four-step meter and what it lets agents do. */
function AutonomyTile({ level, editable = false }: { level: AutonomyLevel; editable?: boolean }) {
  return (
    <>
      <div className="kpi-row">
        <span className="label">Autonomy</span>
        <span className="small">
          <b>{level}</b> · {LEVEL_LABEL[level]}
        </span>
      </div>
      <div className="bars" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={i <= Number(level.slice(1)) ? "on" : ""} />
        ))}
      </div>
      <div className="s">
        {LEVEL_TEXT[level]}
        {editable ? <span className="kpi-edit"> · change</span> : null}
      </div>
    </>
  );
}

export function AutonomyModal({ open, onClose, lineId, current, initial }: { open: boolean; onClose: () => void; lineId: string; current: AutonomyLevel; initial?: AutonomyLevel }) {
  const { path, can, reloadSite } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [level, setLevel] = useState<AutonomyLevel>(initial ?? current);
  const [comment, setComment] = useState("");
  useEffect(() => setLevel(initial ?? current), [current, initial, open]);
  const raising = Number(level.slice(1)) > Number(current.slice(1));
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Line autonomy"
      title="How much may agents do on their own?"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!can("manager") || level === current}
            onClick={async () => {
              const r = await sign({
                title: `Set autonomy to ${level} · ${LEVEL_LABEL[level]}`,
                request: (chainId) => api.post<TypedSignature>(path(`/lines/${lineId}/autonomy/sign-request`), { level, comment, chainId }),
                submit: (proof) => api.put<{ proposal: AutonomyProposalView }>(path(`/lines/${lineId}/autonomy`), { level, comment, ...proof }),
              });
              if (r) {
                const p = r.proposal;
                if (p.status === "open") toast(`Signed ${p.signers.length} of ${p.required}: another manager co-signs in Settings`, "ok");
                else toast(`Autonomy is now ${p.to}${p.onchain?.status === "done" ? ", published on-chain" : ""}`, "ok");
                await reloadSite();
                onClose();
              }
            }}
          >
            {raising ? "Sign (1 of 2)" : "Sign and apply"}
          </Action>
        </div>
      }
    >
      <div className="levels">
        {(["L1", "L2", "L3", "L4"] as AutonomyLevel[]).map((l) => (
          <button type="button" key={l} className={`level${l === level ? " on" : ""}`} onClick={() => setLevel(l)} disabled={!can("manager")}>
            <b>
              {l} · {LEVEL_LABEL[l]}
            </b>
            <span className="muted small">{LEVEL_TEXT[l]}</span>
          </button>
        ))}
      </div>
      <Field label="Reason (signed with the change)">
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
      </Field>
      {raising && <p className="small muted">A manager's signature changes autonomy, and it applies at once.</p>}
      {!can("manager") && <p className="field-e">Only a manager can change autonomy.</p>}
    </Modal>
  );
}

function StartRun({ open, templateId, onClose, onStarted, path }: { open: boolean; templateId: string | null; onClose: () => void; onStarted: (id: string) => void; path: (p: string) => string }) {
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [tpl, setTpl] = useState<string | null>(null);
  const [order, setOrder] = useState("");
  const [qty, setQty] = useState("100");
  const [due, setDue] = useState<string | null>(null);
  const { live } = useApp();
  useEffect(() => {
    if (!open) return;
    void api.get<TemplateView[]>(path("/templates")).then((t) => {
      setTemplates(t);
      setTpl(templateId ?? t[0]?.id ?? null);
    });
  }, [open, path, templateId]);
  const t = templates.find((x) => x.id === tpl);
  const { meta } = useApp();
  const missing = t && meta.machinesRequired !== false ? machineless(t.spec.stages, live?.assets ?? []) : [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="New run"
      title="Start a pipeline run"
      width={620}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!t || !order.trim() || !(Number(qty) > 0) || missing.length > 0}
            title={missing.length ? "Every stage needs a machine to run on" : undefined}
            onClick={async () => {
              const r = await api.post<RunView>(path("/runs"), { templateVersionId: t!.versionId, orderRef: order.trim(), quantity: Number(qty), dueAt: due });
              onStarted(r.id);
            }}
          >
            Start run
          </Action>
        </div>
      }
    >
      <Field label="Template">
        <Select
          value={tpl}
          onChange={setTpl}
          options={outcomesFirst(templates).map((x) => ({ value: x.id, label: x.name, hint: `${x.origin === "custom" ? "Custom" : "Library"} · v${x.version} · ${x.spec.stages.length} stages${outcomeCount(x) ? ` · ${outcomeCount(x)} outcomes` : ""}`, group: x.category }))}
          searchable
        />
      </Field>
      {t && <p className="muted small">{t.description}</p>}
      <div className="form-grid two">
        <Field label="Order or batch reference">
          <input className="input" value={order} onChange={(e) => setOrder(e.target.value)} placeholder="e.g. SO-48213" />
        </Field>
        <Field label="Quantity (units)">
          <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
      </div>
      <Field label="Due (optional)" hint="Used for the ETA and on-track indicator.">
        <DateTimePicker value={due} onChange={setDue} clearable />
      </Field>
      {missing.length > 0 && (
        <div className="notice warn">
          Every stage runs on a machine, and {missing.length === 1 ? "this stage has" : "these stages have"} none:{" "}
          <b>{missing.map((s) => `${s.code} ${s.name} (${s.resourceKind.replaceAll("_", " ")}${s.machine ? ", its pinned machine is gone" : ""})`).join(", ")}</b>. <a href={href("floor")}>Add a machine on the Floor</a>
        </div>
      )}
    </Modal>
  );
}

/** The lot's passport: its QR code and public page, the NFT, and shipping to the customer with a signature. */
function PassportModal({ runId, orderRef, open, onClose }: { runId: string; orderRef: string; open: boolean; onClose: () => void }) {
  const { path, can } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [p, setP] = useState<PassportView | null>(null);
  const [to, setTo] = useState("");
  const load = () => api.get<PassportView>(path(`/runs/${runId}/passport`)).then(setP);
  useEffect(() => {
    if (open) void load().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "bad"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runId]);
  const url = p ? (p.pageUrl.startsWith("http") ? p.pageUrl : `${window.location.origin}${p.pageUrl}`) : "";
  // a Hedera account, an EVM address, or a name the server resolves to one (acme-buyer.customers.acme.ordo.eth)
  const validTo = /^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/.test(to.trim()) || /^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(to.trim());
  return (
    <>
      <Modal open={open} onClose={onClose} eyebrow="Lot passport" title={`Lot ${orderRef}`}>
        {!p ? (
          <Loading />
        ) : (
          <div className="pp-modal">
            <div className="pp-qr">
              <QR value={url} label={`QR code for lot ${orderRef}`} />
              <a href={url} target="_blank" rel="noreferrer" className="small">
                Open the public page
              </a>
            </div>
            <div>
              <p>
                Status: <b>{p.status.replaceAll("_", " ")}</b>
              </p>
              {p.nft ? (
                <p className="small">
                  NFT{" "}
                  {p.nft.url ? (
                    <a href={p.nft.url} target="_blank" rel="noreferrer">
                      {p.nft.tokenId} #{p.nft.serial}
                    </a>
                  ) : (
                    <span className="mono">{p.nft.tokenId}</span>
                  )}
                  {p.nft.serial === null ? " · minting on the next engine cycle" : ` · on-chain: ${p.nft.onchainStatus?.replaceAll("_", " ")}`}
                  {p.nft.error && <span className="field-e"> {p.nft.error}</span>}
                </p>
              ) : (
                <p className="small muted">No HTS collection is configured: the passport lives in Ordo. Set HEDERA_PASSPORT_TOKEN_ID to mint each lot as an NFT.</p>
              )}
              <p className="small muted">Anyone with the code sees what was made, stage by stage, who signed each gate and release, and the ledger anchor that proves it. People appear by their ENS names (the handles they chose), never by their display names.</p>
              {p.shipment ? (
                <p className="small">
                  Shipped {dateTime(p.shipment.at)} to {p.shipment.to.startsWith("0x") ? <Who address={p.shipment.to} /> : <Who hedera={p.shipment.to} />}
                  {p.shipment.txUrl && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={p.shipment.txUrl} target="_blank" rel="noreferrer">
                        {p.shipment.pending ? "airdrop pending the customer's claim" : "NFT delivered"}
                      </a>
                    </>
                  )}
                </p>
              ) : (
                p.status === "completed" &&
                can("manager") && (
                  <div className="pp-ship">
                    <Field label="Ship to (the customer's ENS name, Hedera account or EVM address)">
                      <NameInput accept="any" value={to} onChange={setTo} placeholder="buyer.customers.acme.ordo.eth or 0.0.12345" />
                    </Field>
                    <Action
                      className="btn accent"
                      disabled={!validTo}
                      onClick={async () => {
                        const body = { to: to.trim() };
                        const r = await sign({
                          title: `Ship lot ${orderRef} to ${body.to}`,
                          request: () => api.post<TypedSignature>(path(`/runs/${runId}/ship/sign-request`), body),
                          submit: (proof) => api.post<PassportView>(path(`/runs/${runId}/ship`), { ...body, ...proof }),
                        });
                        if (r) {
                          setP(r);
                          toast("Shipped and recorded", "ok");
                        }
                      }}
                    >
                      Sign and ship
                    </Action>
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
