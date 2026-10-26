import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectLocalUsage,
  LOCAL_ESTIMATE_WARNING,
  scanRollouts,
  STREAM_THRESHOLD_BYTES,
  sumTokensSince,
} from '../src/core/localSource.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'rollout.sample.jsonl');
// Anchors every cutoff; the fixture's timestamps were hand-picked against this value.
const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const HOUR = 3_600_000;

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), 'ocusage-local-'));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

async function seedRollout(relativePath: string, content: string): Promise<void> {
  const full = join(codexHome, 'sessions', relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function tokenCountLine(
  ts: string,
  total: number | null,
  rateLimits: unknown,
  extra: Record<string, unknown> = {},
): string {
  const usage =
    total === null ? null : { input_tokens: total, output_tokens: 0, total_tokens: total };
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: usage === null ? null : { total_token_usage: usage, last_token_usage: usage },
      rate_limits: rateLimits,
      ...extra,
    },
  });
}

function rateLimits(
  primaryPct: number,
  secondaryPct: number,
  primaryAt: number,
  secondaryAt: number,
) {
  return {
    limit_id: 'codex',
    primary: { used_percent: primaryPct, window_minutes: 300, resets_at: primaryAt },
    secondary: { used_percent: secondaryPct, window_minutes: 10080, resets_at: secondaryAt },
    credits: { has_credits: false, unlimited: false, balance: '0' },
    plan_type: 'plus',
  };
}

describe('scanRollouts', () => {
  it('finds the newest rate-limit snapshot and per-event token deltas inside the 7-day window', async () => {
    await seedRollout(join('2026', '09', '06', 'rollout-a.jsonl'), await readFile(FIXTURE, 'utf8'));

    const scan = await scanRollouts({ codexHome, now: NOW });

    // The info:null event at 10:10 is the newest snapshot: 13% / 41%.
    expect(scan.snapshot).not.toBeNull();
    expect(scan.snapshot!.timestampMs).toBe(Date.parse('2026-09-06T10:10:00.000Z'));
    expect(scan.snapshot!.primary).toEqual({
      usedPercent: 13,
      windowSeconds: 18000,
      resetsAtMs: Date.parse('2026-09-06T14:00:00.000Z'),
    });
    expect(scan.snapshot!.secondary).toEqual({
      usedPercent: 41,
      windowSeconds: 604800,
      resetsAtMs: Date.parse('2026-09-10T00:00:00.000Z'),
    });
    expect(scan.snapshot!.planType).toBe('plus');
    expect(scan.snapshot!.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });

    // Deltas: 500 (1000-500 carried over from the old event) + 2000; the duplicate is 0 and
    // the old 500 is outside the window. token_usage_record lines are ignored.
    expect(scan.events.map((e) => e.tokens)).toEqual([500, 2000]);
    expect(sumTokensSince(scan.events, NOW - 7 * 24 * HOUR)).toBe(2500);
    expect(scan.unreadableFiles).toBe(0);
  });

  it('picks the snapshot with the newest event timestamp, not the newest file', async () => {
    const pAt = epoch('2026-09-06T14:00:00Z');
    const sAt = epoch('2026-09-10T00:00:00Z');
    await seedRollout(
      join('2026', '09', '06', 'rollout-new-session.jsonl'),
      tokenCountLine('2026-09-06T09:00:00.000Z', 10, rateLimits(50, 50, pAt, sAt)),
    );
    await seedRollout(
      join('2026', '09', '01', 'rollout-old-but-long-running.jsonl'),
      tokenCountLine('2026-09-06T11:00:00.000Z', 10, rateLimits(60, 61, pAt, sAt)),
    );

    const scan = await scanRollouts({ codexHome, now: NOW });
    expect(scan.snapshot!.primary!.usedPercent).toBe(60);
    expect(scan.snapshot!.secondary!.usedPercent).toBe(61);
  });

  it('accepts the legacy resets_in_seconds form, relative to the event timestamp', async () => {
    await seedRollout(
      join('2026', '09', '06', 'rollout-legacy.jsonl'),
      tokenCountLine('2026-09-06T11:00:00.000Z', 10, {
        primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 3600 },
        secondary: null,
      }),
    );
    const scan = await scanRollouts({ codexHome, now: NOW });
    expect(scan.snapshot!.primary!.resetsAtMs).toBe(Date.parse('2026-09-06T12:00:00.000Z'));
    expect(scan.snapshot!.secondary).toBeNull();
  });

  it('treats a cumulative total that goes backwards as a fresh series', async () => {
    await seedRollout(
      join('2026', '09', '06', 'rollout-reset.jsonl'),
      [
        tokenCountLine('2026-09-06T10:00:00.000Z', 5000, null),
        tokenCountLine('2026-09-06T10:01:00.000Z', 300, null), // resumed session restarted its counter
        tokenCountLine('2026-09-06T10:02:00.000Z', 400, null),
      ].join('\n'),
    );
    const scan = await scanRollouts({ codexHome, now: NOW });
    expect(scan.events.map((e) => e.tokens)).toEqual([5000, 300, 100]);
  });

  it('skips files not touched within the window without opening them', async () => {
    const path = join('2026', '08', '01', 'rollout-ancient.jsonl');
    await seedRollout(path, tokenCountLine('2026-09-06T11:00:00.000Z', 10, null));
    // Backdate the mtime well past the cutoff even though the content claims to be recent.
    const { utimes } = await import('node:fs/promises');
    const ancient = new Date('2026-08-01T00:00:00.000Z');
    await utimes(join(codexHome, 'sessions', path), ancient, ancient);

    const scan = await scanRollouts({ codexHome, now: NOW });
    expect(scan.events).toEqual([]);
  });

  it('returns an empty scan when the sessions directory does not exist', async () => {
    const scan = await scanRollouts({ codexHome, now: NOW });
    expect(scan).toEqual({ snapshot: null, events: [], unreadableFiles: 0 });
  });

  it('streams a file above the size threshold line by line', async () => {
    const padding = 'x'.repeat(4096);
    const lineCount = Math.ceil((STREAM_THRESHOLD_BYTES * 1.2) / (padding.length + 200));
    const lines: string[] = [];
    for (let i = 1; i <= lineCount; i += 1) {
      lines.push(tokenCountLine('2026-09-06T10:00:00.000Z', i, null, { padding }));
    }
    const content = lines.join('\n');
    expect(content.length).toBeGreaterThan(STREAM_THRESHOLD_BYTES);
    await seedRollout(join('2026', '09', '06', 'rollout-huge.jsonl'), content);

    const scan = await scanRollouts({ codexHome, now: NOW });
    expect(sumTokensSince(scan.events, 0)).toBe(lineCount); // each line adds exactly one token
  });
});

describe('sumTokensSince', () => {
  it('sums only events at or after the start', () => {
    const events = [
      { timestampMs: 100, tokens: 1 },
      { timestampMs: 200, tokens: 2 },
      { timestampMs: 300, tokens: 4 },
    ];
    expect(sumTokensSince(events, 200)).toBe(6);
    expect(sumTokensSince(events, 301)).toBe(0);
    expect(sumTokensSince([], 0)).toBe(0);
  });
});

describe('collectLocalUsage', () => {
  it('builds estimated windows from the newest snapshot, with local token counts', async () => {
    await seedRollout(join('2026', '09', '06', 'rollout-a.jsonl'), await readFile(FIXTURE, 'utf8'));

    const result = await collectLocalUsage({ codexHome, now: NOW });

    expect(result.source).toBe('local');
    expect(result.asOf).toBe('2026-09-06T10:10:00.000Z');
    expect(result.account).toEqual({ email: null, plan: 'Plus' });
    expect(result.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });

    const session = result.windows.find((w) => w.id === 'session_5h')!;
    const week = result.windows.find((w) => w.id === 'week_all')!;
    expect(session.label).toBe('Current 5-hour window');
    expect(session.unit).toBe('ratio');
    expect(session.percentUsed).toBe(13);
    expect(session.resetsAt).toBe('2026-09-06T14:00:00.000Z');
    expect(session.windowSeconds).toBe(18000);
    expect(session.localTokens).toBe(2500); // window started 09:00Z; all counted events are later
    expect(session.estimated).toBe(true);
    expect(session.limit).toBeNull();

    expect(week.percentUsed).toBe(41);
    expect(week.resetsAt).toBe('2026-09-10T00:00:00.000Z');
    expect(week.localTokens).toBe(2500);

    expect(result.warnings).toEqual([
      'Live usage unavailable — showing the last usage snapshot Codex saved locally (1h 50m ago).',
    ]);
  });

  it('zeroes a window whose reset time has already passed and says why', async () => {
    const pAt = epoch('2026-09-06T11:00:00Z'); // an hour before NOW
    const sAt = epoch('2026-09-10T00:00:00Z');
    await seedRollout(
      join('2026', '09', '06', 'rollout-stale.jsonl'),
      [
        tokenCountLine('2026-09-06T08:00:00.000Z', 100, rateLimits(90, 30, pAt, sAt)),
        tokenCountLine('2026-09-06T11:30:00.000Z', 150, null), // after the reset, no snapshot
      ].join('\n'),
    );

    const result = await collectLocalUsage({ codexHome, now: NOW });
    const session = result.windows.find((w) => w.id === 'session_5h')!;
    const week = result.windows.find((w) => w.id === 'week_all')!;

    expect(session.percentUsed).toBe(0);
    expect(session.resetsAt).toBeNull();
    expect(session.localTokens).toBe(50); // only activity since the reset
    expect(week.percentUsed).toBe(30); // still inside its window
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/5-hour window has reset since/i)]),
    );
  });

  it('falls back to trailing token windows when no snapshot exists at all', async () => {
    await seedRollout(
      join('2026', '09', '06', 'rollout-nolimits.jsonl'),
      [
        tokenCountLine('2026-09-06T05:00:00.000Z', 1000, null), // 7h ago: weekly only
        tokenCountLine('2026-09-06T10:00:00.000Z', 1300, null), // 2h ago: both windows
      ].join('\n'),
    );

    const result = await collectLocalUsage({ codexHome, now: NOW });
    expect(result.asOf).toBeNull();
    const session = result.windows.find((w) => w.id === 'session_5h')!;
    const week = result.windows.find((w) => w.id === 'week_all')!;

    expect(session.unit).toBe('tokens');
    expect(session.used).toBe(300);
    expect(session.limit).toBeNull();
    expect(session.resetsAt).toBeNull();
    expect(session.estimated).toBe(true);
    expect(week.used).toBe(1300);
    expect(result.warnings).toContain(LOCAL_ESTIMATE_WARNING);
  });

  it('returns no windows when there is nothing to scan', async () => {
    const result = await collectLocalUsage({ codexHome, now: NOW });
    expect(result.windows).toEqual([]);
  });

  it('reports files it could not read instead of failing', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    const { chmod } = await import('node:fs/promises');
    await seedRollout(
      join('2026', '09', '06', 'rollout-locked.jsonl'),
      tokenCountLine('2026-09-06T10:00:00.000Z', 999, null),
    );
    await chmod(join(codexHome, 'sessions', '2026', '09', '06', 'rollout-locked.jsonl'), 0o000);
    await seedRollout(
      join('2026', '09', '06', 'rollout-ok.jsonl'),
      tokenCountLine('2026-09-06T10:00:00.000Z', 42, null),
    );

    const result = await collectLocalUsage({ codexHome, now: NOW });
    expect(result.windows.find((w) => w.id === 'week_all')!.used).toBe(42);
    expect(result.warnings.some((w) => /could not read 1 session log file/i.test(w))).toBe(true);
  });
});
