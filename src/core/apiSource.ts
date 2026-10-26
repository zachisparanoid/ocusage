import { NetworkError, NetworkTimeoutError, TokenExpiredError } from '../errors.js';
import type { RawUsageData, RawWindow, ResolvedCredentials, UsageAccount } from '../types.js';
import { planLabel } from './credentials.js';
import { finiteNumber, firstString, isRecord, readCredits, toIsoTimestamp } from './parse.js';
import { VERSION } from './version.js';
import { mainWindowId, mainWindowLabel, scopedWindowId, scopedWindowLabel } from './windows.js';

/**
 * The same account-usage endpoint the Codex CLI itself polls for its
 * `/status` limits. Found via `strings` on the native binary and confirmed
 * with live authenticated requests — it is not documented anywhere public.
 * It accepts any User-Agent, and the `ChatGPT-Account-Id` header is
 * optional (identical response without it), so ocusage identifies as
 * itself and only sends the account id when auth.json has one.
 */
export const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchApiUsageOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable "now" for resolving relative `reset_after_seconds`. */
  now?: number;
}

export async function fetchApiUsage(
  creds: ResolvedCredentials,
  opts: FetchApiUsageOptions = {},
): Promise<RawUsageData> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: 'application/json',
    'User-Agent': `ocusage/${VERSION}`,
  };
  if (creds.accountId) headers['ChatGPT-Account-Id'] = creds.accountId;

  let response: Response;
  try {
    response = await doFetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new NetworkTimeoutError();
    throw new NetworkError(err instanceof Error ? err.message : 'The usage request failed.');
  } finally {
    clearTimeout(timer);
  }

  // The service answers 401 for a bad token and an expired one alike
  // (`{"detail": "Could not parse your authentication token…"}`), so both
  // map to "re-authenticate" from the user's point of view.
  if (response.status === 401) {
    throw new TokenExpiredError();
  }
  if (!response.ok) {
    throw new NetworkError(`The usage service responded with HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new NetworkError('The usage service returned a response that was not valid JSON.');
  }

  return buildRawUsageData(payload, creds, opts.now ?? Date.now());
}

/**
 * Real captured shape (2026-09, Codex 0.153):
 *   { email, plan_type,
 *     rate_limit: { allowed, limit_reached,
 *                   primary_window:   { used_percent, limit_window_seconds, reset_after_seconds, reset_at },
 *                   secondary_window: { … } },
 *     code_review_rate_limit: null | <same shape>,
 *     additional_rate_limits: null | <unobserved>,
 *     model_usage: { "<model>": { available, available_at, credits_would_enable } },
 *     credits: { has_credits, unlimited, balance, … },
 *     spend_control: { reached, individual_limit }, rate_limit_reached_type, … }
 * Every field is treated as optional; `reset_at` is epoch seconds.
 */
function buildRawUsageData(
  payload: unknown,
  creds: ResolvedCredentials,
  now: number,
): RawUsageData {
  const root = isRecord(payload) ? payload : {};
  const warnings: string[] = [];

  const account: UsageAccount = {
    email: firstString(root.email) ?? creds.email,
    plan: planLabel(firstString(root.plan_type) ?? creds.planType),
  };
  const credits = readCredits(root.credits);

  const windows: RawWindow[] = [];
  const main = isRecord(root.rate_limit) ? root.rate_limit : null;
  if (main) {
    windows.push(...windowsFromRateLimit(main, null, null, now));
    collectLimitFlags(main, root, warnings);
  }
  const review = isRecord(root.code_review_rate_limit) ? root.code_review_rate_limit : null;
  if (review) {
    windows.push(...windowsFromRateLimit(review, 'code_review', 'Code review', now));
  }
  windows.push(...windowsFromAdditional(root.additional_rate_limits, warnings, now));

  collectSpendControl(root.spend_control, warnings);
  collectModelAvailability(root.model_usage, warnings);

  if (windows.length === 0) {
    warnings.push(
      main
        ? 'The usage service returned no rate-limit windows in a shape ocusage recognizes.'
        : 'The usage service returned no rate-limit windows — usage limits only exist for ChatGPT sign-ins.',
    );
  }

  return { source: 'api', account, credits, windows, warnings, asOf: null };
}

const WINDOW_KEYS = ['primary_window', 'secondary_window'] as const;

function windowsFromRateLimit(
  rateLimit: Record<string, unknown>,
  scope: string | null,
  name: string | null,
  now: number,
): RawWindow[] {
  const windows: RawWindow[] = [];
  for (const key of WINDOW_KEYS) {
    const shape = readWindowShape(rateLimit[key], now);
    if (!shape) continue;
    windows.push({
      id: scope ? scopedWindowId(scope, shape.seconds) : mainWindowId(shape.seconds),
      label: scope
        ? scopedWindowLabel(name ?? scope, shape.seconds)
        : mainWindowLabel(shape.seconds),
      used: shape.percent ?? 0,
      limit: null,
      unit: 'ratio',
      percentUsed: shape.percent ?? 0,
      resetsAt: shape.resetsAt,
      windowSeconds: shape.seconds,
      estimated: false,
    });
  }
  return windows;
}

/**
 * `additional_rate_limits` has only ever been observed as `null`. This
 * accepts the two shapes it plausibly takes — an array of
 * `{ limit_id, limit_name, rate_limit: {…} }` entries, or a map keyed by
 * limit id — and warns about anything else rather than guessing.
 */
function windowsFromAdditional(value: unknown, warnings: string[], now: number): RawWindow[] {
  const entries: Array<[string | null, unknown]> = Array.isArray(value)
    ? value.map((entry) => [null, entry])
    : isRecord(value)
      ? Object.entries(value)
      : [];

  const windows: RawWindow[] = [];
  for (const [key, entry] of entries) {
    if (!isRecord(entry)) {
      warnings.push('Unrecognized additional rate limit entry from the usage service.');
      continue;
    }
    const id = firstString(entry.limit_id, entry.id, entry.key, key);
    const name = firstString(entry.limit_name, entry.name, id);
    const rateLimit = isRecord(entry.rate_limit)
      ? entry.rate_limit
      : 'primary_window' in entry || 'secondary_window' in entry
        ? entry
        : null;
    if (!id || !rateLimit) {
      warnings.push(
        `Unrecognized additional rate limit "${name ?? id ?? 'unknown'}" from the usage service.`,
      );
      continue;
    }
    windows.push(...windowsFromRateLimit(rateLimit, id, name ?? id, now));
  }
  return windows;
}

interface WindowShape {
  percent: number | null;
  seconds: number | null;
  resetsAt: string | null;
}

function readWindowShape(value: unknown, now: number): WindowShape | null {
  if (!isRecord(value)) return null;
  const percent = finiteNumber(value.used_percent ?? value.utilization ?? value.percent);
  const windowMinutes = finiteNumber(value.window_minutes);
  const seconds =
    finiteNumber(value.limit_window_seconds) ??
    (windowMinutes !== null ? windowMinutes * 60 : null);

  let resetsAt = toIsoTimestamp(value.reset_at ?? value.resets_at);
  if (resetsAt === null) {
    const after = finiteNumber(value.reset_after_seconds ?? value.resets_in_seconds);
    if (after !== null) resetsAt = new Date(now + after * 1000).toISOString();
  }

  if (percent === null && seconds === null && resetsAt === null) return null;
  return { percent, seconds, resetsAt };
}

function collectLimitFlags(
  rateLimit: Record<string, unknown>,
  root: Record<string, unknown>,
  warnings: string[],
): void {
  const reachedType = firstString(root.rate_limit_reached_type, rateLimit.rate_limit_reached_type);
  const reached =
    rateLimit.limit_reached === true || rateLimit.allowed === false || reachedType !== null;
  if (!reached) return;
  const which = reachedType ? ` (${reachedType} window)` : '';
  warnings.push(`Rate limit reached${which} — Codex requests are blocked until a window resets.`);
}

function collectSpendControl(value: unknown, warnings: string[]): void {
  if (isRecord(value) && value.reached === true) {
    warnings.push('Spend control limit reached for this account.');
  }
}

function collectModelAvailability(value: unknown, warnings: string[]): void {
  if (!isRecord(value)) return;
  for (const [model, info] of Object.entries(value)) {
    if (!isRecord(info) || info.available !== false) continue;
    const until = toIsoTimestamp(info.available_at);
    warnings.push(`Model ${model} is currently unavailable${until ? ` until ${until}` : ''}.`);
  }
}
