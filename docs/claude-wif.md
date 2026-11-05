# Claude with Workload Identity Federation (no API key)

Ordo's agents can call Claude without any Anthropic API key. Vercel gives every deployment an OIDC identity token; the
Claude API is told to trust Vercel's issuer for this project, and the server exchanges that token for a short-lived
Claude API token (refreshed before it expires). Nothing secret is stored in Vercel.

## 1. Vercel: OIDC Federation on

Project **ai_warriors** → Settings → Security → **Secure backend access with OIDC federation**: enabled, issuer mode
**Team**. With Team mode the tokens look like:

| Claim | Value |
|---|---|
| `iss` | `https://oidc.vercel.com/aloys-jehwins-projects` |
| `aud` | `https://vercel.com/aloys-jehwins-projects` |
| `sub` | `owner:aloys-jehwins-projects:project:ai_warriors:environment:production` (`preview` for previews) |

(If the team slug or project name differ, take them from the URL `vercel.com/<team>/<project>`.)

## 2. Claude Console: Connect workload

[platform.claude.com/settings/workload-identity-federation](https://platform.claude.com/settings/workload-identity-federation)
→ **Connect workload** → **Custom OIDC** (needs the admin or owner role):

| Field | Value |
|---|---|
| Issuer URL | `https://oidc.vercel.com/aloys-jehwins-projects` |
| JWKS source | Discovery |
| Match: subject | `owner:aloys-jehwins-projects:project:ai_warriors:environment:production` (add `*` instead of `production` to allow previews too) |
| Match: audience | `https://vercel.com/aloys-jehwins-projects` |
| Service account | a new one, e.g. `ordo-agents`, in the workspace that should pay |
| Scope | `workspace:inference` (the agents only call the Messages API) |
| Token lifetime | 600 s (the default the wizard offers) |

Select **Verify issuer**, then create. Note the **rule ID** (`fdrl_…`), the **service account ID** (`svac_…`), the
**organization ID** (Settings → Organization) and the **workspace ID** (`wrkspc_…`).

## 3. Vercel: environment variables (Production and Preview)

| Variable | Value |
|---|---|
| `ANTHROPIC_FEDERATION_RULE_ID` | `fdrl_…` |
| `ANTHROPIC_ORGANIZATION_ID` | the organization UUID |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | `svac_…` |
| `ANTHROPIC_WORKSPACE_ID` | `wrkspc_…` |

These are identifiers, not secrets. **Remove `ANTHROPIC_API_KEY`** (an API key always wins over federation), and set
`LLM_PROVIDER=claude` or leave it unset. Redeploy. The status page's "ai" rail then reads `claude:claude-opus-5-5`.

## Check it

Open the app so a request reaches the function (that is where Vercel's token arrives), then let an incident run, or look
at the Console's **Authentication history** tab: each exchange is listed with its result. A failed exchange always
returns a plain `401 Authentication failed`; the history names the reason:

- `match_subject_prefix`: the `sub` claim differs from the rule (check the team slug, project name and environment).
- `jti_reused`: Vercel presented the same token twice. Turn off **check jti** on the Vercel issuer.
- `workspace_id_required`: the rule covers several workspaces; set `ANTHROPIC_WORKSPACE_ID`.

Outside Vercel (Docker on a plant network), the same variables work with `ANTHROPIC_IDENTITY_TOKEN_FILE` pointing at a
token your identity provider writes (a Kubernetes projected token, for example) and a rule for that issuer.
