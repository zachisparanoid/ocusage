import { getUsageReport } from '../core/usageSource.js';
import { isOcusageError } from '../errors.js';
import type { CliOptions } from '../types.js';

/** Maps our error classes to short, stable machine-readable codes. */
const ERROR_CODES: Record<string, string> = {
  NotAuthenticatedError: 'no_data',
  TokenExpiredError: 'token_expired',
  NetworkTimeoutError: 'network_timeout',
  NetworkError: 'network_error',
  DataAccessError: 'access_error',
};

/**
 * `--json`: always writes exactly one JSON document to stdout, never ANSI,
 * never a bare stderr line — even failures come back as `{"error": ...}`
 * on stdout so scripts consuming this never have to parse stderr.
 */
export async function runJson(options: CliOptions): Promise<void> {
  try {
    const report = await getUsageReport({ source: options.source });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    if (isOcusageError(err)) {
      const code = ERROR_CODES[err.name] ?? 'error';
      writeErrorJson(code, err.message);
      process.exit(err.exitCode);
    }
    writeErrorJson('internal_error', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function writeErrorJson(code: string, message: string): void {
  process.stdout.write(`${JSON.stringify({ error: code, message }, null, 2)}\n`);
}
