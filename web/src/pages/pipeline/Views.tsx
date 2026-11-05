import type { RunView, StageRunView } from "../../types";
import { AGENT_LABEL, STATE_LABEL, dur, num } from "../../lib/format";
import { SpecBand } from "../../ui/SpecBand";
import { edgeClass, layout } from "./layout";

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
  const label = (
    <text x={x} y={y + 4.5} textAnchor="middle" className="n-code">
      {s.code}
    </text>
  );
  const sq = (cls: string) => <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={8} className={cls} />;
  let mark;
  switch (s.state) {
    case "completed":
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
      {label}
    </g>
  );
}

const paramsLabel = (s: StageRunView) => (s.criteriaResults.length ? `, ${s.criteriaResults.filter((c) => c.ok === true).length} of ${s.criteriaResults.length} parameters in spec` : "");

export function FlowView({ run, selected, onSelect }: { run: RunView; selected: string | null; onSelect: (code: string, x: number, y: number) => void }) {
  const L = layout(run.stages, { colW: 180, laneH: 112, padX: 80, padY: 90 });
  const rw = run.rework ? { from: L.by.get(run.rework.from), to: L.by.get(run.rework.to) } : null;
  const units = run.stages.find((s) => s.code === run.rework?.to)?.reworkUnits ?? 0;
  const top = Math.min(...L.nodes.map((n) => n.y)) - 70;
  return (
    <div className="canvas-scroll">
      <svg className="flow" width={L.width} height={L.height + 40} viewBox={`0 0 ${L.width} ${L.height + 40}`} role="img" aria-label="Pipeline flow">
        {L.edges.map((e, i) => {
          const mx = (e.from.x + e.to.x) / 2;
          return <path key={i} d={`M${e.from.x + 22},${e.from.y} C${mx},${e.from.y} ${mx},${e.to.y} ${e.to.x - 22},${e.to.y}`} className={`edge ${edgeClass(e.to.s.state)}`} />;
        })}
        {rw?.from && rw.to && (
          <g className="rework">
            <path d={`M${rw.from.x},${rw.from.y - 24} C${rw.from.x},${top} ${rw.to.x},${top} ${rw.to.x},${rw.to.y - 26}`} />
            <path d={`M${rw.to.x - 4},${rw.to.y - 33} L${rw.to.x},${rw.to.y - 26} L${rw.to.x + 4},${rw.to.y - 33}`} />
            <text x={(rw.from.x + rw.to.x) / 2} y={top + 14} textAnchor="middle">
              Rework loop{units ? ` · ${units} unit${units === 1 ? "" : "s"} returned` : ""}
            </text>
          </g>
        )}
        {L.nodes.map((n) => (
          <g key={n.s.code} className="node-hit" tabIndex={0} role="button" aria-label={`${n.s.code} ${n.s.name}, ${STATE_LABEL[n.s.state]}${paramsLabel(n.s)}`} onClick={() => onSelect(n.s.code, n.x, n.y)} onKeyDown={(e) => e.key === "Enter" && onSelect(n.s.code, n.x, n.y)}>
            <NodeMark s={n.s} x={n.x} y={n.y} selected={selected === n.s.code} />
            <text x={n.x} y={n.y + 42} textAnchor="middle" className="n-name">
              {n.s.name}
            </text>
            <text x={n.x} y={n.y + 57} textAnchor="middle" className={`n-state st-${n.s.state}`}>
              {STATE_LABEL[n.s.state]}
              {n.s.state === "running" && n.s.progress > 0 ? ` · ${Math.round(n.s.progress * 100)}%` : ""}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function GraphView({ run, selected, onSelect }: { run: RunView; selected: string | null; onSelect: (code: string, x: number, y: number) => void }) {
  const L = layout(run.stages, { colW: 220, laneH: 96, padX: 110, padY: 60 });
  return (
    <div className="canvas-scroll dots">
      <div className="graph" style={{ width: L.width, height: L.height }}>
        <svg width={L.width} height={L.height} className="graph-edges" aria-hidden>
          {L.edges.map((e, i) => {
            const mx = (e.from.x + e.to.x) / 2;
            return <path key={i} d={`M${e.from.x + 90},${e.from.y} C${mx},${e.from.y} ${mx},${e.to.y} ${e.to.x - 90},${e.to.y}`} className={`edge ${edgeClass(e.to.s.state)}`} />;
          })}
        </svg>
        {L.nodes.map((n) => (
          <button type="button" key={n.s.code} className={`gcard s-${n.s.state}${selected === n.s.code ? " selected" : ""}`} style={{ left: n.x - 90, top: n.y - 32 }} onClick={() => onSelect(n.s.code, n.x, n.y)}>
            <span className="gc-top">
              <span className="mono">{n.s.code}</span>
              <span className={`st-${n.s.state}`}>{STATE_LABEL[n.s.state]}</span>
            </span>
            <b>{n.s.name}</b>
            <span className="faint small">
              {n.s.assetName ?? AGENT_LABEL[n.s.agent]} · {n.s.unitsGood}/{run.quantity}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function LedgerView({ run, onOpen }: { run: RunView; onOpen: (code: string) => void }) {
  return (
    <div className="scroll-x">
      <table className="t">
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
            <tr key={s.code} className="click" onClick={() => onOpen(s.code)}>
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
                <div className="faint small">{s.assetName ?? "—"}</div>
              </td>
              <td>{s.startedAt ? new Date(s.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
              <td>{dur(s.durationMin)}</td>
              <td className="r">
                {s.unitsGood} / {s.unitsScrap}
              </td>
              <td className="r">{s.yieldPct === null ? "—" : `${s.yieldPct.toFixed(1)}%`}</td>
              <td className="r">{s.throughputPerHour === null ? "—" : `${num(s.throughputPerHour)} u/h`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
