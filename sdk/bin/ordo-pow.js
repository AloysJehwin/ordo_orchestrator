#!/usr/bin/env node
// Entry point. Kept tiny so an old Node prints a clear message instead of a syntax error.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`ordo-pow needs Node.js 22 or newer; this is Node ${process.versions.node}.\n`);
  process.exit(1);
}
const { run } = await import("../src/cli.js");
await run();
