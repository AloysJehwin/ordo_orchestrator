import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { APIError, Sandbox } from "@vercel/sandbox";
import type { Config } from "../config.js";
import type { BodyLaunch, BodyRunner } from "./bodies.js";

/**
 * Machine bodies on Vercel Sandbox: one named, persistent microVM per machine (`ordo-<site>-<asset>`).
 *
 * - The first boot uploads the body bundle (`body/dist`) with a package.json of its native dependencies, runs
 *   `npm install`, and stops the VM once, which snapshots it: later starts resume from the snapshot and skip the install.
 *   A new bundle (another deploy) is detected by its hash and installed the same way.
 * - Each start runs `node body.mjs` detached, with the BodyEnv as its environment, and exposes BODY_ASK_PORT on a public
 *   `*.vercel.run` URL (the askUrl).
 * - A stop ends the body (SIGTERM, so it can flush its episode log) and stops the VM, which snapshots it again.
 *
 * Idle stops are the caller's: call `sweep(lastActive)` every engine cycle. It stops bodies idle for IDLE_STOP_MS and
 * extends the session of the others before the platform's session timeout ends them.
 */

/** A body with no activity (its newest observation, or a question) for this long is stopped. */
export const IDLE_STOP_MS = 15 * 60_000;
/** The port a body answers questions on when the launch doesn't say */
export const DEFAULT_ASK_PORT = 8787;
/** How long one session may run before the platform stops it. 45 minutes fits every plan (Hobby's cap); sweep() extends it. */
const SESSION_MS = 45 * 60_000;
/** sweep() extends a session when less than this is left, by EXTEND_MS */
const EXTEND_BELOW_MS = 15 * 60_000;
const EXTEND_MS = 30 * 60_000;
/** A body that exits within this long after its start failed to start */
const STARTUP_GRACE_MS = 3_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BODY_HOME = "ordo-body";
const VERSION_FILE = ".ordo-version";
const PID_FILE = ".pid";
/** the body's own disk (its episode log), inside its home so the VM's snapshots keep it */
const DATA_DIR = "data";
/** the body's pid, only while it is still the body (a pid in a snapshot can be another process after a resume) */
const BODY_PID = `p=$(cat ${PID_FILE} 2>/dev/null) && grep -q body.mjs /proc/$p/cmdline 2>/dev/null`;
/** end a running body with SIGTERM, then wait up to 5 seconds for it to exit */
const KILL_BODY = `if ${BODY_PID}; then kill $p; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 $p 2>/dev/null || break; sleep 0.5; done; fi; rm -f ${PID_FILE}; true`;
const TAIL_LINES = 200;

export interface SandboxCredentials {
  /** a Vercel access token scoped to the team */
  token: string;
  teamId: string;
  /** the project the sandboxes belong to: its ID or name */
  projectId: string;
}

export interface SandboxBodiesOptions extends SandboxCredentials {
  /** the body package: dist/ (body.mjs and anything next to it) and package.json (its dependencies). Default: ORDO_BODY_DIR, else <repo>/body */
  bodyDir?: string;
  /** the VM image; the body is Node 22 ESM */
  image?: string;
  /** 2048 MB of memory per vCPU. The body renders images and encodes video. */
  vcpus?: number;
  region?: string;
  /** every line the bodies print (stdout and stderr), e.g. to forward them to the server's log */
  onLine?: (assetId: string, line: string) => void;
}

/** The sandbox a machine's body runs in, one per machine: `ordo-<site>-<asset>`, lowercase, URL-safe. */
export const sandboxName = (siteId: string, assetId: string): string => {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `ordo-${clean(siteId)}-${clean(assetId)}`.replace(/-{2,}/g, "-");
  return name.length <= 100 ? name : `${name.slice(0, 87)}-${createHash("sha256").update(`${siteId}/${assetId}`).digest("hex").slice(0, 12)}`;
};

const defaultBodyDir = (): string => {
  // the checkout's body package, or (in the Vercel function, where the server is one bundle) the copy the build puts beside it
  const dirs = [process.env.ORDO_BODY_DIR, fileURLToPath(new URL("../../../body/", import.meta.url)), fileURLToPath(new URL("./body/", import.meta.url))].filter(Boolean) as string[];
  return dirs.find((d) => existsSync(join(d, "dist", "body.mjs"))) ?? dirs[dirs.length - 1]!;
};

interface Bundle {
  files: { path: string; content: Buffer }[];
  /** sha256 of every file: what is installed in a sandbox is compared with it */
  hash: string;
  hasDependencies: boolean;
}

/** The body's files for the VM: everything in dist/ except source maps, and a package.json with only its dependencies. */
function readBundle(bodyDir: string): Bundle {
  const dist = join(bodyDir, "dist");
  if (!existsSync(join(dist, "body.mjs"))) throw new Error(`No machine body bundle at ${join(dist, "body.mjs")}: build it first (pnpm --filter @ordo/body build)`);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  const files = walk(dist)
    .filter((f) => !f.endsWith(".map"))
    .map((f) => ({ path: relative(dist, f).split("\\").join("/"), content: readFileSync(f) }));
  const pkgFile = join(bodyDir, "package.json");
  const pkg = existsSync(pkgFile) ? (JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, Record<string, string> | undefined>) : {};
  // workspace packages are bundled into body.mjs; npm dependencies (native binaries such as ffmpeg-static) are installed on the VM
  const npmOnly = (deps: Record<string, string> = {}) => Object.fromEntries(Object.entries(deps).filter(([, v]) => !v.startsWith("workspace:")));
  const dependencies = npmOnly(pkg.dependencies);
  const optionalDependencies = npmOnly(pkg.optionalDependencies);
  files.push({ path: "package.json", content: Buffer.from(JSON.stringify({ name: "ordo-body", private: true, type: "module", dependencies, optionalDependencies }, null, 2)) });
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update("\0").update(f.content).update("\0");
  return { files, hash: h.digest("hex"), hasDependencies: Object.keys({ ...dependencies, ...optionalDependencies }).length > 0 };
}

/** collects a command's output into lines, keeping the newest */
const lineSink = (lines: string[], onLine?: (line: string) => void) => {
  let partial = "";
  return new Writable({
    write(chunk: Buffer, _enc, done) {
      const parts = (partial + chunk.toString()).split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts.filter((l) => l.trim())) {
        lines.push(line);
        if (lines.length > TAIL_LINES) lines.shift();
        onLine?.(line);
      }
      done();
    },
  });
};

/** no such sandbox, or its snapshot expired (the next start creates it again and reinstalls the body) */
const gone = (e: unknown) => e instanceof APIError && (e.response.status === 404 || e.response.status === 410);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface RunningBody {
  siteId: string;
  assetId: string;
  name: string;
  sandbox: Sandbox;
  askUrl: string;
  startedAt: number;
  /** what the body was started with, so a start with the same environment leaves it running */
  envHash: string;
  /** set when the body's process ends */
  exitCode?: number;
  lines: string[];
}

export class SandboxBodies implements BodyRunner {
  readonly runtime = "sandbox" as const;
  private readonly creds: SandboxCredentials;
  private readonly bodyDir: string;
  private readonly bodies = new Map<string, RunningBody>();
  private readonly starting = new Map<string, Promise<{ sandboxId: string; askUrl: string }>>();

  constructor(private readonly opts: SandboxBodiesOptions) {
    this.creds = { token: opts.token, teamId: opts.teamId, projectId: opts.projectId };
    this.bodyDir = opts.bodyDir ?? defaultBodyDir();
  }

  /** Start (or wake) the body; a second start with the same environment leaves a running body as it is. */
  start(launch: BodyLaunch): Promise<{ sandboxId: string; askUrl: string }> {
    const pending = this.starting.get(launch.assetId);
    if (pending) return pending;
    const p = this.boot(launch).finally(() => this.starting.delete(launch.assetId));
    this.starting.set(launch.assetId, p);
    return p;
  }

  private async boot(launch: BodyLaunch): Promise<{ sandboxId: string; askUrl: string }> {
    const name = sandboxName(launch.siteId, launch.assetId);
    const port = Number(launch.env.BODY_ASK_PORT ?? DEFAULT_ASK_PORT);
    const env: Record<string, string> = { NODE_ENV: "production" };
    for (const [k, v] of Object.entries(launch.env)) if (v !== undefined && v !== "") env[k] = String(v);
    env.BODY_ASK_PORT = String(port);
    const envHash = createHash("sha256").update(JSON.stringify(Object.entries(env).sort())).digest("hex");

    const current = this.bodies.get(launch.assetId);
    if (current && current.envHash === envHash && current.exitCode === undefined && (await this.get(name))?.status === "running")
      return { sandboxId: name, askUrl: current.askUrl };

    const bundle = readBundle(this.bodyDir);
    try {
      let sandbox = await Sandbox.getOrCreate({
        ...this.creds,
        name,
        image: this.opts.image ?? "vercel/sandbox/node:22",
        persistent: true,
        ports: [port],
        timeout: SESSION_MS,
        resources: { vcpus: this.opts.vcpus ?? 2 },
        tags: { app: "ordo", site: launch.siteId, asset: launch.assetId },
        keepLastSnapshots: { count: 2 },
        ...(this.opts.region ? { region: this.opts.region } : {}),
        resume: true,
      });
      if (!sandbox.routes.some((r) => r.port === port)) {
        await sandbox.update({ ports: [port] });
        sandbox = await Sandbox.get({ ...this.creds, name, resume: true });
      }
      const dir = `${sandbox.cwd || "/vercel/sandbox"}/${BODY_HOME}`;
      // a data directory from the launch is a path on Ordo's host; on the VM the body keeps its data in its home
      env.BODY_DATA_DIR = `${dir}/${DATA_DIR}`;

      // first boot, or a new bundle: upload, install, and snapshot the result by stopping the VM once
      const installed = (await sandbox.readFileToBuffer({ path: `${dir}/${VERSION_FILE}` }))?.toString().trim();
      if (installed !== bundle.hash) {
        await this.install(sandbox, dir, bundle);
        await sandbox.stop();
      }

      // one body per machine: end one an earlier Ordo process left running
      await sandbox.runCommand({ cmd: "bash", args: ["-c", KILL_BODY], cwd: dir });
      const lines: string[] = [];
      const sink = lineSink(lines, this.opts.onLine && ((l) => this.opts.onLine!(launch.assetId, l)));
      const cmd = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", `echo $$ > ${PID_FILE} && exec node body.mjs`],
        cwd: dir,
        env,
        detached: true,
        stdout: sink,
        stderr: sink,
      });
      const body: RunningBody = { siteId: launch.siteId, assetId: launch.assetId, name, sandbox, askUrl: sandbox.domain(port), startedAt: Date.now(), envHash, lines };
      const exited = cmd.wait().then(
        (f) => void (body.exitCode = f.exitCode),
        () => void (body.exitCode ??= -1),
      );
      this.bodies.set(launch.assetId, body);

      // a body that dies at once (a bad environment, a missing dependency) fails the start instead of looking alive
      await Promise.race([exited, new Promise((r) => setTimeout(r, STARTUP_GRACE_MS))]);
      if (body.exitCode !== undefined) {
        this.bodies.delete(launch.assetId);
        throw new Error(`the body exited with code ${body.exitCode}: ${lines.slice(-5).join(" | ") || "no output"}`);
      }
      return { sandboxId: name, askUrl: body.askUrl };
    } catch (e) {
      throw new Error(`sandbox ${name}: ${why(e)}`);
    }
  }

  private async install(sandbox: Sandbox, dir: string, bundle: Bundle): Promise<void> {
    // keep node_modules (npm reconciles it with the new package.json faster than a fresh install) and the body's data
    await sandbox.runCommand({ cmd: "bash", args: ["-c", `mkdir -p ${dir} && find ${dir} -mindepth 1 -maxdepth 1 ! -name node_modules ! -name ${DATA_DIR} -exec rm -rf {} +`] });
    await sandbox.writeFiles(bundle.files.map((f) => ({ path: `${dir}/${f.path}`, content: f.content })));
    if (bundle.hasDependencies) {
      const npm = await sandbox.runCommand({ cmd: "npm", args: ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
      if (npm.exitCode !== 0) throw new Error(`npm install failed (${npm.exitCode}): ${(await npm.stderr()).trim().split("\n").slice(-5).join(" | ")}`);
    }
    await sandbox.writeFiles([{ path: `${dir}/${VERSION_FILE}`, content: bundle.hash }]);
  }

  /** End the body and stop its VM; a persistent sandbox snapshots on stop, so the next start is fast. */
  async stop(assetId: string): Promise<void> {
    const body = this.bodies.get(assetId);
    this.bodies.delete(assetId);
    const sandbox = body ? await this.get(body.name) : await this.find(assetId);
    if (!sandbox || !["running", "pending"].includes(sandbox.status)) return;
    try {
      await sandbox.runCommand({ cmd: "bash", args: ["-c", KILL_BODY], cwd: `${sandbox.cwd || "/vercel/sandbox"}/${BODY_HOME}` });
    } catch {
      // the VM stops anyway
    }
    await sandbox.stop();
  }

  async alive(assetId: string): Promise<{ alive: boolean; detail?: string }> {
    try {
      const body = this.bodies.get(assetId);
      if (body) {
        if (body.exitCode !== undefined) return { alive: false, detail: `the body exited with code ${body.exitCode}: ${body.lines.slice(-3).join(" | ") || "no output"}` };
        const sandbox = await this.get(body.name);
        if (sandbox?.status !== "running") return { alive: false, detail: `sandbox ${body.name} is ${sandbox?.status ?? "gone"}` };
        return { alive: true, detail: `sandbox ${body.name}${sandbox.expiresAt ? ` until ${sandbox.expiresAt.toISOString()}` : ""}` };
      }
      // started by an earlier Ordo process: ask the VM whether its body still runs
      const sandbox = await this.find(assetId);
      if (sandbox?.status !== "running") return { alive: false, detail: sandbox ? `sandbox ${sandbox.name} is ${sandbox.status}` : "no sandbox" };
      const r = await sandbox.runCommand({ cmd: "bash", args: ["-c", BODY_PID], cwd: `${sandbox.cwd || "/vercel/sandbox"}/${BODY_HOME}` });
      return r.exitCode === 0 ? { alive: true, detail: `sandbox ${sandbox.name}` } : { alive: false, detail: `sandbox ${sandbox.name} runs no body` };
    } catch (e) {
      return { alive: false, detail: why(e) };
    }
  }

  /** The bodies this process started and that are still running. */
  running(): { assetId: string; siteId: string; sandboxId: string; askUrl: string; startedAt: number }[] {
    return [...this.bodies.values()].filter((b) => b.exitCode === undefined).map((b) => ({ assetId: b.assetId, siteId: b.siteId, sandboxId: b.name, askUrl: b.askUrl, startedAt: b.startedAt }));
  }

  /** The newest lines a body printed */
  logs(assetId: string): string[] {
    return [...(this.bodies.get(assetId)?.lines ?? [])];
  }

  /** Keep a running body's session from timing out: extends it when less than 15 minutes are left. False when it isn't running. */
  async touch(assetId: string): Promise<boolean> {
    const body = this.bodies.get(assetId);
    if (!body || body.exitCode !== undefined) return false;
    const sandbox = await this.get(body.name);
    if (sandbox?.status !== "running") return false;
    if (sandbox.expiresAt && sandbox.expiresAt.getTime() - Date.now() < EXTEND_BELOW_MS) await sandbox.extendTimeout(EXTEND_MS);
    return true;
  }

  /**
   * One pass of the idle policy, for the caller's engine cycle: stop bodies with no activity for IDLE_STOP_MS (their
   * newest observation or question; the start time when there is none), keep the others' sessions alive.
   */
  async sweep(lastActive: (assetId: string) => number | null, now = Date.now()): Promise<{ stopped: string[]; kept: string[] }> {
    const stopped: string[] = [];
    const kept: string[] = [];
    for (const body of [...this.bodies.values()]) {
      const idle = now - Math.max(lastActive(body.assetId) ?? 0, body.startedAt);
      try {
        if (body.exitCode !== undefined || idle >= IDLE_STOP_MS) {
          await this.stop(body.assetId);
          stopped.push(body.assetId);
        } else if (await this.touch(body.assetId)) kept.push(body.assetId);
      } catch (e) {
        console.warn(`[ordo] sandbox ${body.name}: ${why(e)}`);
      }
    }
    return { stopped, kept };
  }

  /** the sandbox as it is now, without resuming it */
  private async get(name: string): Promise<Sandbox | null> {
    try {
      return await Sandbox.get({ ...this.creds, name, resume: false });
    } catch (e) {
      if (gone(e)) return null;
      throw e;
    }
  }

  /** a machine's sandbox by its asset tag, for bodies started by an earlier Ordo process */
  private async find(assetId: string): Promise<Sandbox | null> {
    const page = await Sandbox.list({ ...this.creds, tags: { asset: assetId } });
    const hit = page.sandboxes.find((s) => s.tags?.app === "ordo");
    return hit ? this.get(hit.name) : null;
  }
}

/** Every machine sandbox of the project, for the doctor and the Floor */
export async function listBodySandboxes(creds: SandboxCredentials): Promise<{ name: string; status: string; assetId: string | null; siteId: string | null; expiresAt: string | null }[]> {
  const page = await Sandbox.list({ ...creds, tags: { app: "ordo" } });
  return (await page.toArray()).map((s) => ({
    name: s.name,
    status: s.status,
    assetId: s.tags?.asset ?? null,
    siteId: s.tags?.site ?? null,
    expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
  }));
}

/** The Vercel Sandbox settings, or what is missing */
export const sandboxCredentials = (cfg: Config): SandboxCredentials | { missing: string[] } => {
  const missing = (["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_SANDBOX_PROJECT"] as const).filter((k) => !cfg[k]);
  return missing.length ? { missing } : { token: cfg.VERCEL_TOKEN!, teamId: cfg.VERCEL_TEAM_ID!, projectId: cfg.VERCEL_SANDBOX_PROJECT! };
};

/** The runner for BODY_RUNTIME=sandbox; null (with a warning) until the Vercel settings are complete. */
export function sandboxBodies(cfg: Config, warn: (w: string) => void = (w) => console.warn(`[ordo] ${w}`), opts: Partial<SandboxBodiesOptions> = {}): SandboxBodies | null {
  const creds = sandboxCredentials(cfg);
  if ("missing" in creds) {
    warn(`BODY_RUNTIME=sandbox needs ${creds.missing.join(", ")}: machine bodies don't run`);
    return null;
  }
  return new SandboxBodies({ ...creds, ...opts });
}
