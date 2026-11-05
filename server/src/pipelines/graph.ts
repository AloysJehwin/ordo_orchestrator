import type { StageSpec } from "../domain/types.js";

export interface Edge {
  from: string;
  to: string;
}

/** Stages grouped by column, lanes ordered by their letter suffix. */
export function columns(stages: StageSpec[]): StageSpec[][] {
  const by = new Map<number, StageSpec[]>();
  for (const s of stages) by.set(s.column, [...(by.get(s.column) ?? []), s]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((a, b) => a.code.localeCompare(b.code)));
}

/**
 * Edges between adjacent columns, as the design defines them: when two adjacent columns have the
 * same number of parallel stages each lane continues on its own; otherwise lanes split or merge
 * (every stage connects to every stage of the next column).
 */
export function edges(stages: StageSpec[]): Edge[] {
  const cols = columns(stages);
  const out: Edge[] = [];
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i]!;
    const b = cols[i + 1]!;
    if (a.length === b.length && a.length > 1) a.forEach((s, j) => out.push({ from: s.code, to: b[j]!.code }));
    else for (const s of a) for (const t of b) out.push({ from: s.code, to: t.code });
  }
  return out;
}

export function predecessors(stages: StageSpec[]): Map<string, string[]> {
  const p = new Map<string, string[]>(stages.map((s) => [s.code, []]));
  for (const e of edges(stages)) p.get(e.to)!.push(e.from);
  return p;
}

/** Validate a spec built in the builder: codes unique, columns contiguous from 1, codes match columns. */
export function validateSpec(stages: StageSpec[], rework: { from: string; to: string } | null): string[] {
  const errors: string[] = [];
  const codes = new Set<string>();
  for (const s of stages) {
    if (codes.has(s.code)) errors.push(`Stage code ${s.code} is used twice`);
    codes.add(s.code);
    if (Number(s.code.slice(0, 2)) !== s.column) errors.push(`Stage ${s.code} is in column ${s.column}`);
  }
  const cols = [...new Set(stages.map((s) => s.column))].sort((a, b) => a - b);
  cols.forEach((c, i) => {
    if (c !== i + 1) errors.push(`Columns must run 1…${cols.length} without gaps`);
  });
  if (rework) {
    const from = stages.find((s) => s.code === rework.from);
    const to = stages.find((s) => s.code === rework.to);
    if (!from || !to) errors.push("Rework loop refers to a missing stage");
    else if (to.column >= from.column) errors.push("A rework loop must send units back to an earlier stage");
  }
  return [...new Set(errors)];
}

/** Recompute codes after the builder reorders or adds stages: one stage per column → "05", several → "05a", "05b". */
export function renumber<T extends { column: number }>(stages: T[]): (T & { code: string })[] {
  const cols = [...new Set(stages.map((s) => s.column))].sort((a, b) => a - b);
  const remap = new Map(cols.map((c, i) => [c, i + 1]));
  const out: (T & { code: string })[] = [];
  for (const c of cols) {
    const group = stages.filter((s) => s.column === c);
    group.forEach((s, j) => {
      const col = remap.get(c)!;
      out.push({ ...s, column: col, code: `${String(col).padStart(2, "0")}${group.length > 1 ? String.fromCharCode(97 + j) : ""}` });
    });
  }
  return out;
}
