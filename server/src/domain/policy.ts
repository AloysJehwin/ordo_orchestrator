import { parse } from "yaml";
import { z } from "zod";
import { hashOf } from "./canonical.js";
import { AutonomyLevel, levelRank, ROLE_RANK, RoleIn, ToolCall as ToolCallSchema, type PolicyResult, type Quality, type Role } from "./types.js";

const ToolPolicy = z.object({ autoFrom: AutonomyLevel, role: RoleIn.optional() });
export const PolicySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  confidenceThreshold: z.number().min(0).max(1),
  defaultRole: RoleIn,
  tools: z.object({
    hold_stage: ToolPolicy,
    reassign_stage: ToolPolicy,
    open_work_order: ToolPolicy,
    request_inspection: ToolPolicy,
    notify_operator: ToolPolicy,
  }),
});
export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(yamlText: string): { policy: Policy; hash: string } {
  const policy = PolicySchema.parse(parse(yamlText));
  return { policy, hash: hashOf(policy) };
}

export interface GuardContext {
  level: AutonomyLevel;
  confidence: number;
  inputQuality: Quality[];
  knownAssets: string[];
}

/** The same role, or a manager: a manager holds every right in the org; the other roles hold only their own. */
export const canApprove = (actor: Role, required: Role): boolean => actor === required || actor === "manager";
export const canApproveAny = (roles: Role[], required: Role): boolean => roles.some((r) => canApprove(r, required));

/**
 * Policy guard: a pure function. Every action an agent proposes passes through here.
 * Result: allow, require approval (by which role), or block.
 */
export function evaluate(action: unknown, ctx: GuardContext, policy: Policy, policyHash: string): PolicyResult {
  const base = { policyVersion: policy.version, policyHash };
  const block = (ruleId: string, explanation: string): PolicyResult => ({ outcome: "block", ruleIds: [ruleId], explanation, ...base });

  const parsed = ToolCallSchema.safeParse(action);
  if (!parsed.success) return block("R0-unknown-or-invalid-tool", "Action is not an allow-listed tool with valid arguments; machine safety functions are never callable.");
  const call = parsed.data;

  const assets = [
    "assetId" in call.args ? call.args.assetId : null,
    "targetAssetId" in call.args ? call.args.targetAssetId : null,
  ].filter((x): x is string => Boolean(x));
  const unknown = assets.find((a) => !ctx.knownAssets.includes(a));
  if (unknown) return block("R1-out-of-scope", `Asset ${unknown} is not registered at this site.`);

  const rules: string[] = [];
  const reasons: string[] = [];
  let role: Role | undefined;
  const need = (ruleId: string, r: Role, why: string) => {
    rules.push(ruleId);
    reasons.push(why);
    if (!role || ROLE_RANK[r] > ROLE_RANK[role]) role = r;
  };

  if (ctx.inputQuality.some((q) => q !== "good")) need("R2-data-quality", policy.defaultRole, "Some input data is not good quality.");
  if (ctx.confidence < policy.confidenceThreshold) need("R3-low-confidence", policy.defaultRole, `Confidence ${ctx.confidence.toFixed(2)} is below ${policy.confidenceThreshold}.`);
  const tp = policy.tools[call.tool];
  if (levelRank(ctx.level) < levelRank(tp.autoFrom))
    need(`R4-level-${call.tool}`, tp.role ?? policy.defaultRole, `${call.tool.replaceAll("_", " ")} runs on its own only from ${tp.autoFrom}; this line is at ${ctx.level}.`);

  if (rules.length === 0) return { outcome: "allow", ruleIds: ["R9-in-policy"], explanation: `Within policy at ${ctx.level}.`, ...base };
  return { outcome: "require_approval", role: role ?? policy.defaultRole, ruleIds: rules, explanation: reasons.join(" "), ...base };
}
