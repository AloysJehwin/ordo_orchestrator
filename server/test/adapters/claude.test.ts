import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeProvider } from "../../src/adapters/claude.js";
import type { LlmTask } from "../../src/adapters/llm.js";

const Diagnosis = z.object({ rootCause: z.string(), confidence: z.number().min(0).max(1) });
const task: LlmTask<z.infer<typeof Diagnosis>> = {
  name: "diagnose",
  system: "You diagnose machines.",
  prompt: "Diagnose this anomaly.",
  input: { signal: "vibration", value: 7.1 },
  schema: Diagnosis,
  offline: () => ({ rootCause: "offline guess", confidence: 0.3 }),
};

/** Anthropic's Messages API, answered in the test process */
function fakeApi(reply: { text?: string; stop_reason?: string }) {
  const requests: Record<string, unknown>[] = [];
  const f = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const body = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
      stop_reason: reply.stop_reason ?? "end_turn",
      stop_sequence: null,
      stop_details: reply.stop_reason === "refusal" ? { type: "refusal", category: "cyber", explanation: null } : null,
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, requests };
}

describe("Claude as the agents' model", () => {
  it("asks for structured output matching the task's schema, with server-side fallbacks, and returns it", async () => {
    const api = fakeApi({ text: JSON.stringify({ rootCause: "bearing wear", confidence: 0.82 }) });
    const r = await claudeProvider({ apiKey: "sk-test" }, "claude-opus-5-5", 5000, api.f).generate(task);
    expect(r).toMatchObject({ value: { rootCause: "bearing wear", confidence: 0.82 }, provider: "claude", modelId: "claude-opus-5-5", fallback: false });
    const req = api.requests[0] as { model: string; system: string; fallbacks: string; output_config: { effort: string; format: { type: string; schema: { properties: object } } }; messages: { content: string }[] };
    expect(req).toMatchObject({ model: "claude-opus-5-5", system: "You diagnose machines.", fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(Object.keys(req.output_config.format.schema.properties)).toEqual(["rootCause", "confidence"]);
    expect(req.messages[0]!.content).toContain('"signal":"vibration"');
  });

  it("falls back to the offline reasoning when Claude declines or answers off-schema", async () => {
    const refused = await claudeProvider({ apiKey: "sk-test" }, "claude-opus-5-5", 5000, fakeApi({ stop_reason: "refusal" }).f).generate(task);
    expect(refused).toMatchObject({ value: { rootCause: "offline guess" }, fallback: true, error: expect.stringMatching(/declined/) });
    const bad = await claudeProvider({ apiKey: "sk-test" }, "claude-opus-5-5", 5000, fakeApi({ text: JSON.stringify({ rootCause: "x", confidence: 7 }) }).f).generate(task);
    expect(bad).toMatchObject({ fallback: true });
  });
});

describe("Claude with Workload Identity Federation (no API key)", () => {
  it("exchanges the workload's identity token for a short-lived token, then calls Claude with it", async () => {
    const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    let n = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const h = new Headers(init?.headers);
      calls.push({ url: u, auth: h.get("authorization"), body: JSON.parse(String(init?.body)) });
      if (u.endsWith("/v1/oauth/token")) return Response.json({ access_token: `sk-ant-oat01-test${++n}`, token_type: "Bearer", expires_in: 600, scope: "workspace:inference" });
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify({ rootCause: "loose mount", confidence: 0.7 }) }], stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch;
    const llm = claudeProvider(
      { federation: { ruleId: "fdrl_01abc", organizationId: "00000000-0000-0000-0000-000000000001", serviceAccountId: "svac_01abc", workspaceId: "wrkspc_01abc", identityToken: () => "vercel.oidc.jwt" } },
      "claude-opus-5-5",
      5000,
      f,
    );
    expect((await llm.generate(task)).value.rootCause).toBe("loose mount");
    await llm.generate(task);
    const exchanges = calls.filter((c) => c.url.endsWith("/v1/oauth/token"));
    expect(exchanges).toHaveLength(1); // cached for the next call
    expect(exchanges[0]!.body).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "vercel.oidc.jwt", federation_rule_id: "fdrl_01abc", organization_id: "00000000-0000-0000-0000-000000000001", service_account_id: "svac_01abc", workspace_id: "wrkspc_01abc" });
    const messages = calls.filter((c) => c.url.includes("/v1/messages"));
    expect(messages.map((m) => m.auth)).toEqual(["Bearer sk-ant-oat01-test1", "Bearer sk-ant-oat01-test1"]);
  });
});
