/**
 * Every error that should produce a friendly, one-line stderr message and a
 * specific exit code extends OcusageError. Anything else that bubbles up to
 * the top-level boundary in cli.ts is treated as an unexpected internal
 * error (exit 1) — OcusageError subclasses are the only "expected" failures.
 */
export abstract class OcusageError extends Error {
  abstract readonly exitCode: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotAuthenticatedError extends OcusageError {
  readonly exitCode = 2;
  constructor(
    message = 'Not signed in to Codex and no local session data found. Run `codex login` (or use Codex for a session), then try again.',
  ) {
    super(message);
  }
}

export class TokenExpiredError extends OcusageError {
  readonly exitCode = 2;
  constructor(
    message = 'Your Codex login token appears expired — run Codex once (or `codex login`) to refresh it.',
  ) {
    super(message);
  }
}

export class NetworkTimeoutError extends OcusageError {
  readonly exitCode = 3;
  constructor(message = 'Could not reach the usage service (timed out).') {
    super(message);
  }
}

export class NetworkError extends OcusageError {
  readonly exitCode = 3;
  constructor(message = 'Could not reach the usage service.') {
    super(message);
  }
}

/** EACCES/ENOENT and similar filesystem failures reading Codex's local state. */
export class DataAccessError extends OcusageError {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
  }
}

export function isOcusageError(error: unknown): error is OcusageError {
  return error instanceof OcusageError;
}
