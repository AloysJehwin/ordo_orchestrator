import type { CriterionResult } from "../domain/types.js";
import type { StageSeriesView } from "./stage-series.js";

/**
 * A stage's parameters as one SVG: each criterion against its acceptable band, where the value fell, and the signal's
 * trend over the stage window. Attached by the agent pre-check as validation evidence, so it carries the measured values
 * and is served only through the authenticated evidence route. Colours are the console's light tokens; status is never
 * colour alone (a shape and a word go with it).
 */
const C = { text: "#201f1d", muted: "#605d5d", faint: "#9b9797", divider: "rgba(32,31,29,0.14)", surface: "#ffffff", band: "rgba(32,31,29,0.08)", ok: "#2f6b3b", bad: "#a3322a", accent: "#b68235" };
const W = 760;
const ROW = 84;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number) => (Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));
const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** A linear domain that shows the band with room around it and always includes the values. */
export function bandDomain(lo: number | null, hi: number | null, values: number[]): [number, number] {
  const pts = [lo, hi, ...values].filter(isNum);
  if (!pts.length) return [0, 1];
  let a = Math.min(...pts);
  let b = Math.max(...pts);
  if (isNum(lo) && isNum(hi)) {
    const span = hi - lo || Math.abs(lo) * 0.1 || 1;
    a = Math.min(a, lo - span * 0.25);
    b = Math.max(b, hi + span * 0.25);
  } else if (isNum(lo)) {
    const span = Math.max(...values.map((v) => Math.abs(v - lo)), Math.abs(lo) * 0.1, 1);
    a = Math.min(a, lo - span * 0.5);
    b = Math.max(b, lo + span * 1.5);
  } else if (isNum(hi)) {
    const span = Math.max(...values.map((v) => Math.abs(hi - v)), Math.abs(hi) * 0.1, 1);
    a = Math.min(a, hi - span * 1.5);
    b = Math.max(b, hi + span * 0.5);
  }
  if (a === b) (a -= 1), (b += 1);
  return [a, b];
}

function marker(x: number, y: number, ok: boolean | null, title: string): string {
  const t = `<title>${esc(title)}</title>`;
  if (ok === true) return `<g>${t}<circle cx="${x}" cy="${y}" r="7" fill="${C.surface}"/><circle cx="${x}" cy="${y}" r="5" fill="${C.ok}"/></g>`;
  if (ok === false) return `<g>${t}<polygon points="${x},${y - 8} ${x + 8},${y + 6} ${x - 8},${y + 6}" fill="${C.surface}"/><polygon points="${x},${y - 6} ${x + 6},${y + 4} ${x - 6},${y + 4}" fill="${C.bad}"/></g>`;
  return `<g>${t}<circle cx="${x}" cy="${y}" r="5" fill="${C.surface}" stroke="${C.faint}" stroke-width="2"/></g>`;
}

function bandGlyph(c: CriterionResult, x0: number, w: number, y: number): string {
  const lo = c.band?.lo ?? null;
  const hi = c.band?.hi ?? null;
  const v = c.measured?.value ?? null;
  const vMax = c.measuredMax?.value ?? null;
  const [a, b] = bandDomain(lo, hi, [v, vMax].filter(isNum));
  const x = (val: number) => x0 + ((val - a) / (b - a)) * w;
  const bl = isNum(lo) ? x(lo) : x0;
  const bh = isNum(hi) ? x(hi) : x0 + w;
  let out = `<line x1="${x0}" x2="${x0 + w}" y1="${y}" y2="${y}" stroke="${C.divider}" stroke-width="1"/>`;
  out += `<rect x="${Math.min(bl, bh).toFixed(1)}" y="${y - 9}" width="${Math.max(2, Math.abs(bh - bl)).toFixed(1)}" height="18" rx="3" fill="${C.band}"/>`;
  if (isNum(lo)) out += `<line x1="${bl.toFixed(1)}" x2="${bl.toFixed(1)}" y1="${y - 13}" y2="${y + 13}" stroke="${C.muted}" stroke-width="1"/><text x="${bl.toFixed(1)}" y="${y + 26}" font-size="10" text-anchor="middle" fill="${C.muted}">${esc(num(lo))}</text>`;
  if (isNum(hi) && hi !== lo) out += `<line x1="${bh.toFixed(1)}" x2="${bh.toFixed(1)}" y1="${y - 13}" y2="${y + 13}" stroke="${C.muted}" stroke-width="1"/><text x="${bh.toFixed(1)}" y="${y + 26}" font-size="10" text-anchor="middle" fill="${C.muted}">${esc(num(hi))}</text>`;
  if (isNum(v) && isNum(vMax) && vMax !== v) {
    out += `<line x1="${x(v).toFixed(1)}" x2="${x(vMax).toFixed(1)}" y1="${y}" y2="${y}" stroke="${c.ok === false ? C.bad : C.ok}" stroke-width="3" stroke-linecap="round"/>`;
    out += marker(Number(x(v).toFixed(1)), y, c.ok, `minimum ${num(v)}`) + marker(Number(x(vMax).toFixed(1)), y, c.ok, `maximum ${num(vMax)}`);
    out += `<text x="${((x(v) + x(vMax)) / 2).toFixed(1)}" y="${y - 15}" font-size="11" text-anchor="middle" fill="${C.text}">${esc(`${num(v)}–${num(vMax)}${c.unit ? ` ${c.unit}` : ""}`)}</text>`;
  } else if (isNum(v)) {
    out += marker(Number(x(v).toFixed(1)), y, c.ok, `${num(v)}${c.unit ? ` ${c.unit}` : ""}`);
    out += `<text x="${x(v).toFixed(1)}" y="${y - 15}" font-size="11" text-anchor="middle" fill="${C.text}">${esc(`${num(v)}${c.unit ? ` ${c.unit}` : ""}`)}</text>`;
  } else out += `<text x="${(x0 + w / 2).toFixed(1)}" y="${y - 15}" font-size="11" text-anchor="middle" fill="${C.faint}">not measured</text>`;
  return out;
}

function trend(pts: { ts: number; value: number }[], lo: number | null, hi: number | null, x0: number, w: number, y0: number, h: number, ok: boolean | null): string {
  if (pts.length < 2) return `<text x="${x0 + w / 2}" y="${y0 + h / 2 + 4}" font-size="10" text-anchor="middle" fill="${C.faint}">${pts.length ? "one reading" : "no trend"}</text>`;
  const vals = pts.map((p) => p.value);
  const [a, b] = bandDomain(lo, hi, [Math.min(...vals), Math.max(...vals)]);
  const t0 = pts[0]!.ts;
  const t1 = pts.at(-1)!.ts || t0 + 1;
  const x = (t: number) => x0 + ((t - t0) / (t1 - t0 || 1)) * w;
  const y = (v: number) => y0 + h - ((v - a) / (b - a)) * h;
  const top = isNum(hi) ? y(hi) : y0;
  const bottom = isNum(lo) ? y(lo) : y0 + h;
  let out = `<rect x="${x0}" y="${Math.min(top, bottom).toFixed(1)}" width="${w}" height="${Math.max(1, Math.abs(bottom - top)).toFixed(1)}" fill="${C.band}"/>`;
  if (isNum(lo)) out += `<line x1="${x0}" x2="${x0 + w}" y1="${y(lo).toFixed(1)}" y2="${y(lo).toFixed(1)}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="3 3"/>`;
  if (isNum(hi)) out += `<line x1="${x0}" x2="${x0 + w}" y1="${y(hi).toFixed(1)}" y2="${y(hi).toFixed(1)}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="3 3"/>`;
  out += `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linejoin="round"/>`;
  const last = pts.at(-1)!;
  out += marker(Number(x(last.ts).toFixed(1)), Number(y(last.value).toFixed(1)), ok, `last ${num(last.value)}`);
  return out;
}

export function renderParameterChart(input: { title: string; subtitle: string; criteria: CriterionResult[]; series: StageSeriesView | null; generatedAt?: string }): string {
  const rows = input.criteria;
  const height = 60 + Math.max(1, rows.length) * ROW + 30;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="'IBM Plex Sans', system-ui, sans-serif" role="img" aria-label="${esc(`Parameters of ${input.title}`)}">`);
  parts.push(`<rect width="${W}" height="${height}" fill="${C.surface}"/>`);
  parts.push(`<text x="16" y="26" font-size="15" font-weight="600" fill="${C.text}">${esc(input.title)}</text>`);
  parts.push(`<text x="16" y="44" font-size="11" fill="${C.muted}">${esc(input.subtitle)}</text>`);
  const window = input.series?.window;
  if (window) parts.push(`<text x="${W - 16}" y="44" font-size="11" text-anchor="end" fill="${C.muted}">${esc(`window ${new Date(window.from).toISOString().slice(0, 16).replace("T", " ")} → ${new Date(window.to).toISOString().slice(11, 16)} UTC`)}</text>`);
  parts.push(`<line x1="16" x2="${W - 16}" y1="56" y2="56" stroke="${C.divider}"/>`);
  if (!rows.length) parts.push(`<text x="16" y="96" font-size="12" fill="${C.faint}">This stage has no success criteria.</text>`);
  rows.forEach((c, i) => {
    const y = 60 + i * ROW;
    const mid = y + 38;
    const status = c.ok === true ? "Pass" : c.ok === false ? "Out of spec ▲" : "Not measured";
    const statusColor = c.ok === true ? C.ok : c.ok === false ? C.bad : C.faint;
    const how = c.kind === "signal" ? `${c.signal ?? ""}${c.agg ? ` · ${c.agg}` : ""}${c.n ? ` · ${c.n} samples` : ""}` : c.kind === "manual" ? "confirmed by a person" : "from counts and time";
    parts.push(`<text x="16" y="${mid - 4}" font-size="13" font-weight="600" fill="${C.text}">${esc(c.label)}</text>`);
    parts.push(`<text x="16" y="${mid + 13}" font-size="11" fill="${C.muted}">${esc(`target ${c.target}`)}</text>`);
    parts.push(`<text x="16" y="${mid + 27}" font-size="10" fill="${C.faint}">${esc(how)}</text>`);
    parts.push(bandGlyph(c, 232, 230, mid));
    parts.push(`<text x="490" y="${mid + 4}" font-size="12" font-weight="600" fill="${statusColor}">${esc(status)}</text>`);
    const pts = c.signal ? input.series?.signals[c.signal] ?? [] : [];
    parts.push(trend(pts, c.band?.lo ?? null, c.band?.hi ?? null, 580, 164, y + 10, 56, c.ok));
    if (i < rows.length - 1) parts.push(`<line x1="16" x2="${W - 16}" y1="${y + ROW - 2}" y2="${y + ROW - 2}" stroke="${C.divider}"/>`);
  });
  parts.push(`<text x="16" y="${height - 10}" font-size="10" fill="${C.faint}">${esc(`Generated by Ordo's agent pre-check at ${input.generatedAt ?? new Date().toISOString()}. Band: acceptable region. ● pass, ▲ out of spec, ○ not measured. Trend: the signal over the stage window.`)}</text>`);
  parts.push("</svg>");
  return parts.join("\n");
}
