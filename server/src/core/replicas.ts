import { createHash } from "node:crypto";
import type { BlobStore } from "../chain/zerog.js";
import type { Db } from "../db/db.js";
import { HttpError } from "../engine/errors.js";
import type { Jobs } from "./jobs.js";
import type { Recorder } from "./recorder.js";

export const REPLICATE_JOB = "og.upload";

export interface ReplicaView {
  status: "pending" | "done" | "failed";
  root: string | null;
  url: string | null;
  error: string | null;
}

/**
 * Validation evidence copied to 0G Storage. Ordo keeps serving files from its database; the copy on 0G, named by its
 * Merkle root, is recorded in the ledger so the evidence behind a release stays available and checkable even if
 * Ordo's database is lost. Uploads run as jobs and retry with back-off.
 */
export class Replicas {
  constructor(
    private db: Db,
    private jobs: Jobs,
    private rec: Recorder,
    readonly store: BlobStore,
  ) {
    jobs.register(REPLICATE_JOB, async (_p, job) => {
      const bytes = await this.bytes(job.ref);
      const r = await this.store.put(bytes);
      if (job.siteId)
        await this.rec.decide(job.siteId, {
          agent: "system:0g",
          kind: "evidence.replicated",
          summary: `Evidence sha256:${job.ref.slice(0, 12)}… stored on 0G Storage, root ${r.root.slice(0, 14)}…`,
          data: { sha256: `sha256:${job.ref}`, root: r.root, tx: r.tx, url: r.url },
        });
      return r;
    });
  }

  private async bytes(hex: string): Promise<Uint8Array> {
    const b = (await this.db.query<{ bytes: Uint8Array }>("SELECT bytes FROM blobs WHERE sha256 = $1", [hex])).rows[0];
    if (!b) throw new Error(`No blob sha256:${hex}`);
    return new Uint8Array(b.bytes);
  }

  /** Queue a copy of a stored file (by its sha256:… hash). */
  request(siteId: string, sha: string) {
    return this.jobs.enqueue(siteId, REPLICATE_JOB, sha.replace(/^sha256:/, ""), {});
  }

  async of(shas: string[]): Promise<Map<string, ReplicaView>> {
    const jobs = await this.jobs.latestMany(REPLICATE_JOB, shas.map((s) => s.replace(/^sha256:/, "")));
    return new Map(
      [...jobs].map(([hex, j]) => {
        const r = (j.result ?? {}) as { root?: string; url?: string };
        return [`sha256:${hex}`, { status: j.status, root: r.root ?? null, url: r.url ?? null, error: j.error }];
      }),
    );
  }

  /** Download the copy from 0G, decrypt it and check it is byte for byte the file Ordo recorded. */
  async verify(sha: string): Promise<{ ok: boolean; root: string; sha256: string; size: number }> {
    const hex = sha.replace(/^sha256:/, "");
    const r = (await this.of([hex])).get(`sha256:${hex}`);
    if (!r?.root) throw new HttpError(409, "This file has no copy on 0G yet");
    const bytes = await this.store.get(r.root);
    const got = createHash("sha256").update(bytes).digest("hex");
    return { ok: got === hex, root: r.root, sha256: `sha256:${got}`, size: bytes.byteLength };
  }

  retry(sha: string) {
    return this.jobs.retry(REPLICATE_JOB, sha.replace(/^sha256:/, ""));
  }
}
