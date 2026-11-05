import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { openInBrowser } from "../src/open-url.js";

function fakeSpawn() {
  /** @type {{ command: string, args: readonly string[], options: any }[]} */
  const calls = [];
  const spawnImpl = /** @type {any} */ ((/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => child.emit("error", new Error("ENOENT"))); // a missing launcher must not throw
    return child;
  });
  return { calls, spawnImpl };
}

const url = "https://ordo.example.com/#/pow/sign/c_1?a=1&b=2";

test("uses the platform's opener, detached", () => {
  for (const [platform, command] of /** @type {const} */ ([["darwin", "open"], ["linux", "xdg-open"], ["win32", "cmd"]])) {
    const { calls, spawnImpl } = fakeSpawn();
    assert.equal(openInBrowser(url, { platform, spawnImpl }), true);
    assert.equal(calls[0]?.command, command);
    assert.equal(calls[0]?.options.detached, true);
    assert.equal(calls[0]?.options.stdio, "ignore");
  }
});

test("escapes & for cmd on Windows", () => {
  const { calls, spawnImpl } = fakeSpawn();
  openInBrowser(url, { platform: "win32", spawnImpl });
  assert.deepEqual(calls[0]?.args, ["/c", "start", '""', "https://ordo.example.com/#/pow/sign/c_1?a=1^&b=2"]);
  assert.equal(calls[0]?.options.windowsVerbatimArguments, true);
});

test("refuses anything but http(s) links, and never throws", () => {
  const { calls, spawnImpl } = fakeSpawn();
  assert.equal(openInBrowser("file:///etc/passwd", { platform: "darwin", spawnImpl }), false);
  assert.equal(openInBrowser("javascript:alert(1)", { platform: "darwin", spawnImpl }), false);
  assert.equal(openInBrowser("not a url", { platform: "darwin", spawnImpl }), false);
  assert.equal(calls.length, 0);
  const throwing = /** @type {any} */ (() => {
    throw new Error("spawn failed");
  });
  assert.equal(openInBrowser(url, { platform: "linux", spawnImpl: throwing }), false);
});
