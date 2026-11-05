// Terminal input and output. Works with a real TTY and with piped stdin (lines typed or piped
// ahead of a question are queued, not lost).
import readline from "node:readline";

/**
 * @typedef {object} TerminalOptions
 * @property {NodeJS.ReadableStream & { isTTY?: boolean }} [input]
 * @property {NodeJS.WritableStream & { isTTY?: boolean }} [output]
 * @property {NodeJS.WritableStream & { isTTY?: boolean }} [errorOutput]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @param {TerminalOptions} [options]
 */
export function createTerminal(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const env = options.env ?? process.env;
  const interactive = Boolean(input.isTTY && output.isTTY);
  const useColor =
    env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0"
      ? true
      : Boolean(output.isTTY) && !env.NO_COLOR && env.TERM !== "dumb";

  /** @type {readline.Interface | null} */
  let rl = null;
  /** @type {string[]} */
  const queue = [];
  /** @type {((line: string | null) => void)[]} */
  const waiters = [];
  let closed = false;
  /** @type {(() => void) | null} */
  let interruptHandler = null;
  let thinkingShown = false;

  function ensureReadline() {
    if (rl || closed) return;
    rl = readline.createInterface({ input, output, terminal: interactive, historySize: interactive ? 50 : 0 });
    rl.on("line", (line) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    });
    rl.on("close", () => {
      closed = true;
      while (waiters.length) waiters.shift()?.(null);
    });
    rl.on("SIGINT", () => {
      if (interruptHandler) interruptHandler();
      else process.kill(process.pid, "SIGINT");
    });
  }

  /** @param {string} code @param {string} text */
  const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

  const style = {
    bold: (/** @type {string} */ t) => paint("1", t),
    dim: (/** @type {string} */ t) => paint("2", t),
    red: (/** @type {string} */ t) => paint("31", t),
    green: (/** @type {string} */ t) => paint("32", t),
    yellow: (/** @type {string} */ t) => paint("33", t),
    cyan: (/** @type {string} */ t) => paint("36", t),
  };

  function clearThinking() {
    if (thinkingShown) {
      output.write("\r\x1b[K");
      thinkingShown = false;
    }
  }

  return {
    interactive,
    style,

    /** @param {string} [text] */
    print(text = "") {
      clearThinking();
      output.write(`${text}\n`);
    },

    /** @param {string} text */
    error(text) {
      clearThinking();
      errorOutput.write(`${useColor && errorOutput.isTTY ? style.red(text) : text}\n`);
    },

    /** @param {string} text */
    warn(text) {
      clearThinking();
      errorOutput.write(`${useColor && errorOutput.isTTY ? style.yellow(text) : text}\n`);
    },

    /** A transient "thinking" line on a TTY; nothing when piped. */
    thinking() {
      if (!output.isTTY || thinkingShown) return;
      output.write(style.dim("  …"));
      thinkingShown = true;
    },

    /**
     * Ask for one line. Resolves to null when input has ended (Ctrl-D or end of a pipe).
     * @param {string} prompt
     * @returns {Promise<string | null>}
     */
    ask(prompt) {
      clearThinking();
      ensureReadline();
      const echo = !interactive;
      if (queue.length) {
        // Typed or piped ahead of the question: replay it after the prompt so the screen reads in order.
        const line = /** @type {string} */ (queue.shift());
        output.write(`${prompt}${line}\n`);
        return Promise.resolve(line);
      }
      if (closed) {
        output.write(`${prompt}\n`);
        return Promise.resolve(null);
      }
      if (interactive && rl) {
        rl.setPrompt(prompt);
        rl.prompt();
      } else {
        output.write(prompt);
      }
      return new Promise((resolve) => {
        waiters.push((line) => {
          if (echo) output.write(line === null ? "\n" : `${line}\n`);
          resolve(line);
        });
      });
    },

    /**
     * Called on Ctrl-C while the terminal has the keyboard (TTY raw mode).
     * @param {() => void} handler
     */
    onInterrupt(handler) {
      interruptHandler = handler;
    },

    /** Stop reading input so the process can exit. */
    close() {
      clearThinking();
      if (rl) {
        rl.close();
        rl = null;
      }
      closed = true;
      if (typeof (/** @type {any} */ (input).pause) === "function") /** @type {any} */ (input).pause();
    },
  };
}

/** @typedef {ReturnType<typeof createTerminal>} Terminal */
