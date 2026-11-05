import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { HttpError } from "../engine/errors.js";
import type { BodyLaunch, BodyRunner } from "./bodies.js";

/** Waits between restarts of a body that keeps crashing; after the last one it is left failed. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** A body that ran this long without crashing starts its back-off from the beginning again */
const HEALTHY_MS = 120_000;
const TAIL = 40;

interface Proc {
  child: ChildProcess;
  launch: BodyLaunch;
  port: number;
  startedAt: number;
  crashes: number;
  stopping: boolean;
  restart: NodeJS.Timeout | null;
  tail: string[];
}

/** A free TCP port on the loopback interface, for the body's question server. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });

/**
 * Bodies as processes on the Ordo host: `node body/dist/body.mjs` per machine, for development and tests. Each gets only
 * its own environment (never the server's secrets), restarts with back-off when it crashes, and answers questions on a
 * loopback port.
 */
export class LocalBodies implements BodyRunner {
  readonly runtime = "local" as const;
  private procs = new Map<string, Proc>();

  constructor(
    private o: {
      /** the body bundle to run */
      bundle: string;
      /** a body crashed for good, or came back */
      report: (assetId: string, state: "running" | "failed", error: string | null) => void;
      log?: (line: string) => void;
    },
  ) {}

  async start(launch: BodyLaunch): Promise<{ sandboxId: string | null; askUrl: string | null }> {
    const cur = this.procs.get(launch.assetId);
    if (cur && cur.child.exitCode === null && !cur.stopping) return { sandboxId: null, askUrl: `http://127.0.0.1:${cur.port}` };
    if (!existsSync(this.o.bundle)) throw new HttpError(409, `The body bundle is missing (${this.o.bundle}): build it with pnpm --filter @ordo/body build`);
    const port = Number(launch.env.BODY_ASK_PORT ?? 0) || (await freePort());
    const p: Proc = { child: null as unknown as ChildProcess, launch, port, startedAt: 0, crashes: 0, stopping: false, restart: null, tail: [] };
    this.procs.set(launch.assetId, p);
    this.spawn(p);
    return { sandboxId: null, askUrl: `http://127.0.0.1:${port}` };
  }

  private spawn(p: Proc) {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "production" };
    if (process.env.HOME) env.HOME = process.env.HOME;
    for (const [k, v] of Object.entries(p.launch.env)) if (v !== undefined) env[k] = String(v);
    env.BODY_ASK_PORT = String(p.port);
    const child = spawn(process.execPath, [this.o.bundle], { env, stdio: ["ignore", "pipe", "pipe"] });
    p.child = child;
    p.startedAt = Date.now();
    const id = p.launch.assetId;
    const line = (chunk: Buffer) => {
      for (const l of chunk.toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        p.tail.push(l);
        if (p.tail.length > TAIL) p.tail.shift();
        this.o.log?.(`[body ${id}] ${l}`);
      }
    };
    child.stdout?.on("data", line);
    child.stderr?.on("data", line);
    child.on("exit", (code, signal) => {
      if (p.stopping || this.procs.get(id) !== p) return;
      if (Date.now() - p.startedAt > HEALTHY_MS) p.crashes = 0;
      const why = `exited (${signal ?? `code ${code}`})${p.tail.length ? `: ${p.tail.at(-1)!.slice(0, 200)}` : ""}`;
      const wait = BACKOFF_MS[p.crashes];
      if (wait === undefined) {
        this.o.log?.(`[body ${id}] ${why}; crashed ${p.crashes} times, not restarting`);
        this.o.report(id, "failed", `The body ${why} and kept crashing`);
        this.procs.delete(id);
        return;
      }
      p.crashes += 1;
      this.o.log?.(`[body ${id}] ${why}; restarting in ${wait / 1000} s`);
      p.restart = setTimeout(() => {
        p.restart = null;
        if (p.stopping || this.procs.get(id) !== p) return;
        this.spawn(p);
        this.o.report(id, "running", null);
      }, wait);
      p.restart.unref?.();
    });
  }

  async stop(assetId: string): Promise<void> {
    const p = this.procs.get(assetId);
    if (!p) return;
    p.stopping = true;
    if (p.restart) clearTimeout(p.restart);
    this.procs.delete(assetId);
    if (p.child.exitCode !== null || p.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => p.child.kill("SIGKILL"), 4_000);
      p.child.once("exit", () => (clearTimeout(kill), resolve()));
      p.child.kill("SIGTERM");
    });
  }

  async alive(assetId: string): Promise<{ alive: boolean; detail?: string }> {
    const p = this.procs.get(assetId);
    if (!p) return { alive: false, detail: "not running on this host" };
    if (p.restart) return { alive: false, detail: `restarting after crash ${p.crashes}` };
    return { alive: p.child.exitCode === null, detail: `pid ${p.child.pid} · port ${p.port}` };
  }

  /** The server is shutting down: stop every body, leaving their records as they are, so they start again on boot. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }
}
