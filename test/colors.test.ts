import pc from 'picocolors';
import { afterEach, describe, expect, it } from 'vitest';
import { createPalette, resolveColorEnabled, severityColor } from '../src/render/colors.js';

const ALL_COLOR_KEYS = ['text', 'dim', 'bold', 'accent', 'ok', 'warn', 'danger', 'track'] as const;

describe('createPalette', () => {
  it('returns identity functions for every color when disabled', () => {
    const palette = createPalette(false);
    expect(palette.enabled).toBe(false);
    for (const key of ALL_COLOR_KEYS) {
      expect(palette[key]('x')).toBe('x');
    }
  });

  it('wraps text with non-identity output for every color when enabled', () => {
    const palette = createPalette(true);
    expect(palette.enabled).toBe(true);
    for (const key of ALL_COLOR_KEYS) {
      const out = palette[key]('x');
      expect(out).not.toBe('x');
      expect(out).toContain('x');
    }
  });

  describe('with a truecolor-capable terminal', () => {
    const originalColorterm = process.env.COLORTERM;
    const originalTerm = process.env.TERM;

    afterEach(() => {
      process.env.COLORTERM = originalColorterm;
      process.env.TERM = originalTerm;
    });

    it('emits the exact 24-bit hex values of the palette', () => {
      process.env.COLORTERM = 'truecolor';
      const palette = createPalette(true);

      expect(palette.ok('x')).toBe('\x1b[38;2;74;222;128mx\x1b[39m'); // #4ADE80
      expect(palette.warn('x')).toBe('\x1b[38;2;251;191;36mx\x1b[39m'); // #FBBF24
      expect(palette.danger('x')).toBe('\x1b[38;2;248;113;113mx\x1b[39m'); // #F87171
      expect(palette.track('x')).toBe('\x1b[38;2;58;58;58mx\x1b[39m'); // #3A3A3A
      expect(palette.dim('x')).toBe('\x1b[38;2;138;138;138mx\x1b[39m'); // #8A8A8A
      expect(palette.text('x')).toBe('\x1b[38;2;230;230;230mx\x1b[39m'); // #E6E6E6
      // OpenAI green rather than ccusage's coral: bold + #10A37F
      expect(palette.accent('x')).toBe('\x1b[1m\x1b[38;2;16;163;127mx\x1b[39m\x1b[22m');
    });
  });

  describe('degrading on a legacy terminal', () => {
    const originalColorterm = process.env.COLORTERM;
    const originalTerm = process.env.TERM;

    afterEach(() => {
      process.env.COLORTERM = originalColorterm;
      process.env.TERM = originalTerm;
    });

    it('falls back to 16-color ANSI on the Linux virtual console', () => {
      delete process.env.COLORTERM;
      process.env.TERM = 'linux';
      const palette = createPalette(true);

      expect(palette.ok('x')).not.toContain('38;2;');
      expect(palette.danger('x')).not.toContain('38;2;');
      expect(palette.track('x')).not.toContain('38;2;');
      expect(palette.accent('x')).not.toContain('38;2;');
    });
  });
});

describe('severityColor', () => {
  const palette = createPalette(true);

  it('is green under 60%', () => {
    expect(severityColor(palette, 0)).toBe(palette.ok);
    expect(severityColor(palette, 59)).toBe(palette.ok);
  });

  it('is amber from 60% to 84%', () => {
    expect(severityColor(palette, 60)).toBe(palette.warn);
    expect(severityColor(palette, 84)).toBe(palette.warn);
  });

  it('is red from 85% to 100%', () => {
    expect(severityColor(palette, 85)).toBe(palette.danger);
    expect(severityColor(palette, 100)).toBe(palette.danger);
  });
});

describe('resolveColorEnabled', () => {
  it('is always false when --no-color is passed, regardless of terminal support', () => {
    expect(resolveColorEnabled(true)).toBe(false);
  });

  it('otherwise defers to picocolors (NO_COLOR / FORCE_COLOR / TTY detection)', () => {
    expect(resolveColorEnabled(false)).toBe(pc.isColorSupported);
  });
});
