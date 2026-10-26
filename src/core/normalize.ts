import { WINDOW_IDS } from '../types.js';
import type {
  DataSourceKind,
  RawUsageData,
  RawWindow,
  UsageReport,
  UsageWindow,
} from '../types.js';

/** The two account-wide windows always sort first, 5-hour then weekly. */
const PRIMARY_ORDER: readonly string[] = [WINDOW_IDS.session, WINDOW_IDS.weekAll];

/**
 * The only place `percentUsed` gets computed. Every data source hands us
 * raw `used`/`limit`/optional pre-computed `percentUsed`; this is where the
 * clamp-and-never-divide-by-zero rules are enforced, once.
 */
export function normalize(raw: RawUsageData, fetchedAt: string): UsageReport {
  return {
    account: raw.account,
    credits: raw.credits,
    windows: orderWindows(raw.windows).map((w) => toUsageWindow(w, raw.source)),
    fetchedAt,
    asOf: raw.asOf ?? fetchedAt,
    source: raw.source,
    warnings: raw.warnings,
  };
}

function toUsageWindow(w: RawWindow, source: DataSourceKind): UsageWindow {
  const percentUsed = computePercent(w);
  const limit = w.limit !== null && w.limit > 0 ? w.limit : null;
  return {
    id: w.id,
    label: w.label,
    // Ratio-unit windows (percent-only service buckets) have no independent
    // "used" quantity — the percent itself IS the measurement — so used
    // mirrors percentUsed for a self-consistent --json payload.
    used: w.unit === 'ratio' ? percentUsed : w.used,
    limit,
    unit: w.unit,
    percentUsed,
    resetsAt: w.resetsAt,
    windowSeconds: w.windowSeconds,
    localTokens: w.localTokens ?? null,
    source,
    estimated: w.estimated,
  };
}

function computePercent(w: RawWindow): number {
  if (w.limit !== null && w.limit > 0) {
    return clamp(Math.round((w.used / w.limit) * 100), 0, 100);
  }
  if (typeof w.percentUsed === 'number' && Number.isFinite(w.percentUsed)) {
    return clamp(Math.round(w.percentUsed), 0, 100);
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Stable sort: session_5h, week_all, then everything else in source order. */
function orderWindows(windows: RawWindow[]): RawWindow[] {
  const priorityOf = (id: string): number => {
    const idx = PRIMARY_ORDER.indexOf(id);
    return idx === -1 ? PRIMARY_ORDER.length : idx;
  };
  return [...windows].sort((a, b) => priorityOf(String(a.id)) - priorityOf(String(b.id)));
}
