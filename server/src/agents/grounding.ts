/**
 * Grounding check: every decimal number the model writes must appear (±2 %) somewhere in
 * the input it was given. Small integers and percentages-as-words are ignored. A failed
 * check does not reject the output; it caps confidence so the policy guard escalates.
 */
export function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string") for (const m of value.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectNumbers(v, out);
  return out;
}

export function groundingCheck(text: string, input: unknown): { ok: boolean; unknownNumbers: number[] } {
  const known = collectNumbers(input);
  const derived = new Set<number>();
  for (const k of known) {
    derived.add(Math.round(k));
    derived.add(Math.round(k * 10) / 10);
    derived.add(Math.round(k * 100)); // probability 0.94 → 94 (%)
    derived.add(Math.round(k * 60)); // hours → minutes
  }
  const unknown: number[] = [];
  for (const m of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    const isSmallInt = Number.isInteger(n) && Math.abs(n) <= 10;
    if (isSmallInt) continue;
    const ok = known.some((k) => Math.abs(k - n) <= Math.max(0.02 * Math.abs(k), 0.051)) || derived.has(n);
    if (!ok) unknown.push(n);
  }
  return { ok: unknown.length === 0, unknownNumbers: unknown };
}
