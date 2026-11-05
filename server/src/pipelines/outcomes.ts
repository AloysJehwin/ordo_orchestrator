import { Criterion, outcomeSignal, type Outcome, type StageSpec, type TemplateSpec } from "../domain/types.js";

/** The measured-signal criterion an outcome's metric becomes: read from `outcome.<key>`, which the machine reports. */
export function outcomeCriterion(o: Outcome): Criterion {
  return Criterion.parse({
    label: o.metric.label,
    op: o.metric.op,
    target: o.metric.target,
    ...(o.metric.targetMax !== undefined ? { targetMax: o.metric.targetMax } : {}),
    unit: o.metric.unit,
    kind: "signal",
    signal: outcomeSignal(o.key),
    agg: o.metric.agg ?? "last",
    outcome: o.key,
  });
}

/**
 * A stage's criteria with one per outcome: the outcome-made ones are rebuilt from `outcomes` (so editing an outcome
 * edits its criterion, and removing it removes its criterion); the stage's own criteria stay. The engine, the criteria
 * evaluation, zero-knowledge proofs and proof-of-work interviews then treat outcomes like any measured parameter.
 * Throws when an outcome's metric label is already one of the stage's own criteria.
 */
export function stageWithOutcomes(stage: StageSpec): StageSpec {
  const own = stage.criteria.filter((c) => !c.outcome);
  const made = stage.outcomes.map(outcomeCriterion);
  const labels = new Set(own.map((c) => c.label));
  for (const c of made) {
    if (labels.has(c.label)) throw new Error(`Stage ${stage.code}: the outcome metric "${c.label}" has the same name as one of the stage's criteria`);
    labels.add(c.label);
  }
  return { ...stage, criteria: [...own, ...made] };
}

export const withOutcomeCriteria = (spec: TemplateSpec): TemplateSpec => ({ ...spec, stages: spec.stages.map(stageWithOutcomes) });
