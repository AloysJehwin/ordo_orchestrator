import { bandDomain, fmtNum, isNum } from "../lib/criteria";

export interface SpecBandProps {
  /** the acceptable region; an open end is null */
  lo: number | null;
  hi: number | null;
  /** where the value fell (null: not measured, or not shown, as on the public passport) */
  value?: number | null;
  /** the upper value of an envelope (its minimum is `value`) */
  valueMax?: number | null;
  ok: boolean | null;
  unit?: string;
  compact?: boolean;
  label?: string;
}

/** A marker whose shape says the state as well as its colour: ● pass, ▲ out of spec, ○ not measured. */
function Mark({ x, y, ok, r, title }: { x: number; y: number; ok: boolean | null; r: number; title: string }) {
  if (ok === true)
    return (
      <g>
        <title>{title}</title>
        <circle cx={x} cy={y} r={r + 2} className="sb-ring" />
        <circle cx={x} cy={y} r={r} className="sb-mark ok" />
      </g>
    );
  if (ok === false)
    return (
      <g>
        <title>{title}</title>
        <polygon points={`${x},${y - r - 3} ${x + r + 3},${y + r + 1} ${x - r - 3},${y + r + 1}`} className="sb-ring" />
        <polygon points={`${x},${y - r - 1} ${x + r + 1},${y + r - 1} ${x - r - 1},${y + r - 1}`} className="sb-mark bad" />
      </g>
    );
  return (
    <g>
      <title>{title}</title>
      <circle cx={x} cy={y} r={r} className="sb-mark na" />
    </g>
  );
}

/**
 * One parameter against its acceptable band: the band is a neutral region with its bounds marked; where the value fell is a
 * marker whose shape and colour both carry the state. On the public passport the value is withheld and only the band shows.
 */
export function SpecBand(p: SpecBandProps) {
  const compact = Boolean(p.compact);
  const w = compact ? 120 : 240;
  const h = compact ? 14 : 40;
  const mid = compact ? 7 : 20;
  const r = compact ? 3.5 : 5;
  const pad = compact ? 5 : 8;
  const values = [p.value, p.valueMax].filter(isNum);
  const [a, b] = bandDomain(p.lo, p.hi, values);
  const x = (v: number) => pad + ((v - a) / (b - a)) * (w - pad * 2);
  const bl = isNum(p.lo) ? x(p.lo) : 0;
  const bh = isNum(p.hi) ? x(p.hi) : w;
  const unit = p.unit ? ` ${p.unit}` : "";
  const bandText = isNum(p.lo) && isNum(p.hi) ? (p.lo === p.hi ? `exactly ${fmtNum(p.lo)}${unit}` : `${fmtNum(p.lo)}–${fmtNum(p.hi)}${unit}`) : isNum(p.lo) ? `at least ${fmtNum(p.lo)}${unit}` : isNum(p.hi) ? `at most ${fmtNum(p.hi)}${unit}` : "no band";
  const valueText = isNum(p.value) ? (isNum(p.valueMax) && p.valueMax !== p.value ? `${fmtNum(p.value)}–${fmtNum(p.valueMax)}${unit}` : `${fmtNum(p.value)}${unit}`) : null;
  const state = p.ok === true ? "in spec" : p.ok === false ? "out of spec" : "not measured";
  const aria = `${p.label ?? "Parameter"}: ${valueText ?? state}, band ${bandText}${valueText ? `, ${state}` : ""}`;
  const tickTop = compact ? 2 : mid - 10;
  const tickBottom = compact ? h - 2 : mid + 10;
  return (
    <svg className={`specband${compact ? " compact" : ""}`} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={aria}>
      <title>{aria}</title>
      <line x1={0} x2={w} y1={mid} y2={mid} className="sb-axis" />
      <rect x={Math.min(bl, bh)} y={compact ? 3 : mid - 7} width={Math.max(2, Math.abs(bh - bl))} height={compact ? h - 6 : 14} rx={compact ? 2 : 3} className="sb-band" />
      {isNum(p.lo) && <line x1={bl} x2={bl} y1={tickTop} y2={tickBottom} className="sb-tick" />}
      {isNum(p.hi) && p.hi !== p.lo && <line x1={bh} x2={bh} y1={tickTop} y2={tickBottom} className="sb-tick" />}
      {!compact && isNum(p.lo) && (
        <text x={bl} y={h - 2} textAnchor="middle" className="sb-tick-l">
          {fmtNum(p.lo)}
        </text>
      )}
      {!compact && isNum(p.hi) && p.hi !== p.lo && (
        <text x={bh} y={h - 2} textAnchor="middle" className="sb-tick-l">
          {fmtNum(p.hi)}
        </text>
      )}
      {isNum(p.value) && isNum(p.valueMax) && p.valueMax !== p.value && <line x1={x(p.value)} x2={x(p.valueMax)} y1={mid} y2={mid} className={`sb-span ${p.ok === false ? "bad" : "ok"}`} />}
      {isNum(p.value) && <Mark x={x(p.value)} y={mid} ok={p.ok} r={r} title={`${isNum(p.valueMax) ? "minimum " : ""}${fmtNum(p.value)}${unit}`} />}
      {isNum(p.value) && isNum(p.valueMax) && p.valueMax !== p.value && <Mark x={x(p.valueMax)} y={mid} ok={p.ok} r={r} title={`maximum ${fmtNum(p.valueMax)}${unit}`} />}
      {!compact && valueText && (
        <text x={Math.min(w - 4, Math.max(4, (x(p.value!) + x(p.valueMax ?? p.value!)) / 2))} y={mid - 10} textAnchor="middle" className="sb-val">
          {valueText}
        </text>
      )}
    </svg>
  );
}
