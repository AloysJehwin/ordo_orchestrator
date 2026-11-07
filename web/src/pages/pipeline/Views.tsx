import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { RunView, StagePendingView, StageRunView } from "../../types";
import { AGENT_LABEL, STATE_LABEL, dur, num } from "../../lib/format";
import { SpecBand } from "../../ui/SpecBand";
import { Ref } from "../../ui/Name";
import { atGate, columnCount, edgeClass, fitColumn, layout, neighbour, roleWords, swatch, type Layout } from "./layout";
import { shortWhy } from "./Pending";

/** What a stage waits on, when it waits (from the run's pending actions). */
type PendingOf = (code: string) => StagePendingView | null;
/** A stage that waits says so under its state: queued stages, and running ones waiting on a person. */
const whyOf = (s: StageRunView, pending?: PendingOf) => (s.state === "queued" || s.state === "running" ? (pending?.(s.code) ?? null) : null);

/** Where a stage was picked, so the caller can place its block beside it. */
export type OnSelect = (code: string, el: Element) => void;

/** The width an element has to fill, kept current as the window resizes. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Arrow keys move between stages; Enter opens the one in focus. */
function useKeys(L: Layout, wrap: RefObject<HTMLElement | null>, onSelect: OnSelect) {
  return (code: string) => (e: KeyboardEvent<Element>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(code, e.currentTarget);
      return;
    }
    const to = neighbour(L, code, e.key);
    if (!to) return;
    e.preventDefault();
    (wrap.current?.querySelector(`[data-code="${to}"]`) as HTMLElement | SVGElement | null)?.focus();
  };
}

const paramsLabel = (s: StageRunView) => (s.criteriaResults.length ? `, ${s.criteriaResults.filter((c) => c.ok === true).length} of ${s.criteriaResults.length} parameters in spec` : "");
const progressText = (s: StageRunView) => (s.state === "running" && s.progress > 0 ? ` · ${Math.round(s.progress * 100)}%` : "");

/** An arc from angle a0 to a1 (degrees, clockwise from the top). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const rad = (a: number) => ((a - 90) * Math.PI) / 180;
  const p = (a: number) => `${(cx + r * Math.cos(rad(a))).toFixed(1)},${(cy + r * Math.sin(rad(a))).toFixed(1)}`;
  return `M${p(a0)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
}

/** One arc per criterion around the node: solid for pass, solid with an outward tick for out of spec, dashed for not measured. */
function CriteriaRing({ s, x, y, r }: { s: StageRunView; x: number; y: number; r: number }) {
  const cs = s.criteriaResults;
  if (!cs.length) return null;
  const span = 360 / cs.length;
  const gap = cs.length === 1 ? 10 : 7;
  const rad = (a: number) => ((a - 90) * Math.PI) / 180;
  return (
    <g className="cring" aria-hidden>
      {cs.map((c, i) => {
        const a0 = i * span + gap / 2;
        const a1 = (i + 1) * span - gap / 2;
        const mid = rad((a0 + a1) / 2);
        return (
          <g key={c.label}>
            <path d={arc(x, y, r, a0, a1)} className={c.ok === true ? "cr-ok" : c.ok === false ? "cr-bad" : "cr-na"}>
              <title>{`${c.label}: ${c.actual ?? "not measured"} · target ${c.target}`}</title>
            </path>
            {c.ok === false && <line x1={x + (r + 2) * Math.cos(mid)} y1={y + (r + 2) * Math.sin(mid)} x2={x + (r + 7) * Math.cos(mid)} y2={y + (r + 7) * Math.sin(mid)} className="cr-tick" />}
          </g>
        );
      })}
    </g>
  );
}

function NodeMark({ s, x, y, selected }: { s: StageRunView; x: number; y: number; selected: boolean }) {
  const r = 21;
  const sq = (cls: string) => <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={8} className={cls} />;
  let mark;
  switch (s.state) {
    case "completed":
    case "skipped":
      mark = <circle cx={x} cy={y} r={r} className="n-done" />;
      break;
    case "running":
      mark = (
        <>
          <circle cx={x} cy={y} r={r + 6} className="n-halo" />
          <circle cx={x} cy={y} r={r} className="n-run" />
        </>
      );
      break;
    case "awaiting_approval":
      mark = (
        <>
          <rect x={x - r - 5} y={y - r - 5} width={(r + 5) * 2} height={(r + 5) * 2} rx={11} className="n-halo" />
          {sq("n-gate")}
        </>
      );
      break;
    case "held":
      mark = sq("n-held");
      break;
    case "done_deviation":
      mark = <circle cx={x} cy={y} r={r} className="n-dev" />;
      break;
    default:
      mark = <circle cx={x} cy={y} r={r} className="n-queued" />;
  }
  return (
    <g className={`node s-${s.state}${selected ? " selected" : ""}`}>
      <CriteriaRing s={s} x={x} y={y} r={s.state === "awaiting_approval" ? 36 : 29} />
      {mark}
      <text x={x} y={y + 4.5} textAnchor="middle" className="n-code">
        {s.code}
      </text>
    </g>
  );
}

/** The rework loop, arcing over the stages from where units are sent back to where they rejoin. */
function Rework({ L, run, lift, top, dx = 0 }: { L: Layout; run: RunView; lift: number; top: number; dx?: number }) {
  const a = run.rework ? L.by.get(run.rework.from) : null;
  const b = run.rework ? L.by.get(run.rework.to) : null;
  if (!a || !b) return null;
  // dx moves the ends off the centre line (graph cards: towards their right corner, clear of the column labels)
  const from = { x: a.x + dx, y: a.y };
  const to = { x: b.x + dx, y: b.y };
  const units = run.stages.find((s) => s.code === run.rework?.to)?.reworkUnits ?? 0;
  const fy = from.y - lift;
  const ty = to.y - lift - 2;
  return (
    <g className="rework">
      <path d={`M${from.x},${fy} C${from.x},${top} ${to.x},${top} ${to.x},${ty}`} />
      <path d={`M${to.x - 4},${ty - 7} L${to.x},${ty} L${to.x + 4},${ty - 7}`} />
      <text x={(from.x + to.x) / 2} y={top + 16} textAnchor="middle">
        Rework loop{units ? ` · ${units} unit${units === 1 ? "" : "s"} returned` : ""}
      </text>
    </g>
  );
}

export function FlowView({ run, selected, onSelect, pending }: { run: RunView; selected: string | null; onSelect: OnSelect; pending?: PendingOf }) {
  const [box, w] = useWidth<HTMLDivElement>();
  const wrap = useRef<HTMLDivElement>(null);
  const padX = 100;
  const colW = fitColumn(w, columnCount(run.stages), padX, 176, 288);
  const L = layout(run.stages, { colW, laneH: 148, padX, padY: 104 });
  const keys = useKeys(L, wrap, onSelect);
  const top = Math.min(...L.nodes.map((n) => n.y)) - 78;
  const labelW = Math.min(colW - 20, 232);
  const height = L.height + 44;
  return (
    <div className="canvas-scroll" ref={box}>
      <div className="flow-wrap" ref={wrap} style={{ width: L.width, height }}>
        <svg className="flow" width={L.width} height={height} viewBox={`0 0 ${L.width} ${height}`} role="group" aria-label="Pipeline flow: arrow keys move between stages, Enter opens one">
          {L.edges.map((e, i) => {
            const mx = (e.from.x + e.to.x) / 2;
            return <path key={i} d={`M${e.from.x + 22},${e.from.y} C${mx},${e.from.y} ${mx},${e.to.y} ${e.to.x - 22},${e.to.y}`} className={`edge ${edgeClass(e.to.s.state)}`} />;
          })}
          <Rework L={L} run={run} lift={24} top={top} />
          {L.nodes.map((n) => (
            <g
              key={n.s.code}
              data-code={n.s.code}
              className="node-hit"
              tabIndex={0}
              role="button"
              aria-label={`${n.s.code} ${n.s.name}, ${STATE_LABEL[n.s.state]}${paramsLabel(n.s)}${whyOf(n.s, pending) ? `, ${whyOf(n.s, pending)!.headline}` : ""}`}
              onClick={(e) => onSelect(n.s.code, e.currentTarget)}
              onKeyDown={keys(n.s.code)}
            >
              <NodeMark s={n.s} x={n.x} y={n.y} selected={selected === n.s.code} />
            </g>
          ))}
        </svg>
        {L.nodes.map((n) => (
          // the label is part of the node: clicking it picks the stage too (the node above carries the keyboard and name)
          <div key={n.s.code} className={`fl-label${selected === n.s.code ? " on" : ""}`} style={{ left: n.x - labelW / 2, top: n.y + 40, width: labelW }} aria-hidden onClick={(e) => onSelect(n.s.code, e.currentTarget)}>
            <span className="fl-name" title={n.s.name}>
              {n.s.name}
            </span>
            <span className={`fl-state st-${n.s.state}`}>
              {STATE_LABEL[n.s.state]}
              {progressText(n.s)}
            </span>
            {(() => {
              const p = whyOf(n.s, pending);
              return p ? (
                <span className={`fl-why w-${p.status}`} title={p.headline}>
                  {shortWhy(p)}
                </span>
              ) : null;
            })()}
          </div>
        ))}
      </div>
    </div>
  );
}

const CW = 240;
const CH = 118;

/** A right-angled connector with rounded corners from the right edge of one card to the left edge of the next. */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y1 - y2) < 1) return `M${x1},${y1} H${x2}`;
  const mx = (x1 + x2) / 2;
  const r = Math.min(12, Math.abs(y2 - y1) / 2, (x2 - x1) / 4);
  const d = y2 > y1 ? 1 : -1;
  return `M${x1},${y1} H${mx - r} Q${mx},${y1} ${mx},${y1 + d * r} V${y2 - d * r} Q${mx},${y2} ${mx + r},${y2} H${x2}`;
}

export function GraphView({ run, selected, onSelect, pending }: { run: RunView; selected: string | null; onSelect: OnSelect; pending?: PendingOf }) {
  const [box, w] = useWidth<HTMLDivElement>();
  const wrap = useRef<HTMLDivElement>(null);
  const padX = CW / 2 + 28;
  const colW = fitColumn(w, columnCount(run.stages), padX, CW + 60, CW + 150);
  const headH = 40 + (run.rework ? 52 : 0);
  const L = layout(run.stages, { colW, laneH: CH + 36, padX, padY: CH / 2 + 22, padTop: headH });
  const keys = useKeys(L, wrap, onSelect);
  const arrow = (cls: string) => `url(#gar-${cls})`;
  return (
    <div className="canvas-scroll graph-scroll" ref={box}>
      <div className="graph" ref={wrap} style={{ width: L.width, height: L.height }}>
        {L.cols.map((c, i) =>
          c.stages.length > 1 ? <div key={`band${i}`} className="g-band" style={{ left: c.x - CW / 2 - 12, top: headH - 6, width: CW + 24, height: L.height - headH - 4 }} aria-hidden /> : null,
        )}
        {L.cols.map((c, i) => (
          <div key={`h${i}`} className="g-head" style={{ left: c.x - CW / 2, top: run.rework ? 52 : 8, width: CW }} aria-hidden>
            <span className="mono">{c.stages.length > 1 ? `${c.stages[0]!.code}–${c.stages[c.stages.length - 1]!.code}` : c.stages[0]!.code}</span>
            {c.stages.length > 1 && <span>{c.stages.length} in parallel</span>}
          </div>
        ))}
        <svg width={L.width} height={L.height} className="graph-edges" aria-hidden>
          <defs>
            {(["e-done", "e-active", "e-queued"] as const).map((k) => (
              <marker key={k} id={`gar-${k}`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0.5 L8,4 L0,7.5 z" className={`gar ${k}`} />
              </marker>
            ))}
          </defs>
          {L.edges.map((e, i) => {
            const cls = edgeClass(e.to.s.state);
            const d = elbow(e.from.x + CW / 2, e.from.y, e.to.x - CW / 2 - 1, e.to.y);
            return (
              <g key={i}>
                <path d={d} className={`edge ${cls}`} markerEnd={arrow(cls)} />
                {cls === "e-active" && <path d={d} className="edge-flow" />}
              </g>
            );
          })}
          <Rework L={L} run={run} lift={CH / 2} top={10} dx={CW / 2 - 30} />
        </svg>
        {L.nodes.map((n) => (
          <GraphCard key={n.s.code} s={n.s} run={run} x={n.x} y={n.y} selected={selected === n.s.code} onSelect={onSelect} onKeyDown={keys(n.s.code)} why={whyOf(n.s, pending)} />
        ))}
      </div>
    </div>
  );
}

function GraphCard({ s, run, x, y, selected, onSelect, onKeyDown, why }: { s: StageRunView; run: RunView; x: number; y: number; selected: boolean; onSelect: OnSelect; onKeyDown: (e: KeyboardEvent<Element>) => void; why: StagePendingView | null }) {
  const crit = s.criteriaResults;
  const pass = crit.filter((c) => c.ok === true).length;
  const bad = crit.some((c) => c.ok === false);
  const done = Math.min(1, run.quantity > 0 ? s.unitsGood / run.quantity : 0);
  return (
    <button
      type="button"
      data-code={s.code}
      className={`gcard s-${s.state}${selected ? " selected" : ""}`}
      style={{ left: x - CW / 2, top: y - CH / 2, width: CW, height: CH }}
      aria-label={`${s.code} ${s.name}, ${STATE_LABEL[s.state]}${paramsLabel(s)}${why ? `, ${why.headline}` : ""}`}
      onClick={(e) => onSelect(s.code, e.currentTarget)}
      onKeyDown={onKeyDown}
    >
      <span className="gc-top">
        <span className="mono gc-code">{s.code}</span>
        <span className={`gc-state st-${s.state}`}>
          <i className={`lg ${swatch(s.state)}`} aria-hidden />
          {STATE_LABEL[s.state]}
          {progressText(s)}
        </span>
      </span>
      <span className="gc-name" title={s.name}>
        {s.name}
      </span>
      <span className="gc-res">{s.assetId ? <Ref kind="machine" id={s.assetId} fallback={s.assetName ?? AGENT_LABEL[s.agent]} plain link={false} /> : (s.assetName ?? AGENT_LABEL[s.agent])}</span>
      <span className="gc-foot">
        {s.state === "running" ? (
          <span className="progress gc-prog" aria-hidden>
            <span style={{ width: `${Math.round(Math.max(done, s.progress) * 100)}%` }} />
          </span>
        ) : null}
        {why && s.state === "queued" ? (
          <span className={`gc-why w-${why.status}`} title={why.headline}>
            {shortWhy(why)}
          </span>
        ) : (
          <span className="num">
            {s.unitsGood}/{run.quantity}
          </span>
        )}
        {crit.length > 0 && (
          <span className={bad ? "bad-text" : pass === crit.length ? "ok-text" : "faint"}>
            {pass}/{crit.length} in spec
          </span>
        )}
        {atGate(s) && <span className="gc-wait">needs {roleWords(s.escalationRole)}</span>}
      </span>
    </button>
  );
}

export function LedgerView({ run, onOpen }: { run: RunView; onOpen: (code: string) => void }) {
  return (
    <div className="scroll-x">
      <table className="t ledger">
        <thead>
          <tr>
            <th>Stage</th>
            <th>State</th>
            <th>Outcome</th>
            <th>Parameters</th>
            <th>Agent · resource</th>
            <th>Started</th>
            <th>Duration</th>
            <th className="r">Good / scrap</th>
            <th className="r">Yield</th>
            <th className="r">Throughput</th>
          </tr>
        </thead>
        <tbody>
          {run.stages.map((s) => (
            <tr key={s.code} className="click" tabIndex={0} onClick={() => onOpen(s.code)} onKeyDown={(e) => e.key === "Enter" && onOpen(s.code)}>
              <td>
                <span className="mono">{s.code}</span> {s.name}
              </td>
              <td className={`st-${s.state}`}>{STATE_LABEL[s.state]}</td>
              <td className="wrap">{s.outcome ?? s.waitingReason ?? <span className="faint">—</span>}</td>
              <td className="band-cell">
                {s.criteriaResults.length ? (
                  s.criteriaResults.map((c) => <SpecBand key={c.label} compact lo={c.band?.lo ?? null} hi={c.band?.hi ?? null} value={c.measured?.value ?? null} valueMax={c.measuredMax?.value ?? null} ok={c.ok} unit={c.unit} label={`${c.label} ${c.target}`} />)
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td>
                {AGENT_LABEL[s.agent]}
                <div className="faint small">{s.assetId ? <Ref kind="machine" id={s.assetId} fallback={s.assetName ?? "—"} link={false} /> : (s.assetName ?? "—")}</div>
              </td>
              <td className="num">{s.startedAt ? new Date(s.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
              <td>{dur(s.durationMin)}</td>
              <td className="r num">
                {s.unitsGood} / {s.unitsScrap}
              </td>
              <td className="r num">{s.yieldPct === null ? "—" : `${s.yieldPct.toFixed(1)}%`}</td>
              <td className="r num">{s.throughputPerHour === null ? "—" : `${num(s.throughputPerHour)} u/h`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
