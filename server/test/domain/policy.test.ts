import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canApprove, canApproveAny, evaluate, loadPolicy, type GuardContext } from "../../src/domain/policy.js";
import { LEGACY_ROLE, LEVELS, RoleIn, ROLES, TemplateSpec, type AutonomyLevel, type ToolCall } from "../../src/domain/types.js";

const { policy, hash } = loadPolicy(readFileSync(new URL("../../../policies/default.yaml", import.meta.url), "utf8"));
const ctx = (level: AutonomyLevel, over: Partial<GuardContext> = {}): GuardContext => ({ level, confidence: 0.9, inputQuality: ["good"], knownAssets: ["A1", "A2"], ...over });

const A = {
  hold: { tool: "hold_stage", args: { runId: "R-0001", stageCode: "06", reason: "Cpk below limit" } },
  reassign: { tool: "reassign_stage", args: { runId: "R-0001", stageCode: "03a", targetAssetId: "A2" } },
  workOrder: { tool: "open_work_order", args: { assetId: "A1", priority: "high", windowMinutes: 30 } },
  inspect: { tool: "request_inspection", args: { assetId: "A1", sampleRatePct: 100 } },
  notify: { tool: "notify_operator", args: { assetId: "A1", instruction: "Reduce feed override to 80% until maintenance" } },
} satisfies Record<string, ToolCall>;

// a = allow, m = a manager's approval (policy v3: every escalation goes to a manager)
const MATRIX: Record<keyof typeof A, [string, string, string, string]> = {
  hold: ["m", "m", "a", "a"],
  reassign: ["m", "m", "a", "a"],
  workOrder: ["m", "m", "m", "a"],
  inspect: ["m", "m", "a", "a"],
  notify: ["m", "a", "a", "a"],
};
const decode = { a: ["allow", undefined], m: ["require_approval", "manager"] } as const;

describe("policy guard matrix", () => {
  for (const [name, row] of Object.entries(MATRIX))
    LEVELS.forEach((level, i) => {
      it(`${name} at ${level} → ${row[i]}`, () => {
        const r = evaluate(A[name as keyof typeof A], ctx(level), policy, hash);
        const [outcome, role] = decode[row[i] as keyof typeof decode];
        expect(r.outcome).toBe(outcome);
        expect(r.role).toBe(role);
        expect(r.policyHash).toBe(hash);
      });
    });
});

describe("policy guard safety rules", () => {
  it("blocks anything that is not an allow-listed tool, at every level", () => {
    for (const level of LEVELS) expect(evaluate({ tool: "override_interlock", args: {} }, ctx(level), policy, hash).outcome).toBe("block");
  });
  it("blocks unknown assets", () => {
    expect(evaluate({ ...A.workOrder, args: { ...A.workOrder.args, assetId: "ZZ" } }, ctx("L4"), policy, hash).outcome).toBe("block");
  });
  it("escalates low confidence and bad data even at L4", () => {
    expect(evaluate(A.hold, ctx("L4", { confidence: 0.4 }), policy, hash).ruleIds).toContain("R3-low-confidence");
    expect(evaluate(A.hold, ctx("L4", { inputQuality: ["bad"] }), policy, hash).ruleIds).toContain("R2-data-quality");
  });
  it("approval rights: the same role, or a manager", () => {
    for (const r of ROLES) {
      expect(canApprove(r, r)).toBe(true);
      expect(canApprove("manager", r)).toBe(true);
    }
    expect(canApprove("contributor", "manager")).toBe(false);
    expect(canApprove("contributor", "validator")).toBe(false);
    expect(canApprove("validator", "manager")).toBe(false);
    // no rank between the other roles: a validator is not a tester, nor a tester a validator
    expect(canApprove("validator", "tester")).toBe(false);
    expect(canApprove("tester", "validator")).toBe(false);
    expect(canApprove("validator", "contributor")).toBe(false);
    expect(canApproveAny(["contributor", "validator"], "validator")).toBe(true);
    expect(canApproveAny(["contributor", "tester"], "validator")).toBe(false);
    expect(canApproveAny([], "contributor")).toBe(false);
  });
});

describe("roles from before the four-role model", () => {
  it("map onto the four roles wherever a role is read from stored data", () => {
    expect(LEGACY_ROLE).toEqual({
      admin: "manager",
      plant_manager: "manager",
      supervisor: "manager",
      process_engineer: "manager",
      maintenance_lead: "manager",
      quality_engineer: "validator",
      operator: "contributor",
    });
    expect(RoleIn.parse("operator")).toBe("contributor");
    expect(RoleIn.parse("quality_engineer")).toBe("validator");
    expect(RoleIn.parse("tester")).toBe("tester");
    expect(RoleIn.safeParse("vendor").success).toBe(false);
  });

  it("an older policy file still loads: its roles become managers and validators", () => {
    const v2 = `id: default
version: 2
confidenceThreshold: 0.7
defaultRole: supervisor
tools:
  hold_stage: { autoFrom: L3 }
  reassign_stage: { autoFrom: L3 }
  open_work_order: { autoFrom: L4, role: maintenance_lead }
  request_inspection: { autoFrom: L3, role: quality_engineer }
  notify_operator: { autoFrom: L2 }
`;
    const old = loadPolicy(v2).policy;
    expect(old.defaultRole).toBe("manager");
    expect(old.tools.open_work_order.role).toBe("manager");
    expect(old.tools.request_inspection.role).toBe("validator");
    expect(evaluate(A.inspect, ctx("L1"), old, "h")).toMatchObject({ outcome: "require_approval", role: "validator" });
  });

  it("an older template's escalation roles map too, and the shipped policy and library use the manager", () => {
    const spec = TemplateSpec.parse({
      stages: [
        { code: "01", column: 1, name: "Machine", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "supervisor", timeoutMin: 10, criteria: [] },
        { code: "02", column: 2, name: "Inspect", agent: "vision_qa", resourceKind: "inspection", mode: "approve", escalationRole: "quality_engineer", timeoutMin: 10, criteria: [] },
      ],
      rework: null,
    });
    expect(spec.stages.map((s) => s.escalationRole)).toEqual(["manager", "validator"]);
    expect(policy).toMatchObject({ version: 3, defaultRole: "manager" });
    for (const t of Object.values(policy.tools)) if (t.role) expect(t.role).toBe("manager");
    const library = JSON.parse(readFileSync(new URL("../../src/library/templates.json", import.meta.url), "utf8")) as { templates: { stages: { escalationRole: string }[] }[] };
    const roles = library.templates.flatMap((t) => t.stages.map((s) => s.escalationRole));
    expect(roles).toHaveLength(140);
    expect(new Set(roles)).toEqual(new Set(["manager"]));
  });
});
