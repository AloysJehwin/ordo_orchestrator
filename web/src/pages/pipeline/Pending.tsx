import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CircleAlert, CircleCheck, Clock, Info, RotateCw, SkipForward, TriangleAlert } from "lucide-react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { go } from "../../lib/router";
import type { PendingAction, RunPendingView, RunView, StagePendingView, StageRunView } from "../../types";
import { Action, useToast } from "../../ui/kit";
import { WaiveModal } from "./Resources";
import { roleWords } from "./layout";
import type { useStageActions } from "./StageParts";

/** What each waiting stage of a running run waits on (GET /runs/:id/pending), kept current with the live feed. */
export function useRunPending(run: RunView | null) {
  const { path, sees, live } = useApp();
  const [data, setData] = useState<RunPendingView | null>(null);
  const on = Boolean(run && run.status === "running" && sees(2));
  const id = run?.id ?? null;
  const load = useCallback(async () => {
    if (!id) return;
    setData(await api.get<RunPendingView>(path(`/runs/${id}/pending`)).catch(() => null));
  }, [path, id]);
  useEffect(() => {
    if (on) void load();
    else setData(null);
  }, [on, load, live?.headSeq]);
  const of = useCallback((code: string | null | undefined) => (code ? (data?.stages.find((s) => s.code === code) ?? null) : null), [data]);
  return { pending: data, of, reload: load };
}
export type Pending = ReturnType<typeof useRunPending>;

/** How long a stage has waited, in the largest unit that fits. */
export function waited(since: string | null): string | null {
  if (!since) return null;
  const m = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}

/** The few words a stage node has room for: the stages it waits for, else what it waits on. */
export const shortWhy = (p: StagePendingView) => (p.upstream.length ? `after ${p.upstream.join(", ")}` : p.headline);

/**
 * Runs a stage's pending actions: retry (start the buying machine's body), bypass (a signed waiver), the next step (step
 * the run, approve the gate, record by hand) or the page where it is fixed. Render `modal` once.
 */
export function usePendingActions(run: RunView | null, stageActions: ReturnType<typeof useStageActions>, onRecord: (s: StageRunView) => void, reload: () => Promise<unknown>) {
  const { path, refresh, can } = useApp();
  const toast = useToast();
  const [waive, setWaive] = useState<{ stage: StageRunView; missing: string[] } | null>(null);
  const act = async (s: StageRunView, p: StagePendingView, a: PendingAction) => {
    if (!run) return;
    switch (a.id) {
      case "start_body":
        await api.post(path(`/machines/${a.assetId}/start`));
        toast(`${a.label.replace(/^(Restart|Start) /, "").replace(/ now$/, "")}'s body is starting: it buys what is missing on its first cycle`, "ok");
        await Promise.all([reload(), refresh()]);
        return;
      case "waive_resources":
        setWaive({ stage: s, missing: p.missing ?? [] });
        return;
      case "step_run": {
        const r = await api.post<{ started: string[] }>(path(`/runs/${run.id}/step`));
        toast(r.started.length ? `Started ${r.started.join(", ")}` : "Nothing could start yet", r.started.length ? "ok" : "info");
        await Promise.all([reload(), refresh()]);
        return;
      }
      case "approve_gate":
        await stageActions.approve(s);
        await reload();
        return;
      case "record":
        onRecord(s);
        return;
      case "open_machine":
        go(a.assetId ? `floor?asset=${a.assetId}` : "floor");
        return;
      case "open_vendors":
        go("team?tab=vendors");
        return;
      case "open_approvals":
        go("approvals");
    }
  };
  const modal =
    run && waive ? <WaiveModal open run={run} stage={waive.stage} missing={waive.missing} onClose={() => setWaive(null)} onDone={reload} /> : null;
  return { act, modal, may: (a: PendingAction) => can(a.role) };
}
export type PendingRunner = ReturnType<typeof usePendingActions>;

const TONE_ICON: Record<StagePendingView["items"][number]["tone"], ReactNode> = {
  bad: <CircleAlert size={14} aria-hidden />,
  warn: <TriangleAlert size={14} aria-hidden />,
  info: <Info size={14} aria-hidden />,
  ok: <CircleCheck size={14} aria-hidden />,
};
const KIND_ORDER: PendingAction["kind"][] = ["retry", "bypass", "do", "open"];

function ActionButton({ a, onClick, small }: { a: PendingAction; onClick: () => Promise<unknown> | unknown; small?: boolean }) {
  const cls = a.kind === "retry" ? "btn accent" : a.kind === "open" ? "btn link" : "btn";
  return (
    <Action className={`${cls}${small ? " sm" : ""}`} title={a.detail} onClick={onClick}>
      {a.kind === "retry" && <RotateCw size={14} aria-hidden />}
      {a.kind === "bypass" && <SkipForward size={14} aria-hidden />}
      {a.label}
      {a.kind === "bypass" && a.id === "waive_resources" ? "…" : ""}
      {a.kind === "open" && <ArrowRight size={14} aria-hidden />}
    </Action>
  );
}

/** Who may take the actions this person may not, in words. */
function needs(actions: PendingAction[]): string | null {
  if (!actions.length) return null;
  const roles = [...new Set(actions.map((a) => a.role))];
  return `${roles.map((r) => `a ${roleWords(r)}`).join(" or ")} can ${actions.map((a) => a.label.charAt(0).toLowerCase() + a.label.slice(1)).join(", or ")}`;
}

/**
 * A stage's pending actions: what it waits on, the chain down to the first thing that is stuck, and the actions this
 * person may take (retry, bypass, the next step, where to fix it). Actions for other roles are named, not offered.
 */
export function PendingCard({ stage, p, runner, compact = false }: { stage: StageRunView; p: StagePendingView; runner: PendingRunner; compact?: boolean }) {
  const mine = [...p.actions].filter(runner.may).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const theirs = p.actions.filter((a) => !runner.may(a));
  const items = compact ? p.items.filter((i) => i.tone === "bad" || i.tone === "warn").slice(0, 2) : p.items;
  const shown = compact ? mine.filter((a) => a.kind === "retry" || a.kind === "bypass" || a.kind === "do") : mine;
  const w = waited(p.since);
  const other = needs(theirs);
  return (
    <div className={`pend s-${p.status}${compact ? " compact" : ""}`}>
      <div className="pend-h">
        <span className="pend-ico">{p.status === "blocked" ? <CircleAlert size={16} aria-hidden /> : <Clock size={16} aria-hidden />}</span>
        <b>{p.headline}</b>
        {w && <span className="pend-since">{p.status === "blocked" ? `stuck ${w}` : `waiting ${w}`}</span>}
      </div>
      {items.length > 0 && (
        <ul className="pend-items">
          {items.map((i, k) => (
            <li key={k} className={`t-${i.tone}`}>
              {TONE_ICON[i.tone]}
              <span>{i.text}</span>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <div className="pend-acts">
          {shown.map((a) => (
            <ActionButton key={`${a.id}:${a.assetId ?? ""}`} a={a} small={compact} onClick={() => runner.act(stage, p, a)} />
          ))}
        </div>
      )}
      {!compact && other && <p className="pend-note">{other.charAt(0).toUpperCase() + other.slice(1)}.</p>}
    </div>
  );
}

/**
 * Why the run is not moving, above the stage map: each stage holding it up, the first thing in its way, and the
 * retry or bypass this person may take, with the stage's full details a click away.
 */
export function RunHoldUp({ run, pending, runner, onOpen }: { run: RunView; pending: RunPendingView | null; runner: PendingRunner; onOpen: (code: string) => void }) {
  if (!pending || !pending.blocking.length) return null;
  const rows = pending.blocking
    .map((code) => ({ s: run.stages.find((x) => x.code === code), p: pending.stages.find((x) => x.code === code) }))
    .filter((r): r is { s: StageRunView; p: StagePendingView } => Boolean(r.s && r.p));
  if (!rows.length) return null;
  return (
    <section className="holdup card" aria-label="Why this run is not moving">
      {rows.slice(0, 3).map(({ s, p }) => {
        const first = p.items.find((i) => i.tone === "bad") ?? p.items.find((i) => i.tone === "warn");
        const quick = p.actions.filter((a) => runner.may(a) && (a.kind === "retry" || a.kind === "bypass" || a.kind === "do")).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
        const w = waited(p.since);
        return (
          <div key={s.code} className="hu-row">
            <span className="hu-ico" aria-hidden>
              <CircleAlert size={18} />
            </span>
            <div className="hu-text">
              <div className="hu-title">
                Held up at <span className="mono">{s.code}</span> {s.name}
                {w && <span className="hu-since"> · stuck {w}</span>}
              </div>
              <div className="hu-why">
                {p.headline}
                {first ? `: ${first.text}` : ""}
              </div>
            </div>
            <div className="hu-acts">
              {quick.slice(0, 2).map((a) => (
                <ActionButton key={`${a.id}:${a.assetId ?? ""}`} a={a} small onClick={() => runner.act(s, p, a)} />
              ))}
              <button type="button" className="btn sm" onClick={() => onOpen(s.code)}>
                Details
              </button>
            </div>
          </div>
        );
      })}
      {rows.length > 3 && <p className="faint small hu-more">and {rows.length - 3} more stage(s) held up</p>}
    </section>
  );
}
