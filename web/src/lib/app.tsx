import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import type { AccessLevel, DecisionView, Directory, InboxItemView, Me, Meta, MyAccess, Role, RunView, Site, Status, Team, TypedSignature } from "../types";
import { nameBook, type NameBook } from "./names";
import type { AssetView } from "../types";

export interface Live {
  now: string;
  assets: AssetView[];
  runs: RunView[];
  inbox: InboxItemView[];
  decisions: DecisionView[];
  headSeq: number;
  access: MyAccess;
  counts: { approvals: number; validation: number; workOrders: number; autonomy: number; cases?: number };
}

/** The same role, or a manager: a manager holds every right in the org. */
export const canAct = (roles: Role[], required: Role) => roles.some((r) => r === required || r === "manager");

interface Ctx {
  me: Me;
  setMe: (m: Me) => void;
  site: Site;
  siteId: string;
  meta: Meta;
  status: Status;
  live: Live | null;
  team: Team | null;
  /** address → what to call them: their ENS name, else their display name, else a short address */
  names: Map<string, string>;
  /** every entity of the org by its ENS name */
  book: NameBook;
  reloadNames: () => Promise<void>;
  roles: Role[];
  can: (r: Role) => boolean;
  /** what this member may see: a level 1–4 and a line/stage scope (a manager: 4, everything) */
  access: MyAccess;
  sees: (level: AccessLevel) => boolean;
  refresh: () => Promise<void>;
  reloadSite: () => Promise<void>;
  path: (p: string) => string;
}
const AppCtx = createContext<Ctx | null>(null);
/** The app context when inside a site, else null (public pages: the passport, open pipelines). */
export const useAppMaybe = () => useContext(AppCtx);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("outside app");
  return c;
};

export function AppProvider(props: { me: Me; setMe: (m: Me) => void; siteId: string; meta: Meta; status: Status; children: ReactNode }) {
  const [site, setSite] = useState<Site | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [dir, setDir] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/v1/sites/${props.siteId}`;
  const busy = useRef(false);

  const reloadSite = useCallback(async () => {
    const [s, t] = await Promise.all([api.get<Site>(base), api.get<Team>(`${base}/team`)]);
    setSite(s);
    setTeam(t);
  }, [base]);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setLive(await api.get<Live>(`${base}/live`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.reload();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [base]);

  const reloadNames = useCallback(async () => {
    setDir(await api.get<Directory>(`${base}/directory`).catch(() => null));
  }, [base]);

  useEffect(() => {
    void reloadSite().catch((e) => setError(String(e)));
    void refresh();
    void reloadNames();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 5000);
    // names settle on-chain in batches: their status is worth a slower poll
    const n = setInterval(() => document.visibilityState === "visible" && void reloadNames(), 30_000);
    return () => {
      clearInterval(t);
      clearInterval(n);
    };
  }, [reloadSite, refresh, reloadNames]);

  // stable across the 5 s live poll, so pages that load on [path] don't refetch and reset their state
  const path = useCallback((p: string) => `${base}${p}`, [base]);
  const assets = live?.assets;
  const book = useMemo(() => nameBook(dir, assets ?? []), [dir, assets]);
  const names = useMemo(() => {
    const m = new Map<string, string>(book.entries.filter((e) => e.address).map((e) => [e.address!.toLowerCase(), e.name]));
    for (const x of team?.members ?? []) m.set(x.address, book.byAddress(x.address)?.name ?? x.ens ?? x.name ?? `${x.address.slice(0, 6)}…${x.address.slice(-4)}`);
    return m;
  }, [team, book]);
  const roles = site?.myRoles;
  const can = useCallback((r: Role) => canAct(roles ?? [], r), [roles]);
  // the live poll carries the current access, so a change by a manager shows within seconds
  const access = live?.access ?? site?.myAccess;
  const sees = useCallback((l: AccessLevel) => (access?.level ?? 1) >= l, [access]);
  const value = useMemo(
    () => (site && roles && access ? { me: props.me, setMe: props.setMe, site, siteId: props.siteId, meta: props.meta, status: props.status, live, team, names, book, reloadNames, roles, can, access, sees, refresh, reloadSite, path } : null),
    [props.me, props.setMe, site, props.siteId, props.meta, props.status, live, team, names, book, reloadNames, roles, can, access, sees, refresh, reloadSite, path],
  );

  if (!value) return <div className="boot">{error ?? "Loading site…"}</div>;
  return (
    <AppCtx.Provider value={value}>
      {props.children}
    </AppCtx.Provider>
  );
}

export type { TypedSignature };
