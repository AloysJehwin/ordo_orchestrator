import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { EvidenceError, formatBytes, hashEvidence, MAX_EVIDENCE_BYTES } from "../src/evidence.js";

/** @type {string} */
let dir;
const content = Buffer.from("line 1\nline 2\nété\n");
const expected = createHash("sha256").update(content).digest("hex");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ordo-pow-evidence-"));
  await writeFile(path.join(dir, "log.txt"), content);
  await mkdir(path.join(dir, "sub dir"));
  await writeFile(path.join(dir, "sub dir", "photo 1.jpg"), content);
  await writeFile(path.join(dir, "empty.bin"), "");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("hashEvidence", () => {
  test("hashes a file relative to cwd and records name and size only", async () => {
    const result = await hashEvidence("log.txt", { cwd: dir });
    assert.equal(result.sha256, expected);
    assert.equal(result.size, content.length);
    assert.equal(result.name, "log.txt");
    assert.equal(result.path, path.join(dir, "log.txt"));
  });

  test("accepts absolute paths, quotes and escaped spaces from drag-and-drop", async () => {
    const abs = path.join(dir, "sub dir", "photo 1.jpg");
    assert.equal((await hashEvidence(abs, { cwd: "/" })).sha256, expected);
    assert.equal((await hashEvidence(`'${abs}'`, { cwd: "/" })).name, "photo 1.jpg");
    assert.equal((await hashEvidence(`"sub dir/photo 1.jpg"`, { cwd: dir })).sha256, expected);
    assert.equal((await hashEvidence("sub\\ dir/photo\\ 1.jpg", { cwd: dir })).sha256, expected);
  });

  test("hashes an empty file", async () => {
    const result = await hashEvidence("empty.bin", { cwd: dir });
    assert.equal(result.size, 0);
    assert.equal(result.sha256, createHash("sha256").digest("hex"));
  });

  test("rejects missing files and directories", async () => {
    await assert.rejects(hashEvidence("nope.txt", { cwd: dir }), (err) => err instanceof EvidenceError && /No file at nope\.txt/.test(err.message));
    await assert.rejects(hashEvidence("sub dir", { cwd: dir }), /is a directory/);
    await assert.rejects(hashEvidence("  ", { cwd: dir }), /No path/);
  });

  test("rejects files over the limit before reading them", async () => {
    const big = path.join(dir, "big.bin");
    const handle = await open(big, "w");
    await handle.truncate(MAX_EVIDENCE_BYTES + 1); // sparse: no real disk use
    await handle.close();
    await assert.rejects(hashEvidence("big.bin", { cwd: dir }), /is 50 MB, over the 50 MB limit/);
    await assert.rejects(hashEvidence("log.txt", { cwd: dir, maxBytes: 4 }), /over the 4 B limit/);
  });

  test("a file at exactly the limit is accepted", async () => {
    const result = await hashEvidence("log.txt", { cwd: dir, maxBytes: content.length });
    assert.equal(result.sha256, expected);
  });
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(50 * 1024 * 1024), "50 MB");
});
