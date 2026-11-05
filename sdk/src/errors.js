// Error types the CLI turns into messages and exit codes. Messages never contain secrets.

export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  ABORTED: 3,
  INTERRUPTED: 130,
});

/** Bad arguments or a malformed token. Exit code 2. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/** The session is unknown, revoked or past its expiry. Exit code 1. */
export class SessionGoneError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(
      message ??
        "This proof-of-work command is no longer valid: the session is unknown or has expired.\n" +
          "Open the stage in the Ordo console and click “Contribute proof of work” to get a new command.",
    );
    this.name = "SessionGoneError";
  }
}
