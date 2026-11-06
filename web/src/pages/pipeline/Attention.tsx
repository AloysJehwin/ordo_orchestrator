import { CircleCheck, CircleAlert, Hand, Clock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useApp } from "../../lib/app";
import type { InboxItemView, RunView } from "../../types";
import { atGate, roleWords } from "./layout";

interface Item {
  key: string;
  code: string | null;
  tone: "bad" | "accent" | "warn";
  icon: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  mine: boolean;
}

/**
 * What on this run needs a person: gates waiting or held (and on whom), parameters out of their band, stages waiting
 * on data or an operator, and open exceptions. Each row opens its stage.
 */
export function Attention({ run, inbox, onOpen }: { run: RunView; inbox: InboxItemView[]; onOpen: (code: string) => void }) {
  const { can } = useApp();
  const items: Item[] = [];
  for (const s of run.stages.filter(atGate)) {
    const mine = can(s.escalationRole);
    items.push({
      key: `gate:${s.code}`,
      code: s.code,
      tone: s.state === "held" ? "bad" : "accent",
      icon: <Hand size={15} aria-hidden />,
      title: (
        <>
          <span className="mono">{s.code}</span> {s.name}
        </>
      ),
      detail: `${s.state === "held" ? "Held" : "Waiting at its gate"} for ${roleWords(s.escalationRole)}s${mine ? " · you can release it" : ""}`,
      mine,
    });
  }
  for (const s of run.stages) {
    const out = s.criteriaResults.filter((c) => c.ok === false);
    if (!out.length) continue;
    items.push({
      key: `spec:${s.code}`,
      code: s.code,
      tone: "bad",
      icon: <TriangleAlert size={15} aria-hidden />,
      title: (
        <>
          <span className="mono">{s.code}</span> {out.length === 1 ? `${out[0]!.label} out of its band` : `${out.length} parameters out of their bands`}
        </>
      ),
      detail: out.map((c) => `${c.label} ${c.actual ?? "?"} (target ${c.target})`).join(" · "),
      mine: false,
    });
  }
  for (const s of run.stages) {
    if (!s.waitingReason || atGate(s) || (s.state !== "running" && s.state !== "queued")) continue;
    items.push({
      key: `wait:${s.code}`,
      code: s.code,
      tone: "warn",
      icon: <Clock size={15} aria-hidden />,
      title: (
        <>
          <span className="mono">{s.code}</span> {s.name}
        </>
      ),
      detail: s.waitingReason,
      mine: false,
    });
  }
  const gates = new Set(run.stages.map((s) => s.gateItemId).filter(Boolean));
  for (const i of inbox.filter((x) => x.status === "pending" && x.kind === "exception" && !gates.has(x.id))) {
    items.push({
      key: `inbox:${i.id}`,
      code: i.stageCode,
      tone: i.severity === "high" || i.severity === "critical" ? "bad" : "warn",
      icon: <CircleAlert size={15} aria-hidden />,
      title: i.title,
      detail: `Needs ${roleWords(i.requiredRole)}${can(i.requiredRole) ? " · you can decide it" : ""}`,
      mine: can(i.requiredRole),
    });
  }
  // what the signed-in person can act on comes first
  items.sort((a, b) => Number(b.mine) - Number(a.mine));
  return (
    <section className="attention card" aria-labelledby="att-h">
      <div className="card-h">
        <h2 id="att-h">Needs attention</h2>
        {items.length > 0 && <span className="num small muted">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="att-clear">
          <CircleCheck size={16} aria-hidden /> Nothing waits on a person. Every stage is in its band or still running.
        </p>
      ) : (
        <ul className="att-list">
          {items.map((it) => (
            <li key={it.key}>
              <button type="button" className={`att-row t-${it.tone}${it.mine ? " mine" : ""}`} disabled={!it.code} onClick={() => it.code && onOpen(it.code)}>
                <span className="att-ico">{it.icon}</span>
                <span className="att-text">
                  <b>{it.title}</b>
                  <span className="small muted">{it.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
