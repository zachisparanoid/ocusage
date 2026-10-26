import { describe, expect, it } from 'vitest';
import { renderBar, resolveBarGlyphs } from '../src/render/bar.js';

const identity = (s: string): string => s;
const angle = (s: string): string => `<${s}>`;
const brace = (s: string): string => `[${s}]`;

describe('resolveBarGlyphs', () => {
  it('uses unicode blocks by default', () => {
    expect(resolveBarGlyphs('xterm-256color')).toEqual({ fill: '█', track: '░' });
    expect(resolveBarGlyphs(undefined)).toEqual({ fill: '█', track: '░' });
  });

  it('falls back to ascii for TERM=dumb', () => {
    expect(resolveBarGlyphs('dumb')).toEqual({ fill: '#', track: '-' });
  });
});

describe('renderBar', () => {
  it('renders half-filled at 50% of a width-10 bar', () => {
    expect(renderBar(50, 10, identity)).toBe('█████░░░░░');
  });

  it('renders fully empty at 0%', () => {
    expect(renderBar(0, 10, identity)).toBe('░░░░░░░░░░');
  });

  it('renders fully filled at 100%', () => {
    expect(renderBar(100, 10, identity)).toBe('██████████');
  });

  it('clamps percentages above 100 to a full bar', () => {
    expect(renderBar(150, 10, identity)).toBe('██████████');
  });

  it('clamps negative percentages to an empty bar', () => {
    expect(renderBar(-20, 10, identity)).toBe('░░░░░░░░░░');
  });

  it('rounds the fill count to the nearest cell', () => {
    expect(renderBar(52, 25, identity)).toBe(`${'█'.repeat(13)}${'░'.repeat(12)}`);
  });

  it('returns an empty string for a zero-width bar', () => {
    expect(renderBar(50, 0, identity)).toBe('');
  });

  it('treats a negative width as zero', () => {
    expect(renderBar(50, -5, identity)).toBe('');
  });

  it('applies separate fill and track color functions', () => {
    expect(renderBar(50, 4, angle, brace)).toBe('<██>[░░]');
  });

  it('defaults the track color to identity when omitted', () => {
    expect(renderBar(50, 4, angle)).toBe('<██>░░');
  });

  it('uses the supplied glyph set', () => {
    expect(renderBar(50, 4, identity, identity, { fill: '#', track: '-' })).toBe('##--');
  });

  it('omits the color wrapper entirely for a zero-length segment', () => {
    const noisy = (s: string): string => (s.length > 0 ? `X${s}X` : 'SHOULD_NOT_APPEAR');
    expect(renderBar(0, 5, noisy)).not.toContain('SHOULD_NOT_APPEAR');
    expect(renderBar(100, 5, identity, noisy)).not.toContain('SHOULD_NOT_APPEAR');
  });
});
