// Run the real bin as a child process with piped stdin.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../../bin/ordo-pow.js", import.meta.url));

/**
 * @param {{ args?: string[], env?: Record<string, string>, input?: string, cwd?: string, timeoutMs?: number }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function runCli({ args = [], env = {}, input = "", cwd = process.cwd(), timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NO_COLOR: "1",
        ORDO_POW_NO_OPEN: "1",
        ORDO_POW_POLL_INTERVAL_MS: "20",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
