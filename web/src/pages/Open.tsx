import { useEffect, useState } from "react";
import { api } from "../api";
import { ago, dateTime, pct, shortAddr, STATE_LABEL } from "../lib/format";
import { href, type Route } from "../lib/router";
import type { Me, PublicPipeline, StageState } from "../types";
import { Action, Empty } from "../ui/kit";
import { Name } from "../ui/Name";
import { joinOrg, OrgExplorer, ROLE_NAME } from "./Explore";
import { SignIn } from "./SignIn";

const progressOf = (p: PublicPipeline) => p.stages.reduce((a, s) => a + s.progress, 0) / Math.max(1, p.stages.length);

const Progress = ({ p }: { p: PublicPipeline }) => (
  <div className="progress" aria-label={`${p.metrics.completed} of ${p.metrics.total} stages done`}>
    <span style={{ width: `${Math.round(progressOf(p) * 100)}%` }} />
  </div>
);

const nameOf = (u: NonNullable<Me["user"]>) => u.ens ?? u.displayName ?? shortAddr(u.address);
const initialsOf = (u: NonNullable<Me["user"]>) => {
  const n = u.displayName ?? u.ens?.split(".")[0] ?? "";
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((x) => x[0]!.toUpperCase()).join("") : u.address.slice(2, 4).toUpperCase();
};
/** Open the console on a site: the console starts on the site it last remembers. */
const openSite = (siteId: string) => {
  try {
    localStorage.setItem("ordo.site", siteId);
  } catch {
    /* ignore */
  }
  window.location.hash = "#/pipelines";
  window.location.reload();
};

/** What the page knows about whoever is looking: their account and orgs. */
interface Account {
  me: Me | null;
  signIn: () => void;
}

const Head = ({ account, children }: { account: Account; children?: React.ReactNode }) => {
  const u = account.me?.user;
  return (
    <header className="op-top">
      <a className="pp-brand" href={href("open")}>
        Ordo · Open orgs
      </a>
      <span className="op-top-links">
        {children}
        {u ? (
          <a className="op-me-chip" href="#you" title={u.address} onClick={(e) => (e.preventDefault(), document.getElementById("you")?.scrollIntoView({ behavior: "smooth" }))}>
            <span className="op-avatar sm">{initialsOf(u)}</span>
            <span className="op-me-name">{nameOf(u)}</span>
          </a>
        ) : (
          <button type="button" className="btn sm accent" onClick={account.signIn}>
            Sign in
          </button>
        )}
        <a className="btn sm" href="#/">
          Console
        </a>
      </span>
    </header>
  );
};

/** A returning person's own details: who they are and the roles they hold in each org. */
function YouPanel({ account, siteId }: { account: Account; siteId?: string }) {
  const u = account.me?.user;
  if (!u) return null;
  const sites = [...(account.me?.memberships ?? [])].sort((a, b) => Number(b.siteId === siteId) - Number(a.siteId === siteId));
  const copy = () => void navigator.clipboard?.writeText(u.address);
  return (
    <section className="op-section op-you" id="you">
      <div className="op-you-h">
        <span className="op-avatar">{initialsOf(u)}</span>
        <div className="op-you-id">
          <b>{u.ens ? <Name name={u.ens} /> : nameOf(u)}</b>
          {u.ens && u.displayName && <span className="small muted">{u.displayName}</span>}
          <button type="button" className="op-addr" onClick={copy} title="Copy address">
            {shortAddr(u.address)}
          </button>
        </div>
      </div>

      <h3 className="op-you-t">Your orgs</h3>
      {sites.length ? (
        <ul className="op-you-list">
          {sites.map((m) => (
            <li key={m.siteId}>
              <div className="row-between">
                <b>{m.siteName}</b>
                {m.siteId === siteId && <span className="tag accent">This org</span>}
              </div>
              <div className="chips">
                {m.roles.map((r) => (
                  <span key={r} className="chip">
                    {ROLE_NAME[r] ?? r}
                  </span>
                ))}
              </div>
              {(u.names ?? [])
                .filter((n) => n.siteId === m.siteId)
                .map((n) => (
                  <div key={n.name} className="small">
                    <Name name={n.name} status={n.status} />
                  </div>
                ))}
              <button type="button" className="link small" onClick={() => openSite(m.siteId)}>
                Open in console →
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="op-none">You haven't joined an org yet.{siteId ? " Join this one below." : " Join one below."}</p>
      )}

    </section>
  );
}

/**
 * Open orgs and their running pipelines, which anyone can browse without an account. A newcomer sees what an org is
 * making and which roles its pipelines need, and joins as a contributor with one click once signed in. A manager
 * makes people validators or testers from the org's Team page.
 */
export function Open({ route, me, onSignedIn }: { route: Route; me: Me | null; onSignedIn: (m: Me) => void }) {
  const [signingIn, setSigningIn] = useState(false);
  const userId = me?.user?.id ?? null;
  useEffect(() => {
    // a returning person: refresh their orgs and roles
    if (userId) void api.get<Me>("/v1/me").then(onSignedIn).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  if (signingIn && !me?.user) return <SignIn onSignedIn={(m) => (onSignedIn(m), setSigningIn(false))} />;
  const account: Account = { me, signIn: () => setSigningIn(true) };
  if (route.id && route.sub) return <PipelinePage siteId={route.id} runId={route.sub} account={account} />;
  return <PipelineList account={account} />;
}

function PipelineList({ account }: { account: Account }) {
  const [rows, setRows] = useState<PublicPipeline[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<PublicPipeline[]>("/v1/public/pipelines")
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <div className="pp op">
      <Head account={account} />
      <h1>Open orgs</h1>
      <p className="muted">Anyone can join an open org as a contributor: follow its running pipelines and submit proof of your work on their stages. Managers make contributors validators or testers.</p>
      {account.me?.user && (
        <div className="op-you-strip">
          <YouPanel account={account} />
        </div>
      )}
      <section className="op-section">
        <OrgExplorer signedIn={Boolean(account.me?.user)} onOpen={openSite} onSignIn={account.signIn} />
      </section>
      <h2>Pipelines running now</h2>
      {error && <p className="field-e">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <Empty title="No pipelines are running right now">Check back later.</Empty>}
      <div className="op-grid">
        {rows?.map((p) => (
          <a key={`${p.siteId}/${p.runId}`} className="pp-card op-card" href={href(`open/${p.siteId}/${p.runId}`)}>
            <div className="faint small">{p.site}</div>
            <h2>{p.pipeline.name}</h2>
            <p className="small muted">
              {p.pipeline.category} · v{p.pipeline.version} · {p.quantity} units · started {ago(p.startedAt)}
            </p>
            <Progress p={p} />
            <p className="small">
              {p.metrics.completed} of {p.metrics.total} stages done
              {p.metrics.gatesPending ? ` · ${p.metrics.gatesPending} gate${p.metrics.gatesPending > 1 ? "s" : ""} waiting for a signature` : ""}
            </p>
            <div className="chips">
              {p.roles.map((r) => (
                <span key={r.role} className="chip">
                  {r.label}
                </span>
              ))}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

type Tone = "done" | "active" | "waiting" | "held" | "idle";
const toneOf = (state: string): Tone =>
  state === "completed" || state === "done_deviation" || state === "skipped" ? "done" : state === "running" ? "active" : state === "awaiting_approval" ? "waiting" : state === "held" ? "held" : "idle";
const howOf = (s: PublicPipeline["stages"][number]) => (s.mode === "approve" ? `Gate signed by a ${s.gateRole}` : s.mode === "manual" ? "Contributors submit proof of work" : `Automatic · escalates to a ${s.gateRole}`);

/** "Signs the gate at 01 X", "Signs the gate at 02 Y" → one line naming the stage codes. */
function summarize(why: string[]) {
  const gates = why.filter((w) => w.startsWith("Signs the gate at ")).map((w) => w.slice(18).split(" ")[0]);
  const misses = why.filter((w) => w.startsWith("Decides when ")).map((w) => w.slice(13).split(" ")[0]);
  const rest = why.filter((w) => !w.startsWith("Signs the gate at ") && !w.startsWith("Decides when "));
  return [
    ...(gates.length ? [gates.length > 1 ? `Signs the gates at stages ${gates.join(", ")}` : why.find((w) => w.startsWith("Signs the gate at "))!] : []),
    ...(misses.length ? [`Decides when stage${misses.length > 1 ? "s" : ""} ${misses.join(", ")} miss${misses.length > 1 ? "" : "es"} their criteria`] : []),
    ...rest,
  ];
}

const Stat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) => (
  <div className="op-stat">
    <span className="op-stat-l">{label}</span>
    <span className="op-stat-v">{value}</span>
    {sub && <span className="op-stat-s">{sub}</span>}
  </div>
);

function PipelinePage({ siteId, runId, account }: { siteId: string; runId: string; account: Account }) {
  const me = account.me;
  const [p, setP] = useState<PublicPipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<PublicPipeline>(`/v1/public/pipelines/${encodeURIComponent(siteId)}/${encodeURIComponent(runId)}`)
      .then(setP)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [siteId, runId]);

  if (error)
    return (
      <div className="pp op">
        <Head account={account} />
        <Empty title="This pipeline isn't public" action={<a className="btn" href={href("open")}>See all running pipelines</a>}>
          {error}
        </Empty>
      </div>
    );
  if (!p) return <div className="boot">Loading pipeline…</div>;

  const member = me?.memberships.find((m) => m.siteId === siteId);
  const roles: string[] = member?.roles ?? [];
  const columns = [...new Set(p.stages.map((s) => s.column))].sort((a, b) => a - b);
  const progress = Math.round(progressOf(p) * 100);
  const waiting = p.stages.filter((s) => toneOf(s.state) === "waiting" || toneOf(s.state) === "held");
  const open = p.roles.filter((r) => !r.holders).length;
  const statusTone = p.status === "running" ? (waiting.length ? "warn" : "accent") : p.status === "completed" ? "ok" : "bad";
  return (
    <div className="pp op">
      <Head account={account}>
        <a href={href("open")}>← All pipelines</a>
      </Head>

      <header className="op-hero">
        <div className="op-hero-main">
          <div className="op-eyebrow">
            <span>{p.site}</span>
            <span aria-hidden>·</span>
            <span>{p.pipeline.category}</span>
            <span aria-hidden>·</span>
            <span>v{p.pipeline.version}</span>
          </div>
          <h1>{p.pipeline.name}</h1>
          <p className="op-lede">{p.pipeline.description}</p>
          <div className="op-hero-tags">
            <span className={`tag ${statusTone}`}>{p.status === "running" ? (waiting.length ? `Running · ${waiting.length} waiting on a person` : "Running") : p.status}</span>
            {open > 0 && <span className="tag accent">{open} role{open > 1 ? "s" : ""} with nobody yet</span>}
          </div>
        </div>
        <a className="btn accent op-hero-cta" href="#take-part" onClick={(e) => (e.preventDefault(), document.getElementById("take-part")?.scrollIntoView({ behavior: "smooth" }))}>
          Take part
        </a>
      </header>

      <div className="op-stats">
        <Stat label="Progress" value={`${progress}%`} sub={<span className="progress op-stat-bar"><span style={{ width: `${progress}%` }} /></span>} />
        <Stat label="Stages done" value={`${p.metrics.completed} / ${p.metrics.total}`} />
        <Stat label="Units" value={p.quantity.toLocaleString()} sub={p.metrics.rolledYield !== null ? `${pct(p.metrics.rolledYield)} rolled yield` : undefined} />
        <Stat label="Started" value={ago(p.startedAt)} sub={p.dueAt ? `due ${dateTime(p.dueAt)}${p.metrics.onTrack === false ? " · behind" : p.metrics.onTrack ? " · on track" : ""}` : dateTime(p.startedAt)} />
      </div>

      <div className="op-layout">
        <main className="op-main">
          <section className="op-section">
            <div className="op-section-h">
              <h2>Stages</h2>
              <span className="op-legend">
                <i className="t-done" /> Done <i className="t-active" /> Running <i className="t-waiting" /> Waiting <i className="t-idle" /> Queued
              </span>
            </div>
            <ol className="op-flow">
              {columns.map((c) => {
                const group = p.stages.filter((s) => s.column === c);
                const tones = group.map((s) => toneOf(s.state));
                const tone: Tone = tones.every((t) => t === "done") ? "done" : (["held", "waiting", "active"] as Tone[]).find((t) => tones.includes(t)) ?? "idle";
                return (
                  <li key={c} className={`op-step t-${tone}`}>
                    <span className="op-dot" aria-hidden />
                    <div className={`op-step-cards${group.length > 1 ? " parallel" : ""}`}>
                      {group.map((s) => (
                        <div key={s.code} className={`op-stage t-${toneOf(s.state)}`}>
                          <div className="op-stage-h">
                            <span className="op-code">{s.code}</span>
                            <b>{s.name}</b>
                            <span className={`op-state t-${toneOf(s.state)}`}>{STATE_LABEL[s.state as StageState] ?? s.state}</span>
                          </div>
                          <div className="op-stage-meta">
                            {s.resource} · {s.agent}
                          </div>
                          <div className="op-stage-how">{howOf(s)}</div>
                          {toneOf(s.state) === "active" && s.progress > 0 && (
                            <span className="progress op-stage-bar">
                              <span style={{ width: `${Math.round(s.progress * 100)}%` }} />
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="op-section">
            <div className="op-section-h">
              <h2>Validation</h2>
            </div>
            <p className="small muted">The lot ships only after a validation package is signed Performed by, Reviewed by and Approved by.</p>
            {p.validation && p.validation.length > 0 ? (
              <ul className="op-vals">
                {p.validation.map((v) => (
                  <li key={v.ref}>
                    <span className="op-code">{v.ref}</span>
                    <span>
                      <b>{v.type}</b>
                      {v.stageCode && <span className="faint"> · stage {v.stageCode}</span>}
                    </span>
                    {v.waitingFor ? <span className="tag warn">Needs {v.waitingFor.label.toLowerCase()} · {v.waitingFor.roleLabel}</span> : <span className="tag ok">{v.status}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="op-none">No validation packages opened for this run yet.</p>
            )}
          </section>
        </main>

        <aside className="op-aside">
          <YouPanel account={account} siteId={siteId} />
          <div className="op-section" id="take-part">
            <div className="op-section-h">
              <h2>Take part</h2>
            </div>
            <p className="small muted">
              {member ? `You are in ${p.site}.` : `Join ${p.site} as a contributor with your wallet. A manager makes contributors validators or testers; both stake.`}
            </p>
            {member ? (
              <button type="button" className="btn sm" onClick={() => openSite(siteId)}>
                Open in console
              </button>
            ) : me?.user ? (
              <Action className="btn sm accent" onClick={async () => openSite(await joinOrg(siteId))}>
                Join as contributor
              </Action>
            ) : (
              <button type="button" className="btn sm accent" onClick={account.signIn}>
                Sign in to join
              </button>
            )}
            <ul className="op-rolelist">
              {p.roles.map((r) => (
                <li key={r.role} className="op-role">
                  <div className="op-role-h">
                    <b>{r.label}</b>
                    <span className={`op-holders${r.holders ? "" : " open"}`}>{r.holders ? `${r.holders} here` : "Open"}</span>
                  </div>
                  {summarize(r.why).map((w) => (
                    <p key={w} className="op-role-why">
                      {w}
                    </p>
                  ))}
                  {roles.includes(r.role) && <span className="tag ok">You hold this role</span>}
                </li>
              ))}
            </ul>

          </div>
        </aside>
      </div>

    </div>
  );
}
