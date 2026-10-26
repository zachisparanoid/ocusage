import { describe, expect, it } from 'vitest';
import { normalize } from '../src/core/normalize.js';
import { WINDOW_IDS } from '../src/types.js';
import type { RawUsageData, RawWindow } from '../src/types.js';

const FETCHED_AT = '2026-09-06T12:00:00.000Z';

function raw(windows: RawWindow[], overrides: Partial<RawUsageData> = {}): RawUsageData {
  return {
    source: 'local',
    account: { email: null, plan: null },
    credits: null,
    windows,
    warnings: [],
    asOf: null,
    ...overrides,
  };
}

function ratioWindow(id: string, percentUsed: number, extra: Partial<RawWindow> = {}): RawWindow {
  return {
    id,
    label: id,
    used: 0,
    limit: null,
    unit: 'ratio',
    percentUsed,
    resetsAt: null,
    windowSeconds: null,
    estimated: false,
    ...extra,
  };
}

describe('normalize', () => {
  it('computes percentUsed from used/limit, rounded and clamped', () => {
    const report = normalize(
      raw([
        {
          id: WINDOW_IDS.weekAll,
          label: 'x',
          used: 130,
          limit: 200,
          unit: 'tokens',
          resetsAt: null,
          windowSeconds: null,
          estimated: false,
        },
      ]),
      FETCHED_AT,
    );
    expect(report.windows[0]!.percentUsed).toBe(65);
  });

  it('clamps percentUsed to 100 when used exceeds limit, but keeps the true numbers', () => {
    const report = normalize(
      raw([
        {
          id: WINDOW_IDS.weekAll,
          label: 'x',
          used: 999,
          limit: 100,
          unit: 'tokens',
          resetsAt: null,
          windowSeconds: null,
          estimated: false,
        },
      ]),
      FETCHED_AT,
    );
    expect(report.windows[0]!.percentUsed).toBe(100);
    expect(report.windows[0]!.used).toBe(999);
    expect(report.windows[0]!.limit).toBe(100);
  });

  it('never divides by zero: a zero limit normalizes to null and 0%', () => {
    const report = normalize(
      raw([
        {
          id: WINDOW_IDS.weekAll,
          label: 'x',
          used: 500,
          limit: 0,
          unit: 'tokens',
          resetsAt: null,
          windowSeconds: null,
          estimated: false,
        },
      ]),
      FETCHED_AT,
    );
    expect(report.windows[0]!.limit).toBeNull();
    expect(report.windows[0]!.percentUsed).toBe(0);
  });

  it('uses a pre-computed percentUsed for ratio-unit windows, mirroring it into used', () => {
    const report = normalize(raw([ratioWindow(WINDOW_IDS.session, 46.7)]), FETCHED_AT);
    expect(report.windows[0]!.percentUsed).toBe(47);
    expect(report.windows[0]!.used).toBe(47);
  });

  it('clamps an out-of-range server percentage', () => {
    const report = normalize(raw([ratioWindow(WINDOW_IDS.session, 140)]), FETCHED_AT);
    expect(report.windows[0]!.percentUsed).toBe(100);
  });

  it('defaults percentUsed to 0 when neither limit nor percentUsed is known', () => {
    const report = normalize(
      raw([
        {
          id: WINDOW_IDS.weekAll,
          label: 'x',
          used: 12345,
          limit: null,
          unit: 'tokens',
          resetsAt: null,
          windowSeconds: null,
          estimated: true,
        },
      ]),
      FETCHED_AT,
    );
    expect(report.windows[0]!.percentUsed).toBe(0);
    expect(report.windows[0]!.used).toBe(12345);
  });

  it('carries windowSeconds and localTokens through, defaulting localTokens to null', () => {
    const report = normalize(
      raw([
        ratioWindow(WINDOW_IDS.session, 7, { windowSeconds: 18000, localTokens: 1_200_000 }),
        ratioWindow(WINDOW_IDS.weekAll, 24, { windowSeconds: 604800 }),
      ]),
      FETCHED_AT,
    );
    expect(report.windows[0]!.windowSeconds).toBe(18000);
    expect(report.windows[0]!.localTokens).toBe(1_200_000);
    expect(report.windows[1]!.localTokens).toBeNull();
  });

  it('orders session_5h first and week_all second regardless of input order', () => {
    const report = normalize(
      raw([
        ratioWindow('code_review_week', 1),
        ratioWindow(WINDOW_IDS.weekAll, 2),
        ratioWindow('code_review_5h', 3),
        ratioWindow(WINDOW_IDS.session, 4),
      ]),
      FETCHED_AT,
    );
    expect(report.windows.map((w) => w.id)).toEqual([
      WINDOW_IDS.session,
      WINDOW_IDS.weekAll,
      'code_review_week',
      'code_review_5h',
    ]);
  });

  it('passes account, credits, fetchedAt, source, and warnings through unchanged', () => {
    const report = normalize(
      raw([], {
        source: 'api',
        account: { email: 'a@example.com', plan: 'Plus' },
        credits: { hasCredits: true, unlimited: false, balance: '12.5' },
        warnings: ['careful'],
      }),
      FETCHED_AT,
    );
    expect(report.account).toEqual({ email: 'a@example.com', plan: 'Plus' });
    expect(report.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.5' });
    expect(report.source).toBe('api');
    expect(report.warnings).toEqual(['careful']);
    expect(report.fetchedAt).toBe(FETCHED_AT);
  });

  it('uses the raw asOf when the source supplied one, else fetchedAt', () => {
    expect(normalize(raw([]), FETCHED_AT).asOf).toBe(FETCHED_AT);
    expect(normalize(raw([], { asOf: '2026-09-06T10:10:00.000Z' }), FETCHED_AT).asOf).toBe(
      '2026-09-06T10:10:00.000Z',
    );
  });
});
