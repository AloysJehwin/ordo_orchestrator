import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsUpDown, Hexagon, MoreHorizontal } from "lucide-react";
import { api } from "./api";
import { useApp } from "./lib/app";
import { LEVEL_LABEL, shortAddr } from "./lib/format";
import { go, href, useRoute } from "./lib/router";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { Action, Field, Icon, Menu, Modal, useToast } from "./ui/kit";
import { useDismiss } from "./ui/hooks";
import { Approvals } from "./pages/Approvals";
import { Builder } from "./pages/Builder";
import { Finance } from "./pages/Finance";
import { Floor } from "./pages/Floor";
import { FleetModal } from "./pages/floor/Bodies";
import { History } from "./pages/History";
import { Pipelines } from "./pages/Pipelines";
import { Proof } from "./pages/Proof";
import { Settings } from "./pages/Settings";
import { TeamPage } from "./pages/Team";
import { Templates } from "./pages/Templates";
import { Validation } from "./pages/Validation";
import { WorkOrders } from "./pages/WorkOrders";
import { PowPage, PowSign } from "./pages/Pow";
import { Cases } from "./pages/Cases";
import { Rewards } from "./pages/Rewards";
import { NameOpener } from "./pages/Names";
import { HandlePicker } from "./ui/HandlePicker";
import { useRegisterOrg } from "./pages/Stakes";
import type { AccessLevel, ChainStatus, Role } from "./types";

type Count = "approvals" | "validation" | "workOrders" | "autonomy" | "cases";
/**
 * `level` is the visibility level the page needs (the API refuses below it); `manager` pages are for managers only;
 * `roles` pages are for people holding one of those roles (and managers).
 */
type NavItem = { page: string; label: string; short?: string; icon: string; count?: Count; level?: AccessLevel; manager?: boolean; roles?: Role[] };
const NAV: NavItem[] = [
  { page: "pipelines", label: "Pipelines", icon: "pipelines" },
  { page: "validation", label: "Validation", icon: "validation", count: "validation", level: 3 },
  { page: "templates", label: "Templates", icon: "templates" },
  { page: "pow", label: "Proof of work", short: "My work", icon: "pow", level: 2 },
  { page: "cases", label: "Cases", icon: "cases", count: "cases", roles: ["tester", "validator"] },
  { page: "rewards", label: "Rewards", icon: "rewards" },
  { page: "history", label: "Run history", short: "History", icon: "history" },
  { page: "floor", label: "Floor & fleet", short: "Floor", icon: "floor", level: 2 },
  { page: "approvals", label: "Approvals", icon: "approvals", count: "approvals", manager: true },
  { page: "work-orders", label: "Work orders", icon: "workorders", count: "workOrders", level: 4 },
  { page: "finance", label: "Finance", icon: "finance", level: 4 },
  { page: "builder", label: "Builder", icon: "builder", manager: true },
];
const ADMIN_NAV: NavItem[] = [
  { page: "team", label: "Team", icon: "team" },
  { page: "proof", label: "Proof & ledger", short: "Proof", icon: "proof", level: 4 },
  { page: "settings", label: "Settings", icon: "settings", count: "autonomy", manager: true },
];
// the phone tab bar holds the first four of these that the person can open; the rest live under More
const PRIMARY = ["pipelines", "floor", "validation", "approvals", "pow", "cases", "history", "team", "templates"];

/** A route that moved: go to where it lives now. */
function GoTo({ path }: { path: string }) {
  useEffect(() => go(path), [path]);
  return null;
}

function Clock({ tz }: { tz: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return <>{now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: tz })} local</>;
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <a className="brand" href="#/pipelines" aria-label="Ordo">
      <span className="brand-mark" aria-hidden>
        <Hexagon size={16} strokeWidth={1.8} />
      </span>
      <span className="brand-text">
        <b>Ordo</b>
        {!compact && <span>Line console</span>}
      </span>
    </a>
  );
}

export function Shell({ onSignOut, onSwitchAccount, onSwitchSite }: { onSignOut: () => void; onSwitchAccount: () => void; onSwitchSite: (id: string) => void }) {
  const { site, live, me, setMe, can, sees, roles, book } = useApp();
  const route = useRoute();
  const toast = useToast();
  const [rename, setRename] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [handleOk, setHandleOk] = useState(true);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  useDismiss(more, [moreRef, moreBtn], () => setMore(false));
  useEffect(() => setMore(false), [route.page, route.id]);
  const line = site.lines[0];
  const agentsWithAssets = new Set((live?.assets ?? []).map((a) => a.owningAgent)).size;
  const user = me.user!;
  // what this person is called here: their ENS name at this org, else their display name
  const myName = book.byAddress(user.address)?.name ?? user.ens;
  const display = myName ?? user.displayName ?? shortAddr(user.address);
  const open = (n: NavItem) => (n.manager ? can("manager") : n.roles ? n.roles.some(can) && sees(n.level ?? 1) : sees(n.level ?? 1));
  const nav = NAV.filter(open);
  const adminNav = ADMIN_NAV.filter(open);
  const all = [...nav, ...adminNav];
  const count = (n: NavItem) => (n.count && live ? (live.counts[n.count] ?? 0) : 0);
  const isActive = (n: NavItem) => route.page === n.page || (n.page === "pipelines" && !all.some((x) => x.page === route.page));

  let page: ReactNode;
  const target = [...NAV, ...ADMIN_NAV].find((n) => n.page === route.page);
  switch (target && !open(target) ? "" : route.page) {
    case "validation":
      page = <Validation />;
      break;
    case "templates":
      page = <Templates />;
      break;
    case "history":
      page = <History />;
      break;
    case "floor":
      page = <Floor />;
      break;
    case "approvals":
      page = <Approvals />;
      break;
    case "builder":
      page = <Builder />;
      break;
    case "team":
      page = <TeamPage />;
      break;
    case "proof":
      page = <Proof />;
      break;
    case "settings":
      page = <Settings />;
      break;
    case "work-orders":
      page = <WorkOrders />;
      break;
    case "finance":
      page = <Finance />;
      break;
    case "cases":
      page = <Cases />;
      break;
    case "rewards":
      page = <Rewards />;
      break;
    case "names":
      // names live on the Team page now
      page = <GoTo path={`team?tab=names${route.query.get("q") ? `&q=${encodeURIComponent(route.query.get("q")!)}` : ""}`} />;
      break;
    case "name":
      page = route.id ? <NameOpener name={route.id} /> : <GoTo path="team?tab=names" />;
      break;
    case "pow":
      page = route.id && route.sub === "sign" ? <PowSign id={route.id} /> : <PowPage />;
      break;
    default:
      page = <Pipelines />;
  }
  const navItem = (n: NavItem) => {
    const c = count(n);
    return (
      <a key={n.page} href={href(n.page)} className={isActive(n) ? "active" : ""} aria-current={isActive(n) ? "page" : undefined}>
        <Icon name={n.icon} />
        <span className="grow">{n.label}</span>
        {c > 0 && <span className="count num">{c}</span>}
      </a>
    );
  };
  const avatar = (
    <span className="avatar" style={{ background: `hsl(${parseInt(user.address.slice(2, 8), 16) % 360} 40% 86%)` }}>
      {user.displayName || user.ens ? display.slice(0, 1).toUpperCase() : ""}
    </span>
  );
  const accountItems = [
    { label: "Set display name", onClick: () => setRename(user.displayName ?? "") },
    { label: user.handle ? `Change handle (${user.handle})` : "Choose a handle", onClick: () => setHandle(user.handle ?? "") },
    ...me.memberships.filter((m) => m.siteId !== site.id).map((m) => ({ label: `Switch to ${m.siteName}`, onClick: () => onSwitchSite(m.siteId) })),
    { label: "Switch account", onClick: onSwitchAccount },
    { label: "Sign out", onClick: onSignOut, danger: true },
  ];
  const siteInfo = (
    <div className="site-info">
      <div>
        <div className="label">Site</div>
        <div className="site-name">
          {site.name}
          {line ? ` · ${line.name}` : ""}
        </div>
        <div className="small muted">
          <Clock tz={site.timezone} />
        </div>
      </div>
      {line && (
        <div>
          <div className="label">Autonomy</div>
          <div className="site-name">
            {line.autonomy} · {LEVEL_LABEL[line.autonomy]}
          </div>
          <div className="small muted">
            {agentsWithAssets} agents with assets · <span className="num">{live?.assets.length ?? 0}</span> assets
          </div>
        </div>
      )}
    </div>
  );
  const primaryPages = PRIMARY.filter((p) => all.some((n) => n.page === p)).slice(0, 4);
  const primary = primaryPages.map((p) => all.find((n) => n.page === p)!);
  const secondary = all.filter((n) => !primaryPages.includes(n.page));
  const inSecondary = secondary.some(isActive);
  const secondaryCount = secondary.reduce((a, n) => a + count(n), 0);
  return (
    <div className="shell">
      <aside className="side">
        <div className="side-card">
          <Brand />
          <nav className="nav" aria-label="Main">
            {nav.map(navItem)}
            <div className="nav-sep" />
            {adminNav.map(navItem)}
          </nav>
          <div className="foot">
            {siteInfo}
            <Menu
              align="left"
              title="Account"
              trigger={(_o, toggle) => (
                <button type="button" className="user-chip" onClick={toggle}>
                  {avatar}
                  <span className="user-text">
                    <span>{display}</span>
                    <span className="faint small">{site.myRoles.map((r) => r.replaceAll("_", " ")).join(", ")}</span>
                  </span>
                  <ChevronsUpDown size={14} className="faint" aria-hidden />
                </button>
              )}
              items={accountItems}
            />
          </div>
        </div>
      </aside>
      <header className="topbar">
        <Brand compact />
        <span className="topbar-site">{site.name}</span>
        <Menu
          title={display}
          trigger={(_o, toggle) => (
            <button type="button" className="user-chip compact" onClick={toggle} aria-label="Account">
              {avatar}
            </button>
          )}
          items={accountItems}
        />
      </header>
      <main className="main">
        <div className="content">
          <ErrorBoundary key={`${route.page}/${route.id ?? ""}/${route.sub ?? ""}`}>{page}</ErrorBoundary>
        </div>
      </main>
      {more && (
        <div className="more-panel" ref={moreRef} role="dialog" aria-label="More pages">
          <nav className="nav" aria-label="More">
            {secondary.map(navItem)}
          </nav>
          {siteInfo}
        </div>
      )}
      <nav className="tabbar" aria-label="Main">
        {primary.map((n) => (
          <a key={n.page} href={href(n.page)} className={isActive(n) && !more ? "on" : ""} aria-current={isActive(n) ? "page" : undefined}>
            <span className="tab-ico">
              <Icon name={n.icon} size={19} />
              {count(n) > 0 && <span className="tab-dot" aria-label={`${count(n)} waiting`} />}
            </span>
            <span className="tab-l">{n.short ?? n.label}</span>
          </a>
        ))}
        <button type="button" ref={moreBtn} className={inSecondary || more ? "on" : ""} aria-expanded={more} onClick={() => setMore(!more)}>
          <span className="tab-ico">
            <MoreHorizontal size={19} aria-hidden />
            {secondaryCount > 0 && <span className="tab-dot" aria-label={`${secondaryCount} waiting`} />}
          </span>
          <span className="tab-l">More</span>
        </button>
      </nav>
      {route.query.get("register") === "1" && can("manager") && <RegisterPrompt />}
      {route.query.get("machines") === "1" && route.query.get("register") !== "1" && can("manager") && <MachinesPrompt />}
      <Modal
        open={rename !== null}
        onClose={() => setRename(null)}
        title="Display name"
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setRename(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!rename?.trim()}
              onClick={async () => {
                try {
                  setMe(await api.patch("/v1/me", { displayName: rename }));
                  setRename(null);
                  toast("Name saved", "ok");
                } catch (e) {
                  toast(String(e instanceof Error ? e.message : e), "bad");
                }
              }}
            >
              Save
            </button>
          </div>
        }
      >
        <Field label="Shown to your team beside your ENS name" hint="Your wallet address stays the identity behind every signature. Your display name never goes on-chain.">
          <input className="input" value={rename ?? ""} onChange={(e) => setRename(e.target.value)} maxLength={60} />
        </Field>
      </Modal>
      <Modal
        open={handle !== null}
        onClose={() => setHandle(null)}
        title="Your handle"
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setHandle(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!handle?.trim() || !handleOk || handle === user.handle}
              onClick={async () => {
                try {
                  setMe(await api.patch("/v1/me", { handle }));
                  setHandle(null);
                  toast("Handle saved: your names are being reissued", "ok");
                } catch (e) {
                  toast(String(e instanceof Error ? e.message : e), "bad");
                }
              }}
            >
              Save
            </button>
          </div>
        }
      >
        <p className="small muted">Your handle is the first label of your ENS names in every org you belong to. Changing it revokes your old names and issues new ones.</p>
        <HandlePicker value={handle ?? ""} onChange={setHandle} onValid={setHandleOk} org={book.org} suggestion={user.handleSuggestion} />
      </Modal>
    </div>
  );
}

/** Right after a manager creates an org (after its registration): one signature creates the machines its templates need. */
function MachinesPrompt() {
  const route = useRoute();
  const close = () => {
    const q = new URLSearchParams(route.query);
    q.delete("machines");
    window.location.hash = `#/${route.page}${q.size ? `?${q}` : ""}`;
  };
  return <FleetModal first onClose={close} />;
}

/** Right after a manager creates an org: sign its registration in OrdoTrust, so credentials and stakes can follow. Settings keeps a retry. */
function RegisterPrompt() {
  const { path, site, status } = useApp();
  const route = useRoute();
  const register = useRegisterOrg();
  // undefined while loading; null when the chain status cannot be read
  const [chain, setChain] = useState<ChainStatus | null | undefined>(undefined);
  useEffect(() => {
    void api.get<ChainStatus>(path("/chain")).then(setChain).catch(() => setChain(null));
  }, [path]);
  const close = () => {
    const q = new URLSearchParams(route.query);
    q.delete("register");
    window.location.hash = `#/${route.page}${q.size ? `?${q}` : ""}`;
  };
  const needed = Boolean(chain?.configured && !chain.registered);
  // nothing to register: move on (to the machines step, when it is next)
  useEffect(() => {
    if (chain !== undefined && !needed) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, needed]);
  if (!needed) return null;
  return (
    <Modal
      open
      onClose={close}
      eyebrow="On-chain"
      title={`Register ${site.name} in OrdoTrust`}
      footer={
        <div className="btns end">
          <button type="button" className="btn" onClick={close}>
            Later
          </button>
          <Action className="btn primary" onClick={async () => (await register()) && close()}>
            Sign registration
          </Action>
        </div>
      }
    >
      <p>
        OrdoTrust on {status.trust?.name ?? "the chain"} keeps this org's credentials and stakes. Registering makes you its first manager there, so the validators and testers you appoint can stake and sign.
      </p>
      <p className="muted small">One signature from your wallet; Ordo relays it and pays the gas. You can do it later from Settings.</p>
    </Modal>
  );
}
