# ordo-pow

Record proof of work on an Ordo production stage from your terminal.

You open a running stage in the Ordo console and click **Contribute proof of work**. The console shows a command:

```sh
npx ordo-pow@latest opw1.…
```

Run it. A short interview asks what you did on the stage, the values you measured, your evidence files and anything unusual. When the stage runs on a machine, it also shows you what the machine captured for each of the stage's outcomes (a photo, a trace, a spectrogram) and asks you to confirm or dispute it. The interviewer is a language model served by the [0G Private Computer](https://pc.0g.ai) Router in private mode, so only providers running in a TEE (trusted execution environment) see the conversation. An Ordo can run on standard routing instead, when no TEE provider serves its model; the CLI then says "standard routing (not a TEE)" in its banner, and nothing in the record is labelled TEE. When you confirm, the record goes to Ordo, a signing link opens in your browser, and once you have signed it the command prints the public proof link.

Requires Node.js 22 or newer. No dependencies.

## Usage

```sh
npx ordo-pow@latest <token> [--notes <file>] [--api <url>] [--no-open]
```

To keep the token out of your shell history, pass it in the environment instead:

```sh
ORDO_POW_TOKEN='opw1.…' npx ordo-pow@latest
```

| Option | |
|---|---|
| `--notes <file>` | A `.txt` or `.md` file of your observations. The interviewer records what it states (measurements, your verdict on each outcome) and asks only about the rest. Its text goes to the model like a typed answer; its hash becomes evidence. |
| `--api <url>` | Talk to this Ordo API instead of the address in the token |
| `--no-open` | Print the signing link but do not open a browser |
| `-h`, `--help` | Help |
| `-v`, `--version` | Version |

During the interview, type your answers. `/show` prints what has been recorded so far, `/notes <file>` reads an observations file as your answer, `/quit` stops without sending anything. Before anything is sent you see the full record and confirm with `y`.

When the agent wants to show a file of yours to the model (a photo) or transcribe one (a voice note), it asks first, file by file: `? Show bench.jpg (2.1 MB) to the interviewer model …? [y/N]`. Anything but `y` keeps the file hash-only.

If you press Ctrl-C while waiting for your signature, run the same command again: it notices the record was already submitted and goes straight back to waiting. A session can only be submitted once.

## What leaves your machine

- **Your answers** go to the TEE provider through the 0G Router (private mode), and to Ordo as the transcript, together with the measurements, notes and summary. Ordo seals the full record; the public proof shows commitments and checks, never your raw answers or values.
- **Evidence files never reach Ordo.** For each file you name, Ordo gets its file name, size, media type and SHA-256. Files up to 50 MB.
- **A file goes to 0G only with your consent, per file**, and only to the TEE provider:
  - a photo (PNG, JPEG, WebP or GIF, up to 5 MB) is shown to the interviewer model as an image, so it can ask about what it sees. At most 12 MB of images go in one request, and once the model has answered, earlier images are replaced with a placeholder, so requests stay under the Router's 20 MB limit. The record marks the file `analyzedBy: { kind: "vision", model, requestId }`;
  - a voice note (WAV, MP3, M4A, OGG or WebM, up to 12 MB) is transcribed by the session's speech-to-text model (`whisper-large-v3` on mainnet). The transcript goes into your sealed record as a voice note, the audio does not; the call's receipt joins the others with `kind: "transcription"`.
  - Anything else (PDF, video, CSV, logs) stays hash-only.
- **The machine's media** comes from Ordo, not from you: `review_outcome` downloads what the stage's machine captured, checks it against the hash the machine signed, saves a copy under your temp folder (`ordo-pow-<session>/`) for you to open, and shows it to the model. Your record binds the hashes of the versions you reviewed.
- **Secrets are never printed.** The token's secret and the session's Router key stay in memory. The Router key is fetched with the token, so it never appears in the command you copy.

## The stage's machine

When the stage runs on a machine, the session lists its outcomes: what the machine captures (a photo of the part, a pressure trace, an acoustic recording), the metric its on-board agent reads from it, and the target. The interviewer goes through each one:

| Tool | What it does |
|---|---|
| `review_outcome {key}` | Loads the latest capture: the value, the target, the machine's own 0G reading, and the media as an image (a photo, a video keyframe, an audio spectrogram or a chart), or an excerpt for a CSV or text file. |
| `confirm_outcome {key, verdict, observed?, note?}` | Records your verdict: `confirm` (it matches what you saw), `dispute` (it does not: what differs, and the value you observed if you give one) or `unsure`. |
| `ask_machine {question}` | Asks the machine's on-board agent about its run (offered only when the machine has a running body). Its answer is the machine's account, never your statement. At most 30 questions per session. |

`finish` is refused until every required outcome the machine captured has been reviewed and confirmed or disputed. A disputed outcome is shown to the validators who choose between proofs of work.

## Verifiability

Every request to the Router goes out with the session's trust mode in `X-0G-Provider-Trust-Mode`. In private mode, the default, that is `private` (TEE providers only, no fallback to non-TEE providers) with `"verify_tee": true` (the Router checks the provider's TEE signature itself and reports the result). For every Router response the agent keeps a receipt, and all receipts are posted to Ordo with the record:

| Receipt field | Source |
|---|---|
| `resKey` | `ZG-Res-Key` response header: the chat ID the provider signed. Falls back to the body's `id` when the header is absent. |
| `requestId` | `x_0g_trace.request_id`, else the `X-Request-ID` header: the Router's id for the request. |
| `provider` | `x_0g_trace.provider`, else the `X-Provider` header: the on-chain address of the provider that served the answer. |
| `providerIdentity` | `x_0g_trace.provider_identity`, when the provider reports one. |
| `teeVerified` | `x_0g_trace.tee_verified`: `true` when the Router verified the provider's TEE signature, `false` when a signature was present but did not verify (the answer is untrusted), `null` when not reported. |
| `model` | The model that answered. |
| `requestSha256` | SHA-256 of the exact request bytes sent (canonical JSON: sorted keys, no whitespace). |
| `responseSha256` | SHA-256 of the exact response bytes received. |
| `headers` | Every response header starting with `zg-`, `x-0g-` or `0g-`, plus `x-request-id` and `x-provider`. |
| `trace` | The whole `x_0g_trace` object, including `billing`. |

A voice note's transcription goes to the Router's `POST …/v1/audio/transcriptions?verify_tee=true` with a JSON body (`model`, `file_base64`, `filename`, `response_format: "json"`) and the same private-mode header; its receipt has the same fields plus `kind: "transcription"`, and its `requestId` is kept on the voice note.

Ordo does not have to trust the Router's `tee_verified` flag. With `resKey` and `provider` it can verify each answer independently, as the 0G docs describe: read the provider's service record (URL and `teeSignerAddress`) from the on-chain serving contract, fetch `GET {provider url}/v1/proxy/signature/{resKey}?model={model}` (returns `{ text, signature }`), and check the EIP-191 signature against `teeSignerAddress`. The 0G compute SDK does the same in `broker.inference.processResponse(provider, chatID)`.

Sources:
- 0G Router, Verifiable Execution: <https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution>
- 0G Router, Chat Completions (`x_0g_trace`, tools): <https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions>
- 0G Router, Privacy (trust modes): <https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy>
- 0G Router, Errors: <https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/errors>
- 0G Router API reference: <https://0gfoundation.github.io/0g-router/>

## What the agent sends to Ordo

`POST /v1/pow/session/finish` with the record you confirmed:

| Field | |
|---|---|
| `measurements` | `[{ criterion, value, unit?, note? }]`: the values you gave (never the machine's outcome metrics, which you confirm instead) |
| `evidence` | `[{ name, sha256, size, mediaType?, analyzedBy? }]`; `analyzedBy` is `{ model, requestId, kind: "vision" \| "transcription" }` when you let 0G see the file |
| `confirmations` | `[{ outcome, sha256, verdict, observed?, note }]`: your verdict on each outcome, bound to the hash of the version you reviewed |
| `voiceNotes` | `[{ name, sha256, size, mediaType, transcript, model, requestId, at }]` |
| `notes`, `summary`, `transcript`, `receipts` | Your notes, the summary you confirmed, the conversation, and the Router receipts |

Ordo checks each confirmation against what the machine captured (the outcome exists, the hash is one of its signed versions), seals the record with the machine's media hashes and its answers to `ask_machine`, and the signature you give covers all of it.

## Errors from the Router

| Status | What you see | Retry |
|---|---|---|
| 401 | The session's key was rejected; get a new command from the console | no |
| 402 | The organization's 0G balance is too low; ask your Ordo manager to top it up on pc.0g.ai | no |
| 429 | Rate limited | once, after `Retry-After` |
| 502, 503 | Provider failed, or no private (TEE) provider is serving the model right now | once, after a short wait |

After a failure you can press Enter to try again or type `/quit`. Nothing you recorded is lost while the command is running.

## Exit codes

| Code | |
|---|---|
| 0 | Signed; the proof link was printed |
| 1 | Failed: session invalid or expired, Ordo unreachable, not signed within 30 minutes |
| 2 | Bad arguments or token |
| 3 | You stopped (`/quit`, or input ended) before submitting |
| 130 | Interrupted with Ctrl-C |

## Environment

| Variable | |
|---|---|
| `ORDO_POW_TOKEN` | The token, instead of the argument |
| `ORDO_POW_NO_OPEN=1` | Same as `--no-open` |
| `ORDO_POW_MOCK_ROUTER=1` | Forces the scripted offline interviewer instead of the Router. For testing: no LLM is called (model `ordo-mock-interviewer`), and its receipts are marked as mock (`provider: null`, `trace.mock: true`), so Ordo will not treat them as TEE receipts. The agent also uses it on its own when the Ordo deployment has no Router key (its session says `router.network: "mock"`). |
| `ORDO_POW_POLL_INTERVAL_MS` | Status check interval while waiting for the signature (default 3000) |
| `ORDO_POW_POLL_TIMEOUT_MS` | How long to wait for the signature (default 1800000, 30 minutes) |
| `NO_COLOR=1` | Plain output |
| `ORDO_POW_DEBUG=1` | Print stack traces for unexpected errors |

## Development

```sh
pnpm --filter ordo-pow test        # node:test: unit tests plus end-to-end runs against a local Ordo API and Router
pnpm --filter ordo-pow typecheck   # JSDoc types checked by tsc, no build step
```

The package is plain ESM JavaScript with JSDoc types; what is in `src/` is what runs.

## License

MIT
