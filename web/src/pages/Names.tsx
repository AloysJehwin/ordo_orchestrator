import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { go, useRoute } from "../lib/router";
import type { DirectoryEntry, EnsNamesResponse, EnsNameView, NameKind } from "../types";
import { Action, Empty, Loading } from "../ui/kit";
import { Name } from "../ui/Name";

const STATUS = { pending: ["registering", "warn"], sent: ["in a batch", "warn"], issued: ["on-chain", "ok"], revoked: ["revoked", ""], failed: ["failed", "bad"] } as const;

/** The org's name tree, grouped the way it sits on-chain. */
const GROUPS: { title: string; kinds: NameKind[]; note?: string }[] = [
  { title: "The org", kinds: ["org", "treasury", "collection"], note: "Each collection has its own ENSv2 registry under the org." },
  { title: "People", kinds: ["person"], note: "Minted to each person's own wallet, from the handle they chose." },
  { title: "Roles", kinds: ["role", "registrar"], note: "Holding the name is holding the role: contracts read roles from these registries." },
  { title: "Machines", kinds: ["machine"], note: "Owned by each machine's device key; their Hedera record is the machine's own account." },
  { title: "Agents", kinds: ["agent"] },
  { title: "Lines and pipelines", kinds: ["line", "pipeline"] },
  { title: "Vendors, customers and financiers", kinds: ["vendor", "customer", "financier"] },
  { title: "Runs", kinds: ["run", "stage", "budget", "topup"], note: "A run's name is its lot: releases are recorded on it. Stages, its budget and top-ups sit under it." },
  { title: "Work orders", kinds: ["workorder"] },
];

/** Where an entity with a name lives in the console. */
export function routeFor(e: Pick<DirectoryEntry, "kind" | "ref" | "name">, entries: DirectoryEntry[]): string {
  const runOf = (name: string) => entries.find((x) => x.kind === "run" && name.endsWith(`.${x.name}`))?.ref ?? null;
  switch (e.kind) {
    case "run":
      return `pipelines/${e.ref}`;
    case "stage":
      return `pipelines/${e.ref.split(":")[0]}`;
    case "budget":
      return `pipelines/${e.ref}`;
    case "topup": {
      const run = runOf(e.name);
      return run ? `pipelines/${run}` : "team?tab=names";
    }
    case "person":
    case "role":
      return "team";
    case "machine":
    case "line":
      return "floor";
    case "workorder":
    case "vendor":
      return "work-orders";
    case "customer":
    case "financier":
      return "finance";
    case "pipeline":
      return "templates";
    default:
      return `team?tab=names&q=${encodeURIComponent(e.name)}`;
  }
}

/** The org's names, as a tab of the Team page: who and what is named, what is on-chain, and what waits. */
export function Names() {
  const { path, site, can, book } = useApp();
  const route = useRoute();
  const [data, setData] = useState<EnsNamesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(route.query.get("q") ?? "");
  useEffect(() => setQ(route.query.get("q") ?? ""), [route.query]);
  const load = () =>
    api
      .get<EnsNamesResponse>(path("/names"))
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, site]);
  const items = useMemo(() => {
    const all = (data?.items ?? []).filter((n) => n.kind !== "registrar" || can("manager"));
    const s = q.trim().toLowerCase();
    return s ? all.filter((n) => n.name.includes(s) || (n.records.description ?? "").toLowerCase().includes(s) || n.address?.toLowerCase() === s || n.hedera === s) : all;
  }, [data, q, can]);

  if (error) return <Empty title="Names are not available">{error}</Empty>;
  if (!data) return <Loading />;
  if (!data.live) return <Empty title="ENS names are off">This Ordo has no ENSv2 root configured (ENS_PARENT_NAME, ENS_NAMES_ADDRESS).</Empty>;
  return (
    <div className="section">
      <div className="names-head">
        {data.org ? <Name name={data.org} /> : null}
        <span className="faint small">
          ENSv2 on Sepolia under {data.root} · people by handle, the roles they hold, machines, agents, lines, vendors, runs, stages, budgets and work orders, registered in batches
        </span>
      </div>
      <div className="kpis names-kpis">
        <div className="kpi">
          <div className="label">On-chain</div>
          <div className="v">{data.issued}</div>
          <div className="s">registered in OrdoNames batches</div>
        </div>
        <div className="kpi">
          <div className="label">Waiting</div>
          <div className="v">{data.pending}</div>
          <div className="s">{data.gas.paused ? (data.gas.reason ?? "paused by the gas limits") : "sent in the next batches"}</div>
        </div>
        <div className="kpi">
          <div className="label">Failed</div>
          <div className="v">{data.failed}</div>
          <div className="s">retried with backoff, then here</div>
        </div>
        <div className="kpi">
          <div className="label">Gas today</div>
          <div className="v">{data.gas.spentTodayEth.toFixed(4)}</div>
          <div className="s">
            of {data.gas.dailyEth} ETH{data.gas.balanceEth !== null ? ` · ${data.gas.balanceEth.toFixed(3)} ETH left` : ""}
          </div>
        </div>
      </div>
      <div className="name-lookup section">
        <input className="mono" placeholder="Search names, descriptions, addresses or accounts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search names" />
      </div>
      {GROUPS.map((g) => {
        const rows = items.filter((n) => g.kinds.includes(n.kind));
        if (!rows.length) return null;
        return (
          <section key={g.title} className="card section">
            <div className="card-h">
              <h2>{g.title}</h2>
              <span className="faint small num">{rows.length}</span>
            </div>
            <div className="card-b">
              {g.note && <p className="small muted">{g.note}</p>}
              <div className="name-tree">
                {rows.map((n) => (
                  <NameRow key={`${n.kind}:${n.ref}`} n={n} canRetry={can("manager")} onRetry={load} entries={book.entries} />
                ))}
              </div>
            </div>
          </section>
        );
      })}
      {!items.length && <Empty title="No names match">Try part of a name, an address or a Hedera account.</Empty>}
    </div>
  );
}

function NameRow({ n, canRetry, onRetry, entries }: { n: EnsNameView; canRetry: boolean; onRetry: () => Promise<unknown>; entries: DirectoryEntry[] }) {
  const { path } = useApp();
  const [label, tone] = STATUS[n.status];
  const shown = n.kind === "registrar" ? { ...n, name: n.name.replace("#registrar", "") } : n;
  return (
    <div className="name-row">
      <div style={{ minWidth: 0, paddingLeft: Math.max(0, n.depth - 1) * 14 }}>
        <Name name={shown.name} status={n.status} />
        <div className="faint small">
          {n.kind === "registrar" ? "may register names in the org's registry" : (n.records.description ?? n.kind)}
          {n.hedera ? ` · ${n.hedera}` : ""}
        </div>
        {n.error && <div className="field-e small">{n.error}</div>}
      </div>
      <span className={`tag ${tone}`}>{label}</span>
      <span className="r small">
        {n.txUrl && (
          <a href={n.txUrl} target="_blank" rel="noreferrer">
            tx
          </a>
        )}{" "}
        {n.kind !== "registrar" && n.kind !== "collection" && n.kind !== "org" && (
          <button type="button" className="link" onClick={() => go(routeFor(n, entries))}>
            open
          </button>
        )}
        {n.status === "failed" && canRetry && (
          <Action
            className="btn sm"
            onClick={async () => {
              await api.post(path(`/names/${n.kind}/${encodeURIComponent(n.ref)}/retry`));
              await onRetry();
            }}
          >
            Retry
          </Action>
        )}
      </span>
    </div>
  );
}

/** `/#/name/<ens>`: opens what a name stands for in this org, or says what it resolves to. */
export function NameOpener({ name }: { name: string }) {
  const { book, path } = useApp();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const e = book.entries.find((x) => x.name === name.toLowerCase());
    if (e) {
      go(routeFor(e, book.entries));
      return;
    }
    api
      .get<{ name: string | null; address: string | null; hedera: string | null }>(path(`/names/resolve?q=${encodeURIComponent(name)}`))
      .then((r) => setMsg(`${r.name ?? name} is not in this org. It resolves to ${[r.address, r.hedera].filter(Boolean).join(" and ") || "nothing"}.`))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)));
  }, [name, book, path]);
  return msg ? <Empty title={name}>{msg}</Empty> : <Loading text={`Opening ${name}…`} />;
}
