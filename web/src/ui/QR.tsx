import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** A QR code as one SVG path, drawn from the module matrix (no HTML injection). */
export function QR({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    const count = q.getModuleCount();
    let d = "";
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { path: d, n: count + 8 };
  }, [value]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}
