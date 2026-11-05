import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { ago, shortAddr } from "../../lib/format";
import { MEDIA_ICON, metricText } from "../../lib/outcomes";
import type { OutcomeView, RunView, StageRunView } from "../../types";
import { Modal } from "../../ui/kit";
import { SpecBand } from "../../ui/SpecBand";

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const status = (o: OutcomeView) => (!o.captured ? "○ Not captured" : o.ok === true ? "● In spec" : o.ok === false ? "▲ Out of spec" : "○ Not judged");

/**
 * What the stage's machine captured for each of its outcomes: the media, the value its on-board agent read from it,
 * and that value against the target. Level 2 sees whether each was captured and met its target; level 3 the media.
 */
export function StageOutcomes({ run, stage }: { run: RunView; stage: StageRunView }) {
  const { path, sees, live } = useApp();
  const [list, setList] = useState<OutcomeView[] | null>(null);
  const [big, setBig] = useState<{ o: OutcomeView; src: string } | null>(null);
  const head = live?.headSeq ?? 0;
  const load = useCallback(
    () =>
      api
        .get<{ outcomes: OutcomeView[] }>(path(`/runs/${run.id}/stages/${stage.code}/outputs`))
        .then((r) => setList(r.outcomes))
        .catch(() => setList(null)),
    [path, run.id, stage.code],
  );
  useEffect(() => {
    if (sees(2) && stage.outcomes.length) void load();
  }, [load, sees, stage.outcomes.length, head]);
  if (!stage.outcomes.length || !sees(2)) return null;
  const captured = list?.filter((o) => o.captured).length ?? 0;
  const file = (o: OutcomeView, which: "file" | "preview") => api.url(path(`/runs/${run.id}/stages/${stage.code}/outputs/${o.key}/${which}?version=${o.output?.version ?? ""}`));
  return (
    <section className="dsec">
      <div className="row-between">
        <h3>Outcomes</h3>
        {list && (
          <span className="faint small">
            {captured} of {list.length} captured · {list.filter((o) => o.ok === true).length} in spec
          </span>
        )}
      </div>
      {!list && <p className="faint small">Loading what the machine captured…</p>}
      <div className="oc-grid">
        {list?.map((o) => (
          <div key={o.key} className={`oc-card s-${o.ok === true ? "ok" : o.ok === false ? "bad" : "na"}`}>
            <div className="pc-h">
              <b>
                <span aria-hidden>{MEDIA_ICON[o.media]}</span> {o.label}
              </b>
              <span className={`tag ${o.ok === true ? "ok" : o.ok === false ? "bad" : ""}`}>{status(o)}</span>
            </div>
            <div className="faint small">
              {o.mediaLabel} · {o.instrument}
              {!o.required && " · optional"}
            </div>
            {o.output && <Media o={o} src={file(o, "file")} preview={o.output.hasPreview ? file(o, "preview") : null} onOpen={(src) => setBig({ o, src })} />}
            <SpecBand
              lo={o.metric.targetMax !== undefined || o.metric.op === ">=" ? o.metric.target : null}
              hi={o.metric.targetMax ?? (o.metric.op === "<=" ? o.metric.target : null)}
              value={o.output?.value ?? null}
              ok={o.ok}
              unit={o.metric.unit}
              label={`${o.metric.label} ${metricText(o.metric)}`}
            />
            <div className="pc-meta faint small">
              {o.metric.label} {metricText(o.metric)}
              {o.output ? ` · read ${o.output.value}${o.metric.unit ? ` ${o.metric.unit}` : ""}` : ""}
              {o.capturedAt ? ` · ${ago(o.capturedAt)}` : ""}
              {o.output && o.output.versions > 1 ? ` · version ${o.output.version} of ${o.output.versions}` : ""}
            </div>
            {o.output && (
              <div className="oc-proof small">
                <span className="tag" title={`Signed by the machine's key ${o.output.device}: an EIP-712 OrdoOutput binding the file's hash, the lot, the stage and the value`}>
                  ✓ Signed by {shortAddr(o.output.device)}
                </span>
                {o.output.analysis?.requestId && (
                  <span className="tag" title={`${o.output.analysis.model ?? "0G"}${o.output.analysis.provider ? ` · ${o.output.analysis.provider}` : ""}${o.output.analysis.teeVerified ? " · TEE verified" : ""}`}>
                    0G {o.output.analysis.teeVerified ? "TEE " : ""}read · {o.output.analysis.requestId.slice(0, 10)}
                  </span>
                )}
                {o.output.replica && (
                  <span className={`tag ${o.output.replica.status === "done" ? "ok" : o.output.replica.status === "failed" ? "bad" : ""}`} title={o.output.replica.root ?? undefined}>
                    0G Storage · {o.output.replica.status === "done" ? "stored" : o.output.replica.status}
                  </span>
                )}
                {o.output.ledgerSeq !== null && <span className="faint">ledger #{o.output.ledgerSeq}</span>}
              </div>
            )}
            {o.output?.analysis && (
              <p className="small muted oc-read">
                {o.output.analysis.summary}
                {o.output.analysis.anomaly && <span className="bad-t"> Anomaly: {o.output.analysis.anomaly}</span>}
              </p>
            )}
            {o.captured && !o.output && <p className="faint small">Captured. Its media and value need level 3.</p>}
          </div>
        ))}
      </div>
      <Modal open={Boolean(big)} onClose={() => setBig(null)} title={big?.o.label ?? ""} eyebrow={big ? `${big.o.mediaLabel} · ${big.o.instrument}` : ""} width={920}>
        {big && <img className="oc-big" src={big.src} alt={big.o.label} />}
        {big?.o.output && <p className="faint small mono">{big.o.output.sha256}</p>}
      </Modal>
    </section>
  );
}

export function Media({ o, src, preview, onOpen }: { o: OutcomeView; src: string; preview: string | null; onOpen: (src: string) => void }) {
  const out = o.output!;
  const isImage = out.mime.startsWith("image/");
  if (o.media === "audio")
    return (
      <div className="oc-media">
        {preview && <img src={preview} alt={`${o.label} spectrogram`} onClick={() => onOpen(preview)} />}
        <audio controls preload="none" src={src} />
      </div>
    );
  if (o.media === "video")
    return (
      <div className="oc-media">
        <video controls preload="none" poster={preview ?? undefined} src={src} />
      </div>
    );
  if (isImage || preview)
    return (
      <div className="oc-media">
        <img src={isImage ? src : preview!} alt={o.label} loading="lazy" onClick={() => onOpen(isImage ? src : preview!)} />
        {!isImage && (
          <a className="link small" href={src} target="_blank" rel="noreferrer">
            Open the {out.mime === "text/csv" ? "CSV" : out.mime.split("/")[1]} · {kb(out.size)}
          </a>
        )}
      </div>
    );
  if (out.mime === "text/csv") return <CsvChart src={src} unit={o.metric.unit} />;
  return (
    <div className="oc-media doc">
      <a className="link" href={src} target="_blank" rel="noreferrer">
        ▤ Open the {out.mime === "application/pdf" ? "PDF" : out.mime.split("/")[1]} · {kb(out.size)}
      </a>
    </div>
  );
}

/** A spectrum or trace uploaded as CSV (x, y per row), drawn as a line. */
function CsvChart({ src, unit }: { src: string; unit: string }) {
  const [pts, setPts] = useState<[number, number][] | null>(null);
  useEffect(() => {
    let on = true;
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then((t) => {
        const rows = t
          .split(/\r?\n/)
          .map((l) => l.split(/[,;\t]/).map(Number))
          .filter((r) => r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]))
          .map((r) => [r[0]!, r[1]!] as [number, number]);
        if (on) setPts(rows.slice(0, 4000));
      })
      .catch(() => on && setPts([]));
    return () => {
      on = false;
    };
  }, [src]);
  if (!pts) return <p className="faint small">Loading the trace…</p>;
  if (pts.length < 2)
    return (
      <a className="link small" href={src} target="_blank" rel="noreferrer">
        Open the CSV
      </a>
    );
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 320;
  const H = 90;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${(((p[0] - x0) / (x1 - x0 || 1)) * W).toFixed(1)},${(H - ((p[1] - y0) / (y1 - y0 || 1)) * H).toFixed(1)}`).join("");
  return (
    <div className="oc-media">
      <svg viewBox={`0 0 ${W} ${H}`} className="oc-chart" role="img" aria-label={`Trace from ${x0} to ${x1}${unit ? `, ${unit}` : ""}`}>
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <a className="link small" href={src} target="_blank" rel="noreferrer">
        Open the CSV · {pts.length} points
      </a>
    </div>
  );
}
