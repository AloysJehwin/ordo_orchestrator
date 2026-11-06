import { useEffect, useState } from "react";
import { api } from "../api";
import { shortAddr } from "../lib/format";
import type { Me } from "../types";
import { Field } from "../ui/kit";
import { HandlePicker } from "../ui/HandlePicker";
import { OrgExplorer } from "./Explore";
import { Select } from "../ui/Select";

const zonesAll = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "Asia/Kolkata", "Europe/Berlin", "America/New_York"];
  }
})();

/** an org's ENS label, as the server makes it from its name (Pune Plant 1 → pune-plant-1) */
const orgLabel = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "your-org";

export function Setup({
  me,
  ensRoot,
  onCreated,
  onJoined,
  onSignOut,
  onSwitchAccount,
}: {
  me: Me;
  ensRoot?: string | null;
  onCreated: (id: string) => void;
  onJoined: (id: string) => void;
  onSignOut: () => void;
  onSwitchAccount: () => void;
}) {
  const [joining, setJoining] = useState(() => window.location.hash.startsWith("#/join"));
  useEffect(() => {
    const f = () => setJoining(window.location.hash.startsWith("#/join"));
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const [name, setName] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [line, setLine] = useState("Line 1");
  const [zones, setZones] = useState<string[]>(["Machining", "Assembly", "Quality & packing"]);
  const [zoneInput, setZoneInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [handle, setHandle] = useState("");
  const [handleOk, setHandleOk] = useState(true);
  const addr = me.user!.address;
  const needsHandle = !me.user!.handle && Boolean(ensRoot);

  if (!me.canCreateSite || joining) return <JoinSite me={me} ensRoot={ensRoot ?? null} onJoined={onJoined} onSignOut={onSignOut} onSwitchAccount={onSwitchAccount} canCreate={me.canCreateSite} />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string }>("/v1/sites", { name: name.trim(), timezone: tz, lineName: line.trim(), zones, ...(needsHandle && handle.trim() ? { handle: handle.trim() } : {}) });
      onCreated(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const addZone = () => {
    const z = zoneInput.trim();
    if (z && !zones.includes(z)) setZones([...zones, z]);
    setZoneInput("");
  };
  return (
    <div className="auth">
      <div className="auth-card wide">
        <div className="eyebrow">Set up · signed in as {shortAddr(addr)}</div>
        <h1>Create your org</h1>
        <p className="muted">An org is one plant or lab. You become its manager, with every right. Anyone can join it as a contributor, and you make people validators or testers. With OrdoTrust configured you sign its on-chain registration next. Nothing is pre-filled with sample data.</p>
        <div className="form-grid">
          <Field label="Org name" hint={ensRoot ? <>Its ENS name: <span className="mono">{orgLabel(name)}.{ensRoot}</span></> : undefined}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pune Plant 1" autoFocus />
          </Field>
          {needsHandle && <HandlePicker value={handle} onChange={setHandle} onValid={setHandleOk} org={`${orgLabel(name)}.${ensRoot}`} suggestion={me.user!.handleSuggestion} />}
          <Field label="Time zone">
            <Select value={tz} onChange={setTz} options={zonesAll.map((z) => ({ value: z, label: z.replaceAll("_", " "), group: z.split("/")[0] }))} searchable />
          </Field>
          <Field label="First production line" hint="Autonomy is set per line. New lines start at L2 · Recommend.">
            <input className="input" value={line} onChange={(e) => setLine(e.target.value)} />
          </Field>
          <Field label="Zones" hint="Assets are grouped by zone on the floor view.">
            <div className="chips">
              {zones.map((z) => (
                <span key={z} className="chip">
                  {z}
                  <button type="button" aria-label={`Remove ${z}`} onClick={() => setZones(zones.filter((x) => x !== z))}>
                    ×
                  </button>
                </span>
              ))}
              <input className="chip-input" value={zoneInput} placeholder="Add zone ↵" onChange={(e) => setZoneInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addZone())} onBlur={addZone} />
            </div>
          </Field>
        </div>
        {error && <p className="field-e">{error}</p>}
        <div className="btns">
          <button type="button" className="btn accent" disabled={busy || name.trim().length < 2 || !line.trim() || !handleOk} onClick={submit}>
            Create org
          </button>
          <a className="btn" href="#/join">
            Join an existing org instead
          </a>
          <button type="button" className="btn" onClick={onSwitchAccount}>
            Switch account
          </button>
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/** A wallet with no org yet joins an open one as a contributor, or one that invited it. */
function JoinSite({ me, ensRoot, onJoined, onSignOut, onSwitchAccount, canCreate }: { me: Me; ensRoot: string | null; onJoined: (id: string) => void; onSignOut: () => void; onSwitchAccount: () => void; canCreate: boolean }) {
  const addr = me.user!.address;
  const [handle, setHandle] = useState("");
  const needsHandle = !me.user!.handle && Boolean(ensRoot);
  return (
    <div className="auth">
      <div className="auth-card wide">
        <div className="eyebrow">Join an org · signed in as {shortAddr(addr)}</div>
        <h1>Join an org</h1>
        <p className="muted">
          You join as a contributor: you follow the running pipelines and submit proof of your work on their stages. A manager can make you a validator or tester later. You can also{" "}
          <a href="#/open">browse the running pipelines</a> first.
        </p>
        {needsHandle && <HandlePicker value={handle} onChange={setHandle} org={`the-org.${ensRoot}`} suggestion={me.user!.handleSuggestion} label="Your handle in the orgs you join" />}
        <OrgExplorer signedIn onOpen={onJoined} handle={needsHandle ? handle : undefined} />
        <div className="btns">
          {canCreate && (
            <a className="btn" href="#/">
              Create an org instead
            </a>
          )}
          <button type="button" className="btn" onClick={onSwitchAccount}>
            Switch account
          </button>
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
        <p className="faint small">
          Your wallet address, for a manager inviting you to a closed org: <span className="mono">{addr}</span>
        </p>
      </div>
    </div>
  );
}
