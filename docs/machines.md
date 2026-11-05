# Machines

## Vercel Sandbox runtime

With `BODY_RUNTIME=sandbox`, each machine's body runs in its own [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox): a Firecracker microVM that Ordo starts, wakes and stops. This is how the Render deployment runs bodies; `BODY_RUNTIME=local` (a process per machine on the Ordo host) is for development and tests. The runner is `SandboxBodies` in `server/src/core/bodies-sandbox.ts`.

### One sandbox per machine

- **Name:** `ordo-<site>-<asset>`, lowercase, e.g. `ordo-site-3f9a0c1d2e4b-ast-7c2d9e0f1a3b`. Tags `app=ordo`, `site`, `asset`, so Ordo finds a machine's sandbox again after it restarts.
- **Machine:** image `vercel/sandbox/node:22`, 2 vCPUs with 4 GB of memory, region `iad1` (Vercel's default, next to the Render service in `virginia`).
- **Persistent:** the sandbox keeps its disk between sessions. Stopping it snapshots the disk, and the next start resumes from the newest snapshot. It keeps the last two snapshots.

### What happens on a start

1. Ordo gets the machine's sandbox, or creates it.
2. **First boot, or a new body bundle** (detected by the bundle's sha256): Ordo uploads `body/dist` (without source maps) to `ordo-body` in the sandbox's working directory (`/vercel/sandbox/ordo-body`), with a `package.json` of the body's npm dependencies and optional dependencies, such as `ffmpeg-static` (workspace code is bundled into `body.mjs`). It runs `npm install` and stops the sandbox once, which snapshots the installed body. Later starts skip the install.
3. Ordo ends a body that an earlier Ordo process left running, then runs `node body.mjs` detached, with the start's `BodyEnv` as its environment. `BODY_DATA_DIR` points at `ordo-body/data`, so the episode log survives stops and new bundles.
4. `BODY_ASK_PORT` (8787 unless the start says otherwise) is public at `https://<subdomain>.vercel.run`: that is the start's `askUrl`, where Ordo asks the body about its run (`GET /ask`).
5. A body that exits within 3 seconds fails the start, with its last lines of output in the error.

On a **stop**, Ordo sends the body SIGTERM so it can flush its episode log, waits up to 5 seconds, and stops the sandbox, which snapshots it again.

### Idle stop and session time

A sandbox session lasts 45 minutes, which fits every Vercel plan. The body service calls `sweep(lastActive)` every engine cycle:

- it stops a body with no activity for 15 minutes (`IDLE_STOP_MS`);
- it extends the session of every other body by 30 minutes whenever less than 15 are left, up to the plan's limit (45 minutes on Hobby, 24 hours on Pro).

### Setup

1. **A project for the sandboxes.** In the Vercel dashboard, create an empty project named `ordo-machines` in your team (it needs no repository and no deployment), or run `npx vercel project add ordo-machines --scope <team>`.
2. **A token.** At [vercel.com/account/settings/tokens](https://vercel.com/account/settings/tokens), create a token scoped to that team.
3. **Settings,** in Render (**ordo → Environment**) and in `server/.env` to try it locally:

   | Variable | Value |
   | --- | --- |
   | `BODY_RUNTIME` | `sandbox` (set by `render.yaml`) |
   | `VERCEL_TOKEN` | the token (sensitive) |
   | `VERCEL_TEAM_ID` | **Team Settings → General → Team ID** (`team_…`) |
   | `VERCEL_SANDBOX_PROJECT` | `ordo-machines` (its name or `prj_…` ID) |

4. **A public Ordo.** Bodies call Ordo at its public address (`PUBLIC_URL`, else `RENDER_EXTERNAL_URL`), never at `localhost`. To try sandboxes from a laptop, expose the dev server with a tunnel and set `PUBLIC_URL` to it.
5. **Check it:** `pnpm env:doctor`. The rail "vercel sandbox" checks that the token reaches the team, that the project exists, and lists the machine sandboxes and which are running. It warns when Ordo has no public address.

Without the three `VERCEL_*` values, Ordo starts with the warning "BODY_RUNTIME=sandbox needs …" and machine bodies don't run.

### Inspecting and troubleshooting

- **Sandboxes and sessions:** the `ordo-machines` project in the Vercel dashboard, or the `sandbox` CLI (`npx sandbox --help`).
- **A body's output:** the runner keeps each body's newest 200 lines (`logs(assetId)`); a failed start includes the last lines in its error.
- **"npm install failed":** the error carries npm's last lines. The sandbox has full internet access by default; `ffmpeg-static` downloads its binary while installing.
- **A snapshot expired:** the next start creates the sandbox again and reinstalls the body (slower, nothing to do).
- **Code:** `sandboxBodies(cfg)` builds the runner (null, with a warning, until the settings are complete); `listBodySandboxes(creds)` lists every machine sandbox with its state, for the doctor and the Floor.
