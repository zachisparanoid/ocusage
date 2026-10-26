import { WINDOW_IDS } from '../types.js';
import type { WindowId } from '../types.js';

/**
 * Codex describes its limits purely by window length: a `primary_window`
 * of 18000 s and a `secondary_window` of 604800 s. Ids and labels are
 * derived from that length rather than from the primary/secondary role, so
 * a changed window size degrades to a still-stable id (`window_10800s`)
 * instead of a wrong label.
 */
export const FIVE_HOURS_SEC = 5 * 60 * 60;
export const ONE_WEEK_SEC = 7 * 24 * 60 * 60;

/** "5-hour", "week", "3-hour", "2-day", "90-minute", "90s", "unknown". */
export function windowShort(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  if (seconds === ONE_WEEK_SEC) return 'week';
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour`;
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}s`;
}

function windowSuffix(seconds: number | null): string {
  if (seconds === FIVE_HOURS_SEC) return '5h';
  if (seconds === ONE_WEEK_SEC) return 'week';
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  return `${seconds}s`;
}

/** The account-wide limit: reuses ccusage's ids for the same concepts. */
export function mainWindowId(seconds: number | null): WindowId {
  if (seconds === FIVE_HOURS_SEC) return WINDOW_IDS.session;
  if (seconds === ONE_WEEK_SEC) return WINDOW_IDS.weekAll;
  return `window_${windowSuffix(seconds)}`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length > 0 ? slug : 'limit';
}

/** A named/scoped limit (code review, an "additional" limit): `<scope-slug>_<len>`. */
export function scopedWindowId(scope: string, seconds: number | null): WindowId {
  return `${slugify(scope)}_${windowSuffix(seconds)}`;
}

export function mainWindowLabel(seconds: number | null): string {
  const short = windowShort(seconds);
  return short === 'week' ? 'Current week' : `Current ${short} window`;
}

export function scopedWindowLabel(name: string, seconds: number | null): string {
  return `${name} (${windowShort(seconds)})`;
}
