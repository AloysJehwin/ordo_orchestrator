import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { Auth, Signatures } from "../../src/auth/auth.js";
import { migrate, openDb } from "../../src/db/db.js";

async function setup() {
  const db = await openDb({ dataDir: "memory" });
  await migrate(db);
  return { db, auth: new Auth(db, { sessionTtlMs: 60_000 }), sigs: new Signatures(db) };
}
const siwe = (address: `0x${string}`, nonce: string, domain = "ordo.test") =>
  createSiweMessage({ address, chainId: 296, domain, nonce, uri: `https://${domain}`, version: "1", statement: "Sign in to Ordo" });

describe("sign-in with ethereum", () => {
  it("signs in with a valid signature, creates the user once, and resolves the session", async () => {
    const { db, auth } = await setup();
    const acct = privateKeyToAccount(generatePrivateKey());
    const message = siwe(acct.address, await auth.issueNonce());
    const { token, principal } = await auth.signIn({ message, signature: await acct.signMessage({ message }), domain: "ordo.test" });
    expect(principal.user.address).toBe(acct.address.toLowerCase());
    expect((await auth.principal(token))?.user.id).toBe(principal.user.id);
    expect(await auth.principal("not-a-token")).toBeNull();
    const again = siwe(acct.address, await auth.issueNonce());
    const second = await auth.signIn({ message: again, signature: await acct.signMessage({ message: again }), domain: "ordo.test" });
    expect(second.principal.user.id).toBe(principal.user.id);
    await auth.signOut(principal.sessionId);
    expect(await auth.principal(token)).toBeNull();
    await db.close();
  });

  it("rejects replayed nonces, wrong domains and someone else's signature", async () => {
    const { db, auth } = await setup();
    const acct = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const nonce = await auth.issueNonce();
    const message = siwe(acct.address, nonce);
    const signature = await acct.signMessage({ message });
    await auth.signIn({ message, signature, domain: "ordo.test" });
    await expect(auth.signIn({ message, signature, domain: "ordo.test" })).rejects.toThrow(/nonce/);
    const m2 = siwe(acct.address, await auth.issueNonce(), "evil.test");
    await expect(auth.signIn({ message: m2, signature: await acct.signMessage({ message: m2 }), domain: "ordo.test" })).rejects.toThrow(/another site/);
    const m3 = siwe(acct.address, await auth.issueNonce());
    await expect(auth.signIn({ message: m3, signature: await other.signMessage({ message: m3 }), domain: "ordo.test" })).rejects.toThrow(/does not match/);
    await db.close();
  });

  it("accepts invites on sign-in", async () => {
    const { db, auth } = await setup();
    const acct = privateKeyToAccount(generatePrivateKey());
    await db.query("INSERT INTO sites (id, name, timezone) VALUES ('site_1', 'Plant 03', 'Asia/Kolkata')");
    await db.query("INSERT INTO invites (id, site_id, address, role) VALUES ('inv_1', 'site_1', $1, 'contributor')", [acct.address.toLowerCase()]);
    const message = siwe(acct.address, await auth.issueNonce());
    const { principal } = await auth.signIn({ message, signature: await acct.signMessage({ message }), domain: "ordo.test" });
    expect(principal.memberships).toEqual([{ siteId: "site_1", siteName: "Plant 03", roles: ["contributor"] }]);
    await db.close();
  });
});

describe("EIP-712 decision signatures", () => {
  it("verifies once, only for the action and entity it names", async () => {
    const { db, auth, sigs } = await setup();
    const acct = privateKeyToAccount(generatePrivateKey());
    const message = siwe(acct.address, await auth.issueNonce());
    const { principal } = await auth.signIn({ message, signature: await acct.signMessage({ message }), domain: "ordo.test" });
    const typed = await sigs.request(principal.user, { action: "gate.release", entity: "R-0001/06", meaning: "Released by", comment: "ok", site: "site_1", chainId: 296 });
    const signature = await acct.signTypedData(typed);
    await expect(sigs.consume(db, principal.user, { action: "gate.release", entity: "R-0001/07" }, { nonce: typed.message.nonce, signature })).rejects.toThrow(/different action/);
    const typed2 = await sigs.request(principal.user, { action: "gate.release", entity: "R-0001/06", meaning: "Released by", comment: "ok", site: "site_1", chainId: 296 });
    const ok = await sigs.consume(db, principal.user, { action: "gate.release", entity: "R-0001/06" }, { nonce: typed2.message.nonce, signature: await acct.signTypedData(typed2) });
    expect(ok.id).toMatch(/^sig_/);
    await expect(sigs.consume(db, principal.user, { action: "gate.release", entity: "R-0001/06" }, { nonce: typed2.message.nonce, signature })).rejects.toThrow(/used or expired/);
    const typed3 = await sigs.request(principal.user, { action: "gate.release", entity: "R-0001/06", meaning: "Released by", comment: "", site: "site_1", chainId: 296 });
    const forged = await privateKeyToAccount(generatePrivateKey()).signTypedData(typed3);
    await expect(sigs.consume(db, principal.user, { action: "gate.release", entity: "R-0001/06" }, { nonce: typed3.message.nonce, signature: forged })).rejects.toThrow(/does not match/);
    await db.close();
  });
});
