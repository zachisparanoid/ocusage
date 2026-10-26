/* eslint-disable no-control-regex -- matching real ANSI escape sequences is the point of this file */
import { describe, expect, it } from 'vitest';
import { renderCompactDashboard, renderDashboard } from '../src/render/dashboard.js';
import type { UsageReport, UsageWindow } from '../src/types.js';

const FETCHED_AT = '2026-09-06T14:03:00.000Z';
const ANSI_PATTERN = /\x1b\[/;

function window(overrides: Partial<UsageWindow>): UsageWindow {
  return {
    id: 'session_5h',
    label: 'Current 5-hour window',
    used: 7,
    limit: null,
    unit: 'ratio',
    percentUsed: 7,
    resetsAt: '2026-09-06T19:00:00.000Z', // fetchedAt + 4h 57m
    windowSeconds: 18000,
    localTokens: 1_240_000,
    source: 'api',
    estimated: false,
    ...overrides,
  };
}

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    account: { email: 'you@example.com', plan: 'Plus' },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    windows: [
      window({}),
      window({
        id: 'week_all',
        label: 'Current week',
        used: 24,
        percentUsed: 24,
        resetsAt: '2026-09-12T06:03:00.000Z', // fetchedAt + 5d 16h
        windowSeconds: 604800,
        localTokens: 18_300_000,
      }),
    ],
    fetchedAt: FETCHED_AT,
    asOf: FETCHED_AT,
    source: 'api',
    warnings: [],
    ...overrides,
  };
}

describe('renderDashboard (plain)', () => {
  const output = renderDashboard(report(), { colorEnabled: false, columns: 80 });

  it('matches the plain-text snapshot', () => {
    expect(output).toMatchSnapshot();
  });

  it('never emits ANSI escape codes', () => {
    expect(output).not.toMatch(ANSI_PATTERN);
  });

  it('shows the header with email, plan, and fetched time', () => {
    expect(output).toContain('Codex · usage');
    expect(output).toContain('you@example.com · Plus');
    expect(output).toContain('fetched 2026-09-06 14:03');
  });

  it('shows both windows with percent, reset time, and the local token hint', () => {
    expect(output).toContain('Current 5-hour window');
    expect(output).toContain('7%');
    expect(output).toContain('resets in 4h 57m · ~1.24M tokens');
    expect(output).toContain('Current week');
    expect(output).toContain('24%');
    expect(output).toContain('resets in 5d 16h · ~18.3M tokens');
  });

  it('orders the 5-hour window before the weekly one', () => {
    expect(output.indexOf('Current 5-hour window')).toBeLessThan(output.indexOf('Current week'));
  });

  it('does not mention credits when the account has none', () => {
    expect(output).not.toContain('credits');
  });
});

describe('renderDashboard (color)', () => {
  const output = renderDashboard(report(), { colorEnabled: true, columns: 80 });

  it('matches the colored snapshot', () => {
    expect(output).toMatchSnapshot();
  });

  it('emits ANSI escape codes', () => {
    expect(output).toMatch(ANSI_PATTERN);
  });

  it('still contains the same plain-text content once colors are stripped', () => {
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toContain('7%');
    expect(stripped).toContain('Current week');
  });
});

describe('renderDashboard edge cases', () => {
  it('degrades the header to the title alone when email is unknown', () => {
    const output = renderDashboard(report({ account: { email: null, plan: null } }), {
      colorEnabled: false,
      columns: 80,
    });
    expect(output).toContain('Codex · usage');
    expect(output).not.toContain('fetched');
  });

  it('shows the plan alone when only the email is missing', () => {
    const output = renderDashboard(report({ account: { email: null, plan: 'Plus' } }), {
      colorEnabled: false,
      columns: 80,
    });
    expect(output).toContain('Plus');
    expect(output).toContain('fetched 2026-09-06 14:03');
  });

  it('appends the credit balance to the identity line when the account has credits', () => {
    const output = renderDashboard(
      report({ credits: { hasCredits: true, unlimited: false, balance: '12.50' } }),
      { colorEnabled: false, columns: 80 },
    );
    expect(output).toContain('you@example.com · Plus · credits 12.50');
  });

  it('says "unlimited credits" for an unlimited account', () => {
    const output = renderDashboard(
      report({ credits: { hasCredits: true, unlimited: true, balance: null } }),
      { colorEnabled: false, columns: 80 },
    );
    expect(output).toContain('you@example.com · Plus · unlimited credits');
  });

  it('shows a placeholder when there are no windows', () => {
    const output = renderDashboard(report({ windows: [] }), { colorEnabled: false, columns: 80 });
    expect(output).toContain('No usage windows available.');
  });

  it('renders warnings with a dim warning glyph', () => {
    const output = renderDashboard(
      report({ warnings: ['Live usage unavailable — showing the last usage snapshot (12m ago).'] }),
      { colorEnabled: false, columns: 80 },
    );
    expect(output).toContain(
      '⚠ Live usage unavailable — showing the last usage snapshot (12m ago).',
    );
  });

  it('shows only the reset phrase for a ratio window with no local token count', () => {
    const output = renderDashboard(report({ windows: [window({ localTokens: null })] }), {
      colorEnabled: false,
      columns: 80,
    });
    expect(output).toContain('resets in 4h 57m');
    expect(output).not.toContain('~');
    expect(output).not.toContain('tokens');
  });

  it('shows a bare used count with "(estimated)" for a null-limit token window', () => {
    const output = renderDashboard(
      report({
        windows: [
          window({
            unit: 'tokens',
            used: 1_240_000,
            percentUsed: 0,
            resetsAt: null,
            localTokens: null,
            estimated: true,
          }),
        ],
      }),
      { colorEnabled: false, columns: 80 },
    );
    expect(output).toContain('1.24M tokens (estimated) · resets: unknown');
    expect(output).not.toContain('1.24M /');
  });

  it('shows a used/limit fraction when a real limit is known', () => {
    const output = renderDashboard(
      report({
        windows: [window({ unit: 'tokens', used: 430_000, limit: 512_000, percentUsed: 84 })],
      }),
      { colorEnabled: false, columns: 80 },
    );
    expect(output).toContain('430K / 512K tokens · resets in 4h 57m');
  });

  it('shows "resets: unknown" when resetsAt is null', () => {
    const output = renderDashboard(report({ windows: [window({ resetsAt: null })] }), {
      colorEnabled: false,
      columns: 80,
    });
    expect(output).toContain('resets: unknown');
  });

  it('shrinks the bar and drops the detail to its own indented line under 40 columns', () => {
    const output = renderDashboard(report({ windows: [window({})] }), {
      colorEnabled: false,
      columns: 32,
    });
    const lines = output.split('\n');
    const barLine = lines.find((l) => l.includes('░') || l.includes('█'));
    expect(barLine).toBeDefined();
    expect(barLine).not.toContain('resets'); // detail must not be on the bar line
    const detailLine = lines.find((l) => l.includes('resets in'));
    expect(detailLine).toBeDefined();
    expect(detailLine!.startsWith('    ')).toBe(true); // indented under the bar
  });

  it('keeps the detail inline at a normal 80-column width', () => {
    const output = renderDashboard(report({ windows: [window({})] }), {
      colorEnabled: false,
      columns: 80,
    });
    const barLine = output.split('\n').find((l) => l.includes('░') || l.includes('█'));
    expect(barLine).toContain('resets in 4h 57m');
  });
});

describe('renderCompactDashboard', () => {
  it('renders one line per window with no header', () => {
    const output = renderCompactDashboard(report(), { colorEnabled: false });
    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
    expect(output).not.toContain('Codex · usage');
    expect(lines[0]).toContain('5-hour');
    expect(lines[0]).toContain('7%');
    expect(lines[0]).toContain('resets in 4h 57m');
    expect(lines[1]).toContain('weekly');
    expect(lines[1]).toContain('24%');
  });

  it('derives a short name for windows it has no alias for', () => {
    const output = renderCompactDashboard(
      report({ windows: [window({ id: 'code_review_week', label: 'Code review (week)' })] }),
      { colorEnabled: false },
    );
    expect(output).toContain('review-wk');
  });

  it('matches the compact snapshot', () => {
    expect(renderCompactDashboard(report(), { colorEnabled: false })).toMatchSnapshot();
  });
});
