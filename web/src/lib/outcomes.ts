import type { AssetKind, AssetView, Outcome, OutcomeMedia, StageSpec, TemplateView } from "../types";

export const MEDIA: OutcomeMedia[] = ["thermal", "image", "audio", "video", "spectrum", "document"];
export const MEDIA_LABEL: Record<OutcomeMedia, string> = {
  thermal: "Thermal image",
  image: "Photo or micrograph",
  audio: "Audio",
  video: "Video",
  spectrum: "Spectrum or chromatogram",
  document: "Document",
};
/** A one-glyph mark for each media type, used on cards and in pickers. */
export const MEDIA_ICON: Record<OutcomeMedia, string> = { thermal: "◐", image: "▣", audio: "♪", video: "▶", spectrum: "∿", document: "▤" };
/** Fewer than this many outcomes on a stage is allowed, but the builder asks for more. */
export const MIN_OUTCOMES = 5;

/** A key from a label: lowercase letters, digits and _, starting with a letter (the server's rule). */
export function outcomeKey(label: string, taken: string[] = []): string {
  let k = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 28);
  if (k.length < 2) k = `outcome${k}`;
  let out = k;
  for (let n = 2; taken.includes(out); n++) out = `${k}_${n}`;
  return out;
}
export const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

export function metricText(m: Outcome["metric"]): string {
  const u = m.unit ? ` ${m.unit}` : "";
  if (m.targetMax !== undefined) return `${m.target}–${m.targetMax}${u}`;
  return `${m.op === ">=" ? "≥" : m.op === "<=" ? "≤" : "="} ${m.target}${u}`;
}

const o = (key: string, label: string, media: OutcomeMedia, instrument: string, metric: Outcome["metric"], required = true): Outcome => ({ key, label, media, instrument, metric, required });

/** What a new stage's machine captures by default, per kind of machine: five or more, every media type a machine of that kind would produce. */
export const OUTCOME_PRESETS: Partial<Record<AssetKind, Outcome[]>> = {
  cnc: [
    o("spindle_thermal", "Spindle thermal image", "thermal", "Thermal camera", { label: "Spindle ΔT", unit: "°C", op: "<=", target: 8 }),
    o("spindle_audio", "Spindle acoustics", "audio", "Contact microphone", { label: "Spindle tone", unit: "Hz", op: ">=", target: 180, targetMax: 240 }),
    o("surface_micrograph", "Surface micrograph", "image", "Inline microscope", { label: "Surface roughness Ra", unit: "µm", op: "<=", target: 1.6 }),
    o("cut_video", "Cutting video", "video", "Enclosure camera", { label: "Chatter events", unit: "", op: "<=", target: 0 }),
    o("probe_report", "Probe report", "document", "On-machine probe", { label: "Out-of-tolerance features", unit: "", op: "<=", target: 0 }),
  ],
  robot: [
    o("joint_thermal", "Joint thermal image", "thermal", "Thermal camera", { label: "Peak joint temperature", unit: "°C", op: "<=", target: 70 }),
    o("servo_audio", "Servo acoustics", "audio", "Contact microphone", { label: "Servo tone", unit: "Hz", op: ">=", target: 80, targetMax: 140 }),
    o("fit_photo", "Assembly photo", "image", "Cell camera", { label: "Misalignment", unit: "mm", op: "<=", target: 0.2 }),
    o("cycle_video", "Cycle video", "video", "Cell camera", { label: "Cycle time", unit: "s", op: "<=", target: 45 }),
    o("torque_log", "Torque log", "document", "Nutrunner controller", { label: "Out-of-spec fastenings", unit: "", op: "<=", target: 0 }),
  ],
  manual_station: [
    o("bench_photo", "Assembly photo", "image", "Bench camera", { label: "Visible defects", unit: "", op: "<=", target: 0 }),
    o("bench_thermal", "Bench thermal image", "thermal", "Thermal camera", { label: "Hot spot", unit: "°C", op: "<=", target: 45 }),
    o("tool_audio", "Tool acoustics", "audio", "Bench microphone", { label: "Tool tone", unit: "Hz", op: ">=", target: 900, targetMax: 1300 }),
    o("fit_video", "Fit-check video", "video", "Bench camera", { label: "Rework events", unit: "", op: "<=", target: 0 }),
    o("traveller", "Signed traveller", "document", "Station terminal", { label: "Open steps", unit: "", op: "<=", target: 0 }),
  ],
  inspection: [
    o("ct_slice", "CT slice", "image", "Industrial CT", { label: "Porosity", unit: "%", op: "<=", target: 0.5 }),
    o("surface_photo", "Surface photo", "image", "Vision camera", { label: "Surface defects", unit: "", op: "<=", target: 0 }),
    o("thermography", "Thermography", "thermal", "Lock-in thermography", { label: "Thermal contrast", unit: "°C", op: "<=", target: 3 }),
    o("ut_scan", "Ultrasonic A-scan", "spectrum", "Ultrasonic probe", { label: "Attenuation", unit: "dB", op: "<=", target: 6 }),
    o("inspection_report", "Inspection report", "document", "CMM", { label: "Nonconformances", unit: "", op: "<=", target: 0 }),
  ],
  agv: [
    o("route_video", "Route video", "video", "Onboard camera", { label: "Unplanned stops", unit: "", op: "<=", target: 2 }),
    o("motor_thermal", "Drive thermal image", "thermal", "Thermal camera", { label: "Drive temperature", unit: "°C", op: "<=", target: 60 }),
    o("drive_audio", "Drive acoustics", "audio", "Onboard microphone", { label: "Drive tone", unit: "Hz", op: ">=", target: 300, targetMax: 420 }),
    o("payload_photo", "Payload photo", "image", "Onboard camera", { label: "Load shift", unit: "mm", op: "<=", target: 10 }),
    o("delivery_receipt", "Delivery receipt", "document", "Fleet manager", { label: "Exceptions", unit: "", op: "<=", target: 0 }),
  ],
  pack_line: [
    o("seal_thermal", "Seal thermal image", "thermal", "Thermal camera", { label: "Seal temperature", unit: "°C", op: ">=", target: 160, targetMax: 190 }),
    o("label_photo", "Label photo", "image", "Vision camera", { label: "Misprints", unit: "", op: "<=", target: 0 }),
    o("line_video", "Line video", "video", "Line camera", { label: "Jams", unit: "", op: "<=", target: 0 }),
    o("checkweigher", "Checkweigher trace", "spectrum", "Checkweigher", { label: "Mean pack weight", unit: "g", op: ">=", target: 498, targetMax: 506 }),
    o("packing_list", "Packing list", "document", "Line terminal", { label: "Discrepancies", unit: "", op: "<=", target: 0 }),
  ],
  process_vessel: [
    o("jacket_thermal", "Jacket thermal image", "thermal", "Thermal camera", { label: "Jacket ΔT", unit: "°C", op: "<=", target: 5 }),
    o("culture_micrograph", "Culture micrograph", "image", "Inline microscope", { label: "Viability", unit: "%", op: ">=", target: 90 }),
    o("impeller_audio", "Impeller acoustics", "audio", "Contact microphone", { label: "Impeller tone", unit: "Hz", op: ">=", target: 110, targetMax: 130 }),
    o("raman", "Raman spectrum", "spectrum", "Raman probe", { label: "Glucose", unit: "g/L", op: ">=", target: 2, targetMax: 6 }),
    o("foam_video", "Foam time-lapse", "video", "Headspace camera", { label: "Foam height", unit: "cm", op: "<=", target: 4 }),
    o("batch_record", "Batch record", "document", "MES export", { label: "Deviations", unit: "", op: "<=", target: 0 }, false),
  ],
  maintenance_crew: [
    o("motor_thermal", "Motor thermal image", "thermal", "Thermal camera", { label: "Motor temperature", unit: "°C", op: "<=", target: 70 }),
    o("bearing_audio", "Bearing acoustics", "audio", "Ultrasonic listener", { label: "Bearing tone", unit: "kHz", op: ">=", target: 28, targetMax: 40 }),
    o("wear_photo", "Wear photo", "image", "Borescope", { label: "Wear depth", unit: "mm", op: "<=", target: 0.5 }),
    o("oil_spectrum", "Oil spectrum", "spectrum", "Oil analyser", { label: "Iron", unit: "ppm", op: "<=", target: 50 }),
    o("work_record", "Work record", "document", "CMMS", { label: "Open items", unit: "", op: "<=", target: 0 }),
  ],
};

/** The stages that could not run for want of a machine (system stages need none); the server checks the same at run start. */
export function machineless(stages: Pick<StageSpec, "code" | "name" | "resourceKind" | "machine">[], assets: AssetView[]) {
  const kinds = new Set(assets.map((a) => a.kind));
  return stages.filter((s) => s.resourceKind !== "system" && !(s.machine ? assets.some((a) => a.id === s.machine && a.kind === s.resourceKind) : kinds.has(s.resourceKind)));
}

/** What is wrong with a stage's outcomes, for the builder's publish check. */
export function outcomeErrors(outcomes: Outcome[], ownLabels: string[] = []): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  const metrics = new Set(ownLabels);
  for (const x of outcomes) {
    const name = x.label || x.key || "An outcome";
    if (!x.label.trim()) out.push("Every outcome has a name");
    if (!KEY_RE.test(x.key)) out.push(`${name}: its key is lowercase letters, digits and _`);
    if (keys.has(x.key)) out.push(`Two outcomes use the key ${x.key}`);
    keys.add(x.key);
    if (!x.instrument.trim()) out.push(`${name}: name the instrument that captures it`);
    if (!x.metric.label.trim()) out.push(`${name}: name the value read from it`);
    else if (metrics.has(x.metric.label)) out.push(`${name}: its value "${x.metric.label}" is named like another parameter of the stage`);
    metrics.add(x.metric.label);
    if (x.metric.targetMax !== undefined && x.metric.targetMax < x.metric.target) out.push(`${name}: the upper bound is below the lower bound`);
  }
  return out;
}

/** How many multimedia outcomes a template's stages capture (versions from before outcomes have none). */
export const outcomeCount = (t: TemplateView) => t.spec.stages.reduce((n, s) => n + (s.outcomes ?? []).length, 0);
/** Templates whose machines capture multimedia outcomes first, the rest in the server's order. */
export const outcomesFirst = (list: TemplateView[]) => [...list].sort((a, b) => Number(outcomeCount(b) > 0) - Number(outcomeCount(a) > 0));
