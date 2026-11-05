import type { AgentKey, AssetKind, SignalLimit } from "../domain/types.js";
import type { ProfileSignal } from "./gateway.js";

/** One signal a virtual machine's process model emits, with the unit and limits its asset is registered with. */
export interface BodySignal extends ProfileSignal {
  unit: string;
  warn?: number;
  alarm?: number;
  /** the value never goes below this (a battery, a speed) */
  min?: number;
}

/**
 * The process model of one kind of virtual machine: the signals its body streams while it works, the tone its
 * vibration carries (used for audio when an outcome's metric is not itself a frequency), and the agent that owns it.
 * Values are plausible, not measured: a virtual machine is a simulation, and says so.
 */
export interface BodyProfile {
  kind: AssetKind;
  agent: AgentKey;
  signals: BodySignal[];
  /** dominant vibration tone, Hz */
  toneHz: number;
  /** seconds per unit at full speed, for OEE */
  idealCycleS: number;
}

const s = (name: string, unit: string, base: number, swing: number, o: Partial<BodySignal> = {}): BodySignal => ({ name, unit, base, swing, periodS: 300, ...o });

export const BODY_PROFILES: Record<Exclude<AssetKind, "system">, BodyProfile> = {
  cnc: {
    kind: "cnc",
    agent: "scheduler",
    toneHz: 210,
    idealCycleS: 60,
    signals: [
      s("spindle_speed", "rpm", 8000, 350, { periodS: 240, warn: 11000, alarm: 12000 }),
      s("load_pct", "%", 55, 10, { periodS: 180, warn: 85, alarm: 95 }),
      s("temperature", "°C", 33, 1.2, { drift: 6, periodS: 420, warn: 55, alarm: 65 }),
      s("vibration", "mm/s", 1.6, 0.35, { periodS: 200, warn: 4.5, alarm: 7.1 }),
      s("coolant_temp", "°C", 22, 0.7, { periodS: 500, warn: 30, alarm: 35 }),
    ],
  },
  robot: {
    kind: "robot",
    agent: "line",
    toneHz: 110,
    idealCycleS: 45,
    signals: [
      s("load_pct", "%", 45, 9, { periodS: 160, warn: 85, alarm: 95 }),
      s("temperature", "°C", 41, 1.8, { drift: 5, periodS: 400, warn: 70, alarm: 80 }),
      s("vibration", "mm/s", 0.9, 0.25, { periodS: 220, warn: 2.8, alarm: 4.5 }),
      s("tcp_speed", "mm/s", 850, 110, { periodS: 140, warn: 1500, alarm: 2000 }),
    ],
  },
  manual_station: {
    kind: "manual_station",
    agent: "line",
    toneHz: 1100,
    idealCycleS: 120,
    signals: [
      s("temperature", "°C", 23, 0.5, { periodS: 900, warn: 30, alarm: 35 }),
      s("humidity_pct", "%", 45, 3.5, { periodS: 700, warn: 65, alarm: 75 }),
      s("torque_nm", "N·m", 12, 1.2, { periodS: 120, warn: 18, alarm: 22 }),
    ],
  },
  inspection: {
    kind: "inspection",
    agent: "vision_qa",
    toneHz: 60,
    idealCycleS: 90,
    signals: [
      s("temperature", "°C", 21, 0.25, { periodS: 900, warn: 24, alarm: 26 }),
      s("vibration", "mm/s", 0.2, 0.05, { periodS: 300, warn: 0.8, alarm: 1.2 }),
      s("throughput_per_h", "/h", 40, 5, { periodS: 600, min: 0 }),
    ],
  },
  agv: {
    kind: "agv",
    agent: "supply",
    toneHz: 360,
    idealCycleS: 180,
    signals: [
      s("battery_pct", "%", 92, 0.8, { drift: -16, periodS: 600, min: 5 }),
      s("speed_mps", "m/s", 1.2, 0.3, { periodS: 90, warn: 2.2, alarm: 2.5, min: 0 }),
      s("load_pct", "%", 60, 8, { periodS: 400, warn: 95, alarm: 100 }),
      s("temperature", "°C", 38, 1.5, { drift: 4, periodS: 500, warn: 60, alarm: 70 }),
    ],
  },
  pack_line: {
    kind: "pack_line",
    agent: "logistics",
    toneHz: 50,
    idealCycleS: 2,
    signals: [
      s("speed_ppm", "packs/min", 120, 7, { periodS: 200, warn: 160, alarm: 180, min: 0 }),
      s("seal_temp", "°C", 175, 2.5, { periodS: 260, warn: 195, alarm: 205 }),
      s("vibration", "mm/s", 1.1, 0.3, { periodS: 180, warn: 4.5, alarm: 7.1 }),
      s("load_pct", "%", 60, 7, { periodS: 300, warn: 90, alarm: 98 }),
    ],
  },
  process_vessel: {
    kind: "process_vessel",
    agent: "process",
    toneHz: 120,
    idealCycleS: 3600,
    signals: [
      s("temperature", "°C", 37, 0.35, { periodS: 420, warn: 39, alarm: 40 }),
      s("ph", "", 7.05, 0.05, { periodS: 700 }),
      s("dissolved_oxygen", "%", 46, 2.5, { drift: -8, periodS: 500, min: 0 }),
      s("agitation_rpm", "rpm", 120, 3.5, { periodS: 260, warn: 180, alarm: 220 }),
      s("pressure_bar", "bar", 0.3, 0.03, { periodS: 600, warn: 0.8, alarm: 1.0 }),
      s("vibration", "mm/s", 0.6, 0.15, { periodS: 240, warn: 2.8, alarm: 4.5 }),
    ],
  },
  maintenance_crew: {
    kind: "maintenance_crew",
    agent: "maintenance",
    toneHz: 32000,
    idealCycleS: 1800,
    signals: [
      s("vibration", "mm/s", 2.2, 0.45, { periodS: 300, warn: 4.5, alarm: 7.1 }),
      s("temperature", "°C", 48, 1.8, { periodS: 600, warn: 70, alarm: 80 }),
      s("load_pct", "%", 40, 9, { periodS: 360, warn: 90, alarm: 98 }),
    ],
  },
};

export const hasBody = (kind: AssetKind): kind is Exclude<AssetKind, "system"> => kind !== "system";

/** The limits a virtual machine's asset is registered with: every signal it emits has one, so Ordo keeps them all. */
export function profileLimits(kind: Exclude<AssetKind, "system">): Record<string, SignalLimit> {
  return Object.fromEntries(BODY_PROFILES[kind].signals.map((x) => [x.name, { unit: x.unit, ...(x.warn !== undefined ? { warn: x.warn } : {}), ...(x.alarm !== undefined ? { alarm: x.alarm } : {}) }]));
}
