import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UsageError } from "../src/errors.js";
import { formatToken, isLoopback, parseInvocation, parseToken } from "../src/token.js";

const SECRET = "Zm9vYmFyYmF6cXV4LXNlY3JldF8xMjM0NTY";

/** @param {() => unknown} fn @param {RegExp} message */
function rejects(fn, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${err}`);
    assert.match(err.message, message);
    assert.ok(!err.message.includes(SECRET), "error message contains the secret");
    return true;
  });
}

describe("parseToken", () => {
  test("decodes the API base URL and keeps the secret", () => {
    const token = formatToken("https://ordo.example.com", SECRET);
    assert.match(token, /^opw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(parseToken(token), { apiBaseUrl: "https://ordo.example.com", secret: SECRET });
  });

  test("strips trailing slashes, query and fragment from the base URL", () => {
    assert.equal(parseToken(formatToken("https://ordo.example.com/api/?x=1#y", SECRET)).apiBaseUrl, "https://ordo.example.com/api");
    assert.equal(parseToken(formatToken("http://localhost:8080/", SECRET)).apiBaseUrl, "http://localhost:8080");
  });

  test("tolerates surrounding whitespace", () => {
    assert.equal(parseToken(`  ${formatToken("https://ordo.example.com", SECRET)}\n`).secret, SECRET);
  });

  test("rejects other prefixes and shapes", () => {
    rejects(() => parseToken(""), /Missing token/);
    rejects(() => parseToken(`opw2.${Buffer.from("https://x.io").toString("base64url")}.${SECRET}`), /not an Ordo proof-of-work token/);
    rejects(() => parseToken(SECRET), /not an Ordo proof-of-work token/);
    rejects(() => parseToken(`opw1.${SECRET}`), /malformed/);
    rejects(() => parseToken(`opw1.a.b.${SECRET}`), /malformed/);
  });

  test("rejects a bad URL part", () => {
    rejects(() => parseToken(`opw1.aGVsbG8+.${SECRET}`), /not valid base64url/);
    rejects(() => parseToken(`opw1.${Buffer.from("not a url").toString("base64url")}.${SECRET}`), /not a valid URL/);
    rejects(() => parseToken(`opw1.${Buffer.from("ftp://ordo.example.com").toString("base64url")}.${SECRET}`), /http or https/);
    rejects(() => parseToken(`opw1.${Buffer.from("https://u:p@ordo.example.com").toString("base64url")}.${SECRET}`), /credentials/);
  });

  test("rejects a missing, truncated or non-base64url secret", () => {
    const url = Buffer.from("https://ordo.example.com").toString("base64url");
    rejects(() => parseToken(`opw1.${url}.`), /missing or truncated/);
    rejects(() => parseToken(`opw1.${url}.short`), /missing or truncated/);
    rejects(() => parseToken(`opw1.${url}.${SECRET}=`), /missing or truncated/);
  });
});

describe("parseInvocation", () => {
  const token = formatToken("https://ordo.example.com", SECRET);

  test("token from the argument", () => {
    const inv = parseInvocation([token], {});
    assert.equal(inv.tokenSource, "argument");
    assert.equal(inv.token?.secret, SECRET);
    assert.equal(inv.open, true);
  });

  test("token from ORDO_POW_TOKEN, --api override and --no-open", () => {
    const inv = parseInvocation(["--api", "http://localhost:8080/", "--no-open"], { ORDO_POW_TOKEN: token });
    assert.equal(inv.tokenSource, "env");
    assert.equal(inv.token?.apiBaseUrl, "http://localhost:8080");
    assert.equal(inv.open, false);
  });

  test("ORDO_POW_NO_OPEN disables opening", () => {
    assert.equal(parseInvocation([token], { ORDO_POW_NO_OPEN: "1" }).open, false);
    assert.equal(parseInvocation([token], { ORDO_POW_NO_OPEN: "0" }).open, true);
  });

  test("help and version need no token", () => {
    assert.equal(parseInvocation(["--help"], {}).help, true);
    assert.equal(parseInvocation(["-v"], {}).version, true);
  });

  test("usage errors", () => {
    rejects(() => parseInvocation([], {}), /Missing token/);
    rejects(() => parseInvocation([token, token], {}), /Expected one token/);
    rejects(() => parseInvocation([token, "--frobnicate"], {}), /Unknown option/);
    rejects(() => parseInvocation([token, "--api"], {}), /--api needs a URL/);
    rejects(() => parseInvocation([token, "--api", "ftp://x"], {}), /--api must be an http or https URL/);
  });
});

test("isLoopback", () => {
  assert.equal(isLoopback("http://localhost:8080"), true);
  assert.equal(isLoopback("http://127.0.0.1:1"), true);
  assert.equal(isLoopback("http://[::1]:8080"), true);
  assert.equal(isLoopback("http://app.localhost"), true);
  assert.equal(isLoopback("http://192.168.1.10:8080"), false);
  assert.equal(isLoopback("https://ordo.example.com"), false);
});
