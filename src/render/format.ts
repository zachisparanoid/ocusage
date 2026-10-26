import type { UsageUnit } from '../types.js';

/**
 * 1_240_000 -> "1.24M", 2_400_000 -> "2.4M", 430_000 -> "430K", 999 -> "999".
 * Formats to 2 decimals then trims trailing zeros, so a clean "2.4M" and a
 * precise "1.24M" both come out right. K values are always whole. The same
 * scheme extends to billions: long agentic Codex threads genuinely reach
 * multi-million totals per thread once cached input is included.
 */
export function abbreviateNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';

  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${Math.round(abs / 1000)}K`;
  if (abs < 1_000_000_000) return `${sign}${trimTrailingZeros((abs / 1_000_000).toFixed(2))}M`;
  return `${sign}${trimTrailingZeros((abs / 1_000_000_000).toFixed(2))}B`;
}

function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

export function formatPercent(percentUsed: number): string {
  return `${Math.round(percentUsed)}%`;
}

/** "2026-09-06 14:03" in local time — a wall-clock "fetched at", not UTC. */
export function formatFetchedAt(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function unitLabel(unit: UsageUnit): string {
  switch (unit) {
    case 'tokens':
      return 'tokens';
    case 'messages':
      return 'messages';
    case 'requests':
      return 'requests';
    case 'ratio':
      return '';
  }
}
