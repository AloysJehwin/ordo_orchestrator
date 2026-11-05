import { useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { AGG_LABEL } from "../../lib/criteria";
import type { CriterionResult, StageSeriesView } from "../../types";
import { SpecBand } from "../../ui/SpecBand";
import { Spark } from "../../ui/Spark";

/** The series behind a stage's measured parameters, refreshed with the console's live cadence. */
export function useStageSeries(runId: string, code: string | null, enabled: boolean): StageSeriesView | null {
  const { path, live } = useApp();
  const [data, setData] = useState<StageSeriesView | null>(null);
  const head = live?.headSeq ?? 0;
  useEffect(() => {
    if (!enabled || !code) {
      setData(null);
      return;
    }
    let on = true;
    api
      .get<StageSeriesView>(path(`/runs/${runId}/stages/${code}/series`))
      .then((d) => on && setData(d))
      .catch(() => on && setData(null));
    return () => {
      on = false;
    };
  }, [path, runId, code, enabled, head]);
  return data;
}

export const statusOf = (ok: boolean | null) => (ok === true ? "● Pass" : ok === false ? "▲ Out of spec" : "○ Not measured");

/** One parameter of a stage: its band and where the value fell, how it was measured, and the signal's trend over the stage window. */
export function ParamCard({ c, series, window, live }: { c: CriterionResult; series?: { ts: number; value: number }[]; window?: { from: string; to: string } | null; live?: boolean }) {
  const pts = series ?? [];
  const last = pts.at(-1);
  const band = c.band ?? { lo: null, hi: null };
  return (
    <div className={`param-card s-${c.ok === true ? "ok" : c.ok === false ? "bad" : "na"}`}>
      <div className="pc-h">
        <b>{c.label}</b>
        <span className={`tag ${c.ok === true ? "ok" : c.ok === false ? "bad" : ""}`}>{statusOf(c.ok)}</span>
      </div>
      <SpecBand lo={band.lo} hi={band.hi} value={c.measured?.value ?? null} valueMax={c.measuredMax?.value ?? null} ok={c.ok} unit={c.unit} label={c.label} />
      <div className="pc-meta faint small">
        target {c.target}
        {c.kind === "signal" && (
          <>
            {" "}
            · {c.signal} · {AGG_LABEL[c.agg ?? "last"].toLowerCase()}
            {c.n ? ` · ${c.n} sample${c.n === 1 ? "" : "s"}` : ""}
          </>
        )}
        {c.kind === "manual" && " · confirmed by a person at the gate"}
        {c.kind !== "signal" && c.kind !== "manual" && " · from counts and time"}
      </div>
      {pts.length >= 2 && (
        <>
          <Spark points={pts} unit={c.unit} band={band} window={window ? { from: Date.parse(window.from), to: Date.parse(window.to) } : undefined} marker={last ? { ts: last.ts, value: last.value, ok: c.ok } : undefined} height={56} />
          <div className="faint small">
            {live ? "live" : "stage window"} · {pts.length} points
          </div>
        </>
      )}
    </div>
  );
}
