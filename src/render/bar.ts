import type { ColorFn } from './colors.js';

export interface BarGlyphs {
  fill: string;
  track: string;
}

const UNICODE_GLYPHS: BarGlyphs = { fill: '█', track: '░' };
const ASCII_GLYPHS: BarGlyphs = { fill: '#', track: '-' };

/**
 * Unicode blocks by default — only a genuinely legacy terminal (TERM=dumb)
 * falls back to plain ASCII. Color support and TTY-ness are separate
 * concerns handled by colors.ts and don't affect glyph choice.
 */
export function resolveBarGlyphs(term: string | undefined = process.env.TERM): BarGlyphs {
  return term === 'dumb' ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

const IDENTITY: ColorFn = (s) => s;

/**
 * Pure: (percentUsed, width, fillColor) -> a bar string. `trackColor` and
 * `glyphs` are optional so callers that don't care about styling (tests,
 * plain output) can omit them and get an uncolored bar.
 */
export function renderBar(
  percentUsed: number,
  width: number,
  fillColor: ColorFn,
  trackColor: ColorFn = IDENTITY,
  glyphs: BarGlyphs = resolveBarGlyphs(),
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const clamped = Math.min(100, Math.max(0, percentUsed));
  const filledCount = safeWidth === 0 ? 0 : Math.round((clamped / 100) * safeWidth);
  const emptyCount = safeWidth - filledCount;

  const filled = filledCount > 0 ? fillColor(glyphs.fill.repeat(filledCount)) : '';
  const empty = emptyCount > 0 ? trackColor(glyphs.track.repeat(emptyCount)) : '';
  return filled + empty;
}
