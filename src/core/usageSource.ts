import { NotAuthenticatedError, TokenExpiredError } from '../errors.js';
import type { CliOptions, RawUsageData, ResolvedCredentials, UsageReport } from '../types.js';
import { fetchApiUsage } from './apiSource.js';
import { inspectAuthFile, isTokenExpired, loadCredentials, planLabel } from './credentials.js';
import { collectLocalUsage, LOOKBACK_MS, scanRollouts, sumTokensSince } from './localSource.js';
import type { RolloutScan } from './localSource.js';
import { normalize } from './normalize.js';

export interface GetUsageReportOptions {
  source: CliOptions['source'];
  codexHome?: string;
  now?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const EXPIRED_TOKEN_NOTE =
  'Your Codex login token appears expired — showing local data instead. Run Codex once (or `codex login`) to refresh it.';
const API_KEY_NOTE =
  'Codex is signed in with an API key — usage windows only exist for ChatGPT-plan sign-ins; showing local session logs.';
const MISSING_WINDOWS_NOTE =
  'Live usage response had no rate-limit windows — falling back to local session logs.';

/**
 * The single entry point every command goes through. Owns the auto ->
 * (api, then local fallback) policy; apiSource.ts/localSource.ts stay dumb
 * about *when* they get used.
 */
export async function getUsageReport(opts: GetUsageReportOptions): Promise<UsageReport> {
  const now = opts.now ?? Date.now();
  const fetchedAt = new Date(now).toISOString();

  if (opts.source === 'api') {
    const creds = await requireCredentials(opts.codexHome);
    if (isTokenExpired(creds, now)) throw new TokenExpiredError();
    const raw = await fetchApiUsage(creds, { fetchImpl: opts.fetchImpl, now });
    // Forced api mode never falls back — emit whatever was found.
    return normalize(await withLocalTokens(raw, opts, now), fetchedAt);
  }

  if (opts.source === 'local') {
    // Forcing the local data source only affects where the *numbers* come
    // from — the login token, if present, is still fair game for labeling
    // the header with an email/plan.
    const creds = await loadCredentials(opts.codexHome);
    const raw = withAccountEnrichment(
      await collectLocalUsage({ codexHome: opts.codexHome, now }),
      creds,
    );
    return finalizeOrThrowNoData(raw, fetchedAt);
  }

  return autoResolve(opts, now, fetchedAt);
}

async function autoResolve(
  opts: GetUsageReportOptions,
  now: number,
  fetchedAt: string,
): Promise<UsageReport> {
  const creds = await loadCredentials(opts.codexHome);

  if (!creds) {
    const auth = await inspectAuthFile(opts.codexHome);
    return fallBackToLocal(opts, now, fetchedAt, null, auth.apiKeyOnly ? [API_KEY_NOTE] : []);
  }

  if (isTokenExpired(creds, now)) {
    return fallBackToLocal(opts, now, fetchedAt, creds, [EXPIRED_TOKEN_NOTE]);
  }

  try {
    const raw = await fetchApiUsage(creds, { fetchImpl: opts.fetchImpl, now });
    if (raw.windows.length === 0) {
      return fallBackToLocal(opts, now, fetchedAt, creds, [...raw.warnings, MISSING_WINDOWS_NOTE]);
    }
    return normalize(await withLocalTokens(raw, opts, now), fetchedAt);
  } catch (err) {
    const note =
      err instanceof TokenExpiredError
        ? EXPIRED_TOKEN_NOTE
        : `Live usage unavailable (${describeError(err)}) — falling back to local session logs.`;
    return fallBackToLocal(opts, now, fetchedAt, creds, [note]);
  }
}

async function fallBackToLocal(
  opts: GetUsageReportOptions,
  now: number,
  fetchedAt: string,
  creds: ResolvedCredentials | null,
  extraWarnings: string[],
): Promise<UsageReport> {
  const raw = withAccountEnrichment(
    await collectLocalUsage({ codexHome: opts.codexHome, now }),
    creds,
  );
  return finalizeOrThrowNoData(
    { ...raw, warnings: dedupe([...extraWarnings, ...raw.warnings]) },
    fetchedAt,
  );
}

/**
 * Live percentages plus a local token count for the same window: the cap
 * is secret, so "~1.2M tokens" next to "7%" is the only way to get a feel
 * for what a percentage point costs. Purely best effort — an unreadable
 * sessions tree must never take down a successful live fetch, and with no
 * local activity at all the hint stays null rather than claiming "0"
 * (the account may be used from another machine).
 */
async function withLocalTokens(
  raw: RawUsageData,
  opts: GetUsageReportOptions,
  now: number,
): Promise<RawUsageData> {
  let scan: RolloutScan;
  try {
    scan = await scanRollouts({ codexHome: opts.codexHome, now });
  } catch {
    return raw;
  }
  if (scan.events.length === 0) return raw;

  const cutoff = now - LOOKBACK_MS;
  return {
    ...raw,
    windows: raw.windows.map((w) => {
      if (w.unit !== 'ratio' || w.resetsAt === null || w.windowSeconds === null) return w;
      const resetsAtMs = Date.parse(w.resetsAt);
      if (Number.isNaN(resetsAtMs)) return w;
      const start = resetsAtMs - w.windowSeconds * 1000;
      if (start < cutoff || start > now) return w;
      return { ...w, localTokens: sumTokensSince(scan.events, start) };
    }),
  };
}

function finalizeOrThrowNoData(raw: RawUsageData, fetchedAt: string): UsageReport {
  if (raw.windows.length === 0) {
    throw new NotAuthenticatedError();
  }
  return normalize(raw, fetchedAt);
}

async function requireCredentials(codexHome?: string): Promise<ResolvedCredentials> {
  const creds = await loadCredentials(codexHome);
  if (!creds) throw new NotAuthenticatedError();
  return creds;
}

/**
 * Fills in email/plan for a raw payload that doesn't have its own (the
 * local source knows the plan from its snapshot but never the email) from
 * the login token's claims.
 */
function withAccountEnrichment(raw: RawUsageData, creds: ResolvedCredentials | null): RawUsageData {
  const email = raw.account.email ?? creds?.email ?? null;
  const plan = raw.account.plan ?? planLabel(creds?.planType ?? null);
  return { ...raw, account: { email, plan } };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
