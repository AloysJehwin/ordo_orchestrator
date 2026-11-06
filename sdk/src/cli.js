// The ordo-pow command: fetch the session, interview the contributor, submit, wait for the signature.
/** @import { Session, SessionStatus, FinishPayload } from "./types.js" */
/** @import { Terminal } from "./io.js" */
/** @import { OrdoClient } from "./ordo-api.js" */
import { EXIT, SessionGoneError, UsageError } from "./errors.js";
import { createTerminal } from "./io.js";
import { runInterview } from "./interview.js";
import { BIN_NAME, PACKAGE_NAME, VERSION } from "./meta.js";
import { createMockTransport, MOCK_AUDIO_MODEL, MOCK_MODEL } from "./mock-router.js";
import { openInBrowser } from "./open-url.js";
import { createOrdoClient, OrdoApiError } from "./ordo-api.js";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, waitForSignature } from "./poll.js";
import { createRouterClient, trustText } from "./router.js";
import { isLoopback, isTruthy, normalizeBaseUrl, parseInvocation, TOKEN_ENV } from "./token.js";

export function usage() {
  return `Usage: npx ${PACKAGE_NAME}@latest <token> [--notes <file>] [--api <url>] [--no-open]
       ${TOKEN_ENV}=<token> npx ${PACKAGE_NAME}@latest

Record proof of work on an Ordo stage. Copy the command from the stage in the Ordo
console ("Contribute proof of work"). The interview runs through the 0G Router, in
private mode (TEE providers only) unless your Ordo says otherwise. It shows you what the stage's
machine captured and records whether you confirm or dispute it. Evidence files are
hashed on this machine; Ordo gets only the hashes. A photo or voice note goes to the
0G model only if you say yes for that file.

Options:
  --notes <file>  A .txt or .md file of your observations: the interviewer records what it
                  states (measurements, your verdict on each outcome) and asks only about the rest.
                  Its text goes to the 0G model like your typed answers; its hash is your evidence.
  --api <url>     Use this Ordo API address instead of the one in the token
  --no-open       Do not open the signing link in a browser
  -h, --help      Show this help
  -v, --version   Show the version

Environment:
  ${TOKEN_ENV}           The token, instead of the argument (keeps it out of shell history)
  ORDO_POW_NO_OPEN=1       Same as --no-open
  ORDO_POW_MOCK_ROUTER=1   Scripted offline interviewer instead of the Router (testing only;
                           used anyway when the Ordo deployment has no Router)
  NO_COLOR=1               Plain output

During the interview: /show prints what is recorded, /notes <file> answers from a file,
/quit stops without sending.

Exit codes: 0 signed, 1 failed or expired, 2 bad usage or token, 3 stopped by you, 130 interrupted.`;
}

/**
 * @typedef {"start" | "interview" | "submitting" | "waiting"} Phase
 */

/**
 * Run the command. Resolves to an exit code; never calls process.exit itself
 * (except on Ctrl-C, through `exit`).
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   terminal?: Terminal,
 *   exit?: (code: number) => void,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const terminal = options.terminal ?? createTerminal({ env });
  const exit = options.exit ?? ((code) => void flushAndExit(code));
  const { style } = terminal;

  /** @type {Phase} */
  let phase = "start";
  /** @type {{ expiresAt?: string, signUrl?: string | null }} */
  const context = {};

  const onInterrupt = () => {
    terminal.close();
    terminal.print("");
    for (const line of interruptMessage(phase, context)) terminal.print(line);
    exit(EXIT.INTERRUPTED);
  };
  terminal.onInterrupt(onInterrupt);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  try {
    const invocation = parseInvocation(argv, env);
    if (invocation.help) {
      terminal.print(usage());
      return EXIT.OK;
    }
    if (invocation.version) {
      terminal.print(`${PACKAGE_NAME} ${VERSION}`);
      return EXIT.OK;
    }
    const token = /** @type {NonNullable<typeof invocation.token>} */ (invocation.token);
    const forcedMock = isTruthy(env.ORDO_POW_MOCK_ROUTER);
    const pollIntervalMs = positiveInt(env.ORDO_POW_POLL_INTERVAL_MS, POLL_INTERVAL_MS);
    const pollTimeoutMs = positiveInt(env.ORDO_POW_POLL_TIMEOUT_MS, POLL_TIMEOUT_MS);

    if (!token.apiBaseUrl.startsWith("https:") && !isLoopback(token.apiBaseUrl)) {
      terminal.warn("Warning: talking to Ordo over plain http; the session secret is not encrypted in transit.");
    }
    const client = createOrdoClient({ apiBaseUrl: token.apiBaseUrl, secret: token.secret });

    terminal.print(style.bold(`Ordo proof of work`) + style.dim(`  ·  ${BIN_NAME} ${VERSION}`));

    const status = await readStatus(client);
    if (status.status === "signed") {
      terminal.print("This session's contribution is already signed.");
      if (status.proofUrl) terminal.print(`Public proof: ${style.bold(status.proofUrl)}`);
      return EXIT.OK;
    }
    if (status.status === "expired") throw new SessionGoneError();
    if (status.status === "submitted") {
      terminal.print("Your record was already submitted from this session, so there is no new interview.");
      phase = "waiting";
      context.signUrl = status.signUrl;
      terminal.close();
      return await awaitSignature({ client, terminal, signUrl: status.signUrl, open: invocation.open, pollIntervalMs, pollTimeoutMs });
    }

    // status "open": interview
    let session;
    try {
      session = await client.getSession();
    } catch (err) {
      if (err instanceof OrdoApiError && err.gone) throw new SessionGoneError();
      throw err;
    }
    context.expiresAt = session.expiresAt;

    // An Ordo with no Router key says so (network "mock"): there is no Router to call, so use the scripted interviewer.
    const mock = forcedMock || session.router?.network === "mock";
    let router;
    if (mock) {
      router = createRouterClient({
        baseUrl: "http://mock.invalid/v1",
        apiKey: "mock",
        model: MOCK_MODEL,
        audioModel: MOCK_AUDIO_MODEL,
        transport: createMockTransport(session),
      });
    } else {
      const config = routerConfig(session);
      router = createRouterClient({
        ...config,
        onRetry: (err, delayMs) =>
          terminal.warn(`  The 0G Router answered ${err.status || "with a network error"}; retrying in ${Math.ceil(delayMs / 1000)} s…`),
      });
    }

    printBanner(terminal, session, { mock: mock ? (forcedMock ? "forced" : "ordo") : false, model: router.model });
    phase = "interview";
    const interview = await runInterview({ session, router, terminal, client, cwd, notes: invocation.notes });
    if (interview.outcome === "quit") {
      terminal.print("");
      terminal.print("Stopped. Nothing was submitted.");
      terminal.print(style.dim(`To start again, run the same command${expiryHint(session.expiresAt)}.`));
      return EXIT.ABORTED;
    }

    /** @type {FinishPayload} */
    const payload = {
      summary: interview.record.summary,
      measurements: interview.record.measurements,
      notes: interview.record.notes,
      evidence: interview.record.evidence,
      confirmations: interview.record.confirmations,
      voiceNotes: interview.record.voiceNotes,
      transcript: interview.transcript,
      receipts: interview.receipts,
    };
    phase = "submitting";
    terminal.print("");
    terminal.print("Submitting your record…");
    const submitted = await submit(client, payload, terminal);
    if (!submitted) {
      terminal.print("Nothing was submitted.");
      return EXIT.FAILED;
    }
    phase = "waiting";
    context.signUrl = submitted.signUrl;
    terminal.close();
    if (submitted.contributionId) terminal.print(style.green(`Submitted. Contribution ${submitted.contributionId}.`));
    return await awaitSignature({
      client,
      terminal,
      signUrl: submitted.signUrl,
      open: invocation.open,
      pollIntervalMs,
      pollTimeoutMs,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      terminal.error(err.message);
      terminal.print(style.dim(`Run ${BIN_NAME} --help for usage.`));
      return EXIT.USAGE;
    }
    if (err instanceof SessionGoneError) {
      terminal.error(err.message);
      return EXIT.FAILED;
    }
    if (err instanceof OrdoApiError) {
      terminal.error(err.message);
      return EXIT.FAILED;
    }
    terminal.error(`Unexpected error: ${/** @type {Error} */ (err)?.message ?? String(err)}`);
    if (isTruthy(env.ORDO_POW_DEBUG) && err instanceof Error && err.stack) terminal.error(err.stack);
    return EXIT.FAILED;
  } finally {
    terminal.close();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

/**
 * @param {OrdoClient} client
 * @returns {Promise<SessionStatus>}
 */
async function readStatus(client) {
  try {
    return await client.status();
  } catch (err) {
    if (err instanceof OrdoApiError && err.gone) throw new SessionGoneError();
    throw err;
  }
}

/**
 * Validate the Router settings Ordo sent. The key is never printed.
 * @param {Session} session
 */
function routerConfig(session) {
  const r = session.router;
  if (!r || typeof r.baseUrl !== "string" || typeof r.apiKey !== "string" || !r.apiKey || typeof r.model !== "string" || !r.model) {
    throw new OrdoApiError("Ordo's session has no usable Router settings (base URL, key and model). Ask your Ordo manager to check the 0G Private Computer setup.", 200);
  }
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(r.baseUrl, "The Router address from Ordo");
  } catch (err) {
    throw new OrdoApiError(/** @type {Error} */ (err).message, 200);
  }
  if (!baseUrl.startsWith("https:") && !isLoopback(baseUrl)) {
    throw new OrdoApiError("Ordo gave a Router address that is not https; refusing to send the Router key over plain http.", 200);
  }
  const audioModel = typeof r.audioModel === "string" && r.audioModel ? r.audioModel : null;
  // sessions from an Ordo before trust modes were all private
  const trustMode = r.trustMode === "standard" || r.trustMode === "verified" ? r.trustMode : "private";
  const audioVia = r.audioVia === "chat" || r.audioVia === "transcriptions" ? r.audioVia : undefined;
  return { baseUrl, apiKey: r.apiKey, model: r.model, audioModel, trustMode, ...(audioVia ? { audioVia } : {}) };
}

/**
 * @param {Terminal} terminal
 * @param {Session} session
 * @param {{ mock: false | "forced" | "ordo", model: string }} info
 */
function printBanner(terminal, session, { mock, model }) {
  const { style } = terminal;
  const { stage, org, contributor } = session;
  const names = session.names ?? {};
  const row = (/** @type {string} */ label, /** @type {string} */ value) => terminal.print(`  ${style.dim(label.padEnd(8))} ${value}`);
  const stageFacts = [stage.code, stage.state, stage.orderRef ? `order ${stage.orderRef}` : ""].filter(Boolean).join(" · ");
  // each party by its ENS name when Ordo issues names, with the plain name beside it
  row("Org", names.org ? `${names.org}${org?.name ? style.dim(`  ${org.name}`) : ""}` : (org?.name ?? ""));
  if (names.run) row("Lot", names.run);
  row("Stage", `${stage.name}${stageFacts ? style.dim(`  ${stageFacts}`) : ""}`);
  if (names.stage) row("", style.dim(names.stage));
  const who = names.contributor
    ? `${names.contributor}${contributor?.name ? style.dim(`  ${contributor.name}`) : ""}`
    : contributor?.name
      ? `${contributor.name}${contributor.address ? style.dim(`  ${shortAddress(contributor.address)}`) : ""}`
      : shortAddress(contributor?.address ?? "");
  row("You", who);
  row(
    "Model",
    mock
      ? style.yellow(
          `scripted interviewer (${mock === "forced" ? "ORDO_POW_MOCK_ROUTER" : "this Ordo has no 0G Router configured"}): no LLM; receipts are not TEE receipts`,
        )
      : `${model}  ${style.dim(`0G Router, ${trustText(session.router?.trustMode)}`)}`,
  );
  if (stage.machine) row("Machine", `${names.machine ?? stage.machine.name ?? stage.machine.id}${stage.machine.answers ? "" : style.dim("  (no running body: it cannot be asked questions)")}`);
  const outcomes = stage.outcomes ?? [];
  if (outcomes.length) {
    const captured = outcomes.filter((o) => o.captured).length;
    row("Outcomes", `${outcomes.length}${style.dim(`  ${captured} captured by the machine, to review with you`)}`);
  }
  if (session.expiresAt) row("Expires", formatExpiry(session.expiresAt));
  terminal.print("");
  terminal.print(style.dim("Answer in your own words. /show prints what is recorded, /quit stops without sending."));
}

/**
 * Post the record, with a retry prompt. Never posts twice: on an ambiguous failure it asks
 * Ordo for the status first.
 * @param {OrdoClient} client
 * @param {FinishPayload} payload
 * @param {Terminal} terminal
 * @returns {Promise<{ contributionId: string | null, signUrl: string | null } | null>}
 */
async function submit(client, payload, terminal) {
  for (;;) {
    try {
      return await client.finish(payload);
    } catch (err) {
      if (!(err instanceof OrdoApiError)) throw err;
      if (err.gone) {
        throw new SessionGoneError(
          "The session expired before the record reached Ordo, so nothing was submitted.\n" +
            "Open the stage in the Ordo console, click “Contribute proof of work” again, and run the new command.",
        );
      }
      const status = await client.status().catch(() => null);
      if (status && (status.status === "submitted" || status.status === "signed")) {
        return { contributionId: status.contributionId, signUrl: status.signUrl };
      }
      if (status?.status === "expired") throw new SessionGoneError();
      terminal.error(`Could not submit: ${err.message}`);
      const again = await terminal.ask("Try again? [Y/n] ");
      if (again === null || /^n/i.test(again.trim())) return null;
    }
  }
}

/**
 * Show the signing link, open it, and poll until signed.
 * @param {{ client: OrdoClient, terminal: Terminal, signUrl: string | null, open: boolean, pollIntervalMs: number, pollTimeoutMs: number }} options
 * @returns {Promise<number>}
 */
async function awaitSignature({ client, terminal, signUrl, open, pollIntervalMs, pollTimeoutMs }) {
  const { style } = terminal;
  if (signUrl) {
    terminal.print("");
    terminal.print("Sign your record in the Ordo console:");
    terminal.print(`  ${style.bold(signUrl)}`);
    if (open) {
      const started = openInBrowser(signUrl);
      terminal.print(style.dim(started ? "  (opening it in your browser; if nothing opens, copy the link)" : "  (open it in your browser)"));
    }
  }
  terminal.print("");
  terminal.print(
    style.dim(
      `Waiting for your signature… (checking every ${Math.max(1, Math.round(pollIntervalMs / 1000))} s; Ctrl-C to stop, run the same command again to resume)`,
    ),
  );
  const final = await waitForSignature({
    client,
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    onTrouble: (err) => terminal.warn(`  Having trouble reaching Ordo (${err.message}); still trying.`),
  });
  if (final.status === "signed") {
    terminal.print("");
    terminal.print(style.green("Signed."));
    if (final.proofUrl) terminal.print(`Public proof: ${style.bold(final.proofUrl)}`);
    else if (final.contributionId) terminal.print(`Contribution ${final.contributionId}.`);
    return EXIT.OK;
  }
  if (final.status === "expired") {
    terminal.error("The session expired before the record was signed. Get a new command from the Ordo console.");
    return EXIT.FAILED;
  }
  terminal.error(
    `Stopped waiting after ${Math.round(pollTimeoutMs / 60_000)} minutes. Your record is submitted; sign it${
      signUrl ? ` at ${signUrl}` : " in the Ordo console"
    }, then run the same command again to get the proof link.`,
  );
  return EXIT.FAILED;
}

/**
 * @param {Phase} phase
 * @param {{ expiresAt?: string, signUrl?: string | null }} context
 * @returns {string[]}
 */
function interruptMessage(phase, context) {
  switch (phase) {
    case "interview":
      return [
        "Stopped. Nothing was submitted.",
        `To start again, run the same command${expiryHint(context.expiresAt)}.`,
      ];
    case "submitting":
      return [
        "Stopped while submitting.",
        "Run the same command again: if Ordo received the record it waits for your signature, otherwise the interview starts over. A record is never submitted twice.",
      ];
    case "waiting":
      return [
        `Stopped waiting. Your record is submitted${context.signUrl ? `; sign it at ${context.signUrl}` : ""}.`,
        "To get the proof link, run the same command again. It will not submit a second time.",
      ];
    default:
      return ["Stopped. Nothing was submitted."];
  }
}

/** @param {string | undefined} expiresAt */
function expiryHint(expiresAt) {
  if (!expiresAt) return "";
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return "";
  return ` (the session is valid until ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
}

/** @param {string} expiresAt */
function formatExpiry(expiresAt) {
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return expiresAt;
  const minutes = Math.round((when.getTime() - Date.now()) / 60_000);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (minutes <= 0) return `${time} (expired)`;
  const span = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  return `${time} (in ${span})`;
}

/** @param {string} address */
function shortAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Exit after stdout and stderr have flushed (pipes can be asynchronous).
 * @param {number} code
 */
export async function flushAndExit(code) {
  await Promise.all([
    new Promise((resolve) => process.stdout.write("", () => resolve(undefined))),
    new Promise((resolve) => process.stderr.write("", () => resolve(undefined))),
  ]);
  process.exit(code);
}

/** Entry point for the bin. */
export async function run() {
  const code = await main();
  await flushAndExit(code);
}
