import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { canAct, useApp } from "../lib/app";
import { dateTime, shortAddr, time } from "../lib/format";
import { go, href, useRoute } from "../lib/router";
import { useSign } from "../lib/sign";
import type { CriterionResult, PackageDetail, PackageSummary, RunView, TypedSignature } from "../types";
import { DateTimePicker } from "../ui/Calendar";
import { Action, Empty, Field, Loading, Modal, Segmented, useToast } from "../ui/kit";
import { Select } from "../ui/Select";
import { SpecBand } from "../ui/SpecBand";
import { Actor, Ref, Who } from "../ui/Name";

type Filter = "all" | "mine" | "review" | "closed";
const STEPS = ["Draft", "Agent pre-check", "Submitted", "Review", "Approval", "Released"];
const STATUS_TAG: Record<PackageSummary["status"], [string, string]> = {
  draft: ["Draft", ""],
  in_review: ["In review", "accent"],
  changes_requested: ["Changes requested", "bad"],
  rejected: ["Rejected", "bad"],
  released: ["Released", "ok"],
};
const TYPE_LABEL: Record<string, string> = {
  stage_validation: "Stage validation",
  process_change: "Process change",
  pilot_validation: "Pilot validation",
  proof_of_concept: "Proof of concept",
  operational_qualification: "Operational qualification",
};

export function Validation() {
  const { path, live, can, sees } = useApp();
  const route = useRoute();
  const [list, setList] = useState<PackageSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void api.get<PackageSummary[]>(path("/validation")).then(setList);
  }, [path, live?.headSeq, route.id]);
  if (!list) return <Loading />;
  const shown = list.filter((p) => (filter === "mine" ? p.needsMe : filter === "review" ? p.status === "in_review" : filter === "closed" ? p.status === "released" || p.status === "rejected" : true));
  const id = route.id ?? shown[0]?.id ?? null;
  return (
    <div className="split">
      <div className="split-list">
        <div className="eyebrow">
          {list.filter((p) => p.needsMe).length} need you · {list.length} total
        </div>
        <h1>Validation</h1>
        <p className="muted small">
          {sees(3)
            ? "Prove a stage or process works before it runs on its own: agent pre-check, your evidence, then a signed review chain."
            : "The packages a manager assigned you to perform, and those on stages you contributed to."}
        </p>
        {can("manager") && (
          <button type="button" className="btn accent block-btn" onClick={() => setCreating(true)}>
            New validation package
          </button>
        )}
        <Segmented<Filter>
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "mine", label: "Needs me", count: list.filter((p) => p.needsMe).length },
            { value: "review", label: "In review" },
            { value: "closed", label: "Closed" },
          ]}
        />
        <div className="list">
          {shown.length === 0 && <p className="muted pad">No packages here.</p>}
          {shown.map((p) => (
            <a key={p.id} href={href(`validation/${p.id}`)} className={`list-item${id === p.id ? " on" : ""}`}>
              <div className="li-top">
                <span className={`tag ${STATUS_TAG[p.status][1]}`}>{STATUS_TAG[p.status][0]}</span>
                <span className="faint small mono">{p.code}</span>
              </div>
              <span className="eyebrow muted-eyebrow">
                {p.typeLabel}
                {p.mine && p.status !== "released" && p.status !== "rejected" ? " · yours to perform" : p.view === "summary" ? " · you contributed" : ""}
              </span>
              <b>{p.title}</b>
              <span className="faint small">
                {p.waitingOn ? `Waiting on ${p.waitingOn.toLowerCase()}` : p.status === "released" ? "Released" : "Closed"} · {time(p.updatedAt)}
              </span>
              <div className="mini-progress">
                <span style={{ width: `${(p.stepIndex / 5) * 100}%` }} />
              </div>
            </a>
          ))}
        </div>
      </div>
      <div className="split-detail">
        {id ? (
          <PackageView key={id} id={id} />
        ) : sees(3) ? (
          <Empty title="No validation packages yet">Create one from a stage gate in a pipeline, or start a new package for a process change, pilot or machine qualification.</Empty>
        ) : (
          <Empty title="Nothing assigned to you yet">
            When a manager assigns you a validation package, it appears here: you run the agent pre-check, record each check, attach the evidence and sign Performed by. A validator then reviews it and a manager approves it. Packages on stages you contributed to appear here too, as a summary.
          </Empty>
        )}
      </div>
      <NewPackage open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function PackageView({ id }: { id: string }) {
  const { path, live, me, roles, names, book, can } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [p, setP] = useState<PackageDetail | null>(null);
  const [edit, setEdit] = useState<Partial<PackageDetail>>({});
  const [comment, setComment] = useState("");
  const [addCheck, setAddCheck] = useState(false);
  const [attach, setAttach] = useState<{ slotId: string | null; name: string } | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const load = async () => setP(await api.get<PackageDetail>(path(`/validation/${id}`)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, live?.headSeq]);
  if (!p) return <Loading />;
  const owner = p.owner.id === me.user!.id;
  const open = p.status === "draft" || p.status === "changes_requested";
  const editable = owner && open;
  const summary = p.view === "summary";
  // a manager hands the package to whoever performs it, until Performed by is signed
  const mayAssign = can("manager") && open;
  // a check's value can be changed by the owner before they sign Performed by, and by a validator until release
  const closed = p.status === "released" || p.status === "rejected";
  const canChange = !closed && (editable || canAct(roles, "validator"));
  const recordCheck = async (checkId: string, result: string, status: "pass" | "fail") => {
    const next = await api.patch<PackageDetail>(path(`/validation/${id}/checks/${checkId}`), { status, result });
    setP(next);
    setChanging(null);
    toast(p.status === "in_review" ? "Changed: the package is back with its owner to sign again over the corrected value" : "Check recorded", "ok");
  };
  const link = p.chain.find((c) => c.state === "awaiting");
  const alreadySigned = p.chain.some((c) => c.state === "signed" && c.signer?.address === me.user!.address);
  const mayAct = Boolean(link) && p.status === "in_review" && canAct(roles, link!.role) && !alreadySigned;
  const save = async (patch: Partial<PackageDetail>) => setP(await api.patch<PackageDetail>(path(`/validation/${id}`), patch));
  const act = async (action: "sign" | "return" | "reject") => {
    const label = action === "sign" ? (link ? link.label : "Sign") : action === "return" ? "Request changes" : "Reject";
    const r = await sign<PackageDetail>({
      title: `${label} · ${p.code} ${p.title}`,
      request: (chainId) => api.post<TypedSignature>(path(`/validation/${id}/sign-request`), { action, comment, chainId }),
      submit: (proof) => api.post<PackageDetail>(path(`/validation/${id}/act`), { action, comment, ...proof }),
    });
    if (r) {
      setP(r);
      setComment("");
    }
  };
  const stepWho = (i: number) => {
    if (i === 0) return names.get(p.owner.address.toLowerCase()) ?? p.owner.name ?? shortAddr(p.owner.address);
    if (i === 1) return p.assessment ? `Run ${time(p.assessment.ranAt)}` : "Not run";
    if (i === 2) return p.chain[0]?.signedAt ? time(p.chain[0].signedAt) : "—";
    const c = p.chain[i - 2];
    if (i === 5) return p.status === "released" ? "Released" : "—";
    return c?.signer ? (names.get(c.signer.address.toLowerCase()) ?? shortAddr(c.signer.address)) : (c?.roleLabel ?? "—");
  };
  return (
    <div className="detail">
      <div className="page-head">
        <div className="ph-text">
          <div className="eyebrow">
            {p.typeLabel} · {p.code}
          </div>
          <h1>{p.title}</h1>
          <div className="muted small">
            {p.runId ? (
              <>
                <Ref
                  kind="stage"
                  id={`${p.runId}:${p.stageCode}`}
                  fallback={
                    <>
                      <a href={href(`pipelines/${p.runId}`)}>{p.runId}</a> · stage {p.stageCode}
                    </>
                  }
                />{" "}
                ·{" "}
              </>
            ) : null}
            performed by <Who address={p.owner.address} fallback={p.owner.name ?? undefined} />
            {mayAssign && (
              <>
                {" "}
                <button type="button" className="link small" onClick={() => setAssigning(true)}>
                  Assign
                </button>
              </>
            )}
          </div>
        </div>
        {p.runId && (
          <button type="button" className="btn link" onClick={() => go(`pipelines/${p.runId}`)}>
            Open in pipeline
          </button>
        )}
      </div>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i < p.stepIndex || p.status === "released" ? "done" : i === p.stepIndex ? "now" : ""}>
            <span className="step-n">{i + 1}</span>
            <b>{s}</b>
            <span className="faint small">{stepWho(i)}</span>
          </li>
        ))}
      </ol>
      {summary && (
        <div className="notice small">
          You contributed to this stage, so you see where its validation stands and whether each check passed. Its measured values, files and audit details need access level 3.
        </div>
      )}
      {editable && !can("manager") && (
        <div className="notice small">
          <b>Assigned to you to perform.</b> Run the agent pre-check, record each check, attach the required evidence, then sign Performed by. A validator reviews it and a manager approves it.
        </div>
      )}
      {p.returnedComment && (
        <div className={`notice ${p.status === "rejected" ? "bad" : "warn"}`}>
          <b>{p.status === "rejected" ? "Rejected" : "Returned with changes requested"}:</b> {p.returnedComment}
        </div>
      )}
      {p.status === "released" && (
        <div className="notice ok">
          <b>Released.</b> {p.outcome}
          {p.onchain && (
            <span className="small">
              {" "}
              · On-chain record: {p.onchain.status.replace("_", " ")}
              {p.onchain.txUrl && (
                <>
                  {" "}
                  <a href={p.onchain.txUrl} target="_blank" rel="noreferrer">
                    transaction
                  </a>
                </>
              )}
              {p.onchain.error && <span className="bad-text"> · {p.onchain.error}</span>}
            </span>
          )}
        </div>
      )}
      {editable && (
        <div className="ready-bar">
          <div>
            <b>Complete these before submitting</b>
            <div className="ready-items">
              {p.readiness.items.map((r) => (
                <span key={r.label} className={r.ok ? "ok-text" : "faint"}>
                  {r.ok ? "✓" : "○"} {r.label}
                </span>
              ))}
            </div>
          </div>
          <Action className="btn accent" disabled={!p.readiness.ready} onClick={() => act("sign")}>
            Sign & submit
          </Action>
        </div>
      )}

      <section className="psec">
        <h2>
          <span className="num">01</span> Scope & acceptance
        </h2>
        <div className="form-grid two">
          <Field label="Objective">
            <textarea value={edit.objective ?? p.objective} disabled={!editable} onChange={(e) => setEdit({ ...edit, objective: e.target.value })} onBlur={() => edit.objective !== undefined && save({ objective: edit.objective })} />
          </Field>
          <Field label="Acceptance criteria">
            <textarea value={edit.acceptance ?? p.acceptance} disabled={!editable} onChange={(e) => setEdit({ ...edit, acceptance: e.target.value })} onBlur={() => edit.acceptance !== undefined && save({ acceptance: edit.acceptance })} />
          </Field>
        </div>
        <div className="form-grid four">
          <Field label="Sample plan">
            <input className="input" value={edit.samplePlan ?? p.samplePlan} disabled={!editable} onChange={(e) => setEdit({ ...edit, samplePlan: e.target.value })} onBlur={() => edit.samplePlan !== undefined && save({ samplePlan: edit.samplePlan })} />
          </Field>
          <Field label="Trial window start">
            {editable ? <DateTimePicker value={p.windowStart} onChange={(v) => save({ windowStart: v })} clearable /> : <span>{dateTime(p.windowStart)}</span>}
          </Field>
          <Field label="Trial window end">
            {editable ? <DateTimePicker value={p.windowEnd} onChange={(v) => save({ windowEnd: v })} clearable /> : <span>{dateTime(p.windowEnd)}</span>}
          </Field>
          <Field label="On approval">
            <span className="small">{p.type === "stage_validation" ? (p.runId ? `Gate ${book.name("stage", `${p.runId}:${p.stageCode}`) ?? `${p.runId} · ${p.stageCode}`} released` : "Stage validated") : "Recorded as released in the ledger"}</span>
          </Field>
        </div>
      </section>

      <section className="psec">
        <div className="section-h spread">
          <h2>
            <span className="num">02</span> Validation checks{" "}
            <span className="muted small">
              {p.checks.filter((c) => c.status !== "pending").length} of {p.checks.length} recorded
            </span>
          </h2>
          {editable && (
            <div className="btns">
              <button type="button" className="btn sm" onClick={() => setAddCheck(true)}>
                Add check
              </button>
              <Action className="btn" onClick={async () => setP(await api.post<PackageDetail>(path(`/validation/${id}/precheck`)))}>
                {p.assessment ? "Re-run agent pre-check" : "Run agent pre-check"}
              </Action>
            </div>
          )}
        </div>
        {p.assessment && (
          <div className="assessment">
            <span className="label">Agent assessment</span>
            <div className="small">
              <Actor actor={p.assessment.agent} />
            </div>
            <p>{p.assessment.summary}</p>
            <div className="metric-row">
              {p.assessment.figures.map((f) => (
                <div key={f.label}>
                  <span className="label">{f.label}</span>
                  <b>{f.value}</b>
                </div>
              ))}
              <div>
                <span className="label">Confidence</span>
                <b>{p.assessment.confidence === null ? "—" : p.assessment.confidence.toFixed(2)}</b>
              </div>
            </div>
          </div>
        )}
        {p.checks.length === 0 ? (
          <p className="faint">No checks yet. {editable ? "Add the criteria this package must prove." : ""}</p>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Method</th>
                <th>Target</th>
                <th>Band</th>
                <th>Result</th>
                <th>Source</th>
                <th className="r">Status</th>
              </tr>
            </thead>
            <tbody>
              {p.checks.map((c) => {
                const param = p.parameters?.find((x) => x.label === c.criterion) ?? null;
                // an agent's measurement a person has since changed: the agent's value stays beside theirs
                const changedByPerson = Boolean(c.auto && c.recordedBy?.startsWith("0x") && c.actual && c.result !== c.actual);
                return (
                  <Fragment key={c.id}>
                    <tr className={changing === c.id ? "on" : ""}>
                      <td>{c.criterion}</td>
                      <td className="muted">{c.method}</td>
                      <td>{c.target}</td>
                      <td className="band-cell">
                        {param ? <SpecBand compact lo={param.band?.lo ?? null} hi={param.band?.hi ?? null} value={param.measured?.value ?? null} valueMax={param.measuredMax?.value ?? null} ok={param.ok} unit={param.unit} label={c.criterion} /> : <span className="faint">—</span>}
                      </td>
                      <td>
                        {c.result ?? "—"}
                        {changedByPerson && <div className="faint small">agent measured {c.actual}</div>}
                      </td>
                      <td>
                        <span className={`tag ${changedByPerson ? "warn" : c.auto ? "accent" : ""}`}>{changedByPerson ? "Agent · changed" : c.auto ? "Agent" : "Manual"}</span>
                        {c.recordedBy?.startsWith("0x") && (
                          <div className="faint small">
                            by <Who address={c.recordedBy} />
                          </div>
                        )}
                      </td>
                      <td className="r">
                        <span className="chk-status">
                          <span className={c.status === "pass" ? "ok-text" : c.status === "fail" ? "bad-text" : "faint"}>{c.status === "pass" ? "Pass" : c.status === "fail" ? "Fail ▲" : "Pending"}</span>
                          {canChange && changing !== c.id && (
                            <button type="button" className="link small" onClick={() => setChanging(c.id)}>
                              {c.status === "pending" ? "Record" : "Change"}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {changing === c.id && (
                      <tr className="chk-edit-row">
                        <td colSpan={7}>
                          <CheckEditor check={c} param={param} reviewing={p.status === "in_review"} onCancel={() => setChanging(null)} onSave={(result, status) => recordCheck(c.id, result, status)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="psec">
        <h2>
          <span className="num">03</span> Proof & evidence{" "}
          <span className="muted small">
            {p.evidence.filter((e) => e.sha256 && !e.removedAt).length} attached · {p.evidence.filter((e) => e.required && e.sha256 && !e.removedAt).length} of {p.evidence.filter((e) => e.required && !e.removedAt).length} required
          </span>
        </h2>
        {p.evidence
          .filter((e) => !e.removedAt)
          .map((e) => (
            <div key={e.id} className="evidence">
              <span className={`file-ico${e.sha256 ? "" : " empty"}`}>{e.filename?.split(".").pop()?.slice(0, 4) ?? ""}</span>
              <div className="grow">
                <b>{e.name}</b> <span className={`small ${e.required ? "bad-text" : e.origin === "agent" ? "accent-text" : "faint"}`}>{e.required ? "Required" : e.origin === "agent" ? "Agent-generated" : "Optional"}</span>
                <div className="faint small">
                  {e.sha256 && summary ? (
                    <>
                      Attached · v{e.version} · {time(e.uploadedAt)}
                    </>
                  ) : e.sha256 ? (
                    <>
                      <a href={api.url(path(`/validation/${id}/evidence/${e.id}/file`))}>{e.filename}</a> · {((e.size ?? 0) / 1024).toFixed(1)} KB · v{e.version} · <Actor actor={e.origin === "agent" ? (e.uploadedBy ?? "") : `user:${e.uploadedBy}`} /> · {time(e.uploadedAt)} · <span className="mono">{e.sha256.slice(0, 19)}…</span>
                      {e.zeroG && (
                        <div>
                          {e.zeroG.status === "done" && e.zeroG.root ? (
                            <>
                              On 0G Storage (encrypted), root{" "}
                              <a href={e.zeroG.url ?? undefined} target="_blank" rel="noreferrer" className="mono">
                                {e.zeroG.root.slice(0, 14)}…
                              </a>{" "}
                              ·{" "}
                              <Action
                                className="link"
                                onClick={async () => {
                                  const r = await api.get<{ ok: boolean; size: number }>(path(`/validation/${id}/evidence/${e.id}/0g`));
                                  toast(r.ok ? `The copy on 0G matches, byte for byte (${r.size} bytes)` : "The copy on 0G does not match this file", r.ok ? "ok" : "bad");
                                }}
                              >
                                verify
                              </Action>
                            </>
                          ) : e.zeroG.status === "pending" ? (
                            <>Copying to 0G Storage…{e.zeroG.error ? ` (retrying: ${e.zeroG.error})` : ""}</>
                          ) : (
                            <span className="field-e">Copy to 0G failed: {e.zeroG.error}</span>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    "Not attached"
                  )}
                </div>
              </div>
              {editable && (
                <div className="btns">
                  <button type="button" className="btn sm" onClick={() => setAttach({ slotId: e.id, name: e.name })}>
                    {e.sha256 ? "Replace" : "Attach"}
                  </button>
                  {e.sha256 && e.origin !== "agent" && (
                    <Action className="btn sm" onClick={async () => setP(await api.del<PackageDetail>(path(`/validation/${id}/evidence/${e.id}`)))}>
                      Remove
                    </Action>
                  )}
                </div>
              )}
            </div>
          ))}
        {editable && (
          <button type="button" className="link" onClick={() => setAttach({ slotId: null, name: "" })}>
            + Add other evidence
          </button>
        )}
      </section>

      <section className="psec">
        <h2>
          <span className="num">04</span> Sign-off
        </h2>
        <ol className="chain">
          {p.chain.map((c, i) => (
            <li key={c.meaning} className={c.state}>
              <span className="step-n">{i + 1}</span>
              <div className="grow">
                <b>
                  {c.label} · {c.roleLabel}
                </b>
                <div className="faint small">
                  {c.signer ? (
                    <>
                      <Who address={c.signer.address} /> · {dateTime(c.signedAt)} · <span className="mono">{c.signature?.slice(0, 18)}…</span>
                    </>
                  ) : c.state === "returned" ? (
                    "Returned"
                  ) : c.state === "awaiting" ? (
                    "Awaiting signature"
                  ) : (
                    "Not yet"
                  )}
                </div>
                {c.comment && <div className="muted small">“{c.comment}”</div>}
              </div>
              <span className="small faint">{c.state === "signed" ? "Signed ✓" : i === 0 ? "Signs on submit" : ""}</span>
            </li>
          ))}
        </ol>
        {mayAct && (
          <div className="sign-form">
            <Field label="Comment (required to return or reject)">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
            </Field>
            <label className="check-row small muted">I reviewed the checks and evidence in this package.</label>
            <div className="btns">
              <Action className="btn accent" onClick={() => act("sign")}>
                Sign as {link!.label.toLowerCase()}
              </Action>
              <Action className="btn" disabled={comment.trim().length < 5} onClick={() => act("return")}>
                Request changes
              </Action>
              <Action className="btn danger" disabled={comment.trim().length < 5} onClick={() => act("reject")}>
                Reject
              </Action>
            </div>
          </div>
        )}
        {p.status === "in_review" && !mayAct && link && <p className="muted small">{alreadySigned ? "You already signed this package; another person signs the next step." : `Waiting on a ${link.roleLabel.toLowerCase()}.`}</p>}
      </section>

      <section className="psec">
        <h2>
          <span className="num">05</span> Audit trail
        </h2>
        <div className="stream">
          {p.audit.map((a) => (
            <div key={a.seq} className="row">
              <span className="faint">{time(a.ts)}</span>
              <span className="agent">
                <Actor actor={a.actor} />
              </span>
              <span>{a.type.replaceAll("_", " ").replaceAll(".", " · ")}</span>
              <span className="faint mono small r">#{a.seq}</span>
            </div>
          ))}
        </div>
      </section>

      {assigning && (
        <AssignModal
          current={p.owner.id}
          onClose={() => setAssigning(false)}
          onAssign={async (userId) => {
            setP(await api.post<PackageDetail>(path(`/validation/${id}/owner`), { userId }));
            setAssigning(false);
            toast("Assigned. They see it under Validation, and it counts as needing them.", "ok");
          }}
        />
      )}
      {addCheck && (
        <AddCheck
          onClose={() => setAddCheck(false)}
          onAdd={async (c) => {
            setP(await api.post<PackageDetail>(path(`/validation/${id}/checks`), c));
            setAddCheck(false);
          }}
        />
      )}
      {attach && (
        <AttachModal
          initialName={attach.name}
          fixedName={Boolean(attach.slotId)}
          onClose={() => setAttach(null)}
          onUpload={async (file, name) => {
            const f = new FormData();
            f.set("file", file);
            f.set("name", name);
            if (attach.slotId) f.set("slotId", attach.slotId);
            setP(await api.upload<PackageDetail>(path(`/validation/${id}/evidence`), f));
            toast("Attached and hashed", "ok");
            setAttach(null);
          }}
        />
      )}
    </div>
  );
}

/** Who may perform a package: members holding contributor (or manager). */
function usePerformers() {
  const { team, names, me } = useApp();
  return (team?.members ?? [])
    .filter((m) => m.roles.includes("contributor") || m.roles.includes("manager"))
    .map((m) => ({
      value: m.userId,
      label: `${names.get(m.address.toLowerCase()) ?? m.name ?? shortAddr(m.address)}${m.userId === me.user!.id ? " (you)" : ""}`,
      hint: m.roles.filter((r) => r !== "contributor").join(", ") || "contributor",
    }));
}

function AssignModal({ current, onClose, onAssign }: { current: string; onClose: () => void; onAssign: (userId: string) => Promise<void> }) {
  const options = usePerformers();
  const [who, setWho] = useState<string | null>(current);
  return (
    <Modal
      open
      onClose={onClose}
      title="Assign the package"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action className="btn accent" disabled={!who || who === current} onClick={() => onAssign(who!)}>
            Assign
          </Action>
        </div>
      }
    >
      <Field label="Performed by" hint="They run the pre-check, record the checks, attach evidence and sign Performed by. A validator reviews and a manager approves, each a different person.">
        <Select value={who} onChange={setWho} options={options} placeholder="Choose a member" />
      </Field>
    </Modal>
  );
}

function AddCheck({ onClose, onAdd }: { onClose: () => void; onAdd: (c: { criterion: string; method: string; target: string }) => Promise<void> }) {
  const [c, setC] = useState({ criterion: "", method: "", target: "" });
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a check"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action className="btn accent" disabled={c.criterion.trim().length < 2} onClick={() => onAdd(c)}>
            Add
          </Action>
        </div>
      }
    >
      <Field label="Criterion">
        <input className="input" value={c.criterion} onChange={(e) => setC({ ...c, criterion: e.target.value })} placeholder="e.g. Joint visual" autoFocus />
      </Field>
      <div className="form-grid two">
        <Field label="Method">
          <input className="input" value={c.method} onChange={(e) => setC({ ...c, method: e.target.value })} placeholder="e.g. Visual, 30 units" />
        </Field>
        <Field label="Target">
          <input className="input" value={c.target} onChange={(e) => setC({ ...c, target: e.target.value })} placeholder="e.g. No defects" />
        </Field>
      </div>
    </Modal>
  );
}

function AttachModal({ initialName, fixedName, onClose, onUpload }: { initialName: string; fixedName: boolean; onClose: () => void; onUpload: (f: File, name: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(initialName);
  return (
    <Modal
      open
      onClose={onClose}
      title={fixedName ? `Attach: ${initialName}` : "Attach evidence"}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action className="btn accent" disabled={!file || !name.trim()} onClick={() => onUpload(file!, name.trim())}>
            Attach
          </Action>
        </div>
      }
    >
      {!fixedName && (
        <Field label="Evidence name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
      <label className="drop">
        <input
          type="file"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f && !name) setName(f.name);
          }}
        />
        {file ? (
          <>
            <b>{file.name}</b> · {(file.size / 1024).toFixed(1)} KB
          </>
        ) : (
          "Choose a file (max 4 MB). It is SHA-256 hashed on upload; a replaced file becomes a new version."
        )}
      </label>
    </Modal>
  );
}

function NewPackage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { path, live, book, me } = useApp();
  const performers = usePerformers();
  const [ownerId, setOwnerId] = useState<string | null>(me.user!.id);
  const [type, setType] = useState("stage_validation");
  const [title, setTitle] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const runs: RunView[] = live?.runs ?? [];
  const run = runs.find((r) => r.id === runId);
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      eyebrow="Validation"
      title="New validation package"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={title.trim().length < 3 || (type === "stage_validation" && (!runId || !stage))}
            onClick={async () => {
              const p = await api.post<{ id: string }>(path("/validation"), { type, title: title.trim(), objective, acceptance, runId, stageCode: stage, ownerId });
              onClose();
              go(`validation/${p.id}`);
            }}
          >
            Create draft
          </Action>
        </div>
      }
    >
      <div className="form-grid two">
        <Field label="Type">
          <Select value={type} onChange={setType} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={type === "stage_validation" ? "Run" : "Linked run (optional)"}>
          <Select value={runId} onChange={(v) => (setRunId(v), setStage(null))} options={runs.map((r) => ({ value: r.id, label: `${book.name("run", r.id) ?? r.id} · ${r.templateName}`, hint: r.orderRef }))} placeholder="Choose run" />
        </Field>
        <Field label="Stage" hint="Checks are seeded from the stage's success criteria.">
          <Select
            value={stage}
            onChange={(v) => {
              setStage(v);
              const s = run?.stages.find((x) => x.code === v);
              if (s && !title) setTitle(`${s.name} · ${run!.id}`);
            }}
            options={(run?.stages ?? []).map((s) => ({ value: s.code, label: `${s.code} · ${s.name}`, hint: s.state.replaceAll("_", " ") }))}
            placeholder={run ? "Choose stage" : "Choose a run first"}
            disabled={!run}
          />
        </Field>
      </div>
      <Field label="Objective">
        <textarea value={objective} onChange={(e) => setObjective(e.target.value)} />
      </Field>
      <Field label="Acceptance criteria">
        <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
      </Field>
      <Field label="Performed by" hint="Who runs the pre-check, records the checks, attaches evidence and signs Performed by. A contributor works on it from Validation.">
        <Select value={ownerId} onChange={setOwnerId} options={performers} placeholder="Choose a member" />
      </Field>
    </Modal>
  );
}

/** Change a check's value (an agent's measurement too): what was measured, whether it passes, judged against the band when there is one. */
function CheckEditor({
  check,
  param,
  reviewing,
  onCancel,
  onSave,
}: {
  check: PackageDetail["checks"][number];
  param: CriterionResult | null;
  reviewing: boolean;
  onCancel: () => void;
  onSave: (result: string, status: "pass" | "fail") => Promise<void>;
}) {
  const start = check.result && !/^Not measured/.test(check.result) && !/^(Pass|Fail)$/.test(check.result) ? check.result : (check.actual ?? "");
  const [value, setValue] = useState(start);
  const [status, setStatus] = useState<"pass" | "fail">(check.status === "fail" ? "fail" : "pass");
  const [picked, setPicked] = useState(check.status !== "pending");
  const n = Number(value.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
  const lo = param?.band?.lo ?? null;
  const hi = param?.band?.hi ?? null;
  const judged = Number.isFinite(n) && (lo !== null || hi !== null) ? (lo === null || n >= lo) && (hi === null || n <= hi) : null;
  // until the person picks Pass or Fail themselves, the band decides
  useEffect(() => {
    if (!picked && judged !== null) setStatus(judged ? "pass" : "fail");
  }, [judged, picked]);
  // a bare number gets the parameter's unit, as the agent writes it
  const result = /^-?\d+(\.\d+)?$/.test(value.trim()) && param?.unit ? `${value.trim()} ${param.unit}` : value.trim();
  return (
    <div className="chk-edit">
      <div className="chk-edit-fields">
        <label className="field">
          <span className="field-l">
            {check.criterion} <span className="muted">· target {check.target}</span>
          </span>
          <input className="input sm" value={value} onChange={(e) => setValue(e.target.value)} placeholder={param?.unit ? `e.g. 31.5 ${param.unit}` : "the measured value or finding"} autoFocus />
          {check.actual && <span className="field-h">The agent measured {check.actual}. It stays on record beside your value.</span>}
        </label>
        <div className="field">
          <span className="field-l">Result</span>
          <Segmented<"pass" | "fail">
            size="sm"
            label="Result"
            value={status}
            onChange={(v) => (setStatus(v), setPicked(true))}
            options={[
              { value: "pass", label: "Pass" },
              { value: "fail", label: "Fail" },
            ]}
          />
          {judged !== null && <span className="field-h">{judged ? "Inside" : "Outside"} the band</span>}
        </div>
      </div>
      {reviewing && <p className="notice warn small">The package is in review. Saving changes what its owner signed, so it goes back to them to sign Performed by again over the corrected value; then you sign it on.</p>}
      <div className="btns">
        <Action className="btn sm accent" disabled={!result} onClick={() => onSave(result, status)}>
          Save
        </Action>
        <button type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
