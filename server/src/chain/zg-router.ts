/**
 * 0G Private Computer: the 0G Router (router-api.0g.ai), an OpenAI-compatible gateway whose providers serve models in
 * TEEs. Ordo holds a management key (`mk-…`, scopes account:read, keys:read, keys:create, keys:manage) on the account that
 * pays, and mints a short-lived inference key (`sk-…`) per proof-of-work session: pinned to trust mode `private` (TEE
 * isolation, end-to-end encryption, zero data retention), to one model, with a credit cap and an expiry. The contributor's
 * terminal agent uses that key; Ordo revokes it when the session ends. API reference: https://0gfoundation.github.io/0g-router/
 *
 * Each answer the agent receives carries `x_0g_trace` (`request_id`, `provider`, `tee_verified` when the request asked
 * `verify_tee: true`) and the provider's `ZG-Res-Key` header. The agent sends those receipts with the record; Ordo keeps
 * them and shows whether every turn was served by a TEE provider whose attestation the Router verified.
 */
import type { Config } from "../config.js";

export const ROUTER_URL = { mainnet: "https://router-api.0g.ai/v1", testnet: "https://router-api-testnet.integratenetwork.work/v1" } as const;
export const ROUTER_CONSOLE = { mainnet: "https://pc.0g.ai", testnet: "https://pc.testnet.0g.ai" } as const;

export interface RouterModel {
  id: string;
  verifiability: string | null;
  teeAttested: boolean;
  teeType: string | null;
  e2ee: string | null;
  providers: number;
}
export interface RouterBalance {
  total: string;
  currency: string;
  /** whole units for display: 0G (from wei) or USD (from micro-USD) */
  display: string;
}
export interface SessionKey {
  keyId: string;
  key: string;
  expiresAt: string;
}
/** One Router answer as the terminal agent recorded it. */
export interface Receipt {
  resKey: string | null;
  requestId: string | null;
  provider: string | null;
  providerIdentity: string | null;
  teeVerified: boolean | null;
  model: string | null;
  at: string;
  requestSha256: string;
  responseSha256: string;
}

/** A provider serving a model, from `GET /v1/providers?model=`. Private mode needs one with trust mode `private` (TeeML). */
export interface RouterProvider {
  address: string;
  healthy: boolean;
  trustMode: string | null;
  verifiability: string | null;
  teeType: string | null;
  inputs: string[];
}

export interface Router {
  readonly network: "mainnet" | "testnet" | "mock";
  readonly baseUrl: string;
  readonly model: string;
  /** speech to text for voice notes (whisper-large-v3), or null */
  readonly audioModel: string | null;
  mintSessionKey(name: string, ttlMs: number): Promise<SessionKey>;
  revokeKey(keyId: string): Promise<void>;
  balance(): Promise<RouterBalance>;
  models(): Promise<RouterModel[]>;
  providers(model: string): Promise<RouterProvider[]>;
}

export const PRIVATE_MODE = (p: RouterProvider) => p.trustMode === "private" || p.verifiability === "TeeML";

const units = (v: string, currency: string) => {
  try {
    const n = BigInt(v.split(".")[0] ?? "0");
    if (currency === "usd") return `${(Number(n) / 1e6).toFixed(2)} USD`;
    return `${(Number(n / 10n ** 12n) / 1e6).toFixed(4)} 0G`;
  } catch {
    return v;
  }
};

/** The 0G Router, through Ordo's management key. */
export class ZgRouter implements Router {
  readonly baseUrl: string;
  constructor(
    readonly network: "mainnet" | "testnet",
    private mgmtKey: string,
    readonly model: string,
    /** most one session may spend, in the account's units (0G wei or micro-USD); empty = no cap */
    private creditLimit: string,
    private fetcher: typeof fetch = fetch,
    readonly audioModel: string | null = null,
  ) {
    this.baseUrl = ROUTER_URL[network];
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.mgmtKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { message?: string; code?: string } | string; message?: string };
        msg = (typeof j.error === "string" ? j.error : (j.error?.message ?? j.error?.code)) ?? j.message ?? msg;
      } catch {
        /* not JSON */
      }
      throw new Error(`0G Router ${method} ${path}: HTTP ${res.status} ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async mintSessionKey(name: string, ttlMs: number): Promise<SessionKey> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const r = await this.call<{ key_id?: string; key?: string; expires_at?: string }>("POST", "/api-keys", {
      name: name.slice(0, 60),
      trust_mode: "private",
      allowed_models: this.audioModel ? [this.model, this.audioModel] : [this.model],
      expiration: expiresAt,
      reset_period: "never",
      ...(this.creditLimit ? { credit_limit: this.creditLimit } : {}),
    });
    if (!r.key || !r.key_id) throw new Error("0G Router did not return a key");
    return { keyId: r.key_id, key: r.key, expiresAt: r.expires_at ?? expiresAt };
  }

  async revokeKey(keyId: string) {
    await this.call("DELETE", `/api-keys/${encodeURIComponent(keyId)}`);
  }

  async balance(): Promise<RouterBalance> {
    const r = await this.call<{ total_balance?: string; balance?: string; currency?: string }>("GET", "/account/balance");
    const total = r.total_balance ?? r.balance ?? "0";
    const currency = r.currency ?? "0g";
    return { total, currency, display: units(total, currency) };
  }

  async models(): Promise<RouterModel[]> {
    const r = await this.call<{ data?: { id: string; verifiability?: string; tee_attested?: boolean; tee_type?: string; e2ee?: string; provider_count?: number }[] }>("GET", "/models");
    return (r.data ?? []).map((m) => ({
      id: m.id,
      verifiability: m.verifiability ?? null,
      teeAttested: Boolean(m.tee_attested),
      teeType: m.tee_type ?? null,
      e2ee: m.e2ee ?? null,
      providers: m.provider_count ?? 0,
    }));
  }

  async providers(model: string): Promise<RouterProvider[]> {
    type P = { address: string; is_healthy?: boolean; trust_mode?: string; verifiability?: string; tee_type?: string; architecture?: { input_modalities?: string[] } };
    const r = await this.call<{ data?: P[] }>("GET", `/providers?model=${encodeURIComponent(model)}`);
    return (r.data ?? []).map((p) => ({
      address: p.address,
      healthy: p.is_healthy !== false,
      trustMode: p.trust_mode ?? null,
      verifiability: p.verifiability ?? null,
      teeType: p.tee_type ?? null,
      inputs: p.architecture?.input_modalities ?? [],
    }));
  }
}

/**
 * No Router: sessions still work end to end with the terminal agent's scripted interviewer, which it picks by itself
 * when the session's network is "mock".
 * Keys are placeholders and receipts are marked unverified, so nothing claims a TEE served it.
 */
export class MockRouter implements Router {
  readonly network = "mock" as const;
  readonly baseUrl = "mock://router";
  readonly model = "ordo-mock-interviewer";
  readonly audioModel = null;
  revoked: string[] = [];
  async mintSessionKey(_name: string, ttlMs: number): Promise<SessionKey> {
    const id = `mock_${Math.random().toString(36).slice(2, 10)}`;
    return { keyId: id, key: `sk-mock-${id}`, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  }
  async revokeKey(keyId: string) {
    this.revoked.push(keyId);
  }
  async balance(): Promise<RouterBalance> {
    return { total: "0", currency: "mock", display: "no Router configured" };
  }
  async models(): Promise<RouterModel[]> {
    return [{ id: this.model, verifiability: null, teeAttested: false, teeType: null, e2ee: null, providers: 0 }];
  }
  async providers(): Promise<RouterProvider[]> {
    return [];
  }
}

export function routerFromConfig(cfg: Config, fetcher?: typeof fetch): Router {
  if (!cfg.ZG_ROUTER_MGMT_KEY) return new MockRouter();
  const audio = cfg.ZG_ROUTER_AUDIO_MODEL ?? (cfg.ZG_ROUTER_NETWORK === "mainnet" ? "whisper-large-v3" : "");
  return new ZgRouter(cfg.ZG_ROUTER_NETWORK, cfg.ZG_ROUTER_MGMT_KEY, cfg.ZG_ROUTER_MODEL, cfg.ZG_ROUTER_CREDIT_LIMIT ?? "", fetcher, audio || null);
}

/**
 * Whether private-mode sessions can run, for the doctor: the chat model has a healthy provider in trust mode `private`
 * (TeeML; a TeeTLS-only model fails every private request), the audio model too when one is set, and the account has
 * credits.
 */
export async function checkRouter(r: Router): Promise<{ ok: boolean; detail: string }> {
  if (r.network === "mock") return { ok: false, detail: "no ZG_ROUTER_MGMT_KEY: proof-of-work sessions use the scripted interviewer" };
  const [bal, chat, audio] = await Promise.all([r.balance(), r.providers(r.model), r.audioModel ? r.models() : Promise.resolve(null)]);
  const funded = BigInt(bal.total.split(".")[0] || "0") > 0n;
  const ok = chat.filter((p) => p.healthy && PRIVATE_MODE(p));
  const problems: string[] = [];
  if (!chat.length) problems.push(`model ${r.model} is not on the ${r.network} Router`);
  else if (!ok.length) problems.push(`${r.model} has no healthy private-mode (TeeML) provider: ${[...new Set(chat.map((p) => p.verifiability ?? p.trustMode ?? "?"))].join(", ")}`);
  const audioOk = !r.audioModel || audio?.some((m) => m.id === r.audioModel && /teeml/i.test(m.verifiability ?? ""));
  if (!audioOk) problems.push(`audio model ${r.audioModel} is not served in private mode`);
  if (!funded) problems.push("account is empty");
  const tee = [...new Set(ok.map((p) => p.teeType).filter(Boolean))].join("/");
  const images = ok.some((p) => p.inputs.includes("image"));
  return {
    ok: problems.length === 0,
    detail: `${r.network} · ${r.model} (${ok.length} TeeML provider${ok.length === 1 ? "" : "s"}${tee ? `, ${tee}` : ""}${images ? ", reads images" : ""})${r.audioModel ? ` · ${r.audioModel}` : ""} · balance ${bal.display}${problems.length ? ` · ${problems.join(" · ")}` : ""}`,
  };
}
