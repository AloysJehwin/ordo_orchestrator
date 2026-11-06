import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { api } from "./api";
import { AppProvider } from "./lib/app";
import { useRoute } from "./lib/router";
import { Open } from "./pages/Open";
import { Passport } from "./pages/Passport";
import { PowProof } from "./pages/Pow";
import { SignerProvider } from "./lib/sign";
import { SignIn } from "./pages/SignIn";
import { Setup } from "./pages/Setup";
import { Shell } from "./Shell";
import { requestAccountPick } from "./lib/wallet";
import type { Me, Meta, Status } from "./types";
import { ToastProvider } from "./ui/kit";
import "@fontsource-variable/inter/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import { labelTables } from "./ui/tables";

const lastSite = () => {
  try {
    return localStorage.getItem("ordo.site");
  } catch {
    return null;
  }
};
const saveSite = (id: string) => {
  try {
    localStorage.setItem("ordo.site", id);
  } catch {
    /* ignore */
  }
};

function Root() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<Me>("/v1/me"), api.get<Meta>("/v1/meta"), api.get<Status>("/v1/status")])
      .then(([m, mt, st]) => {
        setMe(m);
        setMeta(mt);
        setStatus(st);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (!me?.memberships.length) return;
    // a link naming its org (?site=…), such as the signing link the terminal agent opens, switches to it
    const wanted = route.query.get("site");
    const pick = me.memberships.find((m) => m.siteId === wanted)?.siteId ?? me.memberships.find((m) => m.siteId === (siteId ?? lastSite()))?.siteId ?? me.memberships[0]!.siteId;
    if (pick !== siteId) {
      if (pick === wanted) saveSite(pick);
      setSiteId(pick);
    }
  }, [me, siteId, route]);

  const signOut = async () => {
    await api.post("/v1/auth/logout").catch(() => undefined);
    window.location.hash = "";
    window.location.reload();
  };
  // signs out, then the sign-in page opens the wallet's account picker
  const switchAccount = () => {
    requestAccountPick();
    return signOut();
  };

  // a lot's public passport (the QR code on a shipped lot) needs no account
  if (route.page === "passport" && route.id) return <Passport runId={route.id} />;
  // a signed proof of work is public too; signing it (#/pow/<id>/sign) needs the contributor's account
  if (route.page === "pow" && route.id && route.sub !== "sign") return <PowProof id={route.id} />;
  // running pipelines and open orgs are public too: a newcomer browses them and joins
  if (route.page === "open") return <Open route={route} me={me} onSignedIn={setMe} />;
  if (error)
    return (
      <div className="boot">
        <p>Could not reach the Ordo API: {error}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!me || !meta || !status) return <div className="boot">Loading…</div>;
  if (!me.user) return <SignIn onSignedIn={setMe} />;
  // a join link (#/join?site=…) opens the org list for members of other orgs too
  if (!me.memberships.length || !siteId || route.page === "join")
    return (
      <Setup
        me={me}
        ensRoot={meta.ensRoot ?? null}
        onSignOut={signOut}
        onSwitchAccount={switchAccount}
        onCreated={async (id) => {
          saveSite(id);
          setMe(await api.get<Me>("/v1/me"));
          setSiteId(id);
          // the shell asks the new manager to sign the org's on-chain registration, then its machines
          window.location.hash = "#/pipelines?register=1&machines=1";
        }}
        onJoined={async (id) => {
          saveSite(id);
          setMe(await api.get<Me>("/v1/me"));
          setSiteId(id);
          window.location.hash = "#/pipelines";
        }}
      />
    );
  return (
    <AppProvider key={siteId} me={me} setMe={setMe} siteId={siteId} meta={meta} status={status}>
      <SignerProvider address={me.user.address} trust={status.trust}>
        <Shell
          onSignOut={signOut}
          onSwitchAccount={switchAccount}
          onSwitchSite={(id) => {
            saveSite(id);
            setSiteId(id);
            window.location.hash = "#/pipelines";
          }}
        />
      </SignerProvider>
    </AppProvider>
  );
}

labelTables();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ErrorBoundary where="app">
        <Root />
      </ErrorBoundary>
    </ToastProvider>
  </StrictMode>,
);
