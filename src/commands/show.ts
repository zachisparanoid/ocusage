import { getUsageReport } from '../core/usageSource.js';
import { createPalette, resolveColorEnabled } from '../render/colors.js';
import { renderCompactDashboard, renderDashboard } from '../render/dashboard.js';
import type { CliOptions, UsageReport } from '../types.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const CLEAR_LINE = '\r\x1b[2K';

interface Spinner {
  stop: () => void;
}

/** Default command: resolve usage data, render the dashboard once, print it. */
export async function runShow(options: CliOptions): Promise<void> {
  const colorEnabled = resolveColorEnabled(options.noColor);
  const spinner = process.stdout.isTTY ? startSpinner(colorEnabled) : null;

  let report: UsageReport;
  try {
    report = await getUsageReport({ source: options.source });
  } finally {
    spinner?.stop();
  }

  const columns = process.stdout.columns;
  const body = options.compact
    ? renderCompactDashboard(report, { colorEnabled, columns })
    : renderDashboard(report, { colorEnabled, columns });

  process.stdout.write(`${body}\n`);
}

function startSpinner(colorEnabled: boolean): Spinner {
  const dim = createPalette(colorEnabled).dim;
  let frame = 0;

  const paint = (): void => {
    process.stderr.write(
      `\r${dim(`${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} reading usage…`)}`,
    );
    frame += 1;
  };

  paint();
  const timer = setInterval(paint, SPINNER_INTERVAL_MS);
  timer.unref(); // never keep the process alive on its own

  return {
    stop: () => {
      clearInterval(timer);
      process.stderr.write(CLEAR_LINE);
    },
  };
}
