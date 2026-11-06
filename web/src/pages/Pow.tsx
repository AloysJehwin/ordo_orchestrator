import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { useSign } from "../lib/sign";
import { TRUST_TEXT, type ContributionView, type PowSession, type PublicContribution, type TypedSignature } from "../types";
import { Empty, Loading } from "../ui/kit";
import { Ref } from "../ui/Name";
import { CancelSession, ContributionRow, StatusTag, TeeBadge } from "./pipeline/Contribute";
import { ContributionOutcomes } from "./pipeline/PowOutcomes";
import { CsvChart, kb } from "./pipeline/Outcomes";

/** My proof of work in this org: open sessions (the command can be started again from the stage) and every contribution. */
export function PowPage() {
  const { path, me, siteId } = useApp();
  const [sessions, setSessions] = useState<PowSession[] | null>(null);
  const [mine, setMine] = useState<ContributionView[] | null>(null);
  const load = useCallback(async () => {
    const [s, m] = await Promise.all([api.get<PowSession[]>(path("/pow/sessions")), api.get<ContributionView[]>(path("/contributions/mine"))]);
    setSessions(s);
    setMine(m);
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!sessions || !mine) return <Loading />;
  const open = sessions.filter((s) => s.status === "open" && Date.parse(s.expiresAt) > Date.now());
  return (
    <div>
      <div className="eyebrow">Contributor</div>
      <h1>Proof of work</h1>
      <p className="muted lede">
        Open a running stage in Pipelines and choose <b>Contribute proof of work</b>. An agent on 0G Private Computer interviews you in your terminal; you sign the record here. A validator selects the valid proof for each stage.
      </p>
      {open.length > 0 && (
        <section className="section card">
          <div className="card-h">
            <h2>Open sessions</h2>
          </div>
          <div className="card-b">
            <table className="t">
              <tbody>
                {open.map((s) => (
                  <tr key={s.id}>
                    <td>
                      Stage <b>{s.stageCode}</b> <span className="small"><Ref kind="run" id={s.runId} link={false} /></span>
                    </td>
                    <td className="small muted">until {dateTime(s.expiresAt)}</td>
                    <td className="r">
                      <CancelSession id={s.id} onDone={load} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="faint small">The command is shown once. To run it again, open the stage and start a new session; it replaces this one.</p>
          </div>
        </section>
      )}
      <section className="section">
        <div className="section-h">
          <h2>Your contributions</h2>
        </div>
        {mine.length === 0 ? (
          <Empty title="No proof of work yet">Open a running stage in Pipelines to contribute.</Empty>
        ) : (
          <ul className="pow-list">
            {mine.map((c) => (
              <li key={c.id} className="card">
                <div className="card-b">
                  <div className="faint small">
                    Stage {c.stageCode} · <Ref kind="run" id={c.runId} link={false} />
                  </div>
                  <ContributionRow c={c} mine={c.contributor.userId === me.user!.id} siteId={siteId} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The contributor reviews what the terminal agent recorded and signs it with their wallet. */
export function PowSign({ id }: { id: string }) {
  const { path, me } = useApp();
  const sign = useSign();
  const [c, setC] = useState<ContributionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api
        .get<ContributionView>(path(`/contributions/${id}`))
        .then(setC)
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [path, id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <Empty title="Proof of work not found">{error}</Empty>;
  if (!c) return <Loading />;
  const mine = c.contributor.userId === me.user!.id;
  return (
    <div className="narrow">
      <div className="eyebrow">
        Stage {c.stageCode} · <Ref kind="run" id={c.runId} />
      </div>
      <h1>{c.status === "unsigned" ? "Sign your proof of work" : "Your proof of work"}</h1>
      <section className="section card">
        <div className="card-h">
          <h2>What the agent recorded</h2>
          <StatusTag c={c} />
        </div>
        <div className="card-b stack">
          {c.summary && <p>{c.summary}</p>}
          <table className="t">
            <thead>
              <tr>
                <th>Value</th>
                <th className="r">Reported</th>
                <th>Commitment</th>
              </tr>
            </thead>
            <tbody>
              {c.measurements.map((m) => (
                <tr key={m.criterion}>
                  <td>
                    {m.criterion}
                    {m.note && <div className="faint small">{m.note}</div>}
                  </td>
                  <td className="r num">{m.value !== undefined ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : "—"}</td>
                  <td className="mono small" title={m.commitment}>
                    {m.commitment.slice(0, 10)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ContributionOutcomes c={c} />
          {c.evidence.length > 0 && (
            <div>
              <div className="label">Evidence (the files stayed on your machine; Ordo has their hashes)</div>
              <ul className="small">
                {c.evidence.map((e) => (
                  <li key={e.sha256}>
                    {e.name} <span className="faint mono">{e.sha256.slice(0, 18)}…</span>
                    {e.analyzedBy && (
                      <span className="tag" title={e.analyzedBy.requestId ?? undefined}>
                        {e.analyzedBy.kind === "transcription" ? "transcribed by" : "shown to"} {e.analyzedBy.model}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.voiceNotes && c.voiceNotes.length > 0 && (
            <div>
              <div className="label">Voice notes (transcribed on 0G with your consent)</div>
              <ul className="small">
                {c.voiceNotes.map((v) => (
                  <li key={v.sha256}>
                    <b>{v.name}</b> <span className="faint">· {v.model}</span>
                    <div className="muted">“{v.transcript}”</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.machineQa && c.machineQa.length > 0 && (
            <div>
              <div className="label">Questions the agent put to the machine</div>
              <ul className="small">
                {c.machineQa.map((q) => (
                  <li key={q.at}>
                    <b>{q.question}</b>
                    <div className="muted">{q.answer}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.notes && c.notes.length > 0 && (
            <div>
              <div className="label">Notes</div>
              <ul className="small">
                {c.notes.map((n) => (
                  <li key={n.at + n.text.slice(0, 20)}>{n.text}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="chips">
            <TeeBadge t={c.tee} />
            <span className="tag mono" title={c.recordSha256}>
              record {c.recordSha256.slice(7, 19)}…
            </span>
          </div>
          <p className="faint small">
            Only you, the org's managers and (on a dispute) its testers can read the conversation and the values; validators with access see the values. The public proof shows the commitments, the evidence hashes, the machine's media you reviewed (the files themselves, by hash), and the TEE receipts.
          </p>
        </div>
      </section>
      <div className="btns">
        {mine && c.status === "unsigned" && (
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              const r = await sign<ContributionView>({
                title: "Sign your proof of work",
                request: (chainId) => api.post<TypedSignature>(path(`/contributions/${id}/sign-request`), { chainId }),
                submit: (proof) => api.post(path(`/contributions/${id}/sign`), proof),
                done: "Proof of work signed",
              });
              if (r) setC(r);
            }}
          >
            Sign with my wallet
          </button>
        )}
        {c.status !== "unsigned" && (
          <a className="btn" href={`#/pow/${c.id}`} target="_blank" rel="noreferrer">
            Public proof
          </a>
        )}
        <a className="btn" href="#/pow">
          All my proof of work
        </a>
      </div>
      {c.status !== "unsigned" && <p className="muted small">Signed {c.signedAt ? ago(c.signedAt) : ""}. The terminal agent shows the proof link and exits by itself.</p>}
    </div>
  );
}

/** A signed proof of work, for anyone with the link: never the values or the conversation. */
export function PowProof({ id }: { id: string }) {
  const [p, setP] = useState<PublicContribution | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<PublicContribution>(`/v1/public/contributions/${encodeURIComponent(id)}`)
      .then(setP)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);
  if (error)
    return (
      <div className="pp">
        <div className="pp-brand">Ordo · Proof of work</div>
        <p className="field-e">{error}</p>
      </div>
    );
  if (!p) return <div className="boot">Loading proof…</div>;
  return (
    <div className="pp">
      <div className="pp-brand">Ordo · Proof of work</div>
      <h1>
        {p.site} · stage {p.stageCode}
      </h1>
      <p className="muted">
        Order {p.orderRef}. Signed by <b>{p.contributor.name ?? shortAddr(p.contributor.address)}</b> <span className="mono small">{p.contributor.address}</span> {p.signedAt ? `on ${dateTime(p.signedAt)}` : ""}.
      </p>
      <div className="chips">
        <TeeBadge t={p.tee} />
        <StatusTag c={p} />
        {p.ledgerSeq !== null && <span className="tag">ledger #{p.ledgerSeq}</span>}
        {p.replica?.status === "done" && p.replica.url && (
          <a className="tag ok" href={p.replica.url} target="_blank" rel="noreferrer">
            sealed copy on 0G Storage
          </a>
        )}
      </div>
      {p.selection && (
        <p>
          Selected as the valid proof for this stage {ago(p.selection.at)} by <span className="mono small">{p.selection.byName ?? shortAddr(p.selection.by)}</span>.
        </p>
      )}
      <section className="pp-card">
        <h2>Committed values</h2>
        <p className="small muted">Each value is committed as Poseidon(subject, value × 10⁴, salt); the value and salt stay sealed with the org. A selected proof's criteria are proven in zero knowledge on the lot's passport.</p>
        <table className="t">
          <tbody>
            {p.measurements.map((m) => (
              <tr key={m.criterion}>
                <td>{m.criterion}</td>
                <td className="mono small" style={{ wordBreak: "break-all" }}>
                  {m.commitment}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {p.evidence.length > 0 && (
        <section className="pp-card">
          <h2>Evidence</h2>
          <p className="small muted">Files stayed with the contributor; these are their SHA-256 hashes. A file marked 0G was shown to (or transcribed by) the private model, with the contributor's consent.</p>
          <ul className="small mono">
            {p.evidence.map((e) => (
              <li key={e.sha256}>
                {e.name} · {e.sha256}
                {e.analyzedBy && <span className="tag"> 0G {e.analyzedBy.kind === "transcription" ? "transcribed" : "vision"}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.outcomes && p.outcomes.length > 0 && (
        <section className="pp-card">
          <h2>What the contributor reviewed</h2>
          <p className="small muted">
            The media the stage&apos;s machine captured and signed, exactly the versions this record binds by SHA-256: the contributor reviewed each one with the interviewer. Their verdicts stay sealed with the org.
          </p>
          <div className="pp-media">
            {p.outcomes.map((o) => (
              <figure key={o.outcome} className="pp-fig">
                {o.file ? <PublicMedia id={p.id} o={o} /> : <div className="pp-none faint small">Not captured</div>}
                <figcaption>
                  <b>{o.label}</b>
                  {o.file && (
                    <span className="faint small">
                      {" "}
                      · v{o.version} · {kb(o.file.size)} · captured {dateTime(o.file.capturedAt)}
                    </span>
                  )}
                  {o.sha256 && <div className="mono faint small pp-hash">{o.sha256}</div>}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
      <section className="pp-card">
        <h2>{(p.tee.trustMode ?? "private") === "private" ? "0G Private Computer receipts" : "0G Router receipts"}</h2>
        <p className="small muted">
          {(p.tee.trustMode ?? "private") === "private"
            ? `The interview ran on ${p.tee.model} through the ${p.tee.network} 0G Router in private mode. For each answer the Router checked the serving provider's TEE attestation; the response key lets anyone ask the provider for its signature over that answer.`
            : `The interview ran on ${p.tee.model} through the ${p.tee.network} 0G Router on ${TRUST_TEXT[p.tee.trustMode ?? "standard"]}: no provider served it in a TEE, so no answer carries an attestation. Each answer's request id and hashes still bind what was asked and answered.`}
        </p>
        <table className="t">
          <thead>
            <tr>
              <th>Turn</th>
              <th>Provider</th>
              <th>TEE</th>
              <th>Response key</th>
            </tr>
          </thead>
          <tbody>
            {p.receipts.map((r, i) => (
              <tr key={i}>
                <td className="num">
                  {i + 1}
                  {r.kind === "transcription" && <span className="faint small"> · voice note</span>}
                </td>
                <td className="mono small">{r.provider ? shortAddr(r.provider) : "—"}</td>
                <td>{r.teeVerified === true ? <span className="tag ok">verified</span> : r.teeVerified === false ? <span className="tag bad">failed</span> : <span className="tag">not reported</span>}</td>
                <td className="mono small">{r.resKey ? `${r.resKey.slice(0, 14)}…` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="pp-card">
        <h2>Signature</h2>
        <p className="small muted">EIP-712, over the record's hash: <span className="mono">{p.recordSha256}</span></p>
        {p.signature && <p className="mono small" style={{ wordBreak: "break-all" }}>{p.signature.signature}</p>}
      </section>
    </div>
  );
}

/** One of the machine's files on the public proof: an image, video or recording plays here; a trace is drawn; anything else downloads. */
function PublicMedia({ id, o }: { id: string; o: PublicContribution["outcomes"][number] }) {
  const f = o.file!;
  const base = `/v1/public/contributions/${encodeURIComponent(id)}/media/${encodeURIComponent(o.outcome)}`;
  const src = api.url(base);
  const preview = f.hasPreview ? api.url(`${base}/preview`) : null;
  if (f.mime.startsWith("video/")) return <video controls preload="metadata" poster={preview ?? undefined} src={src} />;
  if (f.mime.startsWith("audio/"))
    return (
      <>
        {preview && <img src={preview} alt={`${o.label}: spectrogram`} loading="lazy" />}
        <audio controls preload="none" src={src} />
      </>
    );
  if (f.mime.startsWith("image/"))
    return (
      <a href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={o.label} loading="lazy" />
      </a>
    );
  if (f.mime === "text/csv") return <CsvChart src={src} unit="" />;
  return (
    <>
      {preview && <img src={preview} alt={o.label} loading="lazy" />}
      <a className="link small" href={src}>
        Download the {f.mime === "application/pdf" ? "PDF" : (f.mime.split("/")[1] ?? "file").toUpperCase()}
      </a>
    </>
  );
}
