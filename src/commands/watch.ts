import { getUsageReport } from '../core/usageSource.js';
import { createPalette, resolveColorEnabled } from '../render/colors.js';
import type { Palette } from '../render/colors.js';
import { renderCompactDashboard, renderDashboard } from '../render/dashboard.js';
import type { CliOptions, UsageReport } from '../types.js';

const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * `--watch`: repaints on an interval until Ctrl-C. A failed fetch on any
 * one frame is shown inline and retried next interval rather than killing
 * the session — a transient network blip shouldn't end a long-running
 * watch.
 */
export async function runWatch(options: CliOptions): Promise<void> {
  const colorEnabled = resolveColorEnabled(options.noColor);
  const palette = createPalette(colorEnabled);
  let stopped = false;

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    process.stdout.write(SHOW_CURSOR);
  };
  const onSignal = (): void => {
    cleanup();
    process.exit(0);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.stdout.write(HIDE_CURSOR);

  try {
    while (!stopped) {
      await paintFrame(options, colorEnabled, palette);
      if (stopped) break;
      await delay(options.intervalSec * 1000);
    }
  } finally {
    cleanup();
  }
}

async function paintFrame(
  options: CliOptions,
  colorEnabled: boolean,
  palette: Palette,
): Promise<void> {
  let report: UsageReport | null = null;
  let errorMessage: string | null = null;

  try {
    report = await getUsageReport({ source: options.source });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const columns = process.stdout.columns;
  const body = report
    ? options.compact
      ? renderCompactDashboard(report, { colorEnabled, columns })
      : renderDashboard(report, { colorEnabled, columns })
    : `  ${palette.warn('⚠')} ${palette.dim(errorMessage ?? 'Could not fetch usage.')}`;

  process.stdout.write(`${CLEAR_SCREEN}${body}\n\n${renderFooter(options.intervalSec, palette)}\n`);
}

function renderFooter(intervalSec: number, palette: Palette): string {
  const text = `↻ updated ${formatClockTime(new Date())} · refreshing every ${intervalSec}s · Ctrl-C to quit`;
  return `  ${palette.dim(text)}`;
}

function formatClockTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
