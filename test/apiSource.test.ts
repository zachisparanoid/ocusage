import { describe, expect, it } from 'vitest';
import { fetchApiUsage, USAGE_ENDPOINT } from '../src/core/apiSource.js';
import { NetworkError, NetworkTimeoutError, TokenExpiredError } from '../src/errors.js';
import type { ResolvedCredentials } from '../src/types.js';

const creds: ResolvedCredentials = {
  accessToken: 'fixture-access-token',
  accountId: 'acct-fixture-uuid',
  expiresAt: null,
  planType: 'plus',
  email: 'jwt@example.com',
  displayName: 'Example User',
  authMode: 'chatgpt',
  filePath: '/fixture/auth.json',
};

/** A real captured `wham/usage` response (identifiers replaced). */
const REAL_RESPONSE = {
  user_id: 'user-fixture',
  account_id: 'acct-fixture-uuid',
  email: 'you@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 7,
      limit_window_seconds: 18000,
      reset_after_seconds: 17836,
      reset_at: 1788698795,
    },
    secondary_window: {
      used_percent: 24,
      limit_window_seconds: 604800,
      reset_after_seconds: 490214,
      reset_at: 1789171173,
    },
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  model_usage: {
    'gpt-6-astra': { available: true, available_at: null, credits_would_enable: false },
  },
  credits: {
    has_credits: false,
    unlimited: false,
    overage_limit_reached: false,
    balance: '0',
    approx_local_messages: [0, 0],
    approx_cloud_messages: [0, 0],
  },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: null,
  promo: null,
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
};

function jsonResponse(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('fetchApiUsage', () => {
  it('maps the real response into the 5-hour and weekly windows', async () => {
    const result = await fetchApiUsage(creds, { fetchImpl: jsonResponse(REAL_RESPONSE) });

    expect(result.source).toBe('api');
    const byId = Object.fromEntries(result.windows.map((w) => [w.id, w]));
    expect(Object.keys(byId)).toEqual(['session_5h', 'week_all']);

    expect(byId.session_5h!.label).toBe('Current 5-hour window');
    expect(byId.session_5h!.percentUsed).toBe(7);
    expect(byId.session_5h!.windowSeconds).toBe(18000);
    expect(byId.session_5h!.resetsAt).toBe(new Date(1788698795 * 1000).toISOString());
    expect(byId.session_5h!.unit).toBe('ratio');
    expect(byId.session_5h!.limit).toBeNull();
    expect(byId.session_5h!.estimated).toBe(false);

    expect(byId.week_all!.label).toBe('Current week');
    expect(byId.week_all!.percentUsed).toBe(24);
    expect(byId.week_all!.windowSeconds).toBe(604800);
    expect(byId.week_all!.resetsAt).toBe(new Date(1789171173 * 1000).toISOString());

    expect(result.warnings).toEqual([]);
  });

  it('prefers the email and plan the service reports over the JWT claims', async () => {
    const result = await fetchApiUsage(creds, { fetchImpl: jsonResponse(REAL_RESPONSE) });
    expect(result.account).toEqual({ email: 'you@example.com', plan: 'Plus' });
  });

  it('falls back to the JWT claims when the service omits identity', async () => {
    const { email: _e, plan_type: _p, ...noIdentity } = REAL_RESPONSE;
    const result = await fetchApiUsage(creds, { fetchImpl: jsonResponse(noIdentity) });
    expect(result.account).toEqual({ email: 'jwt@example.com', plan: 'Plus' });
  });

  it('reports credits', async () => {
    const result = await fetchApiUsage(creds, {
      fetchImpl: jsonResponse({
        ...REAL_RESPONSE,
        credits: { ...REAL_RESPONSE.credits, has_credits: true, balance: '12.50' },
      }),
    });
    expect(result.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' });
  });

  it('sends the bearer token and account id, identifying as ocusage rather than Codex', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const capture: typeof fetch = async (input, init) => {
      seen = { url: String(input), headers: init!.headers as Record<string, string> };
      return new Response(JSON.stringify(REAL_RESPONSE), { status: 200 });
    };
    await fetchApiUsage(creds, { fetchImpl: capture });

    expect(seen!.url).toBe(USAGE_ENDPOINT);
    expect(seen!.url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(seen!.headers.Authorization).toBe('Bearer fixture-access-token');
    expect(seen!.headers['ChatGPT-Account-Id']).toBe('acct-fixture-uuid');
    expect(seen!.headers['User-Agent']).toMatch(/^ocusage\//);
  });

  it('omits the account header when the account id is unknown', async () => {
    let headers: Record<string, string> = {};
    const capture: typeof fetch = async (_input, init) => {
      headers = init!.headers as Record<string, string>;
      return new Response(JSON.stringify(REAL_RESPONSE), { status: 200 });
    };
    await fetchApiUsage({ ...creds, accountId: null }, { fetchImpl: capture });
    expect('ChatGPT-Account-Id' in headers).toBe(false);
  });

  it('adds code-review windows when the service reports a separate code-review limit', async () => {
    const result = await fetchApiUsage(creds, {
      fetchImpl: jsonResponse({
        ...REAL_RESPONSE,
        code_review_rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: 1788698795 },
          secondary_window: {
            used_percent: 60,
            limit_window_seconds: 604800,
            reset_at: 1789171173,
          },
        },
      }),
    });
    const ids = result.windows.map((w) => w.id);
    expect(ids).toEqual(['session_5h', 'week_all', 'code_review_5h', 'code_review_week']);
    const review = result.windows.find((w) => w.id === 'code_review_week')!;
    expect(review.label).toBe('Code review (week)');
    expect(review.percentUsed).toBe(60);
  });

  it('maps additional named limits defensively', async () => {
    const result = await fetchApiUsage(creds, {
      fetchImpl: jsonResponse({
        ...REAL_RESPONSE,
        additional_rate_limits: [
          {
            limit_id: 'cloud',
            limit_name: 'Cloud tasks',
            rate_limit: {
              primary_window: {
                used_percent: 1,
                limit_window_seconds: 18000,
                reset_at: 1788698795,
              },
              secondary_window: null,
            },
          },
          { something: 'unrecognized' },
        ],
      }),
    });
    const cloud = result.windows.find((w) => w.id === 'cloud_5h');
    expect(cloud).toBeDefined();
    expect(cloud!.label).toBe('Cloud tasks (5-hour)');
    expect(cloud!.percentUsed).toBe(1);
    expect(result.windows.some((w) => w.id === 'cloud_week')).toBe(false);
    expect(result.warnings.some((w) => /unrecognized additional rate limit/i.test(w))).toBe(true);
  });

  it('tolerates a window that only gives reset_after_seconds', async () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    const result = await fetchApiUsage(creds, {
      fetchImpl: jsonResponse({
        rate_limit: {
          primary_window: {
            used_percent: 3,
            limit_window_seconds: 18000,
            reset_after_seconds: 600,
          },
        },
      }),
      now,
    });
    expect(result.windows[0]!.resetsAt).toBe('2026-09-06T12:10:00.000Z');
  });

  it('surfaces server-side limit flags and unavailable models as warnings', async () => {
    const result = await fetchApiUsage(creds, {
      fetchImpl: jsonResponse({
        ...REAL_RESPONSE,
        rate_limit: { ...REAL_RESPONSE.rate_limit, allowed: false, limit_reached: true },
        rate_limit_reached_type: 'secondary',
        spend_control: { reached: true, individual_limit: null },
        model_usage: {
          'gpt-6-astra': { available: false, available_at: 1789171173, credits_would_enable: true },
        },
      }),
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/rate limit reached/i),
        expect.stringMatching(/spend control/i),
        expect.stringMatching(/gpt-6-astra.*unavailable/i),
      ]),
    );
    // Both flags describe one condition — one warning, not two.
    expect(result.warnings.filter((w) => /rate limit reached/i.test(w))).toHaveLength(1);
  });

  it('returns no windows plus a warning when rate_limit is absent (e.g. API-key auth)', async () => {
    const result = await fetchApiUsage(creds, {
      fetchImpl: jsonResponse({ ...REAL_RESPONSE, rate_limit: null }),
    });
    expect(result.windows).toEqual([]);
    expect(result.warnings.some((w) => /no rate-limit windows/i.test(w))).toBe(true);
  });

  it('returns no windows plus a warning for a completely unrecognized response', async () => {
    const result = await fetchApiUsage(creds, { fetchImpl: jsonResponse({ nothing: 'useful' }) });
    expect(result.windows).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('throws TokenExpiredError on 401 (the service answers 401 for bad and expired tokens alike)', async () => {
    await expect(
      fetchApiUsage(creds, {
        fetchImpl: jsonResponse({ detail: 'Could not parse your authentication token.' }, 401),
      }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('throws NetworkError on a non-2xx, non-401 status', async () => {
    await expect(fetchApiUsage(creds, { fetchImpl: jsonResponse({}, 500) })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('throws NetworkError on an unparseable body', async () => {
    const badBody: typeof fetch = async () => new Response('<html>blocked</html>', { status: 200 });
    await expect(fetchApiUsage(creds, { fetchImpl: badBody })).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkTimeoutError when the request does not settle before the timeout', async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    await expect(
      fetchApiUsage(creds, { fetchImpl: hangingFetch, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(NetworkTimeoutError);
  });
});
