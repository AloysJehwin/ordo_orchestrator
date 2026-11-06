import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, LEVEL_LABEL, shortAddr } from "../lib/format";
import { href } from "../lib/router";
import type { AutonomyLevel, AutonomyProposalView, ChainStatus, EnsNamesResponse } from "../types";
import { Name } from "../ui/Name";
import { Action, Field, Segmented, useToast } from "../ui/kit";
import { AutonomyModal } from "./Pipelines";
import { ChainBanner } from "./Stakes";

/** The org's ENS names in short: how many are on-chain, waiting or failed, and a link to the full tree. */
function EnsNames() {
  const { path, site } = useApp();
  const [names, setNames] = useState<EnsNamesResponse | null>(null);
  useEffect(() => {
    void api.get<EnsNamesResponse>(path("/names")).then(setNames).catch(() => setNames(null));
  }, [path, site]);
  if (!names?.live) return null;
  const by = (k: string) => names.items.filter((n) => n.kind === k && n.status !== "revoked").length;
  return (
    <section className="card section">
      <div className="card-h">
        <h2>ENS names</h2>
        <span className="faint small">ENSv2 · Sepolia · under {names.root}</span>
      </div>
      <div className="card-b">
        <p>{names.org ? <Name name={names.org} /> : null}</p>
        <p className="small muted">
          {names.issued} on-chain · {names.pending} waiting · {names.failed} failed — {by("person")} people, {by("role")} role names, {by("machine")} machines, {by("run")} runs.
          {names.gas.paused ? ` Sending is paused: ${names.gas.reason ?? "gas limits"}.` : ""}
        </p>
        <a className="btn sm" href={href("team?tab=names")}>
          Open every name (Team → Names)
        </a>
      </div>
    </section>
  );
}

/** The org's registration in OrdoTrust, with a retry when the manager skipped it after creating the org or the relay failed. */
function OnChain() {
  const { path } = useApp();
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const load = () => api.get<ChainStatus>(path("/chain")).then(setChain);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return (
    <section className="card">
      <div className="card-h">
        <h2>On-chain</h2>
        {chain?.configured && <span className={`tag ${chain.registered ? "ok" : "warn"}`}>{chain.registered ? "Registered" : "Not registered"}</span>}
      </div>
      <div className="card-b">{chain ? <ChainBanner chain={chain} onChange={load} /> : <p className="muted small">Loading…</p>}</div>
    </section>
  );
}

export function Settings() {
  const { status, site, can, path, reloadSite, meta, me } = useApp();
  const [zone, setZone] = useState("");
  const [auto, setAuto] = useState<{ lineId: string; to?: AutonomyLevel } | null>(null);
  const [proposals, setProposals] = useState<AutonomyProposalView[]>([]);
  const toast = useToast();
  useEffect(() => {
    void api.get<AutonomyProposalView[]>(path("/autonomy/proposals")).then(setProposals);
  }, [path, site]);
  const open = proposals.filter((p) => p.status === "open");
  const admin = can("manager");
  return (
    <div>
      <div className="eyebrow">{site.name}</div>
      <h1>Settings</h1>
      <div className="grid2 section">
        <section className="card">
          <div className="card-h">
            <h2>Lines & autonomy</h2>
          </div>
          <div className="card-b">
            {site.lines.map((l) => (
              <div key={l.id} className="row-between">
                <span>
                  <b>{l.name}</b>{" "}
                  <span className="muted">
                    {l.autonomy} · {LEVEL_LABEL[l.autonomy]}
                  </span>
                </span>
                <button type="button" className="btn sm" onClick={() => setAuto({ lineId: l.id })}>
                  Change
                </button>
              </div>
            ))}
            {open.map((p) => (
              <div key={p.id} className="notice warn">
                <b>
                  {p.lineName}: {p.from} → {p.to}
                </b>{" "}
                <span className="small">
                  signed by {p.signers.map((x) => x.name ?? shortAddr(x.address)).join(", ")} {ago(p.createdAt)} · {p.signers.length} of {p.required}
                </span>
                {p.comment && <p className="small">“{p.comment}”</p>}
                {p.signers.some((x) => x.address === me.user!.address) ? (
                  <p className="small">Waiting for another manager to co-sign.</p>
                ) : (
                  can("manager") && (
                    <div className="btns">
                      <button type="button" className="btn accent sm" onClick={() => setAuto({ lineId: p.lineId, to: p.to })}>
                        Review and co-sign
                      </button>
                    </div>
                  )
                )}
              </div>
            ))}
            <p className="faint small">
              Changing autonomy takes a manager's signature{status.trust?.policies ? ", and raising it is published to OrdoPolicies on-chain" : ""}. Every change is recorded in the ledger.
            </p>
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Joining</h2>
            <span className={`tag ${site.openJoin ? "ok" : ""}`}>{site.openJoin ? "Open" : "Invite only"}</span>
          </div>
          <div className="card-b">
            <p className="muted small">
              {site.openJoin
                ? "Anyone with a wallet can join as a contributor, from Open orgs or with this code. You make people validators or testers on the Team page."
                : "Only wallets you invite from the Team page can join. The org stays out of the Open orgs list."}
            </p>
            <Segmented
              size="sm"
              value={site.openJoin ? "open" : "invite"}
              onChange={async (v) => {
                if (!admin) return toast("Only a manager can change this", "bad");
                await api.patch(path(""), { openJoin: v === "open" });
                await reloadSite();
                toast(v === "open" ? "Anyone can join as a contributor" : "Joining is by invite only", "ok");
              }}
              options={[
                { value: "open", label: "Open" },
                { value: "invite", label: "Invite only" },
              ]}
            />
            <p className="mono copy">{site.id}</p>
            <div className="btns">
              <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/#/join?site=${site.id}`).then(() => toast("Join link copied", "ok"))}>
                Copy join link
              </button>
            </div>
          </div>
        </section>
        {status.trust && <OnChain />}
        <section className="card">
          <div className="card-h">
            <h2>Public pipelines</h2>
          </div>
          <div className="card-b">
            <p className="muted small">
              Running pipelines are listed on the public <a href="#/open">Open orgs</a> page, so people without an account can see what this org runs before joining. It shows stages, progress and the roles needed; never order references, machine names, addresses or people's names.
            </p>
            <Segmented
              size="sm"
              value={site.publicPipelines ? "listed" : "hidden"}
              onChange={async (v) => {
                if (!can("manager")) return toast("Only a manager can change this", "bad");
                await api.patch(path(""), { publicPipelines: v === "listed" });
                await reloadSite();
                toast(v === "listed" ? "Pipelines are listed publicly" : "Pipelines are hidden from the public list", "ok");
              }}
              options={[
                { value: "listed", label: "Listed" },
                { value: "hidden", label: "Hidden" },
              ]}
            />
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Zones</h2>
          </div>
          <div className="card-b">
            <div className="chips">
              {site.zones.map((z) => (
                <span key={z.id} className="chip">
                  {z.name}
                  {admin && (
                    <button type="button" aria-label={`Delete ${z.name}`} onClick={async () => (await api.del(path(`/zones/${z.id}`)), await reloadSite())}>
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            {admin && (
              <div className="inline">
                <input className="input grow" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="New zone" />
                <Action className="btn" disabled={!zone.trim()} onClick={async () => (await api.post(path("/zones"), { name: zone.trim() }), setZone(""), await reloadSite(), toast("Zone added", "ok"))}>
                  Add
                </Action>
              </div>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Policy</h2>
            <span className="mono small faint">
              {status.policy.id} v{status.policy.version}
            </span>
          </div>
          <div className="card-b">
            <p className="muted small">Agents may act on their own only from the autonomy level shown; below it the action becomes an inbox item for the listed role. Low confidence or uncertain data always escalates.</p>
            <table className="t compact">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Automatic from</th>
                  <th>Otherwise needs</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries((meta as unknown as { policy: { tools: Record<string, { autoFrom: string; role?: string }>; defaultRole: string } }).policy.tools).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k.replaceAll("_", " ")}</td>
                    <td>{v.autoFrom}</td>
                    <td>{(v.role ?? (meta as unknown as { policy: { defaultRole: string } }).policy.defaultRole).replaceAll("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Field label="Policy hash">
              <span className="mono small">{status.policy.hash}</span>
            </Field>
          </div>
        </section>
        <section className="card">
          <div className="card-h">
            <h2>Rails</h2>
            <span className="faint small">{status.build?.env}</span>
          </div>
          <div className="card-b">
            {status.rails.map((r) => (
              <div key={r.rail} className="row-between">
                <span>{r.rail}</span>
                <span className={r.live ? "ok-text" : "muted"}>{r.mode}</span>
              </div>
            ))}
            {status.warnings.map((w) => (
              <p key={w} className="field-e small">
                {w}
              </p>
            ))}
            {status.build?.commit && <p className="faint small mono">build {status.build.commit.slice(0, 7)}</p>}
          </div>
        </section>
      </div>
      <EnsNames />
      {auto && (
        <AutonomyModal
          open
          onClose={() => {
            setAuto(null);
            void api.get<AutonomyProposalView[]>(path("/autonomy/proposals")).then(setProposals);
          }}
          lineId={auto.lineId}
          current={site.lines.find((l) => l.id === auto.lineId)!.autonomy}
          initial={auto.to}
        />
      )}
    </div>
  );
}
