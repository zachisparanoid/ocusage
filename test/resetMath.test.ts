import { describe, expect, it } from 'vitest';
import {
  formatAgePhrase,
  formatDurationTwoUnits,
  formatResetPhrase,
} from '../src/core/resetMath.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatDurationTwoUnits', () => {
  it('formats days and hours as the largest two units', () => {
    expect(formatDurationTwoUnits(3 * DAY + 4 * HOUR)).toBe('3d 4h');
  });

  it('formats hours and minutes when under a day', () => {
    expect(formatDurationTwoUnits(18 * HOUR + 42 * MINUTE)).toBe('18h 42m');
  });

  it('formats bare minutes when under an hour', () => {
    expect(formatDurationTwoUnits(54 * MINUTE)).toBe('54m');
  });

  it('shows "< 1m" for anything under a minute', () => {
    expect(formatDurationTwoUnits(59_000)).toBe('< 1m');
    expect(formatDurationTwoUnits(1)).toBe('< 1m');
    expect(formatDurationTwoUnits(0)).toBe('< 1m');
  });

  it('shows "1m" (not "< 1m") right at the one-minute boundary', () => {
    expect(formatDurationTwoUnits(MINUTE)).toBe('1m');
  });

  it('drops minutes once days are shown, even at zero hours', () => {
    expect(formatDurationTwoUnits(10 * DAY)).toBe('10d 0h');
  });

  it('drops seconds-level precision once hours are shown', () => {
    expect(formatDurationTwoUnits(2 * HOUR + 59 * MINUTE + 59_000)).toBe('2h 59m');
  });
});

describe('formatResetPhrase', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');

  it('shows "resets: unknown" for a null resetsAt', () => {
    expect(formatResetPhrase(null, now)).toBe('resets: unknown');
  });

  it('shows a duration for a future resetsAt', () => {
    const resetsAt = new Date(now + 3 * DAY + 4 * HOUR).toISOString();
    expect(formatResetPhrase(resetsAt, now)).toBe('resets in 3d 4h');
  });

  it('shows "resetting…" for a resetsAt in the past', () => {
    const resetsAt = new Date(now - HOUR).toISOString();
    expect(formatResetPhrase(resetsAt, now)).toBe('resetting…');
  });

  it('shows "resetting…" for a resetsAt exactly at now', () => {
    expect(formatResetPhrase(new Date(now).toISOString(), now)).toBe('resetting…');
  });

  it('shows "resetting…" rather than a negative duration for a malformed timestamp', () => {
    expect(formatResetPhrase('not-a-real-date', now)).toBe('resetting…');
  });
});

describe('formatAgePhrase', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');

  it('describes how long ago a snapshot was taken using the same two-unit scheme', () => {
    expect(formatAgePhrase(new Date(now - 12 * MINUTE).toISOString(), now)).toBe('12m ago');
    expect(formatAgePhrase(new Date(now - HOUR - 50 * MINUTE).toISOString(), now)).toBe(
      '1h 50m ago',
    );
  });

  it('shows "< 1m ago" for a very fresh snapshot', () => {
    expect(formatAgePhrase(new Date(now - 5_000).toISOString(), now)).toBe('< 1m ago');
  });

  it('never shows a negative age for a timestamp slightly in the future (clock skew)', () => {
    expect(formatAgePhrase(new Date(now + 30_000).toISOString(), now)).toBe('< 1m ago');
  });

  it('shows "unknown" for a malformed timestamp', () => {
    expect(formatAgePhrase('garbage', now)).toBe('unknown');
  });
});
