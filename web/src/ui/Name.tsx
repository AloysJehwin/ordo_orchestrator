import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "../api";
import { useApp, useAppMaybe } from "../lib/app";
import { actorLabel, shortAddr } from "../lib/format";
import { ensAppUrl, isEnsName, splitName } from "../lib/names";
import type { NameKind, NameStatus, ResolvedName } from "../types";
import { useToast } from "./kit";

/**
 * An ENS name, in full: the first label strong, the rest plain, the root muted, breakable at each dot so long names
 * wrap. Click to copy; the arrow opens it in the ENS app. A dot marks a name not on-chain yet, or one that failed.
 */
export function Name({ name, status, link = true, title }: { name: string; status?: NameStatus | null; link?: boolean; title?: string }) {
  // on public pages there is no org context: the root is then the last two labels (ordo.eth)
  const root0 = useAppMaybe()?.book.root ?? name.split(".").slice(-2).join(".");
  const toast = useToast();
  const { head, mid, root } = splitName(name, root0);
  const parts = mid.split(/(?=\.)/);
  return (
    <span className={`ens${status === "failed" ? " ens-failed" : status && status !== "issued" ? " ens-pending" : ""}`} title={title ?? name}>
      <button
        type="button"
        className="ens-copy"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(name).then(() => toast(`Copied ${name}`));
        }}
        aria-label={`Copy ${name}`}
      >
        <b>{head}</b>
        {parts.map((p, i) => (
          <span key={i}>
            <wbr />
            {p}
          </span>
        ))}
        {root && (
          <span className="ens-root">
            <wbr />
            {root}
          </span>
        )}
      </button>
      {status && status !== "issued" && <span className={`ens-dot ${status === "failed" ? "bad" : "warn"}`} aria-label={status === "failed" ? "failed to register" : "registering on-chain"} />}
      {link && (
        <a className="ens-link" href={ensAppUrl(name)} target="_blank" rel="noreferrer" aria-label={`Open ${name} in the ENS app`} onClick={(e) => e.stopPropagation()}>
          <ExternalLink size={11} aria-hidden />
        </a>
      )}
    </span>
  );
}

/** A wallet address or Hedera account, by the name Ordo knows it by; else as it is (shortened). */
export function Who({ address, hedera, fallback, link }: { address?: string | null; hedera?: string | null; fallback?: ReactNode; link?: boolean }) {
  const { book, names } = useApp();
  const e = book.byAddress(address) ?? book.byHedera(hedera);
  if (e) return <Name name={e.name} status={e.status} link={link} />;
  const plain = address ? (names.get(address.toLowerCase()) ?? null) : null;
  if (plain && !plain.includes("…")) return <span>{plain}</span>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (address) return <span className="mono" title={address}>{shortAddr(address)}</span>;
  if (hedera) return <span className="mono">{hedera}</span>;
  return <>—</>;
}

/** An entity by its name (a run, stage, work order, budget, machine…), or `fallback` when it has none yet. */
export function Ref({ kind, id, fallback, link }: { kind: NameKind; id: string | null | undefined; fallback?: ReactNode; link?: boolean }) {
  const { book } = useApp();
  const e = book.of(kind, id);
  if (e) return <Name name={e.name} status={e.status} link={link} />;
  return <>{fallback ?? (id ? <span className="mono">{id}</span> : "—")}</>;
}

/** Who did something in the record ("user:0x…", "agent:maintenance", "system:treasury", "machine:CNC-07"), by name. */
export function Actor({ actor, link = false }: { actor: string; link?: boolean }) {
  const { book, names } = useApp();
  const n = book.actor(actor);
  return n ? <Name name={n} link={link} /> : <>{actorLabel(actor, names)}</>;
}

/**
 * A field for an address that also takes a name: priya.acme.ordo.eth, a 0x address or a Hedera account. Shows what a
 * name resolves to as it is typed; the server resolves it again on submit.
 */
export function NameInput({
  value,
  onChange,
  accept = "any",
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  accept?: "evm" | "hedera" | "any";
  placeholder?: string;
  id?: string;
}) {
  const { path } = useApp();
  const [r, setR] = useState<{ ok: ResolvedName | null; error: string | null }>({ ok: null, error: null });
  const q = value.trim();
  useEffect(() => {
    setR({ ok: null, error: null });
    if (q.length < 3) return;
    const t = setTimeout(() => {
      api
        .get<ResolvedName>(path(`/names/resolve?q=${encodeURIComponent(q)}`))
        .then((ok) => setR({ ok, error: null }))
        .catch((e: unknown) => setR({ ok: null, error: isEnsName(q) ? (e instanceof Error ? e.message : String(e)) : null }));
    }, 350);
    return () => clearTimeout(t);
  }, [q, path]);
  const hint = (() => {
    if (r.error) return <span className="field-e">{r.error}</span>;
    const x = r.ok;
    if (!x) return null;
    const target = accept === "hedera" ? x.hedera : accept === "evm" ? x.address : (x.hedera ?? x.address);
    if (x.source === "address" || x.source === "account") return x.name ? <>Known as <Name name={x.name} link={false} /></> : null;
    if (!target) return <span className="field-e">{x.name} has no {accept === "hedera" ? "Hedera account" : accept === "evm" ? "EVM address" : "address"}</span>;
    return (
      <>
        → <span className="mono">{target}</span>
        {x.source === "ens" ? " (via ENS)" : ""}
      </>
    );
  })();
  return (
    <div className="name-input">
      <input
        id={id}
        className="mono"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={placeholder ?? (accept === "hedera" ? "name.acme.ordo.eth or 0.0.1234" : accept === "evm" ? "name.acme.ordo.eth or 0x…" : "a name, a 0x address or 0.0.1234")}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <div className="small muted name-hint">{hint}</div>}
    </div>
  );
}
