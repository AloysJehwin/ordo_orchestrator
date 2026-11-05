// Best-effort "open this link in the browser". Never throws; returns whether a launcher started.
import { spawn } from "node:child_process";

/**
 * @param {string} url
 * @param {{ platform?: NodeJS.Platform, spawnImpl?: typeof spawn }} [options]
 * @returns {boolean}
 */
export function openInBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Only web links: never hand a file: or custom-scheme URL from the network to the OS opener.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const href = parsed.toString();

  /** @type {[string, string[], import("node:child_process").SpawnOptions]} */
  let launch;
  if (platform === "darwin") {
    launch = ["open", [href], {}];
  } else if (platform === "win32") {
    // `start` treats the first quoted argument as a window title; escape & so cmd does not split the URL.
    launch = ["cmd", ["/c", "start", '""', href.replace(/&/g, "^&")], { windowsVerbatimArguments: true }];
  } else {
    launch = ["xdg-open", [href], {}];
  }
  try {
    const child = spawnImpl(launch[0], launch[1], { ...launch[2], stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
