import { useCallback, useEffect, useState } from "react";
import { parseUnits } from "viem";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { useSign } from "../lib/sign";
import { fromUnits, fundRewardsTx } from "../lib/wallet";
import type { AcceptanceView, RelayView, RewardSettings, RewardsView, TypedSignature } from "../types";
import { Action, Empty, Field, Loading, useToast } from "../ui/kit";

const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

/**
 * The org's reward pool in OrdoTrust: the manager funds it; each selected proof of work earns its contributor the reward
 * and its validator the fee once the challenge window has passed without a case; each person claims to their own wallet.
 */
export function Rewards() {
  const { path, me, siteId, status, can } = useApp();
  const toast = useToast();
  const [v, setV] = useState<RewardsView | null>(null);
  const [amount, setAmount] = useState("");
  const load = useCallback(() => api.get<RewardsView>(path("/rewards")).then(setV), [path]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!v) return <Loading />;
  const unit = (x: string | null) => (x === null ? "—" : `${fromUnits(x, v.decimals)} ${v.symbol}`);
  const trust = status.trust;
  const manager = can("manager");
  const fund = async () => {
    if (!trust) return;
    const hash = await fundRewardsTx(trust, me.user!.address, siteId, amount);
    toast(`Transaction sent: ${hash.slice(0, 10)}…`, "ok");
    setAmount("");
    setTimeout(() => void load(), 6000);
  };
  const claim = async () => {
    const r = await api.post<RelayView>(path("/rewards/claim"));
    toast(r.status === "done" ? "Paid to your wallet" : `Claim ${r.status}${r.error ? `: ${r.error}` : ""}`, r.status === "done" ? "ok" : "bad");
    await load();
  };
  return (
    <div>
      <div className="eyebrow">Proof of work</div>
      <h1>Rewards</h1>
      <p className="muted lede">
        Each proof of work a validator selects earns its contributor {unit(v.settings.reward)} and the validator {unit(v.settings.fee)}. They vest {Math.round(v.settings.challengeWindow / 3600)} hours after the selection unless a tester opens a
        case, which freezes them until a manager decides.
      </p>
      {!v.configured ? (
        <div className="notice">
          <b>Rewards are off.</b> No OrdoTrust contract is configured for this deployment: selections and cases are kept in Ordo's ledger, and nothing is paid.
        </div>
      ) : (
        !v.v3 && (
          <div className="notice warn">
            <b>This deployment's OrdoTrust predates rewards.</b> Selections and cases are signed and kept in the ledger; the pool, payouts and stake cuts start once the v3 contracts are deployed.
          </div>
        )
      )}
      {v.v3 && (
        <section className="section reward-kpis">
          <div className="card reward-kpi">
            <div className="label">Reward pool</div>
            <div className="v">{unit(v.pool)}</div>
          </div>
          <div className="card reward-kpi">
            <div className="label">Yours to claim</div>
            <div className="v">{unit(v.claimable)}</div>
            {v.claimable !== null && BigInt(v.claimable) > 0n && (
              <Action className="btn sm primary" onClick={claim}>
                Claim to my wallet
              </Action>
            )}
          </div>
          {manager && trust && (
            <div className="card reward-kpi">
              <div className="label">Fund the pool</div>
              <div className="fund-row">
                <input className="input num" inputMode="decimal" placeholder={`Amount in ${v.symbol}`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
                <Action className="btn primary" disabled={!(Number(amount) > 0)} onClick={fund}>
                  Fund
                </Action>
              </div>
              <p className="faint small">From your own wallet.</p>
            </div>
          )}
        </section>
      )}
      <section className="section">
        <div className="section-h">
          <h2>Selected proofs of work</h2>
        </div>
        {v.acceptances.length === 0 ? (
          <Empty title="Nothing selected yet">When a validator selects a proof of work for a stage, its reward shows here.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Contributor</th>
                  <th>Validator</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {v.acceptances.map((a) => (
                  <AcceptanceRow key={a.contributionId} a={a} v3={v.v3} unit={unit} me={me.user!.address} onChange={load} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {manager && <RewardSettingsCard v={v} onChange={load} />}
    </div>
  );
}

function AcceptanceRow({ a, v3, unit, me, onChange }: { a: AcceptanceView; v3: boolean; unit: (x: string | null) => string; me: string; onChange: () => void }) {
  const { path } = useApp();
  const toast = useToast();
  const who = (p: { address: string; name: string | null }) => (p.address === me ? "You" : (p.name ?? shortAddr(p.address)));
  const o = a.onchain;
  const vested = o ? o.vestAt * 1000 <= Date.now() : false;
  let state: [string, string];
  if (a.openCase) state = ["Frozen by a case", "warn"];
  else if (!v3) state = ["In Ordo's ledger", ""];
  else if (!o) state = a.relay?.status === "failed" ? ["Not recorded on-chain", "bad"] : ["Recording…", "warn"];
  else if (o.settled) state = ["Paid out", "ok"];
  else if (o.frozen) state = ["Frozen by a case", "warn"];
  else if (vested) state = ["Vested", "ok"];
  else state = [`Vests ${dateTime(new Date(o.vestAt * 1000).toISOString())}`, ""];
  return (
    <tr>
      <td data-label="Stage">
        <b>{a.stageCode}</b> <span className="faint small mono">{a.runId}</span>
        <div className="faint small">selected {ago(a.selectedAt)}</div>
      </td>
      <td data-label="Contributor">
        {who(a.contributor)}
        {o && <div className="faint small num">{unit(o.reward)}</div>}
      </td>
      <td data-label="Validator">
        {who(a.validator)}
        {o && <div className="faint small num">{unit(o.fee)}</div>}
      </td>
      <td data-label="State">
        <span className={`tag ${state[1]}`} title={a.relay?.error ?? undefined}>
          {state[0]}
        </span>
      </td>
      <td className="r">
        {o && vested && !o.settled && !o.frozen && !a.openCase && (
          <Action
            className="btn sm"
            onClick={async () => {
              const r = await api.post<RelayView>(path(`/rewards/settle/${a.contributionId}`));
              toast(r.status === "done" ? "Credited" : `Settle ${r.status}${r.error ? `: ${r.error}` : ""}`, r.status === "done" ? "ok" : "bad");
              onChange();
            }}
          >
            Settle
          </Action>
        )}
        <a className="btn sm" href={`#/pow/${a.contributionId}`} target="_blank" rel="noreferrer">
          Proof
        </a>
      </td>
    </tr>
  );
}

/** The manager's per-org parameters: signed, and enforced by OrdoTrust v3 for acceptances and cases made afterwards. */
function RewardSettingsCard({ v, onChange }: { v: RewardsView; onChange: () => void }) {
  const { path } = useApp();
  const sign = useSign();
  const s = v.settings;
  const [f, setF] = useState({
    reward: fromUnits(s.reward, v.decimals),
    fee: fromUnits(s.fee, v.decimals),
    challengeHours: String(s.challengeWindow / 3600),
    responseHours: String(s.responseWindow / 3600),
    defaultSlash: String(s.defaultSlashBps / 100),
    maxSlash: String(s.maxSlashBps / 100),
    bounty: String(s.bountyBps / 100),
    falseClaim: String(s.falseClaimBps / 100),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  let next: RewardSettings | null = null;
  let error: string | null = null;
  try {
    const bps = (x: string) => Math.round(Number(x) * 100);
    next = {
      reward: parseUnits(f.reward || "0", v.decimals).toString(),
      fee: parseUnits(f.fee || "0", v.decimals).toString(),
      challengeWindow: Math.round(Number(f.challengeHours) * 3600),
      responseWindow: Math.round(Number(f.responseHours) * 3600),
      defaultSlashBps: bps(f.defaultSlash),
      maxSlashBps: bps(f.maxSlash),
      bountyBps: bps(f.bounty),
      falseClaimBps: bps(f.falseClaim),
    };
    const pcts = [next.defaultSlashBps, next.maxSlashBps, next.bountyBps, next.falseClaimBps];
    if (pcts.some((x) => !Number.isFinite(x) || x < 0 || x > 10_000)) error = "Percentages are between 0 and 100.";
    else if (next.maxSlashBps < 1 || next.defaultSlashBps > next.maxSlashBps) error = "The default cut is at most the maximum, which is above 0.";
    else if (!Number.isFinite(next.challengeWindow) || next.challengeWindow < 0 || !Number.isFinite(next.responseWindow) || next.responseWindow < 60) error = "Windows are positive; the response window at least a minute.";
  } catch {
    error = "Amounts are numbers.";
  }
  const save = async () => {
    if (!next || error) return;
    const body = next;
    const r = await sign<RelayView>({
      title: "Change the rewards and slashing settings",
      request: (chainId) => api.post<TypedSignature>(path("/rewards/settings/sign-request"), { ...body, chainId }),
      submit: (proof) => api.put(path("/rewards/settings"), { ...body, ...proof }),
      done: "Settings signed",
    });
    if (r) onChange();
  };
  return (
    <section className="section card">
      <div className="card-h">
        <h2>Rewards and slashing</h2>
        <span className={`tag ${v.settingsOnchain ? "ok" : ""}`}>{v.settingsOnchain ? "Set on-chain" : "Defaults"}</span>
      </div>
      <div className="card-b stack">
        <div className="grid2">
          <Field label={`Contributor reward (${v.symbol})`}>
            <input className="input num" inputMode="decimal" value={f.reward} onChange={set("reward")} />
          </Field>
          <Field label={`Validator fee (${v.symbol})`}>
            <input className="input num" inputMode="decimal" value={f.fee} onChange={set("fee")} />
          </Field>
          <Field label="Challenge window (hours)" hint="Before rewards vest; a tester can open a case meanwhile">
            <input className="input num" inputMode="decimal" value={f.challengeHours} onChange={set("challengeHours")} />
          </Field>
          <Field label="Response window (hours)" hint="For the validator to answer a case">
            <input className="input num" inputMode="decimal" value={f.responseHours} onChange={set("responseHours")} />
          </Field>
          <Field label="Proposed cut (%)" hint="A case's default share of the validator's stake">
            <input className="input num" inputMode="decimal" value={f.defaultSlash} onChange={set("defaultSlash")} />
          </Field>
          <Field label="Maximum cut (%)">
            <input className="input num" inputMode="decimal" value={f.maxSlash} onChange={set("maxSlash")} />
          </Field>
          <Field label="Tester's bounty (%)" hint="Of an upheld cut; the rest goes to the quality fund">
            <input className="input num" inputMode="decimal" value={f.bounty} onChange={set("bounty")} />
          </Field>
          <Field label="False claim (%)" hint="Of the tester's stake, to the validator, when a case is rejected">
            <input className="input num" inputMode="decimal" value={f.falseClaim} onChange={set("falseClaim")} />
          </Field>
        </div>
        {error && <p className="field-e">{error}</p>}
        <p className="faint small">
          Currently {pct(s.defaultSlashBps)} proposed, at most {pct(s.maxSlashBps)}; {pct(s.bountyBps)} of an upheld cut to the tester; {pct(s.falseClaimBps)} of a false claimant's stake to the validator.
        </p>
        <div className="btns">
          <button type="button" className="btn primary" disabled={!v.v3 || Boolean(error)} title={v.v3 ? "" : "Needs the v3 OrdoTrust contract"} onClick={() => void save()}>
            Sign and save
          </button>
        </div>
      </div>
    </section>
  );
}
