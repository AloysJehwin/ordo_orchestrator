// Serves .vercel/output locally the way Vercel routes it, to rehearse a deployment.
//   DATABASE_URL=postgres://... VERCEL=1 pnpm vercel-local
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const root = resolve(".vercel/output");
const { default: handler } = await import(join(root, "functions/api.func/index.mjs"));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json" };
const port = Number(process.env.PORT ?? 3000);

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (/^\/(v1\/.*|health)$/.test(path)) return handler(req, res);
  const file = join(root, "static", path);
  const target = existsSync(file) && statSync(file).isFile() ? file : join(root, "static/index.html");
  res.writeHead(200, { "content-type": types[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
}).listen(port, () => console.log(`[vercel-local] http://localhost:${port}`));
