/**
 * Vercel serverless entry. Bundled by scripts/vercel-build.mjs into .vercel/output/functions/api.func.
 * One instance builds the system once and serves many requests; all state lives in Postgres and the engine
 * advances under database leases, so any number of instances stay consistent.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import policyText from "../../policies/default.yaml";
import { rememberVercelOidcToken } from "./adapters/vercel-oidc.js";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { buildSystem } from "./wiring.js";

type Listener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let ready: Promise<Listener> | null = null;

async function init(): Promise<Listener> {
  const cfg = loadConfig();
  const sys = await buildSystem(cfg, { policyText });
  for (const w of sys.warnings) console.warn(`[ordo] ${w}`);
  const app = createApp(sys, {
    corsOrigins: cfg.CORS_ORIGINS ? cfg.CORS_ORIGINS.split(",").map((s) => s.trim()) : [],
    secureCookies: true,
    build: { env: cfg.VERCEL_ENV ?? "vercel", commit: cfg.VERCEL_GIT_COMMIT_SHA ?? null },
  });
  // Requests arrive as /v1/... (rewritten to this function) or /api/v1/...; serve both.
  return getRequestListener((req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      url.pathname = url.pathname.slice(4);
      return app.fetch(new Request(url, req));
    }
    return app.fetch(req);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // the deployment's OIDC identity, for Workload Identity Federation with the Claude API
  rememberVercelOidcToken(req.headers["x-vercel-oidc-token"]);
  ready ??= init().catch((e) => {
    ready = null; // retry on the next request, e.g. after the database wakes up
    throw e;
  });
  let listener: Listener;
  try {
    listener = await ready;
  } catch (e) {
    // answer in JSON, not with the platform's plain-text error page, so the console can show what is wrong
    console.error("[ordo] startup failed", e);
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: `Ordo API failed to start: ${e instanceof Error ? e.message : String(e)}` }));
    return;
  }
  await listener(req, res);
}
