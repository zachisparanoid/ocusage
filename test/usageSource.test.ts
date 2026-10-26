import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getUsageReport } from '../src/core/usageSource.js';
import { NetworkError, NotAuthenticatedError, TokenExpiredError } from '../src/errors.js';

const AUTH_FIXTURE = join(import.meta.dirname, 'fixtures', 'auth.sample.json');
const ROLLOUT_FIXTURE = join(import.meta.dirname, 'fixtures', 'rollout.sample.jsonl');
const NOW = Date.parse('2026-09-06T12:00:00.000Z');

/** Trimmed real `wham/usage` response; both windows still open at NOW. */
const API_RESPONSE = {
  email: 'api@example.com',
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: 1788698795 },
    secondary_window: { used_percent: 24, limit_window_seconds: 604800, reset_at: 1789171173 },
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), 'ocusage-source-'));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

async function seedAuth(content?: unknown): Promise<void> {
  const raw =
    content === undefined ? await readFile(AUTH_FIXTURE, 'utf8') : JSON.stringify(content);
  await writeFile(join(codexHome, 'auth.json'), raw, 'utf8');
}

async function seedRollout(): Promise<void> {
  const dir = join(codexHome, 'sessions', '2026', '09', '06');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'rollout-fixture.jsonl'),
    await readFile(ROLLOUT_FIXTURE, 'utf8'),
    'utf8',
  );
}

function expiredAuth(): unknown {
  const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return {
    auth_mode: 'chatgpt',
    tokens: { access_token: `h.${b64u({ exp: 1000 })}.s`, account_id: 'acct' },
  };
}

function respond(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

function failing(): typeof fetch {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

function countingFetch(inner: typeof fetch): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    calls += 1;
    return inner(input, init);
  };
  return { fetchImpl, calls: () => calls };
}

describe('getUsageReport (auto)', () => {
  it('uses the live service and enriches each window with local token counts', async () => {
    await seedAuth();
    await seedRollout();

    const report = await getUsageReport({
      source: 'auto',
      codexHome,
      now: NOW,
      fetchImpl: respond(API_RESPONSE),
    });

    expect(report.source).toBe('api');
    expect(report.account).toEqual({ email: 'api@example.com', plan: 'Pro' });
    expect(report.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(report.asOf).toBe(report.fetchedAt);
    expect(report.warnings).toEqual([]);

    const session = report.windows.find((w) => w.id === 'session_5h')!;
    const week = report.windows.find((w) => w.id === 'week_all')!;
    expect(session.percentUsed).toBe(7);
    expect(session.estimated).toBe(false);
    // 5h window opened at reset_at - 5h = 07:46:35Z; the fixture's counted events (10:00, 10:05) sum to 2500.
    expect(session.localTokens).toBe(2500);
    expect(week.localTokens).toBe(2500);
  });

  it('leaves localTokens null when there are no local logs, without failing', async () => {
    await seedAuth();
    const report = await getUsageReport({
      source: 'auto',
      codexHome,
      now: NOW,
      fetchImpl: respond(API_RESPONSE),
    });
    expect(report.source).toBe('api');
    expect(report.windows.every((w) => w.localTokens === null)).toBe(true);
  });

  it('falls back to the local snapshot when the network fails, and says so', async () => {
    await seedAuth();
    await seedRollout();

    const report = await getUsageReport({
      source: 'auto',
      codexHome,
      now: NOW,
      fetchImpl: failing(),
    });

    expect(report.source).toBe('local');
    expect(report.asOf).toBe('2026-09-06T10:10:00.000Z');
    const session = report.windows.find((w) => w.id === 'session_5h')!;
    expect(session.percentUsed).toBe(13);
    expect(session.estimated).toBe(true);
    expect(report.warnings[0]).toMatch(/^Live usage unavailable \(ECONNREFUSED\)/);
    expect(report.warnings.some((w) => /snapshot Codex saved locally \(1h 50m ago\)/.test(w))).toBe(
      true,
    );
    // Identity still comes from the login token even when the service is unreachable.
    expect(report.account).toEqual({ email: 'you@example.com', plan: 'Plus' });
  });

  it('treats a 401 as an expired token and falls back to local data', async () => {
    await seedAuth();
    await seedRollout();
    const report = await getUsageReport({
      source: 'auto',
      codexHome,
      now: NOW,
      fetchImpl: respond({ detail: 'Unauthorized' }, 401),
    });
    expect(report.source).toBe('local');
    expect(report.warnings.some((w) => /token appears expired/i.test(w))).toBe(true);
  });

  it('skips the network entirely when the JWT has already expired', async () => {
    await seedAuth(expiredAuth());
    await seedRollout();
    const counting = countingFetch(respond(API_RESPONSE));

    const report = await getUsageReport({
      source: 'auto',
      codexHome,
      now: NOW,
      fetchImpl: counting.fetchImpl,
    });

    expect(counting.calls()).toBe(0);
    expect(report.source).toBe('local');
    expect(report.warnings.some((w) => /token appears expired/i.test(w))).toBe(true);
  });

  it('explains an API-key sign-in, which has no usage windows, and shows local data', async () => {
    await seedAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture', tokens: null });
    await seedRollout();
    const counting = countingFetch(respond(API_RESPONSE));

    const report = await getUsageReport({
      source: 'auto',
      codexHome,
      now: NOW,
      fetchImpl: counting.fetchImpl,
    });

    expect(counting.calls()).toBe(0);
    expect(report.source).toBe('local');
    expect(report.warnings.some((w) => /API key/i.test(w))).toBe(true);
  });

  it('falls back when the service answers without any rate-limit windows', async () => {
    await seedAuth();
    await seedRollout();
    const report = await getUsageReport({
      source: 'auto',
      codexHome,
      now: NOW,
      fetchImpl: respond({ ...API_RESPONSE, rate_limit: null }),
    });
    expect(report.source).toBe('local');
    expect(report.warnings.some((w) => /no rate-limit windows/i.test(w))).toBe(true);
  });

  it('throws NotAuthenticatedError when there is neither a login nor local data', async () => {
    await expect(
      getUsageReport({ source: 'auto', codexHome, now: NOW, fetchImpl: respond(API_RESPONSE) }),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('getUsageReport (api)', () => {
  it('never falls back: a network failure propagates', async () => {
    await seedAuth();
    await seedRollout();
    await expect(
      getUsageReport({ source: 'api', codexHome, now: NOW, fetchImpl: failing() }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws TokenExpiredError for an expired JWT', async () => {
    await seedAuth(expiredAuth());
    await expect(
      getUsageReport({ source: 'api', codexHome, now: NOW, fetchImpl: respond(API_RESPONSE) }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('throws NotAuthenticatedError without credentials', async () => {
    await expect(
      getUsageReport({ source: 'api', codexHome, now: NOW, fetchImpl: respond(API_RESPONSE) }),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('getUsageReport (local)', () => {
  it('reads only local data but still labels the header from the login token', async () => {
    await seedAuth();
    await seedRollout();
    const counting = countingFetch(respond(API_RESPONSE));

    const report = await getUsageReport({
      source: 'local',
      codexHome,
      now: NOW,
      fetchImpl: counting.fetchImpl,
    });

    expect(counting.calls()).toBe(0);
    expect(report.source).toBe('local');
    expect(report.account).toEqual({ email: 'you@example.com', plan: 'Plus' });
    expect(report.windows.map((w) => w.id)).toEqual(['session_5h', 'week_all']);
  });

  it('throws NotAuthenticatedError when there is nothing local to read', async () => {
    await expect(getUsageReport({ source: 'local', codexHome, now: NOW })).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });
});
