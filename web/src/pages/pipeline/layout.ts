import type { StageRunView, StageState } from "../../types";

export interface NodePos {
  s: StageRunView;
  x: number;
  y: number;
  /** column index (0-based) and lane index within it */
  col: number;
  lane: number;
}
export interface EdgePos {
  from: NodePos;
  to: NodePos;
}
export interface ColPos {
  x: number;
  stages: StageRunView[];
}

/** Same rules as the server: equal lane counts continue lane by lane; otherwise split/merge all-to-all. */
export function layout(stages: StageRunView[], opts: { colW: number; laneH: number; padX: number; padY: number; padTop?: number }) {
  const byCol = new Map<number, StageRunView[]>();
  for (const s of stages) byCol.set(s.column, [...(byCol.get(s.column) ?? []), s]);
  const ordered = [...byCol.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((a, b) => a.code.localeCompare(b.code)));
  const maxLanes = Math.max(1, ...ordered.map((c) => c.length));
  const top = opts.padTop ?? 0;
  const height = top + opts.padY * 2 + (maxLanes - 1) * opts.laneH;
  const mid = top + (height - top) / 2;
  const nodes: NodePos[] = [];
  const cols: ColPos[] = [];
  ordered.forEach((col, i) => {
    const x = opts.padX + i * opts.colW;
    cols.push({ x, stages: col });
    col.forEach((s, j) => nodes.push({ s, x, y: mid + (j - (col.length - 1) / 2) * opts.laneH, col: i, lane: j }));
  });
  const by = new Map(nodes.map((n) => [n.s.code, n]));
  const edges: EdgePos[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    if (a.length === b.length && a.length > 1) a.forEach((s, j) => edges.push({ from: by.get(s.code)!, to: by.get(b[j]!.code)! }));
    else for (const s of a) for (const t of b) edges.push({ from: by.get(s.code)!, to: by.get(t.code)! });
  }
  return { nodes, edges, cols, width: opts.padX * 2 + (ordered.length - 1) * opts.colW, height, by };
}
export type Layout = ReturnType<typeof layout>;

/** How many columns the stages fill. */
export const columnCount = (stages: StageRunView[]) => new Set(stages.map((s) => s.column)).size;

/** A column width that spreads the pipeline over the space it has, within [min, max]; long pipelines scroll. */
export function fitColumn(width: number, cols: number, padX: number, min: number, max: number): number {
  if (cols < 2 || width <= 0) return min;
  return Math.max(min, Math.min(max, Math.floor((width - padX * 2) / (cols - 1))));
}

/** The stage an arrow key moves to: the nearest lane in the next or previous column, or the next lane in this one. */
export function neighbour(L: Layout, code: string, key: string): string | null {
  const n = L.by.get(code);
  if (!n) return null;
  const col = (i: number) => L.nodes.filter((m) => m.col === i);
  if (key === "ArrowUp" || key === "ArrowDown") {
    const same = col(n.col);
    return same[n.lane + (key === "ArrowDown" ? 1 : -1)]?.s.code ?? null;
  }
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const next = col(n.col + (key === "ArrowRight" ? 1 : -1));
  if (!next.length) return null;
  return next.reduce((a, b) => (Math.abs(b.y - n.y) < Math.abs(a.y - n.y) ? b : a)).s.code;
}

export const DONE: StageState[] = ["completed", "done_deviation", "skipped"];
export const edgeClass = (to: StageState) => (DONE.includes(to) ? "e-done" : to === "queued" ? "e-queued" : "e-active");
/** The legend swatch for a stage state. */
export const swatch = (s: StageState) =>
  s === "completed" || s === "skipped" ? "done" : s === "running" ? "run" : s === "awaiting_approval" ? "gate" : s === "held" ? "held" : s === "done_deviation" ? "dev" : "queued";
/** A stage that waits on a person at its gate. */
export const atGate = (s: StageRunView) => s.state === "awaiting_approval" || s.state === "held";
/** A role key as words: quality_engineer → quality engineer. */
export const roleWords = (r: string) => r.replaceAll("_", " ");
