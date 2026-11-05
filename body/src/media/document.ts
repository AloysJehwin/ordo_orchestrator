import { band, decimals, fmt, inSpec, isCount, targetText } from "../metric.js";
import type { Rng } from "../rng.js";
import { renderRng, type CaptureSpec, type Rendered } from "./capture.js";
import { encodePdf, type PdfText } from "./pdf.js";
import { GREEN, INK, Raster, RED, type RGB } from "./raster.js";

interface Row {
  cells: string[];
  bad?: boolean;
}

/**
 * The rows of the report's table. A count of things out of tolerance lists characteristics, that many of them out; any
 * other metric lists the instrument's log through the stage, ending at the value it reports.
 */
function table(c: CaptureSpec, rng: Rng): { head: string[]; rows: Row[] } {
  const m = c.outcome.metric;
  const d = decimals(m);
  if (isCount(m)) {
    const n = Math.max(0, Math.round(c.value));
    const total = Math.max(8, n + 4);
    const bad = new Set<number>();
    while (bad.size < Math.min(n, total)) bad.add(rng.int(total));
    const rows = Array.from({ length: total }, (_, i): Row => {
      const tol = [0.02, 0.05, 0.1, 0.15][i % 4]!;
      const nominal = +(rng.range(5, 120)).toFixed(3);
      const dev = bad.has(i) ? tol * rng.range(1.15, 2) * (rng.chance(0.5) ? 1 : -1) : tol * rng.range(-0.8, 0.8);
      return { cells: [`C${String(i + 1).padStart(3, "0")}`, nominal.toFixed(3), (nominal + dev).toFixed(3), `±${tol.toFixed(2)}`, bad.has(i) ? "OUT" : "OK"], bad: bad.has(i) };
    });
    return { head: ["Feature", "Nominal", "Actual", "Tolerance", "Result"], rows };
  }
  const { lo, hi } = band(m);
  const span = Math.max(Math.abs(c.value) * 0.01, 10 ** -d, hi !== null && lo !== null ? (hi - lo) * 0.08 : 0);
  const rows: Row[] = [];
  const steps = 8;
  for (let i = 0; i < steps; i++) {
    const last = i === steps - 1;
    const v = last ? c.value : Math.max(0, c.value + rng.normal(0, span) * (1 - i / steps));
    rows.push({ cells: [`T+${String(i * 5).padStart(2, "0")} min`, v.toFixed(d), m.unit || "-", last ? "Reported" : ""], bad: last && !inSpec(m, c.value) });
  }
  return { head: ["Time", "Reading", "Unit", ""], rows };
}

/**
 * A one-page PDF report or certificate from the instrument: what was measured, against which target, the readings,
 * the value it reports and whether that is in specification, and which machine signed it. A rendering of the page is
 * the preview, and what the machine's agent reads.
 */
export function renderDocument(c: CaptureSpec): Rendered {
  const rng = renderRng(c);
  const m = c.outcome.metric;
  const ok = inSpec(m, c.value);
  const when = new Date(c.capturedAt * 1000).toISOString().replace("T", " ").slice(0, 19);
  const { head, rows } = table(c, rng);
  const lines: [string, string][] = [
    ["Run / stage", `${c.runId} / ${c.stage} ${c.stageName}`],
    ["Machine", `${c.asset} (${c.kind}), device ${c.device}`],
    ["Instrument", c.outcome.instrument],
    ["Measured", m.label],
    ["Target", targetText(m)],
    ["Captured", `${when} UTC`],
  ];

  // the PDF
  const texts: PdfText[] = [
    { x: 48, y: 60, text: c.outcome.label, size: 18, bold: true },
    { x: 48, y: 80, text: `${c.outcome.instrument} - report`, size: 10, color: [90, 90, 100] },
    { x: 400, y: 60, text: "VIRTUAL MACHINE", size: 9, bold: true, color: [180, 80, 20] },
    { x: 400, y: 72, text: "simulated output", size: 9, color: [180, 80, 20] },
  ];
  lines.forEach(([k, v], i) => {
    texts.push({ x: 48, y: 118 + i * 16, text: k, size: 10, bold: true });
    texts.push({ x: 150, y: 118 + i * 16, text: v.slice(0, 80), size: 10 });
  });
  const ty = 240;
  const colX = [48, 170, 270, 360, 450];
  head.forEach((h, i) => texts.push({ x: colX[i]!, y: ty, text: h, size: 9, bold: true }));
  rows.forEach((r, j) => r.cells.forEach((cell, i) => texts.push({ x: colX[i]!, y: ty + 18 + j * 14, text: cell, size: 9, bold: r.bad || cell === "Reported", color: r.bad ? [200, 30, 30] : undefined })));
  const sy = ty + 40 + rows.length * 14;
  texts.push({ x: 48, y: sy, text: `${m.label}: ${fmt(c.value, m)}`, size: 14, bold: true });
  texts.push({ x: 48, y: sy + 20, text: ok ? "Within specification" : "OUTSIDE SPECIFICATION", size: 11, bold: true, color: ok ? [20, 130, 60] : [200, 30, 30] });
  texts.push({ x: 48, y: 790, text: `Signed by the machine (device ${c.device}) with an OrdoOutput signature over this file's SHA-256.`, size: 8, color: [90, 90, 100] });
  texts.push({ x: 48, y: 802, text: "Produced by an Ordo virtual machine: a simulation, not a measurement of a physical part.", size: 8, color: [90, 90, 100] });
  const pdf = encodePdf({
    title: `${c.outcome.label} - ${c.runId}/${c.stage}`,
    texts,
    rules: [
      { x1: 48, y1: 92, x2: 547, y2: 92, width: 1 },
      { x1: 48, y1: ty + 6, x2: 547, y2: ty + 6 },
      { x1: 48, y1: 776, x2: 547, y2: 776 },
    ],
    boxes: [{ x: 44, y: sy - 16, w: 300, h: 44, fill: ok ? [232, 246, 236] : [252, 232, 232] }],
  });

  // the page, as the preview and what the agent reads
  const W = 420;
  const H = 594;
  const k = W / 595;
  const r = new Raster(W, H, [255, 255, 255]);
  const t = (x: number, y: number, s: string, col: RGB = INK, scale = 1) => r.text(Math.round(x * k), Math.round(y * k), s.slice(0, Math.floor((W - x * k - 4) / (6 * scale))), col, scale);
  t(48, 46, c.outcome.label, INK, 2);
  t(48, 84, c.outcome.instrument, [90, 90, 100]);
  r.text(W - 96, 8, "VIRTUAL MACHINE", [180, 80, 20]);
  r.line(Math.round(48 * k), Math.round(96 * k), Math.round(547 * k), Math.round(96 * k), INK);
  lines.forEach(([kk, v], i) => {
    t(48, 112 + i * 16, kk);
    t(150, 112 + i * 16, v);
  });
  head.forEach((h, i) => t(colX[i]!, ty - 6, h));
  r.line(Math.round(48 * k), Math.round((ty + 6) * k), Math.round(547 * k), Math.round((ty + 6) * k), INK);
  rows.forEach((row, j) => row.cells.forEach((cell, i) => t(colX[i]!, ty + 12 + j * 14, cell, row.bad ? RED : INK)));
  r.rect(Math.round(44 * k), Math.round((sy - 18) * k), Math.round(420 * k), 44, ok ? [232, 246, 236] : [252, 232, 232]);
  t(48, sy - 12, m.label);
  t(48, sy + 2, fmt(c.value, m), INK, 2);
  t(260, sy + 6, ok ? "WITHIN SPECIFICATION" : "OUTSIDE SPECIFICATION", ok ? GREEN : RED);
  t(48, 790, `SIGNED BY ${c.device.slice(0, 10)}…`, [90, 90, 100]);
  r.frame(0, 0, W, H, [200, 200, 206]);
  const png = r.png();
  return { file: { bytes: pdf, mime: "application/pdf", ext: "pdf" }, preview: { bytes: png, mime: "image/png", ext: "png" }, perceive: png };
}
