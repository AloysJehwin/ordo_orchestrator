/** One run of text on the page, in points from the top left. */
export interface PdfText {
  x: number;
  y: number;
  text: string;
  size: number;
  bold?: boolean;
  color?: readonly [number, number, number];
}
export interface PdfRule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width?: number;
  color?: readonly [number, number, number];
}
export interface PdfBox {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: readonly [number, number, number];
}

const A4 = { w: 595, h: 842 };

/** Text as Helvetica (WinAnsi) takes it: the symbols it lacks spelled out, and the PDF string delimiters escaped. */
function pdfString(s: string): string {
  const t = s.replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/Δ/g, "delta ").replace(/[–—]/g, "-").replace(/→/g, "->").replace(/…/g, "...").replace(/Ω/g, "Ohm").replace(/[αΑ]/g, "a").replace(/[^\x20-\x7e°µ·×²³±]/g, "?");
  return t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
const rgb = (c: readonly [number, number, number] | undefined) => (c ?? [0, 0, 0]).map((v) => (v / 255).toFixed(3)).join(" ");

/**
 * A one-page A4 PDF: text in Helvetica and Helvetica-Bold, rules and filled boxes. No dates or ids of its own, so the
 * same content gives the same bytes (for replay).
 */
export function encodePdf(page: { title: string; texts: PdfText[]; rules?: PdfRule[]; boxes?: PdfBox[] }): Uint8Array {
  const ops: string[] = [];
  for (const b of page.boxes ?? []) ops.push(`${rgb(b.fill)} rg ${b.x} ${A4.h - b.y - b.h} ${b.w} ${b.h} re f`);
  for (const r of page.rules ?? []) ops.push(`${rgb(r.color)} RG ${r.width ?? 0.6} w ${r.x1} ${A4.h - r.y1} m ${r.x2} ${A4.h - r.y2} l S`);
  for (const t of page.texts) ops.push(`BT ${rgb(t.color)} rg /${t.bold ? "F2" : "F1"} ${t.size} Tf ${t.x} ${A4.h - t.y} Td (${pdfString(t.text)}) Tj ET`);
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title (${pdfString(page.title)}) /Producer (Ordo machine body) >>`,
  ];
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
