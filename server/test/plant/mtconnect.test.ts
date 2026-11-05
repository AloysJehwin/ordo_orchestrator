import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { assertSafeAgentUrl, parseCurrent } from "../../src/plant/mtconnect.js";

const xml = readFileSync(new URL("../fixtures/mtconnect-current.xml", import.meta.url), "utf8");
const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", parseTagValue: false }).parse(xml);

describe("MTConnect parser", () => {
  it("maps standard data items to canonical signals", () => {
    const obs = parseCurrent(doc, "Mazak");
    const by = Object.fromEntries(obs.map((o) => [o.signal, o]));
    expect(by.execution!.text).toBe("ACTIVE");
    expect(by.part_count!.value).toBe(412);
    expect(by.spindle_speed!.value).toBe(1200);
    expect(by.load_pct!.value).toBe(37.5);
    expect(by.availability!.text).toBe("AVAILABLE");
    expect(by.program!.text).toBe("O1234-BRACKET");
    expect(by.temperature!.quality).toBe("bad");
    expect(by["condition.logic_program"]!.text).toBe("WARNING");
    expect(by.execution!.ts).toBe("2026-10-19T09:58:00Z");
  });
  it("finds devices by name or uuid and fails clearly otherwise", () => {
    expect(parseCurrent(doc, "okuma-1").find((o) => o.signal === "execution")!.text).toBe("READY");
    expect(() => parseCurrent(doc, "Haas")).toThrow(/not found/);
  });
  it("refuses private and local agent URLs", () => {
    for (const u of ["http://localhost:5000", "http://127.0.0.1", "http://10.0.0.5", "http://192.168.1.2", "http://172.20.0.1", "file:///etc/passwd"]) expect(() => assertSafeAgentUrl(u)).toThrow();
    expect(assertSafeAgentUrl("https://demo.mtconnect.org").hostname).toBe("demo.mtconnect.org");
  });
});
