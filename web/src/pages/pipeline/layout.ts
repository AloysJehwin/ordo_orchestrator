import type { StageRunView, StageState } from "../../types";

export interface NodePos {
  s: StageRunView;
  x: number;
  y: number;
}
export interface EdgePos {
  from: NodePos;
  to: NodePos;
}

/** Same rules as the server: equal lane counts continue lane by lane; otherwise split/merge all-to-all. */
export function layout(stages: StageRunView[], opts: { colW: number; laneH: number; padX: number; padY: number }) {
  const cols = new Map<number, StageRunView[]>();
  for (const s of stages) cols.set(s.column, [...(cols.get(s.column) ?? []), s]);
  const ordered = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((a, b) => a.code.localeCompare(b.code)));
  const maxLanes = Math.max(1, ...ordered.map((c) => c.length));
  const height = opts.padY * 2 + (maxLanes - 1) * opts.laneH;
  const mid = height / 2;
  const nodes: NodePos[] = [];
  ordered.forEach((col, i) => {
    col.forEach((s, j) => nodes.push({ s, x: opts.padX + i * opts.colW, y: mid + (j - (col.length - 1) / 2) * opts.laneH }));
  });
  const by = new Map(nodes.map((n) => [n.s.code, n]));
  const edges: EdgePos[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    if (a.length === b.length && a.length > 1) a.forEach((s, j) => edges.push({ from: by.get(s.code)!, to: by.get(b[j]!.code)! }));
    else for (const s of a) for (const t of b) edges.push({ from: by.get(s.code)!, to: by.get(t.code)! });
  }
  return { nodes, edges, width: opts.padX * 2 + (ordered.length - 1) * opts.colW, height, by };
}

export const DONE: StageState[] = ["completed", "done_deviation", "skipped"];
export const edgeClass = (to: StageState) => (DONE.includes(to) ? "e-done" : to === "queued" ? "e-queued" : "e-active");
