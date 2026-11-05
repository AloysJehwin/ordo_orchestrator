/**
 * Vercel's OIDC identity token for this deployment. Vercel sends a fresh one on every request to a function
 * (`x-vercel-oidc-token`); the entry point hands it here, and Workload Identity Federation exchanges it for a
 * short-lived Claude API token, so no Anthropic API key is stored anywhere.
 */
let latest: string | null = process.env.VERCEL_OIDC_TOKEN ?? null;

export function rememberVercelOidcToken(token: string | string[] | undefined) {
  if (typeof token === "string" && token) latest = token;
}

export function vercelOidcToken(): string {
  if (!latest) throw new Error("No Vercel OIDC token yet: enable OIDC Federation for the project (Settings → Security)");
  return latest;
}
