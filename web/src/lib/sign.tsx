import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Spinner, useToast } from "../ui/kit";
import type { ReleaseTyped, TrustChainInfo, TypedSignature } from "../types";
import { discoverWallets, ensureChain, hasActiveWallet, rememberedWallet, setActiveWallet, short, signTyped, walletChainId, type WalletInfo } from "./wallet";

export interface SignJob<T> {
  /** What the person is doing, in plain words. */
  title: string;
  /** Ask the server for the exact typed data (it embeds a single-use nonce). */
  request: (chainId: number | undefined) => Promise<TypedSignature>;
  /** Send the signature back with the action. */
  submit: (proof: { nonce: string; signature: `0x${string}` }) => Promise<T>;
  done?: string;
}

type Runner = <T>(job: SignJob<T>) => Promise<T | null>;
const SignCtx = createContext<Runner>(async () => null);
export const useSign = () => useContext(SignCtx);

/**
 * Every decision that matters is signed with the person's wallet (EIP-712). This dialog shows
 * exactly what is being signed before the wallet prompt opens.
 */
export function SignerProvider(props: { address: string; trust: TrustChainInfo | null; children: ReactNode }) {
  const toast = useToast();
  const [job, setJob] = useState<SignJob<unknown> | null>(null);
  const [typed, setTyped] = useState<TypedSignature | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signing" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const resolver = useRef<((v: unknown) => void) | null>(null);

  useEffect(() => discoverWallets(setWallets), []);
  useEffect(() => {
    if (hasActiveWallet() || !wallets.length) return;
    const remembered = rememberedWallet();
    const w = wallets.find((x) => x.id === remembered) ?? (wallets.length === 1 ? wallets[0] : undefined);
    if (w) setActiveWallet(w);
  }, [wallets]);

  const load = useCallback(async (j: SignJob<unknown>) => {
    setState("loading");
    setError(null);
    try {
      setTyped(await j.request(await walletChainId()));
      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, []);

  const run: Runner = useCallback(
    <T,>(j: SignJob<T>) =>
      new Promise<T | null>((resolve) => {
        resolver.current = resolve as (v: unknown) => void;
        setJob(j as SignJob<unknown>);
        void load(j as SignJob<unknown>);
      }),
    [load],
  );
  const close = (v: unknown = null) => {
    resolver.current?.(v);
    resolver.current = null;
    setJob(null);
    setTyped(null);
  };
  const sign = async () => {
    if (!job || !typed) return;
    setState("signing");
    setError(null);
    try {
      // wallets refuse typed data for a chain they are not on; a release statement names no chain
      if ("chainId" in typed.domain) await ensureChain(typed.domain.chainId, props.trust);
      const signature = await signTyped(typed, props.address);
      const out = await job.submit({ nonce: typed.message.nonce, signature });
      toast(job.done ?? "Signed and recorded in the ledger", "ok");
      close(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/rejected|denied/i.test(msg) ? "You cancelled the signature in your wallet." : msg);
      // the server consumes the nonce only on success, but a fresh one avoids any doubt
      setState("ready");
      if (/expired|used|unknown/i.test(msg)) void load(job);
    }
  };

  const needPick = !hasActiveWallet() && wallets.length > 1;
  return (
    <SignCtx.Provider value={run}>
      {props.children}
      <Modal
        open={Boolean(job)}
        onClose={() => close()}
        eyebrow="Electronic signature · EIP-712"
        title={job?.title ?? ""}
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => close()}>
              Cancel
            </button>
            <button type="button" className="btn accent" disabled={state !== "ready" || needPick || !wallets.length} onClick={sign}>
              {state === "signing" ? (
                <>
                  <Spinner /> Waiting for wallet…
                </>
              ) : (
                "Sign with wallet"
              )}
            </button>
          </div>
        }
      >
        {state === "loading" && (
          <p className="muted">
            <Spinner /> Preparing the signature request…
          </p>
        )}
        {typed?.primaryType === "OrdoRelease" && <ReleaseView typed={typed} address={props.address} />}
        {typed?.primaryType === "OrdoSignature" && (
          <div className="sigview">
            <p className="sig-meaning">{typed.message.meaning}</p>
            <dl className="kv">
              <dt>Signer</dt>
              <dd className="mono">{short(props.address)}</dd>
              <dt>Action</dt>
              <dd className="mono">{typed.message.action}</dd>
              <dt>Entity</dt>
              <dd className="mono">{typed.message.entity}</dd>
              {typed.message.comment && (
                <>
                  <dt>Comment</dt>
                  <dd>{typed.message.comment}</dd>
                </>
              )}
              <dt>Nonce</dt>
              <dd className="mono">{typed.message.nonce}</dd>
              <dt>Chain</dt>
              <dd className="mono">
                {typed.domain.chainId}
                {props.trust?.chainId === typed.domain.chainId ? ` · ${props.trust.name} · verified by OrdoTrust` : ""}
              </dd>
            </dl>
            <p className="faint small">Signing costs no gas and sends no transaction. The signature is verified by Ordo, stored with the decision, and hash-chained into the ledger.</p>
          </div>
        )}
        {needPick && (
          <div className="wallet-pick">
            <span className="label">Choose the wallet you signed in with</span>
            {wallets.map((w) => (
              <button type="button" key={w.id} className="btn" onClick={() => (setActiveWallet(w), setWallets([...wallets]))}>
                {w.icon && <img src={w.icon} alt="" width={16} height={16} />} {w.name}
              </button>
            ))}
          </div>
        )}
        {!wallets.length && state !== "loading" && <p className="field-e">No browser wallet found. Install MetaMask, Rabby or another EIP-1193 wallet to sign.</p>}
        {error && <p className="field-e">{error}</p>}
      </Modal>
    </SignCtx.Provider>
  );
}

const ZERO = `0x${"00".repeat(32)}`;
/** A release statement: exactly what is released, the same for all three signers. */
function ReleaseView({ typed, address }: { typed: ReleaseTyped; address: string }) {
  const m = typed.message;
  return (
    <div className="sigview">
      <p className="sig-meaning">{m.statement}</p>
      <dl className="kv">
        <dt>Signer</dt>
        <dd className="mono">{short(address)}</dd>
        <dt>Lot</dt>
        <dd className="mono">{m.lot || "none"}</dd>
        <dt>Content hash</dt>
        <dd className="mono">{short(m.contentHash)}</dd>
        <dt>Stage proofs</dt>
        <dd className="mono">{m.proofRoot === ZERO ? "none: no stage was signed at its source" : `root ${short(m.proofRoot)}`}</dd>
        {m.comment && (
          <>
            <dt>Comment</dt>
            <dd>{m.comment}</dd>
          </>
        )}
        <dt>Valid until</dt>
        <dd>{new Date(Number(m.deadline) * 1000).toLocaleDateString()}</dd>
      </dl>
      <p className="faint small">
        Signing costs no gas. This statement names no chain: OrdoTrust and the lot&apos;s ENS name both record it, and the ENS resolver verifies each stage proof under the root before it accepts the release.
      </p>
    </div>
  );
}
