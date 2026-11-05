import { useEffect, useState } from "react";
import { api } from "../api";
import { dateTime, shortAddr } from "../lib/format";
import { fromUnits } from "../lib/wallet";
import type { PassportStatus, PublicPassport, SpecProof, StageWork } from "../types";
import { QR } from "../ui/QR";
import { SpecBand } from "../ui/SpecBand";

const STATUS: Record<PassportStatus, [string, string]> = {
  in_production: ["In production", "warn"],
  held: ["On hold", "bad"],
  completed: ["Completed", "ok"],
  aborted: ["Stopped", "bad"],
  shipped: ["Shipped", "ok"],
};
const MEANING: Record<string, string> = { performed: "Performed by", reviewed: "Reviewed by", approved: "Approved by" };

const Check = ({ ok, children }: { ok: boolean | null; children: React.ReactNode }) => (
  <li className={`pp-check ${ok === null ? "" : ok ? "ok" : "bad"}`}>
    <span aria-hidden>{ok === null ? "·" : ok ? "✓" : "✕"}</span>
    <span>{children}</span>
  </li>
);

type BrowserCheck = { state: "idle" } | { state: "checking" } | { state: "done"; ok: number; of: number } | { state: "error"; message: string };

const MEASUREMENT_TYPES = {
  OrdoMeasurement: [
    { name: "site", type: "string" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "asset", type: "string" },
    { name: "criterion", type: "string" },
    { name: "commitment", type: "uint256" },
    { name: "anchor", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;

/**
 * Re-check every proof here, with snarkjs and the published verification key, so a buyer need not trust Ordo's
 * server: each proof must verify for the commitment shown, and where the instrument's gateway (or the operator) signed
 * that commitment as an OrdoMeasurement, the signature must recover the signer shown.
 */
async function verifyInBrowser(proofs: SpecProof[]): Promise<{ ok: number; of: number }> {
  const [{ groth16 }, { recoverTypedDataAddress }, key] = await Promise.all([import("snarkjs"), import("viem"), api.get<{ verificationKey: unknown }>("/v1/public/zk/spec-check")]);
  let ok = 0;
  for (const z of proofs) {
    if (!z.publicSignals) continue;
    const m = z.measurement;
    if (m) {
      const signer = await recoverTypedDataAddress({
        domain: { name: "Ordo", version: "2" },
        types: MEASUREMENT_TYPES,
        primaryType: "OrdoMeasurement",
        message: { site: m.site, runId: m.runId, stage: m.stage, asset: m.asset, criterion: m.criterion, commitment: BigInt(m.commitment), anchor: m.anchor as `0x${string}`, signedAt: BigInt(m.signedAt) },
        signature: m.signature as `0x${string}`,
      }).catch(() => null);
      if (signer?.toLowerCase() !== z.signer?.toLowerCase() || z.publicSignals[3] !== m.commitment) continue;
    }
    if (await groth16.verify(key.verificationKey, z.publicSignals, z.proof as never).catch(() => false)) ok++;
  }
  return { ok, of: proofs.length };
}

const READING_TYPES = {
  OrdoReading: [
    { name: "site", type: "string" },
    { name: "runId", type: "string" },
    { name: "stage", type: "string" },
    { name: "asset", type: "string" },
    { name: "commitment", type: "uint256" },
    { name: "anchor", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;
/**
 * Proof of work, re-checked here: each stage reading's signature must recover the signer shown, and its proof must
 * verify for the commitment that signer signed, with the published stage-check key.
 */
async function verifyWorkInBrowser(work: StageWork[]): Promise<{ ok: number; of: number }> {
  const [{ groth16 }, { recoverTypedDataAddress }, key] = await Promise.all([import("snarkjs"), import("viem"), api.get<{ verificationKey: unknown }>("/v1/public/zk/stage-check")]);
  let ok = 0;
  for (const w of work) {
    const r = w.reading;
    const signer = await recoverTypedDataAddress({
      domain: { name: "Ordo", version: "2" },
      types: READING_TYPES,
      primaryType: "OrdoReading",
      message: { site: r.site, runId: r.runId, stage: r.stage, asset: r.asset, commitment: BigInt(r.commitment), anchor: r.anchor as `0x${string}`, signedAt: BigInt(r.signedAt) },
      signature: r.signature as `0x${string}`,
    }).catch(() => null);
    if (signer?.toLowerCase() !== w.signer.toLowerCase() || !w.publicSignals || w.publicSignals[1] !== r.commitment) continue;
    if (await groth16.verify(key.verificationKey, w.publicSignals, w.proof as never).catch(() => false)) ok++;
  }
  return { ok, of: work.length };
}

/** The lot's public passport: what anyone scanning the QR code on a shipped lot sees, without signing in. */
export function Passport({ runId }: { runId: string }) {
  const [p, setP] = useState<PublicPassport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserCheck>({ state: "idle" });
  const [workCheck, setWorkCheck] = useState<BrowserCheck>({ state: "idle" });
  useEffect(() => {
    api
      .get<PublicPassport>(`/v1/public/passports/${encodeURIComponent(runId)}`)
      .then(setP)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [runId]);

  if (error)
    return (
      <div className="pp">
        <div className="pp-brand">Ordo · Lot passport</div>
        <p className="field-e">{error}</p>
      </div>
    );
  if (!p) return <div className="boot">Loading passport…</div>;
  const x = p.passport;
  const [label, tone] = STATUS[x.status];
  const proof = x.proof;
  const criteria = x.stages.flatMap((s) => s.criteria);
  const met = criteria.filter((c) => c.ok === true);
  // a range or envelope carries two proofs, one per bound; both must verify
  const proven = met.flatMap((c) => [c.zk, c.zkMax].flatMap((z) => (z?.status === "proven" ? [z] : [])));
  const runBrowserCheck = () => {
    setBrowser({ state: "checking" });
    verifyInBrowser(proven)
      .then((r) => setBrowser({ state: "done", ...r }))
      .catch((e) => setBrowser({ state: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  const work = x.stages.flatMap((s) => (s.work ? [s.work] : []));
  const workProven = work.filter((w) => w.status === "proven");
  const runWorkCheck = () => {
    setWorkCheck({ state: "checking" });
    verifyWorkInBrowser(workProven)
      .then((r) => setWorkCheck({ state: "done", ...r }))
      .catch((e) => setWorkCheck({ state: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  const pageUrl = x.pageUrl.startsWith("http") ? x.pageUrl : `${window.location.origin}${x.pageUrl}`;
  return (
    <div className="pp">
      <header className="pp-head">
        <div>
          <div className="pp-brand">Ordo · Lot passport</div>
          <h1>{p.name}</h1>
          <p className="muted">
            {x.quantity} units of <b>{x.product.name}</b> v{x.product.version} · {x.product.category}
            {x.site ? ` · made at ${x.site}` : ""}
          </p>
          <p className="small muted">
            Started {dateTime(x.startedAt)}
            {x.finishedAt ? ` · finished ${dateTime(x.finishedAt)}` : ""}
          </p>
          <span className={`tag ${tone}`}>{label}</span>
        </div>
        <div className="pp-qr">
          <QR value={pageUrl} label={`QR code for ${p.name}`} />
          <span className="faint small mono">{runId}</span>
        </div>
      </header>

      <section className="pp-card">
        <h2>Verification</h2>
        <ul className="pp-checks">
          <Check ok={proof.chainIntact}>
            Ordo's ledger re-walked from the first entry to #{proof.headSeq}: {proof.chainIntact ? "every hash links" : "the chain is broken"} · this lot has {proof.entries} entries
          </Check>
          {proof.anchor ? (
            <Check ok={proof.anchor.matchesChain && proof.anchor.external.ok}>
              Anchored at #{proof.anchor.toSeq} ({proof.anchor.kind === "hedera-hcs" ? "Hedera Consensus Service" : "signed checkpoint"}):{" "}
              {proof.anchor.url ? (
                <a href={proof.anchor.url} target="_blank" rel="noreferrer">
                  {proof.anchor.ref}
                </a>
              ) : (
                <span className="mono">{proof.anchor.ref}</span>
              )}{" "}
              · {proof.anchor.external.detail}
            </Check>
          ) : (
            <Check ok={null}>Not anchored yet: the ledger is anchored every few minutes</Check>
          )}
          {met.length > 0 && (
            <Check ok={proven.length === met.length && proven.every((z) => z.verified) ? true : proven.some((z) => z.verified === false) ? false : null}>
              {proven.length} of {met.reduce((n, c) => n + (c.zkMax ? 2 : 1), 0)} bounds across {met.length} criteria met are proven in zero knowledge: each proof shows the measurement meets its target without
              revealing it, against a commitment recorded in the ledger when the stage closed, signed by the instrument&apos;s gateway or the operator where the value was measured at the source. A range or envelope proves each bound
              separately.{" "}
              {proven.length > 0 &&
                (browser.state === "idle" ? (
                  <button type="button" className="link" onClick={runBrowserCheck}>
                    Verify in this browser
                  </button>
                ) : browser.state === "checking" ? (
                  <span className="muted">Verifying…</span>
                ) : browser.state === "done" ? (
                  <b>
                    {browser.ok} of {browser.of} verified in this browser
                  </b>
                ) : (
                  <span className="field-e">{browser.message}</span>
                ))}
            </Check>
          )}
          {work.length > 0 && (
            <Check ok={workProven.length === work.length && workProven.every((w) => w.verified && w.matches) ? true : work.some((w) => w.verified === false || w.status === "not_met") ? false : null}>
              Proof of work: {work.length} of {x.stages.length} stages had their counts signed where they were made ({work.filter((w) => w.signerKind === "device").length} by the machine&apos;s own gateway), and {workProven.length} are proven in
              zero knowledge to meet the stage&apos;s criteria without revealing the counts.{" "}
              {workProven.length > 0 &&
                (workCheck.state === "idle" ? (
                  <button type="button" className="link" onClick={runWorkCheck}>
                    Verify the work in this browser
                  </button>
                ) : workCheck.state === "checking" ? (
                  <span className="muted">Verifying…</span>
                ) : workCheck.state === "done" ? (
                  <b>
                    {workCheck.ok} of {workCheck.of} signatures and proofs verified in this browser
                  </b>
                ) : (
                  <span className="field-e">{workCheck.message}</span>
                ))}
            </Check>
          )}
          {x.nft ? (
            <Check ok={x.nft.serial !== null && !x.nft.error}>
              Passport NFT{" "}
              {x.nft.url ? (
                <a href={x.nft.url} target="_blank" rel="noreferrer">
                  {x.nft.tokenId} #{x.nft.serial}
                </a>
              ) : (
                <span className="mono">{x.nft.tokenId}</span>
              )}
              {x.nft.serial === null ? " · minting" : ` · on-chain status ${x.nft.onchainStatus?.replace("_", " ")}`}
            </Check>
          ) : (
            <Check ok={null}>No NFT: this deployment keeps passports in Ordo only</Check>
          )}
          {x.ens && (
            <Check ok={x.ens.releases.every((r) => r.status === "done") ? true : x.ens.releases.some((r) => r.status === "failed") ? false : null}>
              ENS name{" "}
              <a href={x.ens.url} target="_blank" rel="noreferrer" className="mono">
                {x.ens.name}
              </a>
              {x.ens.releases.length === 0
                ? " · resolves to this passport"
                : x.ens.releases.map((r) => (
                    <span key={r.packageId}>
                      {" · "}
                      {r.txUrl ? (
                        <a href={r.txUrl} target="_blank" rel="noreferrer">
                          release recorded against the signers' ENS credentials
                        </a>
                      ) : r.status === "failed" ? (
                        `release not recorded: ${r.error}`
                      ) : (
                        "recording the release on ENS"
                      )}
                    </span>
                  ))}
            </Check>
          )}
          {x.shipment && (
            <Check ok>
              Shipped {dateTime(x.shipment.at)} to <span className="mono">{x.shipment.to}</span>
              {x.shipment.txUrl && (
                <>
                  {" "}
                  ·{" "}
                  <a href={x.shipment.txUrl} target="_blank" rel="noreferrer">
                    {x.shipment.pending ? "NFT airdrop, awaiting the customer's claim" : "NFT delivered"}
                  </a>
                </>
              )}
            </Check>
          )}
        </ul>
        <p className="faint small">Checked {dateTime(proof.checkedAt)}.</p>
      </section>

      {x.releases.length > 0 && (
        <section className="pp-card">
          <h2>Released by validation</h2>
          {x.releases.map((r) => (
            <div key={r.id} className="pp-release">
              <b>
                VP-{r.number} · {r.title}
              </b>{" "}
              <span className="muted small">
                {r.type} · released {dateTime(r.releasedAt)}
              </span>
              {r.onchain && (
                <span className="small">
                  {" "}
                  ·{" "}
                  {r.onchain.txUrl ? (
                    <a href={r.onchain.txUrl} target="_blank" rel="noreferrer">
                      recorded on-chain
                    </a>
                  ) : (
                    "recorded on-chain"
                  )}
                </span>
              )}
              <ul className="pp-signers">
                {r.signers.map((s) => (
                  <li key={s.meaning}>
                    {MEANING[s.meaning] ?? s.meaning} <span className="mono" title={s.address}>{s.ens ?? shortAddr(s.address)}</span>
                    {s.stake && (
                      <span className={`tag ${s.stake.active ? "ok" : "warn"}`}>
                        {s.stake.active ? "staked" : "not staked now"} {fromUnits(s.stake.amount, s.stake.decimals)} {s.stake.symbol}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {r.statement && (
                <p className="faint small">
                  All three signed lot <span className="mono">{r.statement.lot || "—"}</span>, content <span className="mono">{shortAddr(r.statement.contentHash)}</span>
                  {r.statement.stagesProven.length > 0 ? (
                    <>
                      {" "}
                      and the proofs of stage{r.statement.stagesProven.length === 1 ? "" : "s"} {r.statement.stagesProven.join(", ")} (root <span className="mono">{shortAddr(r.statement.proofRoot)}</span>)
                    </>
                  ) : null}
                  .
                </p>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="pp-card">
        <h2>Stage by stage</h2>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Stage</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {x.stages.map((s) => (
                <tr key={s.code}>
                  <td>
                    <b>{s.code}</b> {s.name}
                    <div className="faint small">{s.resource}</div>
                    {s.criteria.map((c) => (
                      <div key={c.label} className="small pp-crit">
                        <span>
                          {c.ok === null ? "·" : c.ok ? "✓" : "✕"} {c.label} {c.target}
                        </span>
                        {/* the acceptable band is public; where the measurement fell is not */}
                        <SpecBand compact lo={c.band?.lo ?? null} hi={c.band?.hi ?? null} value={null} ok={c.ok} unit={c.unit} label={`${c.label} ${c.target}`} />
                        {[c.zk, c.zkMax].map(
                          (z, i) =>
                            z && (
                              <span key={i} className={`tag ${z.verified ? "ok" : z.status === "pending" ? "warn" : "bad"}`} title={z.detail}>
                                {z.status === "proven" ? (z.verified ? "ZK proof verified" : "ZK proof invalid") : z.status === "pending" ? "ZK proof pending" : "no ZK proof"}
                                {c.zkMax ? (i === 0 ? " · lower" : " · upper") : ""}
                              </span>
                            ),
                        )}
                        {c.zk && (
                          <span className="faint pp-signer">
                            {c.zk.signerKind === "ordo" ? (
                              "value committed by Ordo"
                            ) : (
                              <>
                                value signed by {c.zk.signerKind === "device" ? "the instrument's gateway" : "the operator"} <span className="mono">{c.zk.signerEns ?? shortAddr(c.zk.signer ?? "")}</span>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                    ))}
                    {s.work && (
                      <div className="small">
                        <span className={`tag ${s.work.status === "proven" && s.work.verified ? "ok" : s.work.status === "pending" ? "warn" : "bad"}`} title={s.work.detail}>
                          {s.work.status === "proven" ? (s.work.verified ? "Work proven" : "Work proof invalid") : s.work.status === "pending" ? "Work proof pending" : s.work.status === "not_met" ? "Signed counts miss a criterion" : "No work proof"}
                        </span>{" "}
                        counts signed by {s.work.signerKind === "device" ? "the machine's gateway" : "the operator"} <span className="mono">{s.work.signerEns ?? shortAddr(s.work.signer)}</span>
                        {!s.work.matches && <span className="bad-text"> · differ from Ordo&apos;s record</span>}
                      </div>
                    )}
                  </td>
                  <td>{s.state.replaceAll("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pp-card">
        <h2>Signed decisions</h2>
        {x.signed.length === 0 ? (
          <p className="muted small">No person signed a decision on this lot.</p>
        ) : (
          <ul className="pp-list">
            {x.signed.map((d, i) => (
              <li key={`${d.ledgerSeq ?? i}`}>
                <span>{d.summary}</span>
                <span className="faint small">
                  {" "}
                  · signed by <span className="mono" title={d.by}>{d.ens ?? shortAddr(d.by)}</span> · {dateTime(d.at)}
                  {d.ledgerSeq ? ` · ledger #${d.ledgerSeq}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="faint small">Agents recorded {x.agentDecisions} further decisions on this lot. Every human decision is an EIP-712 signature from the person's own wallet.</p>
      </section>
      <footer className="faint small pp-foot">Ordo · autonomous manufacturing orchestration, with proof</footer>
    </div>
  );
}
