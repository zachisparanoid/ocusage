import pc from 'picocolors';

export type ColorFn = (s: string) => string;

export interface Palette {
  enabled: boolean;
  /** Soft white — labels/body text. */
  text: ColorFn;
  /** Gray — timestamps, units, footer, warning body text. */
  dim: ColorFn;
  bold: ColorFn;
  /** OpenAI green, bold — the "Codex · usage" title. */
  accent: ColorFn;
  /** Green — severity 0-59%. */
  ok: ColorFn;
  /** Amber — severity 60-84%, and the warning glyph. */
  warn: ColorFn;
  /** Red — severity 85-100%. */
  danger: ColorFn;
  /** Dark gray — the empty portion of a progress bar. */
  track: ColorFn;
}

const IDENTITY: ColorFn = (s) => s;

const PLAIN_PALETTE: Palette = {
  enabled: false,
  text: IDENTITY,
  dim: IDENTITY,
  bold: IDENTITY,
  accent: IDENTITY,
  ok: IDENTITY,
  warn: IDENTITY,
  danger: IDENTITY,
  track: IDENTITY,
};

/**
 * Resolves whether color should be used at all. Delegates the NO_COLOR /
 * FORCE_COLOR / TTY logic to picocolors itself and layers our own
 * `--no-color` flag on top, since picocolors has no notion of
 * application-level flags.
 */
export function resolveColorEnabled(cliNoColor: boolean): boolean {
  if (cliNoColor) return false;
  return pc.isColorSupported;
}

/**
 * True 24-bit color is what the hex palette calls for; picocolors itself
 * only exposes the 16-color ANSI set, so truecolor is a thin wrapper of
 * our own on top of picocolors' on/off + bold detection. Falls back to
 * picocolors' 16-color equivalents for terminals that plausibly can't
 * render 24-bit color (the Linux virtual console being the common
 * real-world case).
 */
function supportsTrueColor(): boolean {
  const colorterm = process.env.COLORTERM ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;
  if (process.env.TERM === 'linux') return false;
  return true;
}

function truecolor(hex: string): ColorFn {
  const { r, g, b } = hexToRgb(hex);
  const open = `\x1b[38;2;${r};${g};${b}m`;
  return (s: string) => (s === '' ? s : `${open}${s}\x1b[39m`);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function compose(outer: ColorFn, inner: ColorFn): ColorFn {
  return (s: string) => outer(inner(s));
}

export function createPalette(colorEnabled: boolean): Palette {
  if (!colorEnabled) return PLAIN_PALETTE;

  const truecolorOk = supportsTrueColor();
  // pc.bold/pc.gray/... are gated by picocolors' OWN ambient isColorSupported
  // check, independent of the `colorEnabled` this function was just told to
  // honor — so in any non-TTY process (every test runner, and real-world
  // piped-but-FORCE_COLOR'd usage) they silently no-op. createColors(true)
  // builds a colors object that unconditionally applies ANSI codes, making
  // `colorEnabled` the single source of truth instead of a second hidden gate.
  const forced = pc.createColors(true);

  return {
    enabled: true,
    text: truecolorOk ? truecolor('#E6E6E6') : IDENTITY,
    dim: truecolorOk ? truecolor('#8A8A8A') : forced.gray,
    bold: forced.bold,
    accent: truecolorOk
      ? compose(forced.bold, truecolor('#10A37F'))
      : compose(forced.bold, forced.cyan),
    ok: truecolorOk ? truecolor('#4ADE80') : forced.green,
    warn: truecolorOk ? truecolor('#FBBF24') : forced.yellow,
    danger: truecolorOk ? truecolor('#F87171') : forced.red,
    track: truecolorOk ? truecolor('#3A3A3A') : forced.gray,
  };
}

/** 0-59% green, 60-84% amber, 85-100% red. */
export function severityColor(palette: Palette, percentUsed: number): ColorFn {
  if (percentUsed >= 85) return palette.danger;
  if (percentUsed >= 60) return palette.warn;
  return palette.ok;
}
