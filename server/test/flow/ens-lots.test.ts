import { decodeFunctionResult, encodeFunctionData, keccak256, namehash, parseAbi, toBytes, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dnsEncode } from "../../src/chain/ensv2.js";
import { ORDO_NAMES_ABI, ORDO_RUN_RESOLVER_ABI } from "../../src/chain/ordo-ens-abi.js";
import { PROOF_DOMAIN, READING_TYPES, RELEASE_TYPES } from "../../src/auth/auth.js";
import { edgeMessage } from "../../src/core/readings.js";
import { readingCommitment } from "../../src/core/stage-proofs.js";
import { anvilPath, deployer, startAnvil } from "../fixtures/anvil.js";
import { deployEnsV2, deployOrdoEns, ensEnv } from "../fixtures/ensv2.js";
import { boot, demote, enlist, wallet, type Client, type System } from "./helpers.js";

/**
 * ENS as the access layer, end to end on the real ENSv2 contracts (anvil): the role names people hold are the
 * credential OrdoNames reads, every run has a registered name with its stages under it, and a released package is
 * recorded on the run's name only with signatures from credentialed people. The machine's gateway holds the device
 * role through the machine's name and signs its stage's counts; the release carries the zero-knowledge proof that they
 * meet the stage's criteria, which OrdoRunResolver verifies on-chain.
 */
const run = anvilPath() || process.env.CI ? describe : describe.skip;

const TEXT = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const ROLE = { OPERATOR: 1, SUPERVISOR: 2, VALIDATOR: 4, PLANT_MANAGER: 8, ADMIN: 16, DEVICE: 64 };
const MANAGER = ROLE.OPERATOR | ROLE.ADMIN | ROLE.PLANT_MANAGER | ROLE.SUPERVISOR | ROLE.VALIDATOR;
const gateway = privateKeyToAccount(generatePrivateKey());

run("ENS credentials and lot names", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let d: ReturnType<typeof deployer>;
  let stack: Awaited<ReturnType<typeof deployEnsV2>>;
  let roles: Address;
  let runs: Address;
  let admin: Client;
  let operator: Client;
  let qe: Client;
  let pm: Client;
  let site = "";
  let runId = "";
  const S = () => `/v1/sites/${site}`;
  const SITE = "pune-plant-1.ordo-test.eth";
  const LOT = `so-7781.runs.${SITE}`;
  /** A request as the machine's gateway sends it: signed with its own key. */
  const edge = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const nonce = `n${Math.random().toString(36).slice(2, 14)}`;
    const sig = await gateway.signMessage({ message: edgeMessage(ts, nonce, method, path, raw) });
    const res = await app.request(path, { method, body: raw || undefined, headers: { "content-type": "application/json", host: "localhost", "x-ordo-device": gateway.address, "x-ordo-ts": String(ts), "x-ordo-nonce": nonce, "x-ordo-sig": sig } });
    return { status: res.status, json: (await res.json()) as any };
  };
  const settle = async (n = 40) => {
    for (let i = 0; i < n; i++) {
      await sys.names.reconcile();
      await sys.lotNames.reconcile(10);
      const open = (await sys.db.query<{ n: string }>("SELECT (SELECT count(*) FROM ens_names WHERE status IN ('pending','sent')) + (SELECT count(*) FROM ens_releases WHERE status = 'pending') AS n")).rows[0]!.n;
      if (Number(open) === 0) return;
    }
  };
  const nameOf = (a: string) => d.pub.readContract({ address: roles, abi: ORDO_NAMES_ABI as Abi, functionName: "nameOf", args: [sitekey(site), a as Address] }) as Promise<string>;
  const rolesOf = async (c: { address: string }) => Number(await d.pub.readContract({ address: roles, abi: ORDO_NAMES_ABI as Abi, functionName: "roles", args: [sitekey(site), c.address as Address] }));
  const resolve = (name: string, data: Hex) => d.pub.readContract({ address: runs, abi: ORDO_RUN_RESOLVER_ABI as Abi, functionName: "resolve", args: [dnsEncode(name), data] }) as Promise<Hex>;
  const textCall = (name: string, key: string) => encodeFunctionData({ abi: TEXT, functionName: "text", args: [namehash(name), key] });
  const onchainText = async (name: string, key: string) => decodeFunctionResult({ abi: TEXT, functionName: "text", data: await resolve(name, textCall(name, key)) }) as string;

  beforeAll(async () => {
    anvil = await startAnvil();
    stack = await deployEnsV2(anvil.url);
    d = deployer(anvil.url);
    const ordo = await deployOrdoEns(anvil.url, stack, { releases: true });
    roles = ordo.names;
    runs = ordo.runResolver!;
    ({ sys, app } = await boot(ensEnv(anvil.url, stack, ordo)));
    admin = await wallet(app);
    operator = await wallet(app);
    qe = await wallet(app);
    pm = await wallet(app);
    site = (await admin.call("POST", "/v1/sites", { name: "Pune Plant 1", timezone: "Asia/Kolkata", lineName: "Line 2", zones: [] })).json.id;
    await enlist(admin, S(), operator);
    await enlist(admin, S(), qe, "validator");
    await enlist(admin, S(), pm, "manager");
  }, 120_000);
  afterAll(async () => {
    await sys?.close();
    anvil?.stop();
  });

  it("reads people's roles from the role names they hold", async () => {
    await settle();
    // a manager holds every role the contracts check (operator too, so a manager's manual readings attest), a
    // contributor is an operator, and a promoted validator keeps their contributor name
    expect(await rolesOf(admin)).toBe(MANAGER);
    expect(await rolesOf(operator)).toBe(ROLE.OPERATOR);
    expect(await rolesOf(qe)).toBe(ROLE.OPERATOR | ROLE.VALIDATOR);
    expect(await rolesOf(pm)).toBe(MANAGER);
    // people who never chose a handle go by their wallet's
    expect(await nameOf(qe.address)).toMatch(new RegExp(`^member-${qe.address.slice(2, 8)}\\.${SITE.replace(/\./g, "\\.")}$`));
    expect(await d.pub.readContract({ address: roles, abi: ORDO_NAMES_ABI as Abi, functionName: "sites", args: [sitekey(site)] })).toEqual([true, d.account.address]);
    expect((await admin.call("GET", "/v1/status")).json.rails.find((r: any) => r.rail === "ens credentials")).toMatchObject({ live: true });
  }, 180_000);

  it("gives every run a registered name, with its stages under it, that resolves to its passport", async () => {
    const asset = (await admin.call("POST", `${S()}/assets`, { name: "CNC-01", kind: "cnc", owningAgent: "scheduler", source: { type: "gateway", device: gateway.address }, limits: {}, idealCycleS: 30 })).json.id;
    const observe = async (signal: string, value: number | null, text: string | null = null) =>
      expect((await edge("POST", "/v1/edge/observations", { assetId: asset, observations: [{ signal, ts: new Date().toISOString(), value, text }] })).status).toBe(200);
    const spec = {
      stages: [
        { code: "01", column: 1, name: "Release order", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "manager", timeoutMin: 10, criteria: [] },
        { code: "02", column: 2, name: "Machine housing", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "manager", timeoutMin: 60, criteria: [{ label: "Yield", op: ">=", target: 95, unit: "%" }] },
      ],
      rework: null,
    };
    await observe("execution", null, "ACTIVE");
    await observe("part_count", 100);
    await observe("scrap", 3);
    const versionId = (await admin.call("POST", `${S()}/templates`, { name: "Housing", category: "Discrete", description: "Test line", spec })).json.versionId;
    runId = (await admin.call("POST", `${S()}/runs`, { templateVersionId: versionId, orderRef: "SO-7781", quantity: 10 })).json.id;
    await observe("part_count", 110);
    await sys.advance(true);
    await settle();

    const passport = (await admin.call("GET", `${S()}/runs/${runId}/passport`)).json;
    expect(passport.ens).toMatchObject({ name: LOT, status: "issued", releases: [] });
    expect((await app.request(`/v1/public/passports/${runId}`)).status).toBe(200);
    // the run is a real name in the org's runs registry, resolved by OrdoRunResolver, which passes its records through
    expect(await d.pub.readContract({ address: runs, abi: ORDO_RUN_RESOLVER_ABI as Abi, functionName: "runNode", args: [sitekey(site), LOT] })).toBe(namehash(LOT));
    expect(await onchainText(LOT, "url")).toBe(`https://ordo.example/#/passport/${runId}`);
    expect(await onchainText(LOT, "description")).toBe("Lot SO-7781: 10 units of Housing v1, made at Pune Plant 1");
    // each stage has a name under the run, pointing at the machine that ran it
    const items = (await admin.call("GET", `${S()}/names`)).json.items;
    expect(items.find((x: any) => x.name === `02-machine-housing.${LOT}`)).toMatchObject({ kind: "stage", status: "issued", records: { "com.ordo.machine": `cnc-01.machines.${SITE}` } });
    expect(items.find((x: any) => x.name === `01-release-order.${LOT}`)).toMatchObject({ kind: "stage", status: "issued" });
    // a name that is not one of the org's runs is not a lot
    await expect(d.pub.readContract({ address: runs, abi: ORDO_RUN_RESOLVER_ABI as Abi, functionName: "runNode", args: [sitekey(site), `nope.runs.${SITE}`] })).rejects.toThrow(/NotALot/);
  }, 180_000);

  it("the machine's gateway holds the device role and signs its stage's counts, which are proven against the criteria", async () => {
    // only the gateway's own key is accepted for its machine
    const forged = await app.request("/v1/edge/stages", { headers: { host: "localhost", "x-ordo-device": gateway.address, "x-ordo-ts": String(Math.floor(Date.now() / 1000)), "x-ordo-nonce": "forged-1234", "x-ordo-sig": `0x${"11".repeat(65)}` } });
    expect(forged.status).toBe(401);
    await settle();
    expect(await rolesOf(gateway)).toBe(ROLE.DEVICE);
    expect(await nameOf(gateway.address)).toBe(`cnc-01.machines.${SITE}`);

    const stages = (await edge("GET", "/v1/edge/stages")).json.stages as any[];
    const st = stages.find((x) => x.runId === runId && x.stage === "02");
    expect(st).toMatchObject({ signed: false, site });
    expect(st.endedAt).toBeGreaterThanOrEqual(st.startedAt);
    // the gateway counts from its own counters: 10 good, no new scrap
    const counts = { good: 10, scrap: 0 };
    const salt = 987654321n;
    const commitment = await readingCommitment(BigInt(st.subject), { good: 10n, scrap: 0n, startedAt: BigInt(st.startedAt), endedAt: BigInt(st.endedAt) }, salt);
    const signedAt = Math.floor(Date.now() / 1000);
    const signature = await gateway.signTypedData({ domain: PROOF_DOMAIN, types: READING_TYPES, primaryType: "OrdoReading", message: { site, runId, stage: "02", asset: st.asset, commitment, anchor: st.anchor, signedAt: BigInt(signedAt) } });
    const body = { runId, stage: "02", ...counts, salt: salt.toString(), commitment: commitment.toString(), anchor: st.anchor, signedAt, signature };
    // a commitment to other counts than the ones sent is refused
    expect((await edge("POST", "/v1/edge/readings", { ...body, good: 11 })).status).toBe(400);
    const r = await edge("POST", "/v1/edge/readings", body);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ signer: gateway.address.toLowerCase(), matches: true });
    // a stage's counts are signed once
    expect((await edge("POST", "/v1/edge/readings", body)).status).toBe(409);

    await sys.stageProofs.reconcile();
    const proofs = (await admin.call("GET", `${S()}/runs/${runId}/proofs`)).json.stages;
    expect(proofs).toEqual([expect.objectContaining({ stage: "02", status: "proven", verified: true, signerKind: "device", criteria: ["Yield"] })]);
    // the public passport shows who signed and the proof, never the counts
    const pub = (await (await app.request(`/v1/public/passports/${runId}`)).json()) as any;
    const work = pub.passport.stages.find((x: any) => x.code === "02").work;
    expect(work).toMatchObject({ status: "proven", verified: true, signerEns: `cnc-01.machines.${SITE}` });
    expect(JSON.stringify(work)).not.toMatch(/"good"|"scrap"|salt/);
  }, 180_000);

  it("records a release on the run's name only with signatures from people holding the role names", async () => {
    const created = await admin.call("POST", `${S()}/validation`, { type: "stage_validation", title: "Housing machining stage", objective: "Prove stage 02", acceptance: "Yield ≥ 95%", runId, stageCode: "02" });
    expect(created.status).toBe(200);
    const id = created.json.id;
    const p = (await admin.call("POST", `${S()}/validation/${id}/precheck`)).json;
    expect(p.checks[0].status).toBe("pass");
    for (const slot of p.evidence.filter((e: any) => !e.sha256)) {
      const form = new FormData();
      form.set("file", new File(["CMM report: all dimensions in tolerance"], "cmm.txt", { type: "text/plain" }));
      form.set("slotId", slot.id);
      await admin.upload(`${S()}/validation/${id}/evidence`, form);
    }
    let proofRoot = "";
    const act = async (c: Client) => {
      const t = await c.call("POST", `${S()}/validation/${id}/sign-request`, { action: "sign", comment: "" });
      expect(t.status).toBe(200);
      // all three sign the same lot, content and proof root
      expect(t.json.message).toMatchObject({ lot: LOT, runId });
      proofRoot ||= t.json.message.proofRoot;
      expect(t.json.message.proofRoot).toBe(proofRoot);
      return c.call("POST", `${S()}/validation/${id}/act`, { action: "sign", comment: "", nonce: t.json.message.nonce, signature: await c.sign(t.json) });
    };
    const first = await act(admin);
    expect(first.json, JSON.stringify(first.json)).toMatchObject({ status: "in_review" });
    expect((await act(qe)).json.step).toBe("approval");
    expect((await act(pm)).json.status).toBe("released");
    await settle();

    const passport = (await admin.call("GET", `${S()}/runs/${runId}/passport`)).json;
    expect(passport.ens.releases).toEqual([expect.objectContaining({ packageId: id, status: "done", error: null })]);
    expect(await onchainText(LOT, "com.ordo.release")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await onchainText(LOT, "com.ordo.release.package")).toBe(id);
    expect(proofRoot).not.toBe(`0x${"00".repeat(32)}`);
    expect(await onchainText(LOT, "com.ordo.release.proofs")).toBe(`1 stages and 0 parameters proven, root ${proofRoot}`);
    expect(await onchainText(LOT, "com.ordo.release.signers")).toBe((await Promise.all([admin, qe, pm].map((c) => nameOf(c.address)))).join(","));
    expect(await onchainText(LOT, "com.ordo.release.signers")).toMatch(/^member-[0-9a-f]{6}\.pune-plant-1\.ordo-test\.eth,/);
    const decisions = (await admin.call("GET", `${S()}/decisions?limit=100`)).json;
    expect(decisions.some((x: any) => x.kind === "ens.lot_released")).toBe(true);

    // signatures from wallets without role names are refused by the contract itself
    const strangers = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
    const meanings = ["performed", "reviewed", "approved"];
    const lot = { siteId: site, lotLabel: LOT, packageId: "vp_x", runId, contentHash: `0x${"ab".repeat(32)}` as Hex, proofRoot: `0x${"00".repeat(32)}` as Hex };
    const sigs = await Promise.all(
      strangers.map(async (a, i) => {
        const message = { site, packageId: "vp_x", runId, lot: lot.lotLabel, meaning: meanings[i]!, statement: "x", comment: "", contentHash: lot.contentHash, proofRoot: lot.proofRoot, nonce: `n-${i}-${Date.now()}`, deadline: 4_000_000_000n };
        const signature = await a.signTypedData({ domain: PROOF_DOMAIN, types: RELEASE_TYPES, primaryType: "OrdoRelease", message });
        return { ...message, signature };
      }),
    );
    await expect(d.pub.simulateContract({ address: runs, abi: ORDO_RUN_RESOLVER_ABI as Abi, functionName: "recordRelease", args: [lot, sigs, [], []], account: d.account })).rejects.toThrow(/NotCredentialed/);
  }, 180_000);

  it("demoting someone narrows their on-chain roles, and removing them revokes the role everywhere", async () => {
    const qeId = (await admin.call("GET", `${S()}/team`)).json.members.find((m: any) => m.address === qe.address).userId;
    expect((await demote(admin, S(), qe, "validator")).status).toBe(200);
    await settle();
    expect(await rolesOf(qe)).toBe(ROLE.OPERATOR);
    expect((await admin.call("DELETE", `${S()}/team/members/${qeId}`)).status).toBe(200);
    await settle();
    expect(await rolesOf(qe)).toBe(0);
    expect(await rolesOf(pm)).toBe(MANAGER);
  }, 180_000);
});

const sitekey = (siteId: string) => keccak256(toBytes(siteId));
