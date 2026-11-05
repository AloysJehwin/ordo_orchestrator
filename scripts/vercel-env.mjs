// Manage Ordo's environment variables in Vercel — the single source of truth for every environment.
//
//   node scripts/vercel-env.mjs status                          which variables are set in each environment
//   node scripts/vercel-env.mjs push <file> <targets>           upsert a dotenv file, e.g. push .env.preview preview
//                                                               targets: production | preview | development (comma-separated)
//   node scripts/vercel-env.mjs sync <map> <environment>        copy the secrets a map file lists for one GitHub environment
//                                                               (run by .github/workflows/sync-vercel-secrets.yml; reads
//                                                               SECRETS_JSON there, or plain environment variables locally)
//   node scripts/vercel-env.mjs export <KEY> <file>             write KEY=value to a file (mode 600) for a later CI step;
//                                                               only for keys pushed with --readable
//   npx vercel env pull server/.env --environment=development   pull back down for local work (Vercel CLI)
//
// push --readable stores keys as "encrypted" instead of "sensitive", so a workflow holding VERCEL_TOKEN can read them
// back with export (used for keys generated in CI that have no GitHub secret, e.g. the ENS owner key).
//
// Needs VERCEL_TOKEN (vercel.com/account/tokens) and a linked project (`npx vercel link` writes .vercel/project.json),
// or VERCEL_PROJECT_ID / VERCEL_ORG_ID. Values are never printed.
import { existsSync, readFileSync } from "node:fs";

const token = process.env.VERCEL_TOKEN;
const linked = existsSync(".vercel/project.json") ? JSON.parse(readFileSync(".vercel/project.json", "utf8")) : {};
const projectId = process.env.VERCEL_PROJECT_ID ?? linked.projectId;
const teamId = process.env.VERCEL_ORG_ID ?? linked.orgId;
if (!token || !projectId) {
  console.error("Set VERCEL_TOKEN and link the project first (npx vercel link), or set VERCEL_PROJECT_ID / VERCEL_ORG_ID.");
  process.exit(1);
}
const qs = teamId?.startsWith("team_") ? `teamId=${teamId}` : "";
const api = async (method, path, body) => {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}${qs}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.message ?? ""}`);
  return json;
};

const parseDotenv = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        let v = l.slice(i + 1).trim();
        if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
        return [l.slice(0, i).trim(), v.replace(/\s+#.*$/, "")];
      })
      .filter(([, v]) => v !== ""),
  );
const SECRET = /KEY|SECRET|TOKEN|PASSCODE|DATABASE_URL|ROLE_ACCOUNTS/;
const known = Object.keys(parseDotenv(readFileSync("server/.env.example", "utf8").replace(/=\s*$/gm, "=x")));

// Formats for `sync`. evm-key accepts a Hedera portal key in hex or DER form and yields 0x + 64 hex.
const FORMATS = {
  raw: (v) => v,
  "evm-key": (v, name) => {
    const der = "3030020100300706052b8104000a04220420";
    let hex = v.replace(/^0x/i, "");
    if (hex.toLowerCase().startsWith(der)) hex = hex.slice(der.length);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} is not a 32-byte ECDSA key`);
    return `0x${hex}`;
  },
};

const readable = process.argv.includes("--readable");
const upsert = async (vars, targets) => {
  for (const [key, value] of Object.entries(vars)) {
    if (!known.includes(key)) console.warn(`! ${key} is not in server/.env.example (pushing anyway)`);
    // Vercel "sensitive" variables can't target development; use encrypted there.
    const type = SECRET.test(key) && !targets.includes("development") && !readable ? "sensitive" : "encrypted";
    await api("POST", `/v10/projects/${projectId}/env?upsert=true`, { key, value, type, target: targets });
    console.log(`✔ ${key} → ${targets.join(", ")} (${type})`);
  }
  console.log("Redeploy for changes to take effect: push a commit, or `npx vercel redeploy <url>`.");
};

const [cmd, file, targetsArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (cmd === "status") {
  const { envs } = await api("GET", `/v9/projects/${projectId}/env`);
  const targets = ["production", "preview", "development"];
  const keys = [...new Set([...known, ...envs.map((e) => e.key)])].sort();
  console.log(`${"variable".padEnd(32)} ${targets.map((t) => t.padEnd(12)).join("")}`);
  for (const k of keys) {
    const row = targets.map((t) => (envs.some((e) => e.key === k && e.target.includes(t)) ? "set" : "–").padEnd(12)).join("");
    console.log(`${k.padEnd(32)} ${row}${known.includes(k) ? "" : "  (not used by Ordo)"}`);
  }
} else if (cmd === "push" && file && targetsArg) {
  await upsert(parseDotenv(readFileSync(file, "utf8")), targetsArg.split(",").map((t) => t.trim()));
} else if (cmd === "sync" && file && targetsArg) {
  // Map lines: <github environment> <GitHub secret> <Vercel variable> [format] [targets]
  const source = process.env.SECRETS_JSON ? JSON.parse(process.env.SECRETS_JSON) : process.env;
  const groups = new Map();
  const missing = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [env, from, to, format = "raw", targets = "production,preview"] = line.replace(/#.*$/, "").trim().split(/\s+/);
    if (env !== targetsArg || !from || !to) continue;
    const raw = source[from]?.trim();
    if (!raw) { missing.push(from); continue; }
    if (!FORMATS[format]) throw new Error(`unknown format "${format}" for ${to} (use ${Object.keys(FORMATS).join(" | ")})`);
    if (!groups.has(targets)) groups.set(targets, {});
    groups.get(targets)[to] = FORMATS[format](raw, from);
  }
  if (missing.length) throw new Error(`not set in the ${targetsArg} environment: ${[...new Set(missing)].join(", ")}`);
  if (!groups.size) console.log(`Nothing listed for ${targetsArg} in ${file}.`);
  for (const [targets, vars] of groups) await upsert(vars, targets.split(","));
} else if (cmd === "export" && file && targetsArg) {
  const { writeFileSync } = await import("node:fs");
  const { envs } = await api("GET", `/v9/projects/${projectId}/env`);
  const e = envs.find((x) => x.key === file && x.target.includes("production"));
  if (!e) {
    console.log(`${file} is not set in Vercel`);
    process.exit(0);
  }
  if (e.type === "sensitive") throw new Error(`${file} is a sensitive variable: Vercel does not return its value`);
  const full = await api("GET", `/v1/projects/${projectId}/env/${e.id}`);
  writeFileSync(targetsArg, `${file}=${full.value}\n`, { mode: 0o600 });
  console.log(`✔ ${file} read from Vercel`);
} else {
  console.log("usage: node scripts/vercel-env.mjs status | push <file> <production|preview|development>[,…] | sync <map> <environment> | export <KEY> <file>");
  process.exit(1);
}
