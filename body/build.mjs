// Bundles the body into one file, dist/body.mjs, with the server modules it shares (the edge gateway, the outcome
// types) inlined. ffmpeg-static stays outside: it is optional, and without it (or ffmpeg on PATH) video is skipped.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/body.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  external: ["ffmpeg-static"],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
console.log("✔ body/dist/body.mjs");
