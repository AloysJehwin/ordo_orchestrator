import { serve } from "@hono/node-server";
import { loadConfig, timerEnabled } from "./config.js";
import { createApp } from "./http/app.js";
import { buildSystem } from "./wiring.js";

const cfg = loadConfig();
const sys = await buildSystem(cfg);
for (const w of sys.warnings) console.warn(`[ordo] ${w}`);
const app = createApp(sys, {
  webDist: cfg.WEB_DIST,
  corsOrigins: cfg.CORS_ORIGINS ? cfg.CORS_ORIGINS.split(",").map((s) => s.trim()) : [],
  secureCookies: false,
  build: { env: cfg.VERCEL_ENV ?? "local", commit: cfg.VERCEL_GIT_COMMIT_SHA ?? null },
});

// Long-running mode: keep pulling data and advancing runs even when nobody is watching.
const timer = timerEnabled(cfg) ? setInterval(() => sys.advance().catch((e) => console.error("[ordo] advance", e)), cfg.TICK_MS) : null;

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  console.log(`[ordo] listening on :${info.port} · ${sys.rails.map((r) => `${r.rail}=${r.mode}`).join(" · ")}`);
});

const shutdown = async () => {
  if (timer) clearInterval(timer);
  server.close();
  await sys.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
