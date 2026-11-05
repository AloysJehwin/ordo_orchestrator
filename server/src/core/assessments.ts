import type { Assessment, Purchase } from "../chain/x402.js";
import type { PlantService } from "../plant/plant.js";
import type { Jobs, JobView } from "./jobs.js";
import type { Recorder } from "./recorder.js";

export const ASSESS_JOB = "x402.assess";
/** How far back the agent sends readings for an assessment. */
const WINDOW_MINUTES = 6 * 60;

export interface AssessmentBuyer {
  post<T>(url: string, body: unknown): Promise<Purchase<T>>;
}
export interface AssessmentView {
  status: JobView["status"];
  error: string | null;
  skipped: string | null;
  assessment: Assessment | null;
  payment: Purchase<Assessment>["payment"];
}

/**
 * Before a vendor is sent out, the maintenance agent buys an independent vibration assessment for the asset, paying
 * per call over x402 from its own Hedera account. Runs as a job so a slow facilitator never holds up the work order.
 */
export class Assessments {
  constructor(
    private jobs: Jobs,
    private plant: PlantService,
    private rec: Recorder,
    private buyer: AssessmentBuyer,
    readonly url: string,
  ) {
    jobs.register(ASSESS_JOB, (p: { assetId: string }, job) => this.buy(job.siteId!, job.ref, p.assetId));
  }

  request(siteId: string, workOrderId: string, assetId: string) {
    return this.jobs.enqueue(siteId, ASSESS_JOB, workOrderId, { assetId });
  }

  private async buy(siteId: string, workOrderId: string, assetId: string): Promise<Record<string, unknown>> {
    const samples = (await this.plant.series(assetId, "vibration", WINDOW_MINUTES)).filter((p) => p.value !== null).map((p) => ({ t: p.ts, v: p.value! }));
    if (samples.length < 3) return { skipped: "Fewer than three vibration readings in the last 6 hours: nothing to assess" };
    const r = await this.buyer.post<Assessment>(this.url, { machineClass: "medium", samples });
    const a = r.body;
    await this.rec.decide(siteId, {
      agent: "agent:maintenance",
      kind: "work_order.assessed",
      assetId,
      summary: `Bought a vibration assessment for ${workOrderId} over x402: zone ${a.zone} at ${a.level} mm/s${a.zone !== "D" && a.hoursToZoneD !== null ? `, zone D ${a.hoursToZoneD < 1 ? "within the hour" : `in about ${Math.round(a.hoursToZoneD)} h`} at this trend` : ""}`,
      data: { workOrderId, assessment: a, payment: r.payment },
    });
    return { assessment: a, payment: r.payment };
  }

  async of(workOrderId: string): Promise<AssessmentView | null> {
    const j = await this.jobs.latest(ASSESS_JOB, workOrderId);
    if (!j) return null;
    const res = (j.result ?? {}) as { assessment?: Assessment; payment?: AssessmentView["payment"]; skipped?: string };
    return { status: j.status, error: j.error, skipped: res.skipped ?? null, assessment: res.assessment ?? null, payment: res.payment ?? null };
  }

  retry(workOrderId: string) {
    return this.jobs.retry(ASSESS_JOB, workOrderId);
  }
}
