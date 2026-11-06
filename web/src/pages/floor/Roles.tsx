import { useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../lib/app";
import { useSign } from "../../lib/sign";
import type { AssetView, MachineCaps, MachineRole, MachineRoleView, TypedSignature } from "../../types";
import { Action, Field, useToast } from "../../ui/kit";
import { Name } from "../../ui/Name";

const ROLES: MachineRole[] = ["runner", "attester", "buyer"];
const LABEL: Record<MachineRole, string> = {
  attester: "Attester",
  buyer: "Buyer",
  runner: "Runner",
};
const INFO: Record<MachineRole, string> = {
  runner: "Can be given stages to run, of the kinds listed.",
  attester: "Signs readings, measurements and outputs, for the stages it runs only.",
  buyer: "Buys a stage's resources over x402 and asks for top-ups, within each stage's max price and its own caps.",
};
const hbar = (t: string | undefined) => `${(Number(t ?? "0") / 1e8).toFixed(8).replace(/\.?0+$/, "")} HBAR`;
const tinybar = (h: string) => (h.trim() ? BigInt(Math.round(Number(h) * 1e8)).toString() : undefined);
const hbarIn = (t: string | undefined) => (t ? String(Number(t) / 1e8) : "");
/** Blank, or a positive number of HBAR. */
const capOk = (h: string) => !h.trim() || Number(h) > 0;

/** What a role's caps allow, in words. */
function capsText(role: MachineRole, caps: MachineCaps | null, kindLabel: (k: string) => string) {
  if (!caps) return null;
  if (role === "runner") return (caps.kinds ?? []).map(kindLabel).join(", ") || "no kinds";
  if (role === "buyer") {
    const parts = [caps.order ? `${hbar(caps.order)} an order` : null, caps.daily ? `${hbar(caps.daily)} a day` : null].filter(Boolean);
    return parts.length ? `up to ${parts.join(", ")}` : "no caps of its own";
  }
  return null;
}

/** What counts now, as the server applies it: the lower of what was signed and what its ENS name says. */
function effective(role: MachineRole, wanted: MachineCaps, held: MachineCaps | null): MachineCaps | null {
  if (!held) return null;
  if (role === "runner") return { kinds: (wanted.kinds ?? []).filter((k) => (held.kinds ?? []).includes(k)) };
  if (role === "buyer") {
    const min = (a?: string, b?: string) => (a === undefined ? b : b === undefined ? a : BigInt(a) < BigInt(b) ? a : b);
    return { order: min(wanted.order, held.order), daily: min(wanted.daily, held.daily) };
  }
  return {};
}

/**
 * A machine's roles: Runner, Attester and Buyer, each an ENS role name it holds (cnc-07.runners.acme.ordo.eth).
 * A manager grants, changes or removes each with a signature; a grant counts once its name is on ENS.
 */
export function MachineRolesSection({ asset }: { asset: AssetView }) {
  const { path, can, book, meta, live } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [roles, setRoles] = useState<MachineRoleView[] | null>(null);
  const [shared, setShared] = useState(0);
  const [edit, setEdit] = useState<{
    role: MachineRole;
    kinds: string[];
    order: string;
    daily: string;
  } | null>(null);
  const manager = can("manager");
  const src = asset.source as { type: string; device?: string };
  const hasKey = src.type === "gateway" && /^0x[0-9a-fA-F]{40}$/.test(src.device ?? "");
  const kindLabel = (k: string) => meta.assetKinds.find((x) => x.key === k)?.label ?? k;

  const load = () => api.get<MachineRoleView[]>(path(`/assets/${asset.id}/roles`)).then(setRoles);
  useEffect(() => {
    void load();
    // one key feeding several machines: only one of them can sign on-chain
    if (hasKey)
      void api
        .get<AssetView[]>(path("/assets"))
        .then((all) => setShared(all.filter((x) => (x.source as { device?: string }).device?.toLowerCase() === src.device!.toLowerCase()).length))
        .catch(() => setShared(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id, live?.headSeq]);

  const change = async (role: MachineRole, grant: boolean, caps: { kinds?: string[]; order?: string; daily?: string } = {}) => {
    const have = roles?.find((r) => r.role === role);
    const r = await sign<{ pending: boolean }>({
      title: grant ? `${have ? "Change" : "Make"} ${asset.name} ${have ? "as" : "a"} ${LABEL[role]}` : `Remove ${asset.name} as ${LABEL[role]}`,
      request: (chainId) => api.post<TypedSignature>(path(`/assets/${asset.id}/roles/sign-request`), { role, grant, ...caps, chainId }),
      submit: (proof) =>
        api.post(path(`/assets/${asset.id}/roles`), {
          role,
          grant,
          ...caps,
          comment: "",
          ...proof,
        }),
    });
    if (!r) return;
    setEdit(null);
    toast(
      r.pending ? `Signed. It counts once ${asset.name}'s role name is on ENS, in about a minute.` : grant ? `${asset.name} is a ${LABEL[role]}` : `${asset.name} is no longer a ${LABEL[role]}`,
      "ok",
    );
    await load();
  };
  const startEdit = (role: MachineRole) => {
    const have = roles?.find((r) => r.role === role);
    if (role === "attester") return void change(role, true);
    setEdit({
      role,
      kinds: have?.caps.kinds ?? [asset.kind],
      order: hbarIn(have?.caps.order),
      daily: hbarIn(have?.caps.daily),
    });
  };

  if (!roles) return null;
  return (
    <section className="dsec">
      <h3>Roles</h3>
      <p className="muted small">
        Each role is an ENS name {asset.name} holds
        {book.live ? "; contracts and Ordo read what it may do from those names" : ""}. A manager signs each change.
      </p>
      {shared > 1 && (
        <p className="notice warn small">This machine's key feeds {shared} machines. On-chain only one of them can sign as an Attester: give each machine its own key (a gateway or a machine body).</p>
      )}
      <ul className="mroles">
        {ROLES.map((role) => {
          const r = roles.find((x) => x.role === role);
          const name = book.of("machinerole", `${role}:${asset.id}`);
          // what counts now, and whether the signed caps still wait for the role name to say them
          const now = r && r.state === "held" ? effective(role, r.caps, r.heldCaps) : null;
          const shown = now ?? r?.caps ?? null;
          const rising = Boolean(now) && capsText(role, now, kindLabel) !== capsText(role, r!.caps, kindLabel);
          const blocked = role === "attester" && !hasKey;
          return (
            <li key={role} className="mrole">
              <div className="mrole-h">
                <b>{LABEL[role]}</b>
                {r ? r.state === "pending" ? <span className="tag pending">pending on ENS</span> : <span className="tag ok">holds</span> : <span className="faint small">does not hold</span>}
                {r && capsText(role, shown, kindLabel) && <span className="small">{capsText(role, shown, kindLabel)}</span>}
              </div>
              <div className="small muted">{blocked ? "It has no key of its own, so it cannot sign: people attest its stages." : INFO[role]}</div>
              {rising && <div className="small faint">Changing to {capsText(role, r!.caps, kindLabel)} once its role name says so</div>}
              {name && r && (
                <div className="small">
                  <Name name={name.name} status={name.status} />
                </div>
              )}
              {manager && !blocked && edit?.role !== role && (
                <div className="btns">
                  {(!r || role !== "attester") && (
                    <button type="button" className="btn sm" onClick={() => startEdit(role)}>
                      {r ? "Change" : `Make ${LABEL[role].toLowerCase()}`}
                    </button>
                  )}
                  {r && (
                    <Action className="btn sm danger" onClick={() => change(role, false)}>
                      Remove
                    </Action>
                  )}
                </div>
              )}
              {edit?.role === role && (
                <div className="mrole-edit">
                  {role === "runner" && (
                    <Field label="Kinds of stage it may run">
                      <div className="chips">
                        {meta.assetKinds.map((k) => (
                          <label key={k.key} className="check small">
                            <input
                              type="checkbox"
                              checked={edit.kinds.includes(k.key)}
                              onChange={(e) =>
                                setEdit({
                                  ...edit,
                                  kinds: e.target.checked ? [...edit.kinds, k.key] : edit.kinds.filter((x) => x !== k.key),
                                })
                              }
                            />{" "}
                            {k.label}
                          </label>
                        ))}
                      </div>
                    </Field>
                  )}
                  {role === "buyer" && (
                    <>
                      <div className="grid2">
                        <Field label="Most per order (HBAR)" error={capOk(edit.order) ? null : "A positive amount, or blank"}>
                          <input value={edit.order} onChange={(e) => setEdit({ ...edit, order: e.target.value })} inputMode="decimal" placeholder="no cap" />
                        </Field>
                        <Field label="Most per day (HBAR)" error={capOk(edit.daily) ? null : "A positive amount, or blank"}>
                          <input value={edit.daily} onChange={(e) => setEdit({ ...edit, daily: e.target.value })} inputMode="decimal" placeholder="no cap" />
                        </Field>
                      </div>
                      <p className="small faint">Leave a cap blank for none of its own: each stage's max price, and any top-up a manager approved, still apply.</p>
                    </>
                  )}
                  <div className="btns">
                    <Action
                      className="btn accent sm"
                      disabled={
                        role === "runner" ? !edit.kinds.length : !capOk(edit.order) || !capOk(edit.daily) || (Boolean(edit.order.trim() && edit.daily.trim()) && Number(edit.daily) < Number(edit.order))
                      }
                      onClick={() =>
                        change(
                          role,
                          true,
                          role === "runner"
                            ? { kinds: edit.kinds }
                            : {
                                order: tinybar(edit.order),
                                daily: tinybar(edit.daily),
                              },
                        )
                      }
                    >
                      Sign
                    </Action>
                    <button type="button" className="btn sm" onClick={() => setEdit(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The roles a machine holds now, as small chips (for lists). */
export function RoleChips({ asset }: { asset: AssetView }) {
  if (!asset.roles) return null;
  if (!asset.roles.length) return <span className="tag faint">no roles</span>;
  return (
    <span className="role-chips">
      {ROLES.filter((r) => asset.roles!.includes(r)).map((r) => (
        <span key={r} className="tag" title={INFO[r]}>
          {LABEL[r]}
        </span>
      ))}
    </span>
  );
}
