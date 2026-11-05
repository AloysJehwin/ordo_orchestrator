// Builds Ordo for Vercel with the Build Output API (v3): static console + one Node function.
// Vercel runs this as the build command and deploys .vercel/output as-is.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const out = ".vercel/output";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/functions/api.func`, { recursive: true });

// 1. Console (same-origin API, so VITE_API_BASE stays empty)
execSync("pnpm --filter @ordo/web build", { stdio: "inherit", env: { ...process.env, VITE_API_BASE: "" } });
cpSync("web/dist", `${out}/static`, { recursive: true });

// 2. API function: one ESM bundle with every dependency inlined
await build({
  entryPoints: ["server/src/vercel.ts"],
  outfile: `${out}/functions/api.func/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  loader: { ".yaml": "text" },
  // PGlite is the local-only database; pg-native is an optional pg addon. (0G SDKs load by name at runtime.)
  external: ["@electric-sql/pglite", "pg-native"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
// the spec-check circuit and its keys, read at runtime to prove lots met their criteria (server/src/core/spec-proofs.ts)
cpSync("server/zk", `${out}/functions/api.func/zk`, { recursive: true });
writeFileSync(
  `${out}/functions/api.func/.vc-config.json`,
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);
writeFileSync(`${out}/functions/api.func/package.json`, JSON.stringify({ type: "module" }));

// 3. Routing: API paths to the function, files from static, everything else to the SPA
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/(v1/.*|health)$", dest: "/api" },
        { handle: "filesystem" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);
console.log("✔ .vercel/output ready (static + functions/api.func)");
