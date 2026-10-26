import { describe, expect, it } from 'vitest';
import {
  FIVE_HOURS_SEC,
  ONE_WEEK_SEC,
  mainWindowId,
  mainWindowLabel,
  scopedWindowId,
  scopedWindowLabel,
  windowShort,
} from '../src/core/windows.js';

describe('windowShort', () => {
  it('names the two windows Codex actually uses', () => {
    expect(windowShort(FIVE_HOURS_SEC)).toBe('5-hour');
    expect(windowShort(ONE_WEEK_SEC)).toBe('week');
  });

  it('degrades gracefully for lengths it has never seen', () => {
    expect(windowShort(3 * 3600)).toBe('3-hour');
    expect(windowShort(2 * 86400)).toBe('2-day');
    expect(windowShort(90 * 60)).toBe('90-minute');
    expect(windowShort(90)).toBe('90s');
  });

  it('says "unknown" when the length is missing', () => {
    expect(windowShort(null)).toBe('unknown');
  });
});

describe('ids', () => {
  it('reuses ccusage ids for the same concepts so one script can read both tools', () => {
    expect(mainWindowId(FIVE_HOURS_SEC)).toBe('session_5h');
    expect(mainWindowId(ONE_WEEK_SEC)).toBe('week_all');
  });

  it('gives an unfamiliar length a stable, length-derived id instead of a wrong one', () => {
    expect(mainWindowId(3 * 3600)).toBe('window_10800s');
    expect(mainWindowId(null)).toBe('window_unknown');
  });

  it('prefixes scoped windows with a slug of their scope', () => {
    expect(scopedWindowId('code_review', FIVE_HOURS_SEC)).toBe('code_review_5h');
    expect(scopedWindowId('Code Review!', ONE_WEEK_SEC)).toBe('code_review_week');
    expect(scopedWindowId('foo', 3 * 3600)).toBe('foo_10800s');
  });
});

describe('labels', () => {
  it('reads naturally for the main windows', () => {
    expect(mainWindowLabel(FIVE_HOURS_SEC)).toBe('Current 5-hour window');
    expect(mainWindowLabel(ONE_WEEK_SEC)).toBe('Current week');
    expect(mainWindowLabel(2 * 86400)).toBe('Current 2-day window');
  });

  it('parenthesizes the window for scoped limits', () => {
    expect(scopedWindowLabel('Code review', FIVE_HOURS_SEC)).toBe('Code review (5-hour)');
    expect(scopedWindowLabel('Code review', ONE_WEEK_SEC)).toBe('Code review (week)');
  });
});
