import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { dateTime, dur, pct, STATE_LABEL } from "../lib/format";
import { go } from "../lib/router";
import type { RunView } from "../types";
import { dayKey, DateRangePicker, parseDay, type Range } from "../ui/Calendar";
import { Empty, Loading, Segmented } from "../ui/kit";

type Outcome = "all" | "running" | "completed" | "aborted";

export function History() {
  const { path } = useApp();
  const [range, setRange] = useState<Range>(() => {
    const t = new Date();
    const f = new Date(t);
    f.setDate(t.getDate() - 6);
    return { from: dayKey(f), to: dayKey(t) };
  });
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const days = range.from ? Math.min(365, Math.ceil((Date.now() - parseDay(range.from).getTime()) / 86_400_000) + 1) : 365;
  useEffect(() => {
    setRuns(null);
    void api.get<RunView[]>(path(`/runs?days=${days}`)).then(setRuns);
  }, [path, days]);
  if (!runs) return <Loading />;
  const inRange = runs.filter((r) => {
    const d = dayKey(new Date(r.startedAt));
    return (!range.from || d >= range.from) && (!range.to || d <= range.to);
  });
  const shown = inRange.filter((r) => outcome === "all" || r.status === outcome);
  const count = (o: Outcome) => inRange.filter((r) => o === "all" || r.status === o).length;
  return (
    <div>
      <div className="eyebrow">{inRange.length} runs in range</div>
      <h1>Run history</h1>
      <div className="filters">
        <DateRangePicker value={range} onChange={setRange} max={dayKey(new Date())} />
        <Segmented<Outcome>
          size="sm"
          value={outcome}
          onChange={setOutcome}
          options={(["all", "running", "completed", "aborted"] as Outcome[]).map((o) => ({ value: o, label: o === "all" ? "All" : o[0]!.toUpperCase() + o.slice(1), count: count(o) }))}
        />
      </div>
      {shown.length === 0 ? (
        <Empty title="No runs in this range">Start a run from Pipelines or Templates; it appears here with its stage outcomes and decisions.</Empty>
      ) : (
        <div className="card scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Run</th>
                <th>Template</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Stages</th>
                <th className="r">Rolled yield</th>
                <th className="r">Decisions</th>
                <th className="r">To people</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="click" onClick={() => go(`pipelines/${r.id}`)}>
                  <td>
                    <b className="mono">{r.id}</b>
                    <div className="faint small">
                      {r.orderRef} · {r.quantity} u
                    </div>
                  </td>
                  <td>
                    {r.templateName}
                    <div className="faint small">v{r.templateVersion}</div>
                  </td>
                  <td>{dateTime(r.startedAt)}</td>
                  <td>{dur(((r.finishedAt ? Date.parse(r.finishedAt) : Date.now()) - Date.parse(r.startedAt)) / 60_000)}</td>
                  <td>
                    <div className="strip">
                      {r.stages.map((s) => (
                        <span key={s.code} className={`sq st-bg-${s.state}`} title={`${s.code} ${s.name}: ${STATE_LABEL[s.state]}`} />
                      ))}
                    </div>
                  </td>
                  <td className="r">{pct(r.metrics.rolledYield)}</td>
                  <td className="r">{r.metrics.decisions}</td>
                  <td className="r">{r.metrics.escalated}</td>
                  <td>
                    <span className={`tag ${r.status === "completed" ? (r.stages.some((s) => s.deviation) ? "warn" : "ok") : r.status === "running" ? "accent" : "bad"}`}>
                      {r.status === "completed" && r.stages.some((s) => s.deviation) ? "Completed · deviation" : r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
