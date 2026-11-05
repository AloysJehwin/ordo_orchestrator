import { describe, expect, it } from "vitest";
import { checkRouter, MockRouter, routerFromConfig, ZgRouter } from "../../src/chain/zg-router.js";
import { loadConfig } from "../../src/config.js";

type Provider = { address: string; is_healthy: boolean; trust_mode: string; verifiability: string; tee_type?: string; architecture?: { input_modalities: string[] } };
const fakeRouter = (providers: Record<string, Provider[]>, models: { id: string; verifiability: string }[], balance = "5000000000000000000") => {
  const calls: { path: string; body?: any }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, "");
    calls.push({ path: path + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json =
      path === "/providers" ? { data: providers[u.searchParams.get("model") ?? ""] ?? [] }
      : path === "/models" ? { data: models }
      : path === "/account/balance" ? { total_balance: balance, currency: "0g" }
      : path === "/api-keys" ? { key_id: "k1", key: "sk-1", expires_at: "2030-01-01T00:00:00Z" }
      : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, calls };
};
const teeml: Provider = { address: "0x1", is_healthy: true, trust_mode: "private", verifiability: "TeeML", tee_type: "TDX", architecture: { input_modalities: ["text", "image"] } };
const teetls: Provider = { address: "0x2", is_healthy: true, trust_mode: "verified", verifiability: "TeeTLS" };

describe("0G Router", () => {
  it("defaults to 0gm with whisper on mainnet, and mints keys for both", async () => {
    const { fetcher, calls } = fakeRouter({}, []);
    const r = routerFromConfig(loadConfig({ ZG_ROUTER_MGMT_KEY: "mk-test" } as NodeJS.ProcessEnv), fetcher);
    expect(r.model).toBe("0gm-1.0-35b-a3b");
    expect(r.audioModel).toBe("whisper-large-v3");
    await r.mintSessionKey("s", 60_000);
    expect(calls.find((c) => c.path === "/api-keys")?.body).toMatchObject({ trust_mode: "private", allowed_models: ["0gm-1.0-35b-a3b", "whisper-large-v3"] });
    expect(routerFromConfig(loadConfig({ ZG_ROUTER_MGMT_KEY: "mk-test", ZG_ROUTER_NETWORK: "testnet" } as NodeJS.ProcessEnv), fetcher).audioModel).toBeNull();
    expect(routerFromConfig(loadConfig({} as NodeJS.ProcessEnv))).toBeInstanceOf(MockRouter);
  });

  it("the doctor passes only with a healthy private-mode (TeeML) provider", async () => {
    const ok = fakeRouter({ "0gm-1.0-35b-a3b": [teeml] }, [{ id: "whisper-large-v3", verifiability: "TeeML" }]);
    const good = await checkRouter(new ZgRouter("mainnet", "mk-x", "0gm-1.0-35b-a3b", "", ok.fetcher, "whisper-large-v3"));
    expect(good.ok).toBe(true);
    expect(good.detail).toMatch(/1 TeeML provider, TDX, reads images/);

    const tls = fakeRouter({ "glm-5.3": [teetls] }, []);
    const bad = await checkRouter(new ZgRouter("mainnet", "mk-x", "glm-5.3", "", tls.fetcher));
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/no healthy private-mode \(TeeML\) provider: TeeTLS/);

    const empty = fakeRouter({ "0gm-1.0-35b-a3b": [teeml] }, [], "0");
    expect((await checkRouter(new ZgRouter("mainnet", "mk-x", "0gm-1.0-35b-a3b", "", empty.fetcher))).detail).toMatch(/account is empty/);
  });
});
