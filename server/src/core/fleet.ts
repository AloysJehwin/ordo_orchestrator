import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { Signatures, TypedSignature, User } from "../auth/auth.js";
import type { Db } from "../db/db.js";
import { ASSET_KIND_LABEL, type AssetKind, type Role } from "../domain/types.js";
import { HttpError } from "../engine/errors.js";
import highValue from "../library/templates-v2.json" with { type: "json" };
import type { Bodies } from "./body-service.js";
import type { Recorder } from "./recorder.js";

type MachineKind = Exclude<AssetKind, "system">;
/** the templates every org gets machines for: the library's high-value ones, whose every stage is a machine */
const FLEET_TEMPLATES = highValue.templates as { key: string; name: string; stages: { resourceKind: string }[] }[];
/** the zone a new org's default zones put each kind of machine in (matched by name; none when the org renamed them) */
const ZONE_OF: Partial<Record<MachineKind, string>> = { cnc: "machining", process_vessel: "machining", robot: "assembly", manual_station: "assembly", inspection: "quality & packing", pack_line: "quality & packing" };

/** Per kind, the most stages any one of these templates has of it: enough machines that a run of any of them never waits for one. */
function needs(): Map<MachineKind, number> {
  const need = new Map<MachineKind, number>();
  for (const t of FLEET_TEMPLATES) {
    const per = new Map<MachineKind, number>();
    for (const s of t.stages) if (s.resourceKind !== "system") per.set(s.resourceKind as MachineKind, (per.get(s.resourceKind as MachineKind) ?? 0) + 1);
    for (const [k, n] of per) need.set(k, Math.max(need.get(k) ?? 0, n));
  }
  return need;
}
const NEED = needs();

export interface FleetKind {
  kind: MachineKind;
  label: string;
  need: number;
  have: number;
  /** the names the missing ones get */
  add: string[];
  zone: string | null;
}
export interface FleetView {
  templates: { key: string; name: string }[];
  kinds: FleetKind[];
  missing: number;
}

/**
 * An org's machines for the library's templates. Right after creating an org its manager signs once,
 * and Ordo creates every virtual machine those templates need, each with its own device key and, when
 * machine wallets are on, its own Hedera account. The signature names exactly the machines it creates.
 */
export class Fleet {
  constructor(
    private db: Db,
    private rec: Recorder,
    private sigs: Signatures,
    private bodies: Bodies,
    private chainId: number,
  ) {}

  async view(siteId: string): Promise<FleetView> {
    const have = new Map((await this.db.query<{ kind: string; n: number }>("SELECT kind, count(*)::int AS n FROM assets WHERE site_id = $1 AND archived_at IS NULL GROUP BY kind", [siteId])).rows.map((r) => [r.kind, Number(r.n)]));
    const names = new Set((await this.db.query<{ name: string }>("SELECT lower(name) AS name FROM assets WHERE site_id = $1 AND archived_at IS NULL", [siteId])).rows.map((r) => r.name));
    const zones = new Map((await this.db.query<{ id: string; name: string }>("SELECT id, name FROM zones WHERE site_id = $1", [siteId])).rows.map((z) => [z.name.toLowerCase(), z.name]));
    const kinds: FleetKind[] = [];
    for (const [kind, need] of NEED) {
      const h = have.get(kind) ?? 0;
      const add: string[] = [];
      for (let i = 1; add.length < need - h; i++) {
        const name = `${ASSET_KIND_LABEL[kind]} ${i}`;
        if (!names.has(name.toLowerCase())) add.push(name);
      }
      kinds.push({ kind, label: ASSET_KIND_LABEL[kind], need, have: Math.min(h, need), add, zone: zones.get(ZONE_OF[kind] ?? "") ?? null });
    }
    return { templates: FLEET_TEMPLATES.map((t) => ({ key: t.key, name: t.name })), kinds, missing: kinds.reduce((n, k) => n + k.add.length, 0) };
  }

  /** what the signature binds: the org and the exact machines it creates */
  private entity(siteId: string, v: FleetView) {
    const plan = v.kinds.filter((k) => k.add.length).map((k) => ({ kind: k.kind, names: k.add }));
    return `${siteId}#fleet:${createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 32)}`;
  }

  private manager(roles: Role[]) {
    if (!roles.includes("manager")) throw new HttpError(403, "A manager sets up the org's machines");
  }

  async request(siteId: string, user: User, roles: Role[], chainId?: number): Promise<TypedSignature> {
    this.manager(roles);
    const v = await this.view(siteId);
    if (!v.missing) throw new HttpError(409, "This org already has every machine its templates need");
    const site = (await this.db.query<{ name: string }>("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0];
    const list = v.kinds.filter((k) => k.add.length).map((k) => `${k.add.length} × ${k.label}`).join(", ");
    return this.sigs.request(user, {
      action: "machines.fleet",
      entity: this.entity(siteId, v),
      meaning: `Create ${v.missing} virtual machines for ${site?.name ?? siteId} (${list}), each with its own device key${this.bodies.hasWallets ? " and its own Hedera account" : ""}, for the templates ${v.templates.map((t) => t.name).join(", ")}`,
      comment: "",
      site: siteId,
      chainId: chainId ?? this.chainId,
    });
  }

  async create(siteId: string, user: User, roles: Role[], proof: { nonce: string; signature: Hex }) {
    this.manager(roles);
    const v = await this.view(siteId);
    if (!v.missing) throw new HttpError(409, "This org already has every machine its templates need");
    const sig = await this.db.tx((q) => this.sigs.consume(q, user, { action: "machines.fleet", entity: this.entity(siteId, v) }, proof));
    const zones = new Map((await this.db.query<{ id: string; name: string }>("SELECT id, name FROM zones WHERE site_id = $1", [siteId])).rows.map((z) => [z.name, z.id]));
    const created: { assetId: string; name: string; kind: MachineKind }[] = [];
    const warnings: string[] = [];
    for (const k of v.kinds)
      for (const name of k.add) {
        const r = await this.bodies.create(siteId, user, roles, { name, kind: k.kind, zoneId: (k.zone && zones.get(k.zone)) ?? null, start: false });
        created.push({ assetId: r.assetId, name, kind: k.kind });
        for (const w of r.warnings) warnings.push(`${name}: ${w}`);
      }
    await this.rec.decide(siteId, {
      agent: `user:${user.address}`,
      kind: "machine.fleet_created",
      summary: `Signed for ${created.length} virtual machines for the templates ${v.templates.map((t) => t.name).join(", ")}`,
      data: { signatureId: sig.id, machines: created },
    });
    return { created, warnings, fleet: await this.view(siteId) };
  }
}
