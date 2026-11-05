import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import { GuardedLlm, buildUserMessage, type LlmProvider } from "./llm.js";

/**
 * Diagnosis and recommendations by Claude, through Anthropic's SDK. The answer is constrained to the task's Zod schema
 * (structured outputs) and still re-validated by GuardedLlm, which falls back to the offline reasoning on any failure.
 * A refused request is re-run on Anthropic's default fallback model inside the same call (server-side fallbacks).
 */
export type ClaudeAuth =
  | { apiKey: string }
  /** Workload Identity Federation: the workload's own identity token, exchanged for short-lived Claude API tokens */
  | { federation: { ruleId: string; organizationId: string; serviceAccountId: string; workspaceId?: string; identityToken: () => string | Promise<string> } };

export function claudeProvider(auth: ClaudeAuth, model: string, timeoutMs: number, fetchImpl?: typeof fetch): LlmProvider {
  const f = fetchImpl ?? fetch;
  const client = new Anthropic({
    maxRetries: 1,
    fetch: f,
    ...("apiKey" in auth
      ? { apiKey: auth.apiKey }
      : {
          // the client caches the exchanged token and refreshes it before it expires
          credentials: oidcFederationProvider({
            identityTokenProvider: auth.federation.identityToken,
            federationRuleId: auth.federation.ruleId,
            organizationId: auth.federation.organizationId,
            serviceAccountId: auth.federation.serviceAccountId,
            workspaceId: auth.federation.workspaceId,
            baseURL: "https://api.anthropic.com",
            fetch: f,
          }),
        }),
  });
  return new GuardedLlm(
    {
      name: "claude",
      modelId: model,
      call: async (task, signal) => {
        const res = await client.beta.messages.parse(
          {
            model,
            max_tokens: 16000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: task.system,
            messages: [{ role: "user", content: buildUserMessage(task) }],
            // short, grounded JSON answers on the incident path: low effort keeps them fast
            output_config: { effort: "low", format: betaZodOutputFormat(task.schema as never) },
          },
          { signal },
        );
        if (res.stop_reason === "refusal") throw new Error(`Claude declined${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`);
        if (res.parsed_output == null) throw new Error(`Claude returned no structured answer (stop: ${res.stop_reason})`);
        return JSON.stringify(res.parsed_output);
      },
    },
    timeoutMs,
  );
}
