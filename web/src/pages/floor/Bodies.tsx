import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { ago, dateTime } from "../../lib/format";
import type { AssetKind, BodyAnswer, BodyState, MachineBody, MachinesView } from "../../types";
import { Action, Field, Modal, useToast } from "../../ui/kit";
import { Select } from "../../ui/Select";

/** Kinds a virtual machine can be: every kind of machine, not a business-system link. */
export const VM_KINDS: { value: Exclude<AssetKind, "system">; label: string }[] = [
  { value: "cnc", label: "CNC machine" },
  { value: "robot", label: "Robot cell" },
  { value: "manual_station", label: "Manual station" },
  { value: "inspection", label: "Inspection station" },
  { value: "agv", label: "AGV fleet" },
  { value: "pack_line", label: "Pack line" },
  { value: "process_vessel", label: "Vessel / oven" },
  { value: "maintenance_crew", label: "Maintenance crew" },
];

const STATE_LABEL: Record<BodyState, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  sleeping: "Sleeping",
  safe_stopped: "Safe-stopped",
  failed: "Failed",
};
const stateClass = (s: BodyState) => (s === "running" ? "ok" : s === "safe_stopped" || s === "failed" ? "bad" : s === "starting" ? "warn" : "muted");

/** The site's virtual machines and their bodies, polled while shown. */
export function useBodies(every = 8000) {
  const { path } = useApp();
  const [view, setView] = useState<MachinesView | null>(null);
  const load = useCallback(() => api.get<MachinesView>(path("/machines")).then(setView), [path]);
  useEffect(() => {
    void load().catch(() => undefined);
    const t = setInterval(() => document.visibilityState === "visible" && void load().catch(() => undefined), every);
    return () => clearInterval(t);
  }, [load, every]);
  return { view, load };
}

function brainText(b: MachineBody, v: MachinesView) {
  if (b.brain === "0g") return "0G agent";
  return v.brain === "0g" ? "no 0G brain yet" : "no 0G brain";
}

export function BodyStatePill({ b }: { b: MachineBody }) {
  return (
    <span className={`pill ${stateClass(b.state)}`} title={b.error ?? undefined}>
      <span className="dot" /> {STATE_LABEL[b.state]}
    </span>
  );
}

/** Start or stop a body (managers). */
function StartStop({ b, onDone }: { b: MachineBody; onDone: () => Promise<unknown> }) {
  const { path, refresh } = useApp();
  const toast = useToast();
  const on = b.state !== "stopped" && b.state !== "failed";
  return (
    <Action
      className="btn sm"
      onClick={async () => {
        await api.post(path(`/machines/${b.assetId}/${on ? "stop" : "start"}`));
        toast(on ? `${b.name} stopped` : `${b.name} starting`, "ok");
        await Promise.all([onDone(), refresh()]);
      }}
    >
      {on ? "Stop" : "Start"}
    </Action>
  );
}

/**
 * Virtual machines on the Floor: each one's body, whether it runs, when it last reported, whether its agent reads and
 * decides through 0G, and its newest episode log.
 */
export function BodiesSection({ onOpen }: { onOpen: (assetId: string) => void }) {
  const { can, sees, path } = useApp();
  const { view, load } = useBodies();
  if (!view || view.bodies.length === 0) return null;
  return (
    <section className="section">
      <div className="section-h">
        <h2>Virtual machines</h2>
        <span className="muted small">
          {view.runtime ? `bodies run ${view.runtime === "local" ? "as processes on the Ordo host" : "in Vercel Sandbox microVMs"}` : "bodies are off on this server (BODY_RUNTIME)"} ·{" "}
          {view.brain === "0g" ? "agents read and decide through 0G" : "no 0G Router: bodies run without an agent and say so"}
        </span>
      </div>
      <div className="card scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Body</th>
              <th>Heartbeat</th>
              <th>Agent</th>
              <th>Episode log</th>
              {can("manager") && <th />}
            </tr>
          </thead>
          <tbody>
            {view.bodies.map((b) => (
              <tr key={b.assetId} className="click" onClick={() => onOpen(b.assetId)}>
                <td>
                  <b>{b.name}</b>
                  <div className="faint small">{b.kind.replaceAll("_", " ")} · simulated</div>
                </td>
                <td>
                  <BodyStatePill b={b} />
                  {b.error && <div className="bad-text small">{b.error.slice(0, 140)}</div>}
                </td>
                <td className="small">{b.heartbeatAt ? ago(b.heartbeatAt) : <span className="faint">none yet</span>}</td>
                <td className="small">{brainText(b, view)}</td>
                <td className="small" onClick={(e) => e.stopPropagation()}>
                  {b.episode ? (
                    <>
                      {sees(3) ? (
                        <a href={api.url(path(`/machines/${b.assetId}/episode?sha256=${encodeURIComponent(b.episode.sha256)}`))} target="_blank" rel="noreferrer">
                          {b.episode.entries} entries
                        </a>
                      ) : (
                        `${b.episode.entries} entries`
                      )}
                      <div className="faint small">
                        {b.episode.decisions} decisions · {ago(b.episode.at)}
                        {b.episode.replica?.root ? " · on 0G Storage" : ""}
                      </div>
                    </>
                  ) : (
                    <span className="faint">none yet</span>
                  )}
                </td>
                {can("manager") && (
                  <td className="r" onClick={(e) => e.stopPropagation()}>
                    <StartStop b={b} onDone={load} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A virtual machine's body in its asset drawer: its state, agent, episode log, and a question for it. */
export function BodyDrawerSection({ assetId }: { assetId: string }) {
  const { can, sees, path } = useApp();
  const { view, load } = useBodies(6000);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<BodyAnswer | null>(null);
  const b = view?.bodies.find((x) => x.assetId === assetId);
  if (!view || !b) return null;
  return (
    <section className="dsec">
      <h3>Body</h3>
      <div className="row-between small">
        <span>
          <BodyStatePill b={b} /> <span className="faint">{b.runtime === "local" ? "process on the Ordo host" : `Vercel Sandbox${b.sandboxId ? ` ${b.sandboxId}` : ""}`}</span>
        </span>
        {can("manager") && <StartStop b={b} onDone={load} />}
      </div>
      <dl className="kv">
        <dt>Agent</dt>
        <dd>{b.brain === "0g" ? "Reads each capture and decides through the 0G Router (private mode)" : "None: no 0G brain, so captures go up unread and the outputs say so"}</dd>
        <dt>Heartbeat</dt>
        <dd>{b.heartbeatAt ? `${dateTime(b.heartbeatAt)} (${ago(b.heartbeatAt)})` : "none yet"}</dd>
        <dt>Device</dt>
        <dd className="mono small">{b.device}</dd>
        {b.account && (
          <>
            <dt>Hedera account</dt>
            <dd className="mono small">{b.account}</dd>
          </>
        )}
        {b.error && (
          <>
            <dt>{b.state === "safe_stopped" ? "Safe stop" : "Error"}</dt>
            <dd className="bad-text">{b.error}</dd>
          </>
        )}
        <dt>Episode log</dt>
        <dd>
          {b.episode ? (
            <>
              {sees(3) ? (
                <a href={api.url(path(`/machines/${b.assetId}/episode?sha256=${encodeURIComponent(b.episode.sha256)}`))} target="_blank" rel="noreferrer">
                  {b.episode.entries} entries, {b.episode.decisions} decisions
                </a>
              ) : (
                `${b.episode.entries} entries, ${b.episode.decisions} decisions`
              )}{" "}
              <span className="faint small">· {ago(b.episode.at)}</span>
              {b.episode.replica?.url && (
                <>
                  {" "}
                  ·{" "}
                  <a href={b.episode.replica.url} target="_blank" rel="noreferrer">
                    0G Storage copy
                  </a>
                </>
              )}
            </>
          ) : (
            "none yet: the body posts it as it works a stage"
          )}
        </dd>
      </dl>
      {sees(3) && b.state !== "stopped" && b.state !== "failed" && (
        <div className="grid2">
          <Field label="Ask the machine" hint={b.brain === "0g" ? "Answered by its agent from its episode log, through 0G." : "Without a brain it answers plainly from its log."}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="What did the last capture read?" maxLength={1000} />
          </Field>
          <div className="btns">
            <Action className="btn sm" disabled={!q.trim()} onClick={async () => setAnswer(await api.post<BodyAnswer>(path(`/machines/${b.assetId}/ask`), { question: q.trim() }))}>
              Ask
            </Action>
          </div>
        </div>
      )}
      {answer && (
        <p className="small">
          {answer.answer}
          <span className="faint"> · {answer.requestId ? `0G request ${answer.requestId}` : "from the log, no 0G request"}</span>
        </p>
      )}
    </section>
  );
}

/** Create a virtual machine: an asset whose body simulates it, with its own key and agent. Started at once when bodies run. */
export function CreateMachineModal(props: { kind?: Exclude<AssetKind, "system">; onClose: () => void; onCreated?: (assetId: string) => void | Promise<void> }) {
  const { site, path, refresh } = useApp();
  const toast = useToast();
  const [kind, setKind] = useState<Exclude<AssetKind, "system">>(props.kind ?? "cnc");
  const label = VM_KINDS.find((k) => k.value === kind)?.label ?? kind;
  const [name, setName] = useState(`${label} (virtual)`);
  const [zone, setZone] = useState<string | null>(site.zones[0]?.id ?? null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      open
      onClose={props.onClose}
      eyebrow="Floor"
      title="Create a virtual machine"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <Action
            className="btn accent"
            disabled={!name.trim()}
            onClick={async () => {
              setErr(null);
              try {
                const r = await api.post<{ assetId: string; warnings: string[] }>(path("/machines"), { name: name.trim(), kind, zoneId: zone });
                for (const w of r.warnings) toast(w, "info");
                toast(`${name.trim()} created`, "ok");
                await refresh();
                await props.onCreated?.(r.assetId);
                props.onClose();
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Create
          </Action>
        </>
      }
    >
      <p className="muted small">
        A virtual machine is simulated by its own body: it streams telemetry, captures and signs the media for its stages&apos; outcomes, and, when Ordo has a 0G Router, has an agent read
        each capture and decide what it does next. Everything it produces is labelled simulated.
      </p>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
      </Field>
      <Field label="Kind">
        <Select
          value={kind}
          onChange={(v) => {
            const k = v as Exclude<AssetKind, "system">;
            if (name === `${label} (virtual)`) setName(`${VM_KINDS.find((x) => x.value === k)?.label ?? k} (virtual)`);
            setKind(k);
          }}
          options={VM_KINDS}
          disabled={Boolean(props.kind)}
        />
      </Field>
      {site.zones.length > 0 && (
        <Field label="Zone">
          <Select value={zone ?? ""} onChange={(v) => setZone(v || null)} options={[...site.zones.map((z) => ({ value: z.id, label: z.name })), { value: "", label: "No zone" }]} />
        </Field>
      )}
      {err && <p className="field-e">{err}</p>}
    </Modal>
  );
}
