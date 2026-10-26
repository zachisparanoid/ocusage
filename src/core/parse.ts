import type { UsageCredits } from '../types.js';

/** Small, dependency-free guards shared by the API and local parsers. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First argument that is a non-empty string, else null. */
export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `obj[key]` when it is a finite number, else null (tolerates a non-object `obj`). */
export function numberAt(obj: unknown, key: string): number | null {
  return isRecord(obj) ? finiteNumber(obj[key]) : null;
}

/**
 * Both the live service and the rollout snapshots describe credits as
 * `{ has_credits, unlimited, balance }` (balance is a string like "0").
 */
export function readCredits(value: unknown): UsageCredits | null {
  if (!isRecord(value)) return null;
  const balance = value.balance;
  return {
    hasCredits: value.has_credits === true,
    unlimited: value.unlimited === true,
    balance:
      typeof balance === 'string'
        ? balance
        : typeof balance === 'number' && Number.isFinite(balance)
          ? String(balance)
          : null,
  };
}

/** Epoch seconds (the service's `reset_at`) or an ISO string -> ISO string; null otherwise. */
export function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}
