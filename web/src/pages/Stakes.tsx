import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { ago, dateTime, shortAddr } from "../lib/format";
import { useSign } from "../lib/sign";
import { fromUnits, trustTx } from "../lib/wallet";
import type { ChainStatus, Role, StakersView, TypedSignature, VendorRow } from "../types";
import { Action, Empty, Field, Loading, Modal, useToast } from "../ui/kit";
import { NameInput, Who } from "../ui/Name";
import { VendorOffers } from "./VendorOffers";

/** Signs and sends the org's registration in OrdoTrust. Returns true when it went through. */
export function useRegisterOrg() {
  const { site, path } = useApp();
  const sign = useSign();
  return async () =>
    Boolean(
      await sign({
        title: `Register ${site.name} in OrdoTrust`,
        request: () => api.post<TypedSignature>(path("/chain/register/sign-request")),
        submit: (proof) => api.post(path("/chain/register"), proof),
        done: "Registered on-chain",
      }),
    );
}

/** Whether OrdoTrust is configured, whether this org is registered there, and a button to register it. */
export function ChainBanner({ chain, onChange }: { chain: ChainStatus; onChange: () => Promise<unknown> }) {
  const { status, can } = useApp();
  const register = useRegisterOrg();
  if (!chain.configured)
    return (
      <div className="notice">
        <b>Stakes are off.</b> No OrdoTrust contract is configured for this deployment, so roles are kept in Ordo and nobody stakes. Set the <span className="mono">TRUST_*</span> variables to enforce credentials and stakes on-chain.
      </div>
    );
  const info = chain.info && "minStake" in chain.info ? chain.info : null;
  return (
    <div className={`notice ${chain.registered ? "ok" : "warn"}`}>
      <b>OrdoTrust on {status.trust?.name}</b>{" "}
      <span className="mono small">
        {status.trust?.explorerUrl ? (
          <a href={`${status.trust.explorerUrl.replace(/\/$/, "")}/address/${status.trust.address}`} target="_blank" rel="noreferrer">
            {shortAddr(status.trust?.address ?? "")}
          </a>
        ) : (
          shortAddr(status.trust?.address ?? "")
        )}
      </span>
      {info && (
        <p className="small">
          Validators and testers act only while holding at least {fromUnits(info.minStake, info.decimals)} {info.symbol} at stake. Unstaking takes {Math.round(info.unstakeCooldownSeconds / 86400)} days, so a case opened meanwhile can still reach the stake.
        </p>
      )}
      {chain.registered ? (
        <p className="small">
          Org registered{chain.registeredAt ? ` ${ago(chain.registeredAt)}` : ""}.{" "}
          {chain.txUrl && (
            <a href={chain.txUrl} target="_blank" rel="noreferrer">
              Registration transaction
            </a>
          )}
        </p>
      ) : (
        <div className="btns">
          <span className="small">This org is not registered on-chain yet: credentials wait until it is.</span>
          {can("manager") && (
            <Action className="btn primary sm" onClick={async () => (await register()) && (await onChange())}>
              Register on-chain
            </Action>
          )}
        </div>
      )}
    </div>
  );
}

interface Credentials {
  configured: boolean;
  registered: boolean;
  admins: string[];
  missing: { userId: string; address: string; name: string | null; role: string; label: string }[];
}

/** Credentials Ordo gave that OrdoTrust does not hold yet: after a redeploy, or when a relay failed. A manager the contract knows signs each again. */
export function MissingCredentials({ registered }: { registered: boolean }) {
  const { path, names, me } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [c, setC] = useState<Credentials | null>(null);
  const load = useCallback(() => api.get<Credentials>(path("/chain/credentials")).then(setC).catch(() => setC(null)), [path]);
  useEffect(() => {
    void load();
  }, [load, registered]);
  if (!c?.configured || !c.registered || !c.missing.length) return null;
  const canSign = c.admins.includes(me.user!.address);
  return (
    <section className="section card">
      <div className="card-h">
        <h2>Credentials missing on-chain</h2>
        <span className="tag warn">{c.missing.length}</span>
      </div>
      <div className="card-b">
        <p className="muted small">
          These roles are given in Ordo but OrdoTrust does not hold them yet, so the contract refuses what they sign or stake.{" "}
          {canSign ? "Sign each one with your wallet." : `Only a manager OrdoTrust knows can sign them: ${c.admins.map((a) => names.get(a.toLowerCase()) ?? shortAddr(a)).join(", ") || "nobody yet"}.`}
        </p>
        <table className="t">
          <tbody>
            {c.missing.map((m) => (
              <tr key={`${m.address}:${m.role}`}>
                <td>
                  <b>
                    <Who address={m.address} fallback={m.name ?? undefined} />
                  </b>
                  <div className="faint small mono">
                    {m.name ? `${m.name} · ` : ""}
                    {m.address}
                  </div>
                </td>
                <td>{m.label}</td>
                <td className="r">
                  <Action
                    className="btn sm primary"
                    disabled={!canSign}
                    onClick={async () => {
                      const r = await sign<{ status: string; error: string | null }>({
                        title: `Record ${names.get(m.address.toLowerCase()) ?? m.name ?? shortAddr(m.address)} as ${m.label} in OrdoTrust`,
                        request: () => api.post<TypedSignature>(path("/chain/credentials/sign-request"), { address: m.address, role: m.role }),
                        submit: (proof) => api.post(path("/chain/credentials/grant"), { address: m.address, role: m.role, ...proof }),
                      });
                      if (!r) return;
                      toast(r.status === "done" ? "Credential recorded on-chain" : `Not recorded: ${r.error ?? r.status}`, r.status === "done" ? "ok" : "bad");
                      await load();
                    }}
                  >
                    Sign grant
                  </Action>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const STAKING: Role[] = ["validator", "tester", "manager"];

/** Validators, testers and managers, with their stakes; and your own stake, which you add and withdraw from your wallet. */
export function Stakes() {
  const { path, me, siteId, status, can, names, meta } = useApp();
  const [v, setV] = useState<StakersView | null>(null);
  const [amount, setAmount] = useState("");
  const toast = useToast();
  const load = useCallback(() => api.get<StakersView>(path("/stakers")).then(setV), [path]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!v) return <Loading />;
  const trust = status.trust;
  const info = v.chain.info && "minStake" in v.chain.info ? v.chain.info : null;
  const mine = v.stakers.find((x) => x.address === me.user!.address);
  const unit = (x: string) => (info ? `${fromUnits(x, info.decimals)} ${info.symbol}` : x);
  const label = (r: Role) => meta.roles.find((x) => x.key === r)?.label ?? r;
  const tx = async (fn: "stake" | "requestUnstake" | "withdraw") => {
    if (!trust) return;
    const hash = await trustTx(trust, me.user!.address, fn, siteId, amount);
    toast(`Transaction sent: ${hash.slice(0, 10)}…`, "ok");
    setAmount("");
    // once it is final, Ordo schedules (or deletes) the payout at the end of the cooldown on Hedera
    setTimeout(() => void api.post(path("/stakers/me/payout-schedule")).catch(() => null).then(load), 6000);
  };
  const state = (x: StakersView["stakers"][number]): [string, string] => {
    if (!info) return ["Roles in Ordo", ""];
    if (!x.onchain) return ["Chain unreachable", "warn"];
    if (x.onchain.activeValidator || x.onchain.activeTester) return ["Active", "ok"];
    if (x.onchain.unlockAt) return [`Unstaking · ${x.onchain.unlockAt * 1000 > Date.now() ? `free ${dateTime(new Date(x.onchain.unlockAt * 1000).toISOString())}` : "withdrawable"}`, "warn"];
    if (!x.onchain.credentials.length) return ["No on-chain credential", "bad"];
    return ["Not staked", "warn"];
  };
  const canStake = mine && mine.roles.some((r) => STAKING.includes(r));
  return (
    <div>
      <ChainBanner chain={v.chain} onChange={load} />
      {can("manager") && <MissingCredentials registered={Boolean(v.chain.registered)} />}
      <section className="section">
        <div className="section-h">
          <h2>Who stakes</h2>
        </div>
        {v.stakers.length === 0 ? (
          <Empty title="Nobody stakes yet">A manager makes people validators or testers from Members. Validators select the valid contribution for a stage; testers open cases against them. Both stake.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="t">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Roles</th>
                  {info && <th className="r">Stake</th>}
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {v.stakers.map((x) => {
                  const st = state(x);
                  return (
                    <tr key={x.userId}>
                      <td>
                        <b>
                          <Who address={x.address} fallback={x.name ?? undefined} />
                        </b>
                        <div className="faint small mono">
                          {x.name ? `${x.name} · ` : ""}
                          {x.address}
                        </div>
                      </td>
                      <td>{x.roles.filter((r) => STAKING.includes(r)).map(label).join(", ")}</td>
                      {info && <td className="r num">{x.onchain ? unit(x.onchain.stake) : "—"}</td>}
                      <td>{st[1] ? <span className={`tag ${st[1]}`}>{st[0]}</span> : <span className="faint small">{st[0]}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canStake && (
        <section className="section card">
          <div className="card-h">
            <h2>Your stake</h2>
            <span className={`tag ${v.me.validator.ok || v.me.tester.ok ? "ok" : "warn"}`}>{v.me.validator.ok || v.me.tester.ok ? "Active" : "Not active yet"}</span>
          </div>
          <div className="card-b">
            {!v.me.validator.ok && v.me.validator.reason && mine.roles.some((r) => r === "validator" || r === "manager") && <p className="muted small">{v.me.validator.reason}</p>}
            {!v.me.tester.ok && v.me.tester.reason && mine.roles.includes("tester") && <p className="muted small">{v.me.tester.reason}</p>}
            {!trust && <p className="muted">Stakes are off on this deployment, so your role is the whole credential.</p>}
            {trust && info && mine.onchain && (
              <>
                <dl className="kv">
                  <dt>Your stake</dt>
                  <dd className="num">{unit(mine.onchain.stake)}</dd>
                  <dt>Minimum</dt>
                  <dd className="num">{unit(info.minStake)}</dd>
                  {mine.onchain.unlockAt > 0 && (
                    <>
                      <dt>Withdrawable from</dt>
                      <dd>{dateTime(new Date(mine.onchain.unlockAt * 1000).toISOString())}</dd>
                    </>
                  )}
                  {mine.onchain.payout?.status === "scheduled" && mine.onchain.payout.url && (
                    <>
                      <dt>Paid back by</dt>
                      <dd>
                        <a href={mine.onchain.payout.url} target="_blank" rel="noreferrer">
                          Hedera schedule {mine.onchain.payout.scheduleId}
                        </a>{" "}
                        <span className="faint small">· runs on its own at {dateTime(mine.onchain.payout.executeAt)}</span>
                      </dd>
                    </>
                  )}
                </dl>
                <div className="inline">
                  <input className="input" style={{ maxWidth: 180 }} type="number" min={0} step="any" placeholder={`Amount in ${info.symbol}`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Stake amount" />
                  <Action className="btn primary" disabled={!(Number(amount) > 0) || !v.chain.registered || !mine.onchain.credentials.length} title={mine.onchain.credentials.length ? "" : "Your credential is not in OrdoTrust yet"} onClick={() => tx("stake")}>
                    Stake
                  </Action>
                  <Action className="btn" disabled={BigInt(mine.onchain.stake) === 0n || mine.onchain.unlockAt > 0} onClick={() => tx("requestUnstake")}>
                    Request unstake
                  </Action>
                  <Action className="btn" disabled={!(mine.onchain.unlockAt > 0 && mine.onchain.unlockAt * 1000 <= Date.now())} onClick={() => tx("withdraw")}>
                    Withdraw
                  </Action>
                </div>
                <p className="faint small">Stake and withdraw are transactions from your own wallet on {trust.name}; you pay their gas. Ordo never holds your stake.</p>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** Maintenance vendors, the payees of work orders. A manager adds each one with a signature; OrdoTrust then holds their vendor credential. */
export function Vendors() {
  const { path, can } = useApp();
  const sign = useSign();
  const toast = useToast();
  const [rows, setRows] = useState<VendorRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ address: "", company: "", categories: "", hourlyRate: "", responseMinutes: "" });
  const load = useCallback(() => api.get<VendorRow[]>(path("/vendors")).then(setRows), [path]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!rows) return <Loading />;
  // a wallet address, or a name that resolves to one (the server resolves it)
  const addrOk = /^0x[0-9a-fA-F]{40}$/.test(form.address.trim()) || /^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(form.address.trim());
  const valid = addrOk && form.company.trim().length >= 2;
  const body = () => ({
    address: form.address.trim(),
    company: form.company.trim(),
    categories: form.categories.trim(),
    hourlyRate: form.hourlyRate.trim() || null,
    responseMinutes: form.responseMinutes ? Number(form.responseMinutes) : null,
  });
  return (
    <div>
      <div className="section-h spread">
        <p className="muted lede">Maintenance vendors that agents may pay for work orders. A manager adds each one with a signature; with OrdoTrust they hold an on-chain vendor credential.</p>
        {can("manager") && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            Add vendor
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty title="No vendors yet">A manager adds a vendor's wallet, company, services and rate.</Empty>
      ) : (
        <div className="card scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Company</th>
                <th>Services</th>
                <th>Rate</th>
                <th>Response</th>
                <th>Wallet</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td>
                    <b>{v.company}</b>
                  </td>
                  <td>{v.categories || "—"}</td>
                  <td className="num">{v.hourlyRate ?? "—"}</td>
                  <td>{v.responseMinutes ? `${v.responseMinutes} min` : "—"}</td>
                  <td className="small">
                    <Who address={v.address} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <VendorOffers />
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        eyebrow="Vendors"
        title="Add a maintenance vendor"
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <Action
              className="btn primary"
              disabled={!valid}
              onClick={async () => {
                const r = await sign<{ id: string; chain: { status: string; error: string | null } | null }>({
                  title: `Add ${form.company.trim()} as a maintenance vendor`,
                  request: (chainId) => api.post<TypedSignature>(path("/vendors/sign-request"), { ...body(), chainId }),
                  submit: (proof) => api.post(path("/vendors"), { ...body(), ...proof }),
                });
                if (!r) return;
                toast(r.chain?.status === "failed" ? `Added; OrdoTrust refused the credential: ${r.chain.error}` : "Vendor added", r.chain?.status === "failed" ? "bad" : "ok");
                setAdding(false);
                setForm({ address: "", company: "", categories: "", hourlyRate: "", responseMinutes: "" });
                await load();
              }}
            >
              Sign and add
            </Action>
          </div>
        }
      >
        <Field label="Vendor wallet" hint="A 0x address, or an ENS name that resolves to one" error={form.address && !addrOk ? "Enter a 0x address with 40 hex characters, or an ENS name" : null}>
          <NameInput accept="evm" value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="0x… or acme-steel.eth" />
        </Field>
        <Field label="Company">
          <input className="input" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
        </Field>
        <Field label="Services" hint="What they repair, e.g. CNC spindles, robots">
          <input className="input" value={form.categories} onChange={(e) => setForm({ ...form, categories: e.target.value })} />
        </Field>
        <div className="form-grid two">
          <Field label="Hourly rate" hint="In the work-order currency">
            <input className="input" inputMode="decimal" value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })} />
          </Field>
          <Field label="Response time (min)">
            <input className="input" type="number" min={1} value={form.responseMinutes} onChange={(e) => setForm({ ...form, responseMinutes: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
