import { useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { MEDIA_ICON, metricText } from "../../lib/outcomes";
import type { ContributionOutcome, ContributionView, OutcomeView } from "../../types";
import { Modal } from "../../ui/kit";
import { SpecBand } from "../../ui/SpecBand";
import { Media } from "./Outcomes";

const VERDICT: Record<NonNullable<ContributionOutcome["verdict"]>, [string, string]> = {
  confirm: ["✓ Confirmed", "ok"],
  dispute: ["▲ Disputed", "bad"],
  unsure: ["? Unsure", "warn"],
};

/** The contributor's verdict on one outcome, as a tag. */
export function VerdictTag({ o }: { o: ContributionOutcome }) {
  if (!o.verdict) return <span className="tag">{o.sha256 ? "Not reviewed" : "Not captured"}</span>;
  const [label, tone] = VERDICT[o.verdict];
  return <span className={`tag ${tone}`}>{label}</span>;
}

/** What the contributor said beside the machine's value: the value they observed and their note. */
function Said({ o, unit }: { o: ContributionOutcome; unit: string }) {
  if (!o.verdict) return null;
  const u = unit ? ` ${unit}` : "";
  return (
    <p className="small oc-said">
      {o.observed !== null && o.observed !== undefined && (
        <>
          Observed <b className="num">{o.observed}</b>
          {u}
          {o.machineValue !== null && o.machineValue !== undefined ? ` (the machine read ${o.machineValue}${u})` : ""}.{" "}
        </>
      )}
      {o.note && <span className="muted">“{o.note}”</span>}
    </p>
  );
}

/**
 * The stage's outcomes as a proof of work binds them: what the machine captured (the version the contributor reviewed)
 * with their verdict on each. Shown on the signing page and to validators; the media comes through the contribution, so
 * its author sees it whatever their level.
 */
export function ContributionOutcomes({ c }: { c: ContributionView }) {
  const { path } = useApp();
  const [list, setList] = useState<OutcomeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState<{ o: OutcomeView; src: string } | null>(null);
  const bound = c.outcomes ?? [];
  useEffect(() => {
    if (!bound.length) return;
    api
      .get<{ outcomes: OutcomeView[] }>(path(`/contributions/${c.id}/outcomes`))
      .then((r) => setList(r.outcomes))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [path, c.id, bound.length]);
  if (!bound.length) return null;
  const file = (o: OutcomeView, which: "file" | "preview") => api.url(path(`/contributions/${c.id}/outputs/${o.key}/${which}`));
  const disputed = bound.filter((o) => o.verdict === "dispute").length;
  const confirmed = bound.filter((o) => o.verdict === "confirm").length;
  return (
    <div className="stack">
      <div className="row-between">
        <div className="label">What the machine captured, and your verdicts</div>
        <span className="faint small">
          {confirmed} confirmed{disputed ? ` · ${disputed} disputed` : ""}
        </span>
      </div>
      {error && <p className="faint small">{error}</p>}
      <div className="oc-grid">
        {bound.map((b) => {
          const o = list?.find((x) => x.key === b.outcome);
          // the record binds the version the contributor reviewed; a newer capture may exist
          const output = o?.output && b.version ? { ...o.output, version: b.version, value: b.machineValue ?? o.output.value } : null;
          const shown = o && output ? { ...o, output } : null;
          return (
            <div key={b.outcome} className={`oc-card s-${b.verdict === "confirm" ? "ok" : b.verdict === "dispute" ? "bad" : "na"}`}>
              <div className="pc-h">
                <b>
                  <span aria-hidden>{MEDIA_ICON[b.media]}</span> {b.label}
                </b>
                <VerdictTag o={b} />
              </div>
              {o && (
                <div className="faint small">
                  {o.mediaLabel} · {o.instrument}
                  {!o.required && " · optional"}
                </div>
              )}
              {shown && <Media o={shown} src={file(shown, "file")} preview={shown.output!.hasPreview ? file(shown, "preview") : null} onOpen={(src) => setBig({ o: shown, src })} />}
              {o && (
                <SpecBand
                  lo={o.metric.targetMax !== undefined || o.metric.op === ">=" ? o.metric.target : null}
                  hi={o.metric.targetMax ?? (o.metric.op === "<=" ? o.metric.target : null)}
                  value={b.machineValue ?? null}
                  ok={o.ok}
                  unit={o.metric.unit}
                  label={`${o.metric.label} ${metricText(o.metric)}`}
                />
              )}
              <Said o={b} unit={o?.metric.unit ?? ""} />
              {b.sha256 && (
                <div className="oc-proof small">
                  <span className="tag mono" title={b.sha256}>
                    v{b.version} · {b.sha256.slice(7, 19)}…
                  </span>
                  {o?.output && b.version !== null && o.output.version > b.version && <span className="faint">newer capture: v{o.output.version}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Modal open={Boolean(big)} onClose={() => setBig(null)} title={big?.o.label ?? ""} eyebrow={big ? `${big.o.mediaLabel} · ${big.o.instrument}` : ""} width={920}>
        {big && <img className="oc-big" src={big.src} alt={big.o.label} />}
      </Modal>
    </div>
  );
}

/** A proof of work's disputes, for the validator choosing between records: which outcome, what the contributor saw. */
export function DisputeList({ c }: { c: ContributionView }) {
  const disputes = (c.outcomes ?? []).filter((o) => o.verdict === "dispute");
  if (!disputes.length) return null;
  return (
    <ul className="small oc-disputes">
      {disputes.map((o) => (
        <li key={o.outcome}>
          <b>{o.label}</b> disputed
          {o.observed !== null && o.observed !== undefined ? `: observed ${o.observed}${o.machineValue !== null && o.machineValue !== undefined ? ` where the machine read ${o.machineValue}` : ""}` : ""}
          {o.note ? <span className="muted"> · “{o.note}”</span> : null}
        </li>
      ))}
    </ul>
  );
}
