import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, sha256Hex } from "../src/canonical.js";

test("sorts keys at every level and keeps array order", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }),
    '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
  );
});

test("matches JSON.stringify for undefined, null, non-finite numbers and strings", () => {
  const value = { u: undefined, n: null, inf: Infinity, s: 'q"\n ', arr: [undefined, 1] };
  assert.deepEqual(JSON.parse(canonicalJson(value)), JSON.parse(JSON.stringify(value)));
  assert.equal(canonicalJson(undefined), "null");
});

test("same value, same bytes, regardless of key order", () => {
  assert.equal(canonicalJson({ x: 1, y: [1, 2] }), canonicalJson({ y: [1, 2], x: 1 }));
});

test("sha256Hex", () => {
  assert.equal(sha256Hex("abc"), createHash("sha256").update("abc").digest("hex"));
  assert.equal(sha256Hex(new TextEncoder().encode("abc")), sha256Hex("abc"));
});
