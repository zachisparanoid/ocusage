import { describe, expect, it } from 'vitest';
import {
  abbreviateNumber,
  formatFetchedAt,
  formatPercent,
  unitLabel,
} from '../src/render/format.js';

describe('abbreviateNumber', () => {
  it('matches the reference examples exactly', () => {
    expect(abbreviateNumber(1_240_000)).toBe('1.24M');
    expect(abbreviateNumber(2_400_000)).toBe('2.4M');
    expect(abbreviateNumber(430_000)).toBe('430K');
    expect(abbreviateNumber(512_000)).toBe('512K');
    expect(abbreviateNumber(999)).toBe('999');
  });

  it('shows exact values under 1000', () => {
    expect(abbreviateNumber(0)).toBe('0');
    expect(abbreviateNumber(1)).toBe('1');
    expect(abbreviateNumber(999)).toBe('999');
  });

  it('shows whole-number K with no decimals', () => {
    expect(abbreviateNumber(1000)).toBe('1K');
    expect(abbreviateNumber(1500)).toBe('2K'); // rounds, doesn't truncate
    expect(abbreviateNumber(999_499)).toBe('999K');
  });

  it('shows up to two decimals for M, trimming trailing zeros', () => {
    expect(abbreviateNumber(2_000_000)).toBe('2M');
    expect(abbreviateNumber(2_500_000)).toBe('2.5M');
    // 1.005 is stored as slightly under 1.005, so toFixed(2) gives "1.00" -> "1M".
    expect(abbreviateNumber(1_005_000)).toBe('1M');
  });

  it('extends the same scheme to billions for very large sums', () => {
    expect(abbreviateNumber(1_964_109_057)).toBe('1.96B');
    expect(abbreviateNumber(2_000_000_000)).toBe('2B');
  });

  it('preserves the sign for negative values', () => {
    expect(abbreviateNumber(-1_240_000)).toBe('-1.24M');
    expect(abbreviateNumber(-999)).toBe('-999');
  });

  it('never throws or divides oddly for non-finite input', () => {
    expect(abbreviateNumber(NaN)).toBe('0');
    expect(abbreviateNumber(Infinity)).toBe('0');
  });
});

describe('formatPercent', () => {
  it('renders an integer percent', () => {
    expect(formatPercent(52)).toBe('52%');
    expect(formatPercent(52.6)).toBe('53%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(100)).toBe('100%');
  });
});

describe('unitLabel', () => {
  it('maps every unit to its label, ratio to empty string', () => {
    expect(unitLabel('tokens')).toBe('tokens');
    expect(unitLabel('messages')).toBe('messages');
    expect(unitLabel('requests')).toBe('requests');
    expect(unitLabel('ratio')).toBe('');
  });
});

describe('formatFetchedAt', () => {
  it('formats as "YYYY-MM-DD HH:mm" (vitest.config.ts pins TZ=UTC for determinism)', () => {
    expect(formatFetchedAt('2026-09-06T14:03:00.000Z')).toBe('2026-09-06 14:03');
  });

  it('zero-pads single-digit month, day, hour, and minute', () => {
    expect(formatFetchedAt('2026-01-05T04:07:00.000Z')).toBe('2026-01-05 04:07');
  });
});
