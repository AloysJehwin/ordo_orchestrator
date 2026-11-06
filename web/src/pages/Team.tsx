import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, shortAddr } from "../lib/format";
import { useRoute } from "../lib/router";
import { useSign } from "../lib/sign";
import type { AccessLevel, AccessScope, Role, Team, TypedSignature } from "../types";
import { Action, Empty, Field, Menu, Modal, Tabs, useToast } from "../ui/kit";
import { Name, NameInput, Who } from "../ui/Name";
import { Select } from "../ui/Select";
import { Names } from "./Names";
import { Stakes, Vendors } from "./Stakes";

type Member = Team["members"][number];
const PROMOTABLE: Role[] = ["validator", "tester", "manager"];
const ROLE_TONE: Record<Role, string> = { manager: "accent", validator: "ok", tester: "warn", contributor: "" };

const scopeText = (s: AccessScope, lineName: (id: string) => string) => {
  if (!s.lines && !s.stages) return "All lines and stages";
  const parts = [s.lines ? `Lines: ${s.lines.map(lineName).join(", ") || "none"}` : "All lines", s.stages ? `Stages: ${s.stages.join(", ") || "none"}` : "all stages"];
  return parts.join(" · ");
};

/** A level and a scope: what a role, or one person, may see. */
function AccessEditor(props: { level: AccessLevel; scope: AccessScope; onChange: (level: AccessLevel, scope: AccessScope) => void }) {
  const { meta, site } = useApp();
  const [stages, setStages] = useState(props.scope.stages?.join(", ") ?? "");
  const lines = props.scope.lines;
  const toggleLine = (id: string) => {
    const cur = lines ?? site.lines.map((l) => l.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    props.onChange(props.level, { ...props.scope, lines: next.length === site.lines.length ? null : next });
  };
  return (
    <div className="stack">
      <Field label="Level">
        <Select<string>
          value={String(props.level)}
          onChange={(v) => props.onChange(Number(v) as AccessLevel, props.scope)}
          options={meta.levels.map((l) => ({ value: String(l.level), label: `${l.level} · ${l.label}` }))}
        />
      </Field>
      {site.lines.length > 1 && (
        <Field label="Lines" hint="Runs on other lines are hidden.">
          <div className="chips">
            {site.lines.map((l) => {
              const on = !lines || lines.includes(l.id);
              return (
                <button key={l.id} type="button" className={`chip-btn${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggleLine(l.id)}>
                  {l.name}
                </button>
              );
            })}
          </div>
        </Field>
      )}
      <Field label="Stages" hint="Stage codes such as 10, 20, 30a. Leave empty for every stage; other stages show their state only.">
        <input
          className="input mono"
          value={stages}
          placeholder="All stages"
          onChange={(e) => setStages(e.target.value)}
          onBlur={() => {
            const codes = stages
              .split(/[\s,]+/)
              .map((x) => x.trim())
              .filter((x) => /^\d{2}[a-z]?$/.test(x));
            props.onChange(props.level, { ...props.scope, stages: codes.length ? [...new Set(codes)] : null });
          }}
        />
      </Field>
    </div>
  );
}

function Members() {
  const { team, meta, can, path, reloadSite, me, site, status, book } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [invite, setInvite] = useState(false);
  const [addr, setAddr] = useState("");
  const [accessFor, setAccessFor] = useState<Member | null>(null);
  const manager = can("manager");
  const label = (r: Role) => meta.roles.find((x) => x.key === r)?.label ?? r;
  const lineName = (id: string) => site.lines.find((l) => l.id === id)?.name ?? id;
  // an address, or a name the server resolves to one (priya.acme.ordo.eth)
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim()) || /^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(addr.trim());
  const who = (m: Member) => book.byAddress(m.address)?.name ?? m.ens ?? m.name ?? shortAddr(m.address);

  const change = async (m: Member, role: Role, grant: boolean) => {
    const r = await sign<{ chain: { status: string; error: string | null } | null; reissue?: string[] }>({
      title: `${grant ? "Make" : "Remove"} ${who(m)} ${grant ? "a" : "as"} ${label(role)}`,
      request: (chainId) => api.post<TypedSignature>(path(`/team/members/${m.userId}/roles/sign-request`), { role, grant, chainId }),
      submit: (proof) => api.post(path(`/team/members/${m.userId}/roles`), { role, grant, comment: "", ...proof }),
    });
    if (!r) return;
    if (r.chain?.status === "failed") toast(`Saved in Ordo; OrdoTrust refused it: ${r.chain.error ?? "retry from Stakes"}`, "bad");
    else if (r.chain?.status === "waiting_site") toast("Saved. It goes on-chain once the org is registered (Settings).", "ok");
    else toast(`${who(m)} is ${grant ? "now" : "no longer"} a ${label(role)}`, "ok");
    // OrdoTrust took the whole manager credential, validator bit included: sign that one again for someone who stays a validator
    for (const chainRole of r.reissue ?? [])
      await sign({
        title: `Keep ${who(m)}'s ${chainRole.toLowerCase()} credential on-chain`,
        request: () => api.post<TypedSignature>(path("/chain/credentials/sign-request"), { address: m.address, role: chainRole }),
        submit: (proof) => api.post(path("/chain/credentials/grant"), { address: m.address, role: chainRole, ...proof }),
        done: "Credential signed again",
      });
    await reloadSite();
  };
  const remove = async (m: Member) => {
    await api.del(path(`/team/members/${m.userId}`));
    toast(m.address === me.user!.address ? "You left the org" : `${who(m)} removed`, "ok");
    if (m.address === me.user!.address) window.location.reload();
    else await reloadSite();
  };
  const override = (m: Member) => team?.access?.members.find((x) => x.userId === m.userId) ?? null;
  const defaultOf = (r: Role) => team?.access?.roles.find((x) => x.role === r);

  return (
    <div>
      <div className="page-head">
        <div className="ph-text">
          <p className="muted lede">
            Anyone with a wallet can join {site.openJoin ? "this org" : "an open org"} as a contributor. A manager promotes people to validator, tester or manager with a signature
            {status.trust ? " that OrdoTrust checks before it gives the on-chain credential" : ""}, and decides how much each role, or each person, can see.
          </p>
        </div>
        {manager && (
          <div className="ph-actions">
            <button type="button" className="btn accent" onClick={() => setInvite(true)}>
              Add by address or name
            </button>
          </div>
        )}
      </div>
      <div className="card scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th>Person</th>
              <th>Roles</th>
              <th>Sees</th>
              <th>Last seen</th>
              {manager && <th />}
            </tr>
          </thead>
          <tbody>
            {team?.members.map((m) => {
              const own = override(m);
              const isMgr = m.roles.includes("manager");
              const lvl = isMgr ? 4 : own ? own.level : Math.max(...m.roles.map((r) => defaultOf(r)?.level ?? meta.roles.find((x) => x.key === r)?.defaultLevel ?? 1));
              return (
                <tr key={m.userId}>
                  <td>
                    <b>
                      <Who address={m.address} fallback={m.name ?? shortAddr(m.address)} />
                    </b>
                    {m.address === me.user!.address && <span className="tag accent">you</span>}
                    {m.name && <div className="small muted">{m.name}</div>}
                    <div className="faint small mono">{m.address}</div>
                    {(m.roleNames ?? []).length > 0 && (
                      <div className="small" title="Holding the name is holding the role">
                        {m.roleNames!.map((rn) => (
                          <div key={rn.name}>
                            <Name name={rn.name} status={rn.status} />
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="chips">
                      {m.roles.map((r) => {
                        const relay = team.relays[`${m.userId}:${r}`];
                        return (
                          <span key={r} className={`tag ${ROLE_TONE[r]}`} title={relay?.error ?? undefined}>
                            {label(r)}
                            {relay && relay.status !== "done" && <span className="faint small"> · {relay.status === "waiting_site" ? "waits for registration" : relay.status}</span>}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="small">
                    {manager || m.address === me.user!.address ? (
                      <>
                        <span className="num">{lvl}</span> · {meta.levels.find((l) => l.level === lvl)?.label}
                        {own && <span className="tag">custom</span>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="faint">{ago(m.lastSeenAt)}</td>
                  {manager && (
                    <td className="r">
                      <Menu
                        title={who(m)}
                        trigger={(open, toggle) => (
                          <button type="button" className="btn sm" aria-expanded={open} aria-label={`Change ${who(m)}`} onClick={toggle}>
                            Change
                          </button>
                        )}
                        items={[
                          ...PROMOTABLE.filter((r) => !m.roles.includes(r)).map((r) => ({ label: `Make ${label(r).toLowerCase()}`, onClick: () => void change(m, r, true) })),
                          ...PROMOTABLE.filter((r) => m.roles.includes(r)).map((r) => ({ label: `Remove ${label(r).toLowerCase()} role`, onClick: () => void change(m, r, false), danger: true })),
                          ...(isMgr ? [] : [{ label: "Set what they see", onClick: () => setAccessFor(m) }]),
                          ...(m.roles.every((r) => r === "contributor") && m.address !== me.user!.address ? [{ label: "Remove from org", onClick: () => void remove(m), danger: true }] : []),
                        ]}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!manager && (
        <div className="btns">
          <Action className="btn sm danger" onClick={() => remove(team!.members.find((m) => m.address === me.user!.address)!)} disabled={!team?.members.some((m) => m.address === me.user!.address && m.roles.every((r) => r === "contributor"))}>
            Leave this org
          </Action>
        </div>
      )}
      {manager && team && team.invites.length > 0 && (
        <section className="section">
          <div className="section-h">
            <h2>Waiting to sign in</h2>
            <span className="muted small">They join as contributors the first time this wallet signs in</span>
          </div>
          <div className="card">
            <table className="t">
              <tbody>
                {team.invites.map((i) => (
                  <tr key={i.id}>
                    <td className="small">
                      <Who address={i.address} fallback={<span className="mono">{i.address}</span>} />
                    </td>
                    <td className="faint">{ago(i.createdAt)}</td>
                    <td className="r">
                      <Action className="btn sm" onClick={async () => (await api.del(path(`/team/invites/${i.id}`)), await reloadSite())}>
                        Cancel
                      </Action>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Modal
        open={invite}
        onClose={() => setInvite(false)}
        title="Add a person"
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setInvite(false)}>
              Cancel
            </button>
            <Action
              className="btn primary"
              disabled={!valid}
              onClick={async () => {
                const r = await api.post<{ added: boolean }>(path("/team/invites"), { address: addr.trim() });
                const shown = addr.trim().startsWith("0x") ? shortAddr(addr.trim()) : addr.trim();
                toast(r.added ? `Added ${shown} as a contributor` : `${shown} joins at first sign-in`, "ok");
                setAddr("");
                setInvite(false);
                await reloadSite();
              }}
            >
              Add as contributor
            </Action>
          </div>
        }
      >
        <Field label="Wallet address or ENS name" error={addr && !valid ? "Enter a 0x address with 40 hex characters, or a name like priya.acme.ordo.eth" : null}>
          <NameInput accept="evm" value={addr} onChange={setAddr} placeholder="0x… or priya.acme.ordo.eth" />
        </Field>
        <p className="faint small">Everyone starts as a contributor. Promote them from the list afterwards; each promotion is signed.</p>
      </Modal>
      {accessFor && team?.access && <MemberAccess member={accessFor} onClose={() => setAccessFor(null)} lineName={lineName} />}
    </div>
  );
}

function MemberAccess({ member, onClose, lineName }: { member: Member; onClose: () => void; lineName: (id: string) => string }) {
  const { team, path, reloadSite, meta } = useApp();
  const toast = useToast();
  const own = team!.access!.members.find((m) => m.userId === member.userId) ?? null;
  const base = team!.access!.roles.filter((r) => member.roles.includes(r.role)).sort((a, b) => b.level - a.level)[0];
  const [level, setLevel] = useState<AccessLevel>(own?.level ?? base?.level ?? 1);
  const [scope, setScope] = useState<AccessScope>(own?.scope ?? base?.scope ?? { lines: null, stages: null });
  const save = async (v: { level: AccessLevel; scope: AccessScope } | null) => {
    await api.put(path(`/access/members/${member.userId}`), v);
    toast(v ? "Saved" : "Back to their roles' defaults", "ok");
    await reloadSite();
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Visibility"
      title={`What ${member.ens ?? member.name ?? shortAddr(member.address)} sees`}
      footer={
        <div className="btns end">
          {own && (
            <Action className="btn" onClick={() => save(null)}>
              Use role defaults
            </Action>
          )}
          <Action className="btn primary" onClick={() => save({ level, scope })}>
            Save
          </Action>
        </div>
      }
    >
      <p className="muted small">
        Their roles give level {base?.level ?? 1} ({meta.levels.find((l) => l.level === base?.level)?.label}), {base ? scopeText(base.scope, lineName).toLowerCase() : "all lines and stages"}. A custom setting replaces that for this person only.
      </p>
      <AccessEditor
        level={level}
        scope={scope}
        onChange={(l, s) => {
          setLevel(l);
          setScope(s);
        }}
      />
    </Modal>
  );
}

/** The default visibility of each role. The manager's is fixed: a manager sees everything. */
function RoleAccess() {
  const { team, meta, path, reloadSite, site } = useApp();
  const toast = useToast();
  const [editing, setEditing] = useState<Role | null>(null);
  const [draft, setDraft] = useState<{ level: AccessLevel; scope: AccessScope } | null>(null);
  const lineName = (id: string) => site.lines.find((l) => l.id === id)?.name ?? id;
  if (!team?.access) return <Empty title="Managers only">A manager sets what each role can see.</Empty>;
  return (
    <div>
      <p className="muted lede">
        What each role sees by default. Level 1 shows stages and their status; 2 adds outcomes (counts, pass or fail); 3 adds proofs, measurements and contribution details; 4 is everything, including agents, wallets, finance and the ledger. A scope limits it to some lines or stages. Set a person's own level from Members.
      </p>
      <div className="card scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th>Role</th>
              <th>Level</th>
              <th>Scope</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {team.access.roles.map((r) => (
              <tr key={r.role}>
                <td>
                  <b>{meta.roles.find((x) => x.key === r.role)?.label}</b>
                  <div className="faint small">{meta.roles.find((x) => x.key === r.role)?.info}</div>
                </td>
                <td>
                  <span className="num">{r.level}</span> · {meta.levels.find((l) => l.level === r.level)?.label}
                </td>
                <td className="small">{scopeText(r.scope, lineName)}</td>
                <td className="r">
                  {r.fixed ? (
                    <span className="faint small">Fixed</span>
                  ) : (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setEditing(r.role);
                        setDraft({ level: r.level, scope: r.scope });
                      }}
                    >
                      Change
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && draft && (
        <Modal
          open
          onClose={() => setEditing(null)}
          eyebrow="Visibility"
          title={`What ${meta.roles.find((x) => x.key === editing)?.label.toLowerCase()}s see`}
          footer={
            <div className="btns end">
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <Action
                className="btn primary"
                onClick={async () => {
                  await api.put(path(`/access/roles/${editing}`), draft);
                  toast("Saved", "ok");
                  setEditing(null);
                  await reloadSite();
                }}
              >
                Save
              </Action>
            </div>
          }
        >
          <AccessEditor level={draft.level} scope={draft.scope} onChange={(level, scope) => setDraft({ level, scope })} />
        </Modal>
      )}
    </div>
  );
}

type TeamTab = "members" | "access" | "stakes" | "vendors" | "names";
export function TeamPage() {
  const { team, can, sees, book } = useApp();
  const route = useRoute();
  const [tab, setTab] = useState<TeamTab>(() => (route.query.get("tab") as TeamTab | null) ?? "members");
  useEffect(() => {
    const t = route.query.get("tab") as TeamTab | null;
    if (t) setTab(t);
  }, [route.query]);
  const tabs: { value: TeamTab; label: string; count?: number }[] = [
    { value: "members", label: "Members", count: team?.members.length },
    ...(can("manager") ? [{ value: "access" as TeamTab, label: "Visibility" }] : []),
    { value: "stakes", label: "Stakes" },
    ...(sees(4) ? [{ value: "vendors" as TeamTab, label: "Vendors" }] : []),
    // every name in the org (ENSv2 under the root), with what is on-chain and what waits
    ...(sees(3) && book.live ? [{ value: "names" as TeamTab, label: "Names", count: book.entries.length }] : []),
  ];
  return (
    <div>
      <div className="eyebrow">People, roles, stakes and names</div>
      <h1>Team</h1>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === "members" && <Members />}
      {tab === "access" && <RoleAccess />}
      {tab === "stakes" && <Stakes />}
      {tab === "vendors" && <Vendors />}
      {tab === "names" && <Names />}
    </div>
  );
}
