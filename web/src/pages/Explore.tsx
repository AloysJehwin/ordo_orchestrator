import { useEffect, useState } from "react";
import { api } from "../api";
import { ago } from "../lib/format";
import type { OrgSummary } from "../types";
import { Action, Empty, Field } from "../ui/kit";

export const ROLE_NAME: Record<string, string> = { manager: "Manager", validator: "Validator", tester: "Tester", contributor: "Contributor" };

/** Join an open org as a contributor. Resolves to the org's id; throws with the server's reason (closed org, unknown code). */
/** Join an org, taking the handle for one's ENS names first when one is given (priya → priya.acme.ordo.eth). */
export const joinOrg = (siteId: string, handle?: string) =>
  api.post<{ joined: boolean }>(`/v1/orgs/${encodeURIComponent(siteId)}/join`, handle?.trim() ? { handle: handle.trim() } : {}).then(() => siteId);

/**
 * Orgs a signed-in wallet can join right now, and the ones it is already in. Joining is open: anyone joins as a
 * contributor, and a manager later makes people validators or testers. A manager can close the org from Settings;
 * then only the people they invite join.
 */
export function OrgExplorer({ signedIn, onOpen, onSignIn, handle }: { signedIn: boolean; onOpen: (siteId: string) => void; onSignIn?: () => void; handle?: string }) {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("site") ?? "");
  const [codeError, setCodeError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<OrgSummary[]>("/v1/orgs")
      .then(setOrgs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [signedIn]);
  const join = async (id: string) => {
    if (!signedIn) return onSignIn?.();
    onOpen(await joinOrg(id, handle));
  };
  return (
    <div className="stack">
      {error && <p className="field-e">{error}</p>}
      {!orgs && !error && <p className="muted">Loading orgs…</p>}
      {orgs && orgs.length === 0 && <Empty title="No open orgs yet">When a manager creates an org, it appears here for anyone to join.</Empty>}
      {orgs && orgs.length > 0 && (
        <ul className="org-list">
          {orgs.map((o) => (
            <li key={o.id} className="org-row">
              <div className="grow">
                <b>{o.name}</b>
                <div className="small muted">
                  <span className="num">{o.members}</span> member{o.members === 1 ? "" : "s"} · <span className="num">{o.lines}</span> line{o.lines === 1 ? "" : "s"} · <span className="num">{o.running}</span> running · since {ago(o.createdAt)}
                </div>
              </div>
              {o.member ? (
                <button type="button" className="btn sm" onClick={() => onOpen(o.id)}>
                  Open
                </button>
              ) : o.open ? (
                <Action className="btn sm primary" onClick={() => join(o.id)}>
                  {signedIn ? "Join" : "Sign in to join"}
                </Action>
              ) : (
                <span className="tag">Invite only</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {signedIn && (
        <Field label="Or join with an org code" hint="A manager finds it in Settings. Closed orgs need an invite to your wallet address instead." error={codeError}>
          <div className="inline">
            <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="site_…" />
            <Action
              className="btn"
              disabled={code.length < 6}
              onClick={async () => {
                setCodeError(null);
                try {
                  onOpen(await joinOrg(code, handle));
                } catch (e) {
                  setCodeError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Join
            </Action>
          </div>
        </Field>
      )}
    </div>
  );
}
