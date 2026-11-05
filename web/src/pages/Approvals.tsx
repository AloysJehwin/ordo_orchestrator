import { useEffect, useState } from "react";
import { api } from "../api";
import { useDecide } from "../lib/actions";
import { canAct, useApp } from "../lib/app";
import { actorLabel, dateTime, time } from "../lib/format";
import { go, href, useRoute } from "../lib/router";
import type { InboxItemView } from "../types";
import { Action, Empty, Field, Loading, Segmented } from "../ui/kit";
import { SpecBand } from "../ui/SpecBand";

type Filter = "pending" | "approved" | "rejected" | "all";

export function Approvals() {
  const { path, live, names, roles } = useApp();
  const route = useRoute();
  const [filter, setFilter] = useState<Filter>("pending");
  const [items, setItems] = useState<InboxItemView[] | null>(null);
  useEffect(() => {
    void api.get<InboxItemView[]>(path(`/inbox?status=${filter}`)).then(setItems);
  }, [path, filter, live?.headSeq]);
  if (!items) return <Loading />;
  const open = items.filter((i) => i.status === "pending").length;
  const current = items.find((i) => i.id === route.id) ?? items[0] ?? null;
  return (
    <div className="split">
      <div className="split-list">
        <div className="eyebrow">
          {live?.inbox.length ?? open} open · {live?.counts.approvals ?? 0} for you
        </div>
        <h1>Approvals & exceptions</h1>
        <Segmented<Filter>
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending", label: "Open" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="list">
          {items.length === 0 && <p className="muted pad">Nothing here. Agents raise items when a gate needs a person or an action is out of policy.</p>}
          {items.map((i) => (
            <a key={i.id} href={href(`approvals/${i.id}`)} className={`list-item${current?.id === i.id ? " on" : ""}`}>
              <div className="li-top">
                <span className={`tag ${i.kind}`}>{i.kind === "approval" ? "Approval" : "Exception"}</span>
                {canAct(roles, i.requiredRole) && i.status === "pending" && <span className="tag accent">For you</span>}
                <span className="faint small">{time(i.createdAt)}</span>
              </div>
              <b>{i.title}</b>
              <span className="faint small">
                {actorLabel(i.agent, names)} · {i.category}
                {i.severity ? ` · ${i.severity}` : ""}
                {i.status !== "pending" ? ` · ${i.status}` : ""}
              </span>
            </a>
          ))}
        </div>
      </div>
      <div className="split-detail">{current ? <Detail key={current.id} item={current} /> : <Empty title="Inbox is clear" />}</div>
    </div>
  );
}

function Detail({ item }: { item: InboxItemView }) {
  const { names, roles } = useApp();
  const decide = useDecide();
  const [choice, setChoice] = useState<number>(item.recommended ?? 0);
  const [comment, setComment] = useState("");
  const allowed = canAct(roles, item.requiredRole);
  const pending = item.status === "pending";
  return (
    <div className="detail">
      <div className="eyebrow">
        {item.kind === "approval" ? "Approval" : "Exception"} · {item.category} · raised by {actorLabel(item.agent, names)}
      </div>
      <h1>{item.title}</h1>
      <p className="lede">{item.body}</p>
      {item.metrics.length > 0 && (
        <div className="metric-row">
          {item.metrics.map((m) => (
            <div key={m.label}>
              <span className="label">{m.label}</span>
              <b>{m.value}</b>
              {m.band && <SpecBand compact lo={m.band.lo} hi={m.band.hi} value={m.band.value} valueMax={m.band.valueMax ?? null} ok={m.band.ok} unit={m.band.unit} label={m.label} />}
            </div>
          ))}
        </div>
      )}
      <div className="section-h spread">
        <h2>Options the agent considered</h2>
        {item.confidence !== null && <span className="muted small">confidence in recommendation {item.confidence.toFixed(2)}</span>}
      </div>
      <div className="options" role="radiogroup">
        {item.options.map((o, i) => (
          <label key={i} className={`option${choice === i ? " on" : ""}${!pending ? " readonly" : ""}`}>
            <input type="radio" name="opt" checked={choice === i} disabled={!pending} onChange={() => setChoice(i)} />
            <span>
              <b>{o.label}</b>
              <span className="muted small">{o.detail}</span>
            </span>
            {item.recommended === i && <span className="tag accent">Recommended</span>}
            {item.decidedOption === i && <span className="tag ok">Chosen</span>}
          </label>
        ))}
      </div>
      {pending ? (
        <>
          <Field label="Comment (signed with your decision)">
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} placeholder="Optional" />
          </Field>
          <div className="btns">
            <Action className="btn accent" disabled={!allowed} onClick={() => decide(item, choice, comment)}>
              Approve selected option
            </Action>
            <Action className="btn" disabled={!allowed} onClick={() => decide(item, -1, comment || "Rejected")}>
              Reject & hold
            </Action>
            {item.runId && (
              <button type="button" className="btn link" onClick={() => go(`pipelines/${item.runId}`)}>
                Open stage in pipeline
              </button>
            )}
          </div>
          {!allowed && <p className="field-e">Needs {item.requiredRole.replaceAll("_", " ")} or a higher role. Your roles: {roles.join(", ").replaceAll("_", " ")}.</p>}
        </>
      ) : (
        <div className="notice">
          <b>{item.status === "approved" ? "Approved" : item.status === "rejected" ? "Rejected" : "Expired"}</b> by {item.decidedBy ? names.get(item.decidedBy) ?? item.decidedBy : "—"} · {dateTime(item.decidedAt)}
          {item.reason && <p className="muted">“{item.reason}”</p>}
          {item.signatureId && <p className="faint small mono">EIP-712 signature {item.signatureId}</p>}
        </div>
      )}
    </div>
  );
}
