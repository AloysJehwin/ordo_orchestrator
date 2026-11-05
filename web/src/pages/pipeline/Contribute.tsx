import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ShieldCheck, ShieldQuestion } from "lucide-react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { ago, shortAddr } from "../../lib/format";
import { useSign } from "../../lib/sign";
import { TRUST_TEXT, type ContributionView, type PowStart, type RunView, type StageRunView, type TeeSummary, type TypedSignature } from "../../types";
import { Action, Field, Modal, useToast } from "../../ui/kit";
import { ContributionOutcomes, DisputeList } from "./PowOutcomes";

/** Stages that take no more proof of work */
const CLOSED = new Set(["queued", "skipped"]);

export const teeLabel = (t: TeeSummary) =>
  t.turns === 0 ? "No 0G turns recorded" : t.allVerified ? `All ${t.turns} turns TEE-verified` : t.verified > 0 ? `${t.verified} of ${t.turns} turns TEE-verified` : t.network === "mock" ? "Scripted interviewer (no TEE)" : (t.trustMode ?? "private") !== "private" ? `${t.turns} turns on standard routing (no TEE)` : `${t.turns} turns, not TEE-verified`;

export function TeeBadge({ t }: { t: TeeSummary }) {
  const ok = t.allVerified;
  return (
    <span className={`tag ${ok ? "ok" : t.failed ? "bad" : "warn"}`} title={`${t.model} on the ${t.network} Router${t.providers.length ? ` · providers ${t.providers.map(shortAddr).join(", ")}` : ""}`}>
      {ok ? <ShieldCheck size={12} aria-hidden /> : <ShieldQuestion size={12} aria-hidden />} {teeLabel(t)}
    </span>
  );
}

const STATUS: Record<ContributionView["status"], [string, string]> = {
  unsigned: ["Waiting for your signature", "warn"],
  signed: ["Signed", ""],
  selected: ["Selected as valid", "ok"],
  not_selected: ["Not selected", ""],
  withdrawn: ["Withdrawn", ""],
};
export const StatusTag = ({ c }: { c: ContributionView }) => <span className={`tag ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span>;

/** The command a contributor pastes into a terminal, and the session's live state until they have signed. */
export function ContributeModal({ run, stage, onClose, onDone }: { run: RunView; stage: StageRunView; onClose: () => void; onDone: () => void }) {
  const { path, siteId } = useApp();
  const toast = useToast();
  const [s, setS] = useState<PowStart | null>(null);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<{ status: string; contributionId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .post<PowStart>(path("/pow/sessions"), { runId: run.id, stage: stage.code })
      .then(setS)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [path, run.id, stage.code]);
  // follow the session: the terminal agent submits, then the contributor signs
  useEffect(() => {
    if (!s) return;
    const t = setInterval(async () => {
      const list = await api.get<{ id: string; status: string; contributionId: string | null }[]>(path("/pow/sessions")).catch(() => []);
      const mine = list.find((x) => x.id === s.sessionId);
      if (mine) setState({ status: mine.status, contributionId: mine.contributionId });
      if (mine?.status === "signed") {
        clearInterval(t);
        onDone();
      }
    }, 4000);
    return () => clearInterval(t);
  }, [s, path, onDone]);
  const copy = async () => {
    if (!s) return;
    await navigator.clipboard?.writeText(s.command);
    setCopied(true);
    toast("Command copied. Paste it into a terminal.", "ok");
    setTimeout(() => setCopied(false), 2500);
  };
  const submitted = state?.status === "submitted" && state.contributionId;
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${run.orderRef} · stage ${stage.code}`}
      title="Contribute proof of work"
      width={640}
      footer={
        <div className="btns end">
          {submitted && (
            <a className="btn primary" href={`#/pow/${state.contributionId}/sign?site=${encodeURIComponent(siteId)}`}>
              Review and sign
            </a>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {state?.status === "signed" ? "Done" : "Close"}
          </button>
        </div>
      }
    >
      {error && <p className="field-e">{error}</p>}
      {!s && !error && <p className="muted">Starting a session…</p>}
      {s && (
        <div className="stack">
          <ol className="steps small">
            <li>Copy the command and run it in a terminal on the machine where your files are (Node 22 or later).</li>
            <li>
              An agent on <b>{(s.router.trustMode ?? "private") === "private" ? "0G Private Computer" : "the 0G Router"}</b> interviews you about this stage: what you did, each measured value, your evidence files and anything unusual.{" "}
              {(s.router.trustMode ?? "private") === "private"
                ? "It runs in a TEE: neither the provider nor Ordo's staff read the conversation in transit."
                : `It runs on ${TRUST_TEXT[s.router.trustMode ?? "standard"]}: the provider serving the model can read the conversation.`}{" "}
              Files stay on your machine and only their SHA-256 is recorded, unless you agree, file by file, to show a photo to the model or have a voice note transcribed on 0G.
            </li>
            {stage.outcomes.length > 0 && <li>It shows you what the stage's machine captured for each of its {stage.outcomes.length} outcomes, and you confirm or dispute each one; your record binds the hashes of the files you reviewed.</li>}
            <li>When you confirm, it opens a link here for you to sign the record with your wallet.</li>
          </ol>
          <div className="cmd">
            <code className="mono">{s.command}</code>
            <button type="button" className="btn sm" onClick={copy} aria-label="Copy command">
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="faint small">
            The token in the command is yours alone and works until {new Date(s.expiresAt).toLocaleTimeString()} ({s.router.model} on the {s.router.network === "mock" ? "scripted interviewer: no Router is configured" : `${s.router.network} Router`}). Don't share it. Starting again replaces it.
          </p>
          <div className="notice">
            <b>{state?.status === "signed" ? "Signed. Your proof of work is recorded." : submitted ? "The agent submitted your record. Sign it to finish." : state?.status === "expired" ? "This session expired. Start again." : "Waiting for the terminal agent…"}</b>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** A stage's proofs of work: everyone's at level 3 and up, otherwise your own. */
export function StageContributions({ run, stage }: { run: RunView; stage: StageRunView }) {
  const { path, sees, can, me, siteId } = useApp();
  const [data, setData] = useState<{ contributions: ContributionView[]; total: number } | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api.get<{ contributions: ContributionView[]; total: number }>(path(`/runs/${run.id}/stages/${stage.code}/contributions`)).then(setData).catch(() => setData(null)), [path, run.id, stage.code]);
  useEffect(() => {
    void load();
  }, [load]);
  const selected = data?.contributions.some((c) => c.status === "selected");
  const canContribute = sees(2) && !CLOSED.has(stage.state) && !selected;
  // a validator (or a manager) with level 3 picks the valid one; nobody selects their own
  const canSelect = sees(3) && can("validator") && !selected;
  const [selecting, setSelecting] = useState<ContributionView | null>(null);
  return (
    <section className="dsec">
      <div className="row-between">
        <h3>Proof of work</h3>
        {data && <span className="faint small">{data.total} signed</span>}
      </div>
      {canContribute && (
        <div className="btns">
          <button type="button" className="btn accent" onClick={() => setOpen(true)}>
            Contribute proof of work
          </button>
        </div>
      )}
      {data && data.contributions.length === 0 && <p className="faint small">{sees(3) ? "No proof of work on this stage yet." : "You have not contributed to this stage yet."}</p>}
      <ul className="pow-list">
        {data?.contributions.map((c) => (
          <li key={c.id}>
            <ContributionRow c={c} mine={c.contributor.userId === me.user!.id} siteId={siteId} onSelect={canSelect && c.status === "signed" && c.contributor.userId !== me.user!.id ? () => setSelecting(c) : undefined} />
          </li>
        ))}
      </ul>
      {open && <ContributeModal run={run} stage={stage} onClose={() => (setOpen(false), void load())} onDone={() => void load()} />}
      {selecting && <SelectModal c={selecting} stage={stage} onClose={() => setSelecting(null)} onDone={() => (setSelecting(null), void load())} />}
    </section>
  );
}

export function ContributionRow({ c, mine, siteId, onSelect }: { c: ContributionView; mine: boolean; siteId: string; onSelect?: () => void }) {
  const { names } = useApp();
  const who = c.contributor.name ?? names.get(c.contributor.address) ?? shortAddr(c.contributor.address);
  return (
    <div className="pow-row">
      <div className="row-between">
        <span>
          <b>{mine ? "You" : who}</b> <span className="faint small">· {ago(c.signedAt ?? c.createdAt)}</span>
        </span>
        <StatusTag c={c} />
      </div>
      <div className="chips">
        <TeeBadge t={c.tee} />
        <span className="tag">
          <span className="num">{c.measurements.length}</span> committed value{c.measurements.length === 1 ? "" : "s"}
        </span>
        {c.evidence.length > 0 && (
          <span className="tag">
            <span className="num">{c.evidence.length}</span> evidence hash{c.evidence.length === 1 ? "" : "es"}
          </span>
        )}
        {(c.outcomes?.length ?? 0) > 0 && (
          <span className="tag">
            <span className="num">{c.outcomes!.filter((o) => o.sha256).length}</span> machine output{c.outcomes!.filter((o) => o.sha256).length === 1 ? "" : "s"} bound
          </span>
        )}
        {(c.disputes ?? 0) > 0 && (
          <span className="tag bad">
            <span className="num">{c.disputes}</span> disputed
          </span>
        )}
        {c.ledgerSeq !== null && <span className="tag">ledger #{c.ledgerSeq}</span>}
      </div>
      {c.summary && <p className="small">{c.summary}</p>}
      <DisputeList c={c} />
      {c.measurements.some((m) => m.value !== undefined) && (
        <dl className="kv small">
          {c.measurements.map((m) => (
            <div key={m.criterion} className="kv-row">
              <dt>{m.criterion}</dt>
              <dd className="num">{m.value !== undefined ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : "committed"}</dd>
            </div>
          ))}
        </dl>
      )}
      {c.selection && (
        <p className="small">
          Selected by <b>{c.selection.byName ?? names.get(c.selection.by) ?? shortAddr(c.selection.by)}</b> {ago(c.selection.at)}
          {c.selection.comment ? `: “${c.selection.comment}”` : ""}
        </p>
      )}
      <div className="btns">
        {onSelect && (
          <button type="button" className="btn sm primary" onClick={onSelect}>
            Select as valid
          </button>
        )}
        {mine && c.status === "unsigned" ? (
          <a className="btn sm primary" href={`#/pow/${c.id}/sign?site=${encodeURIComponent(siteId)}`}>
            Review and sign
          </a>
        ) : (
          c.status !== "unsigned" && (
            <a className="btn sm" href={`#/pow/${c.id}`} target="_blank" rel="noreferrer">
              Public proof
            </a>
          )
        )}
      </div>
    </div>
  );
}

/**
 * A validator selects the valid proof of work for a stage and signs it. The stage closes from the selected record, the
 * others are marked not selected, and with OrdoTrust v3 the acceptance (the contributor's reward, the validator's fee) is
 * recorded on-chain, open to a tester's case until the challenge window ends.
 */
function SelectModal({ c, stage, onClose, onDone }: { c: ContributionView; stage: StageRunView; onClose: () => void; onDone: () => void }) {
  const { path, names } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [comment, setComment] = useState("");
  const who = c.contributor.name ?? names.get(c.contributor.address) ?? shortAddr(c.contributor.address);
  const go = async () => {
    const r = await sign<{ stageClosed: boolean; chain: { status: string; error: string | null } | null }>({
      title: `Select ${who}'s proof of work for stage ${stage.code}`,
      request: (chainId) => api.post<TypedSignature>(path(`/contributions/${c.id}/select/sign-request`), { comment, chainId }),
      submit: (proof) => api.post(path(`/contributions/${c.id}/select`), { comment, ...proof }),
      done: "Selected and recorded in the ledger",
    });
    if (!r) return;
    if (r.chain?.status === "failed") toast(`Selected in Ordo; OrdoTrust refused the acceptance: ${r.chain.error ?? "retry from Rewards"}`, "bad");
    else if (!r.stageClosed) toast("Selected. The stage was not running, so it was not closed from this record.", "ok");
    onDone();
  };
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`Stage ${stage.code} · ${stage.name}`}
      title="Select as the valid proof of work"
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void go()}>
            Sign selection
          </button>
        </div>
      }
    >
      <div className="stack">
        <p className="small">
          You select <b>{who}</b>'s record. The stage closes with its counts and measured values, the other proofs on this stage are marked not selected, and you answer for it: for{" "}
          the challenge window a tester can open a case against you, and the manager decides it.
        </p>
        {c.measurements.some((m) => m.value !== undefined) && (
          <dl className="kv small">
            {c.measurements.map((m) => (
              <div key={m.criterion} className="kv-row">
                <dt>{m.criterion}</dt>
                <dd className="num">{m.value !== undefined ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : "committed"}</dd>
              </div>
            ))}
          </dl>
        )}
        {(c.disputes ?? 0) > 0 && (
          <p className="small notice">
            The contributor disputed {c.disputes} of the machine's outcome{c.disputes === 1 ? "" : "s"}. Check them against the media before you select this record.
          </p>
        )}
        <ContributionOutcomes c={c} />
        <Field label="Why this one (optional)" hint="Kept in the ledger with your signature">
          <textarea className="input" rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Matches the photos and the gauge readings" />
        </Field>
      </div>
    </Modal>
  );
}

/** Cancels an open session from the list of my sessions. */
export function CancelSession({ id, onDone }: { id: string; onDone: () => void }) {
  const { path } = useApp();
  return (
    <Action className="btn sm" onClick={async () => (await api.del(path(`/pow/sessions/${id}`)), onDone())}>
      Cancel
    </Action>
  );
}
