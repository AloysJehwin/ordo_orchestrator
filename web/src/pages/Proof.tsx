import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { dateTime } from "../lib/format";
import type { AnchorDto, LedgerEntryDto, VerifyReport } from "../types";
import { Action, Loading } from "../ui/kit";
import { Actor } from "../ui/Name";
import { Select } from "../ui/Select";

export function Proof() {
  const { path, live, can } = useApp();
  const [ledger, setLedger] = useState<{ entries: LedgerEntryDto[]; anchors: AnchorDto[]; anchorKind: string } | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    void api.get<typeof ledger>(path(`/ledger?limit=150${subject ? `&subject=${encodeURIComponent(subject)}` : ""}`)).then(setLedger);
  }, [path, live?.headSeq, subject]);
  if (!ledger) return <Loading />;
  const verify = async () => setReport(await api.get<VerifyReport>(path(`/verify${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`)));
  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <div className="eyebrow">Head #{live?.headSeq ?? "—"} · anchored with {ledger.anchorKind}</div>
          <h1>Proof & ledger</h1>
          <p className="muted lede">Every decision, signature and data-source change is a hash-chained ledger entry. The head is anchored outside the database, so any later edit is detectable.</p>
        </div>
        <div className="ph-actions">
          <Select
            width={240}
            value={subject}
            onChange={setSubject}
            options={[{ value: "", label: "Whole ledger" }, ...(live?.runs ?? []).map((r) => ({ value: r.id, label: `${r.id} · ${r.templateName}` }))]}
            placeholder="Whole ledger"
          />
          <Action className="btn accent" onClick={verify}>
            Verify now
          </Action>
          {can("manager") && (
            <Action className="btn" onClick={async () => (await api.post(path("/anchors")), setLedger(await api.get(path("/ledger?limit=150"))))}>
              Anchor head
            </Action>
          )}
        </div>
      </div>
      {report && (
        <div className={`notice ${report.ok ? "ok" : "bad"}`}>
          <b>{report.ok ? "Ledger verified." : "Verification failed."}</b> {report.entries} entries re-hashed from genesis to #{report.headSeq}.
          {report.broken.length > 0 && <div>Broken at: {report.broken.map((b) => `#${b.seq} (${b.reason})`).join("; ")}</div>}
          {report.anchors.slice(0, 3).map((a) => (
            <div key={a.id} className="small">
              Anchor #{a.toSeq} · {a.kind} · {a.matchesChain ? "matches chain" : "does not match chain"} · {a.external.detail}{" "}
              {a.url && (
                <a href={a.url} target="_blank" rel="noreferrer">
                  view
                </a>
              )}
            </div>
          ))}
          {report.subject && <div className="small">{report.subject.entries.length} entries for {report.subject.id}, all {report.subject.entries.every((e) => e.ok) ? "intact" : "NOT intact"}.</div>}
        </div>
      )}
      <section className="section">
        <div className="section-h">
          <h2>Anchors</h2>
        </div>
        <div className="card scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>To entry</th>
                <th>Kind</th>
                <th>Reference</th>
                <th>Entry hash</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {ledger.anchors.length === 0 && (
                <tr>
                  <td colSpan={5} className="faint">
                    No anchors yet. The head is anchored automatically as entries accumulate.
                  </td>
                </tr>
              )}
              {ledger.anchors.map((a) => (
                <tr key={a.id}>
                  <td className="mono">#{a.toSeq}</td>
                  <td>{a.kind}</td>
                  <td className="mono small">{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.ref}</a> : a.ref}</td>
                  <td className="mono small">{a.entryHash.slice(0, 23)}…</td>
                  <td>{dateTime(a.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="section">
        <div className="section-h">
          <h2>Entries</h2>
          <span className="muted small">Newest first · click to see the payload</span>
        </div>
        <div className="card scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Actor</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Entry hash</th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((e) => (
                <>
                  <tr key={e.seq} className="click" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                    <td className="mono">{e.seq}</td>
                    <td>{dateTime(e.ts)}</td>
                    <td className="agent">
                      <Actor actor={e.actor} />
                    </td>
                    <td>{e.type}</td>
                    <td className="mono small">{e.subject ?? "—"}</td>
                    <td className="mono small">{e.entryHash.slice(7, 23)}…</td>
                  </tr>
                  {open === e.seq && (
                    <tr key={`${e.seq}-p`}>
                      <td colSpan={6}>
                        <pre className="payload">{JSON.stringify({ payload: e.payload, payloadHash: e.payloadHash, prevHash: e.prevHash, entryHash: e.entryHash }, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
