import { useMemo, useState } from "react";
import { ExternalLink, PenLine } from "lucide-react";
import { useApp } from "../../lib/app";
import { evidenceOf, signedOf } from "../../lib/evidence";
import { actorGroup, time, type ActorGroup } from "../../lib/format";
import { href } from "../../lib/router";
import type { DecisionView } from "../../types";
import { Segmented } from "../../ui/kit";
import { Actor, Who } from "../../ui/Name";

type Filter = "all" | ActorGroup;
const PAGE = 30;

/** What the agents, people and machines decided on this run, and why: newest first, filterable by who decided. */
export function DecisionStream({ decisions, onStage }: { decisions: DecisionView[]; onStage: (code: string) => void }) {
  const { meta, sees } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: decisions.length, agent: 0, person: 0, machine: 0, system: 0 };
    for (const d of decisions) c[actorGroup(d.agent)]++;
    return c;
  }, [decisions]);
  const rows = filter === "all" ? decisions : decisions.filter((d) => actorGroup(d.agent) === filter);
  const options = (
    [
      { value: "all", label: "All" },
      { value: "agent", label: "Agents" },
      { value: "person", label: "People" },
      { value: "machine", label: "Machines" },
      { value: "system", label: "System" },
    ] as { value: Filter; label: string }[]
  )
    .filter((o) => o.value === "all" || counts[o.value] > 0)
    .map((o) => ({ ...o, count: counts[o.value] }));
  return (
    <section className="stream-card card" aria-labelledby="stream-h">
      <div className="card-h">
        <h2 id="stream-h">Decision stream</h2>
        <Segmented<Filter> size="sm" label="Who decided" value={filter} onChange={(f) => (setFilter(f), setShown(PAGE))} options={options} />
      </div>
      {rows.length === 0 ? (
        <p className="card-b muted small">{decisions.length ? "Nothing from them on this run yet." : "No decisions on this run yet. Agents log each one here with its reason and confidence."}</p>
      ) : (
        <ol className="dstream">
          {rows.slice(0, shown).map((d) => (
            <li key={d.id} className="srow">
              <time className="s-time num" dateTime={d.ts}>
                {time(d.ts)}
              </time>
              <span className="s-who">
                <Actor actor={d.agent} />
              </span>
              <span className="s-what">
                <b>{d.summary}</b>
                {d.reason && <span className="muted"> {d.reason}</span>}
                <Evidence d={d} network={meta.hederaNetwork} ledger={sees(4)} />
              </span>
              <span className="s-meta">
                {d.stageCode && (
                  <button type="button" className="s-stage mono" onClick={() => onStage(d.stageCode!)} aria-label={`Open stage ${d.stageCode}`}>
                    {d.stageCode}
                  </button>
                )}
                {d.confidence !== null && (
                  <span className="s-conf" title={`Confidence ${d.confidence.toFixed(2)}`}>
                    <span className="s-meter" aria-hidden>
                      <span style={{ width: `${Math.round(d.confidence * 100)}%` }} />
                    </span>
                    <span className="num">{d.confidence.toFixed(2)}</span>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > shown && (
        <div className="stream-more">
          <button type="button" className="btn sm" onClick={() => setShown(shown + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more
          </button>
          <span className="faint small num">
            {shown} of {rows.length}
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * What backs a decision: the signature it records, the payment, schedule or HCS record on HashScan, and (for those who
 * may read the ledger) its hash-chained ledger entry.
 */
function Evidence({ d, network, ledger }: { d: DecisionView; network: string | undefined; ledger: boolean }) {
  const links = evidenceOf(d, network);
  const sig = signedOf(d);
  const subject = d.runId ? `${d.runId}${d.stageCode ? `/${d.stageCode}` : ""}` : null;
  const showLedger = ledger && d.ledgerSeq !== null;
  if (!links.length && !sig && !showLedger) return null;
  // the signer is worth naming only when it is not the actor already shown on the row
  const signer = sig?.signer && !d.agent.toLowerCase().includes(sig.signer.toLowerCase()) ? sig.signer : null;
  return (
    <span className="s-ev">
      {sig && (
        <span className="s-signed" title={sig.detail}>
          <PenLine size={12} aria-hidden />
          {sig.label}
          {signer && (
            <>
              {" "}
              by <Who address={signer} />
            </>
          )}
        </span>
      )}
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
          {l.label}
          <ExternalLink size={11} aria-hidden />
        </a>
      ))}
      {showLedger && (
        <a className="num" href={href(`proof?seq=${d.ledgerSeq}${subject ? `&subject=${encodeURIComponent(subject)}` : ""}`)} title="This decision's entry in the hash-chained ledger">
          Ledger #{d.ledgerSeq}
        </a>
      )}
    </span>
  );
}
