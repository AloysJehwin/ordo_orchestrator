import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_DOMAIN } from "../../src/auth/auth.js";
import { OUTPUT_TYPES, scaleValue } from "../../src/auth/output-types.js";
import { edgeMessage } from "../../src/core/readings.js";
import { boot, join, promote, wallet, type Client, type System } from "./helpers.js";

/**
 * Multimedia outcomes: a stage declares what its machine captures (here one outcome of each media type), each metric
 * becomes a measured-signal criterion, and the machine uploads signed media that Ordo keeps, records and judges, shown
 * to each member by their level.
 */
describe("machine outputs for a stage's outcomes", () => {
  let sys: System;
  let app: Awaited<ReturnType<typeof boot>>["app"];
  let manager: Client;
  let contributor: Client;
  let validator: Client;
  let machine: PrivateKeyAccount;
  let site = "";
  let runId = "";
  const S = () => `/v1/sites/${site}`;
  const png = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(seed)]);
  const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  const outcomes = [
    { key: "jacket_dt", label: "Jacket thermal image", media: "thermal", instrument: "FLIR A700", metric: { label: "Jacket ΔT", unit: "°C", op: "<=", target: 5 } },
    { key: "viability", label: "Culture micrograph", media: "image", instrument: "Inline microscope", metric: { label: "Viability", unit: "%", op: ">=", target: 90 } },
    { key: "impeller", label: "Impeller acoustics", media: "audio", instrument: "Contact microphone", metric: { label: "Dominant frequency", unit: "Hz", op: ">=", target: 110, targetMax: 130 } },
    { key: "foam", label: "Foam time-lapse", media: "video", instrument: "Headspace camera", metric: { label: "Foam height", unit: "cm", op: "<=", target: 4 } },
    { key: "glucose", label: "Raman spectrum", media: "spectrum", instrument: "Raman probe", metric: { label: "Glucose", unit: "g/L", op: ">=", target: 2, targetMax: 6 } },
    { key: "batch_record", label: "Batch record", media: "document", instrument: "MES export", metric: { label: "Deviations", unit: "", op: "<=", target: 0 }, required: false },
  ];

  /** The machine's upload: the media signed as an OrdoOutput, sent over its signed edge channel. */
  const upload = async (o: { outcome: string; value: number; file: Uint8Array; mime: string; preview?: Uint8Array; signer?: PrivateKeyAccount; device?: PrivateKeyAccount; sha?: string; analysis?: unknown }) => {
    const signer = o.signer ?? machine;
    const device = o.device ?? machine;
    const capturedAt = Math.floor(Date.now() / 1000);
    const sha = o.sha ?? hex(o.file);
    const signature = await signer.signTypedData({
      domain: PROOF_DOMAIN,
      types: OUTPUT_TYPES,
      primaryType: "OrdoOutput",
      message: { site, runId, stage: "01", asset: (await sys.engine.view(site, runId)).stages[0]!.assetId!, outcome: o.outcome, sha256: `0x${hex(o.file)}`, value: scaleValue(o.value), capturedAt: BigInt(capturedAt) },
    });
    const form = new FormData();
    form.set("meta", JSON.stringify({ runId, stage: "01", outcome: o.outcome, capturedAt, value: o.value, sha256: sha, signature, analysis: o.analysis }));
    form.set("file", new Blob([o.file], { type: o.mime }), "media");
    if (o.preview) form.set("preview", new Blob([o.preview], { type: "image/png" }), "preview.png");
    const req = new Request("http://localhost/v1/edge/outputs", { method: "POST", body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    const ts = Math.floor(Date.now() / 1000);
    const nonce = `n-${Math.random().toString(36).slice(2, 12)}`;
    const sig = await device.signMessage({ message: { raw: new TextEncoder().encode(edgeMessage(ts, nonce, "POST", "/v1/edge/outputs", body)) } });
    const res = await app.request("/v1/edge/outputs", {
      method: "POST",
      body,
      headers: { host: "localhost", "content-type": req.headers.get("content-type")!, "x-ordo-device": device.address, "x-ordo-ts": String(ts), "x-ordo-nonce": nonce, "x-ordo-sig": sig },
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  beforeAll(async () => {
    ({ sys, app } = await boot());
    manager = await wallet(app);
    contributor = await wallet(app);
    validator = await wallet(app);
    machine = privateKeyToAccount(generatePrivateKey());
    site = (await manager.call("POST", "/v1/sites", { name: "Bioworks", timezone: "UTC", lineName: "Upstream", zones: [] })).json.id;
    for (const c of [contributor, validator]) await join(c, site);
    expect((await promote(manager, S(), validator, "validator")).status).toBe(200);
    await manager.call("POST", `${S()}/assets`, { name: "BR-2000", kind: "process_vessel", owningAgent: "scheduler", source: { type: "gateway", device: machine.address }, limits: {}, idealCycleS: 60 });
    const spec = {
      stages: [{ code: "01", column: 1, name: "Production bioreactor", agent: "scheduler", resourceKind: "process_vessel", mode: "approve", escalationRole: "manager", timeoutMin: 600, criteria: [], outcomes }],
      rework: null,
    };
    const tpl = await manager.call("POST", `${S()}/templates`, { name: "mAb upstream", category: "Regulated", description: "Outcomes test", spec });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    runId = (await manager.call("POST", `${S()}/runs`, { templateVersionId: tpl.json.versionId, orderRef: "LOT-77", quantity: 1 })).json.id;
    await sys.advance(true);
  }, 120_000);
  afterAll(async () => sys?.close());

  it("each outcome's metric becomes a measured-signal criterion on outcome.<key>", async () => {
    const st = (await manager.call("GET", `${S()}/runs/${runId}`)).json.run.stages[0];
    expect(st.state).toBe("running");
    expect(st.outcomes).toHaveLength(6);
    expect(st.criteria.map((c: any) => [c.label, c.signal, c.outcome])).toEqual(outcomes.map((o) => [o.metric.label, `outcome.${o.key}`, o.key]));
    expect(st.criteria.find((c: any) => c.outcome === "glucose")).toMatchObject({ kind: "signal", op: ">=", target: 2, targetMax: 6, agg: "last" });
    // a metric named like one of the stage's own criteria is refused
    const clash = { stages: [{ code: "01", column: 1, name: "X", agent: "scheduler", resourceKind: "process_vessel", mode: "auto", escalationRole: "manager", timeoutMin: 60, criteria: [{ label: "Viability", op: ">=", target: 1 }], outcomes: [outcomes[1]] }], rework: null };
    expect((await manager.call("POST", `${S()}/templates`, { name: "Clash", category: "Regulated", description: "x", spec: clash })).status).toBe(400);
  });

  it("the machine uploads signed media; Ordo keeps it, records the value and judges the outcome's criterion", async () => {
    const thermal = png("thermal-1");
    const preview = png("thermal-1-preview");
    const r = await upload({ outcome: "jacket_dt", value: 2.4, file: thermal, mime: "image/png", preview, analysis: { summary: "Even jacket, no hot spots", value: 2.4, requestId: "req-zg-1", model: "0gm-1.0-35b-a3b" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ outcome: "jacket_dt", version: 1, sha256: `sha256:${hex(thermal)}`, ledgerSeq: expect.any(Number) });
    expect((await upload({ outcome: "glucose", value: 7.1, file: new TextEncoder().encode("wavenumber,intensity\n1125,0.4\n"), mime: "text/csv" })).status).toBe(200);
    await sys.advance(true);

    const list = (await validator.call("GET", `${S()}/runs/${runId}/stages/01/outputs`)).json.outcomes;
    const dt = list.find((o: any) => o.key === "jacket_dt");
    expect(dt).toMatchObject({ captured: true, ok: true, mediaLabel: "Thermal image", output: { version: 1, value: 2.4, hasPreview: true, device: machine.address.toLowerCase(), analysis: { requestId: "req-zg-1" } } });
    expect(list.find((o: any) => o.key === "glucose")).toMatchObject({ captured: true, ok: false, output: { value: 7.1, mime: "text/csv" } });
    expect(list.find((o: any) => o.key === "foam")).toMatchObject({ captured: false, ok: null, output: null });

    const file = await validator.raw("GET", `${S()}/runs/${runId}/stages/01/outputs/jacket_dt/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(thermal);
    const prev = await validator.raw("GET", `${S()}/runs/${runId}/stages/01/outputs/jacket_dt/preview`);
    expect(new Uint8Array(await prev.arrayBuffer())).toEqual(preview);

    // a second capture is a new version; the ledger has the hash, never the value
    expect((await upload({ outcome: "jacket_dt", value: 3.1, file: png("thermal-2"), mime: "image/png" })).json.version).toBe(2);
    const entries = (await manager.call("GET", `${S()}/verify?subject=${runId}`)).json;
    expect(entries.ok).toBe(true);
  });

  it("refuses media that is not the machine's, not the outcome's type, or not what was signed", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await upload({ outcome: "viability", value: 95, file: png("x"), mime: "image/png", device: stranger, signer: stranger })).status).toBe(403);
    expect((await upload({ outcome: "viability", value: 95, file: png("x"), mime: "image/png", signer: stranger })).status).toBe(401);
    expect((await upload({ outcome: "viability", value: 95, file: png("x"), mime: "audio/wav" })).status).toBe(400);
    expect((await upload({ outcome: "viability", value: 95, file: png("x"), mime: "image/png", sha: "ab".repeat(32) })).status).toBe(400);
    expect((await upload({ outcome: "no_such", value: 1, file: png("x"), mime: "image/png" })).status).toBe(400);
  });

  it("a contributor (level 2) sees whether each outcome was captured and met its target; values and files need level 3", async () => {
    const list = (await contributor.call("GET", `${S()}/runs/${runId}/stages/01/outputs`)).json.outcomes;
    expect(list.find((o: any) => o.key === "jacket_dt")).toMatchObject({ captured: true, ok: true, output: null });
    expect((await contributor.raw("GET", `${S()}/runs/${runId}/stages/01/outputs/jacket_dt/file`)).status).toBe(403);
  });
});
