import { XMLParser } from "fast-xml-parser";

/**
 * MTConnect reader (ANSI/MTC1.4). Reads `/probe` for device names and `/current` for the latest
 * observation of every data item. Read-only by design: MTConnect has no write path.
 */
export interface Observation {
  signal: string;
  value: number | null;
  text: string | null;
  ts: string;
  quality: "good" | "uncertain" | "bad";
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", isArray: () => false, parseTagValue: false });

/** Canonical Ordo signal names for the MTConnect data items that drive status, utilization and stage progress. */
const CANONICAL: Record<string, string> = {
  Execution: "execution",
  PartCount: "part_count",
  Availability: "availability",
  ControllerMode: "controller_mode",
  EmergencyStop: "emergency_stop",
  RotaryVelocity: "spindle_speed",
  SpindleSpeed: "spindle_speed",
  Load: "load_pct",
  Temperature: "temperature",
  Program: "program",
  ProgramName: "program",
  PathFeedrateOverride: "feed_override",
  Vibration: "vibration",
  DisplacementVibration: "vibration",
};

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

export function assertSafeAgentUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Agent URL must be http(s)");
  const h = u.hostname;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(10|127|169\.254|192\.168)\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "0.0.0.0" || h.startsWith("[")) {
    throw new Error("Agent URL must be a public host");
  }
  return u;
}

async function fetchXml(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: "application/xml" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`MTConnect agent returned HTTP ${res.status}`);
  return parser.parse(await res.text()) as Record<string, unknown>;
}

export async function probeDevices(agentUrl: string, timeoutMs = 8000): Promise<{ name: string; uuid: string | null; model: string | null }[]> {
  const base = assertSafeAgentUrl(agentUrl);
  const doc = await fetchXml(new URL("probe", base.href.endsWith("/") ? base : `${base.href}/`).href, timeoutMs);
  const devices = asArray((doc.MTConnectDevices as { Devices?: { Device?: unknown } } | undefined)?.Devices?.Device) as Record<string, unknown>[];
  return devices.map((d) => {
    const desc = d.Description as Record<string, string> | undefined;
    return { name: String(d["@name"]), uuid: (d["@uuid"] as string) ?? null, model: desc?.["@model"] ?? null };
  });
}

/** Walk one DeviceStream and collect every observation, mapped to canonical names where known. */
export function parseCurrent(doc: Record<string, unknown>, device: string): Observation[] {
  const streams = asArray((doc.MTConnectStreams as { Streams?: { DeviceStream?: unknown } } | undefined)?.Streams?.DeviceStream) as Record<string, unknown>[];
  const ds = streams.find((s) => s["@name"] === device || s["@uuid"] === device);
  if (!ds) throw new Error(`Device "${device}" not found on this agent`);
  const out: Observation[] = [];
  const seen = new Set<string>();
  for (const cs of asArray(ds.ComponentStream) as Record<string, unknown>[]) {
    for (const section of ["Samples", "Events", "Condition"] as const) {
      const group = cs[section] as Record<string, unknown> | undefined;
      if (!group || typeof group !== "object") continue;
      for (const [tag, raw] of Object.entries(group)) {
        if (tag.startsWith("@")) continue;
        for (const item of asArray(raw) as (Record<string, string> | string)[]) {
          const el = typeof item === "string" ? { "#text": item } : item;
          const text = el["#text"] ?? "";
          const ts = el["@timestamp"] ?? new Date().toISOString();
          let signal: string;
          let value: number | null = null;
          let txt: string | null = null;
          let quality: Observation["quality"] = "good";
          if (section === "Condition") {
            signal = `condition.${el["@type"] ?? el["@dataItemId"] ?? tag}`.toLowerCase();
            txt = tag.toUpperCase(); // NORMAL | WARNING | FAULT | UNAVAILABLE
            if (txt === "UNAVAILABLE") quality = "bad";
          } else {
            const canonical = CANONICAL[tag];
            signal = canonical && !seen.has(canonical) ? canonical : `${tag}.${el["@name"] ?? el["@dataItemId"] ?? ""}`.toLowerCase();
            if (text === "UNAVAILABLE" || text === "") quality = "bad";
            else if (section === "Samples" || tag === "PartCount") {
              const n = Number.parseFloat(text);
              if (Number.isFinite(n)) value = n;
              else txt = text;
            } else txt = text;
          }
          seen.add(signal);
          out.push({ signal, value, text: txt, ts, quality });
        }
      }
    }
  }
  return out;
}

export async function readCurrent(agentUrl: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const base = assertSafeAgentUrl(agentUrl);
  return fetchXml(new URL("current", base.href.endsWith("/") ? base : `${base.href}/`).href, timeoutMs);
}
