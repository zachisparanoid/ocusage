import { formatResetPhrase } from '../core/resetMath.js';
import { WINDOW_IDS } from '../types.js';
import type { UsageCredits, UsageReport, UsageWindow } from '../types.js';
import { renderBar } from './bar.js';
import { createPalette, severityColor } from './colors.js';
import type { Palette } from './colors.js';
import { abbreviateNumber, formatFetchedAt, formatPercent, unitLabel } from './format.js';

export interface DashboardOptions {
  colorEnabled: boolean;
  /** process.stdout.columns; undefined (piped/non-TTY) falls back to 80. */
  columns?: number;
}

const TITLE = 'Codex · usage';
const GUTTER = '  ';
const HEADER_GAP = '          '; // 10 spaces between identity and "fetched …"
const MIN_BAR_WIDTH = 24;
const MAX_BAR_WIDTH = 44;
const NARROW_BAR_WIDTH = 12;
const NARROW_THRESHOLD = 40;
const COMPACT_BAR_WIDTH = 10;
const DEFAULT_COLUMNS = 80;
const NO_WINDOWS_MESSAGE = 'No usage windows available.';

const COMPACT_NAMES: Record<string, string> = {
  [WINDOW_IDS.session]: '5-hour',
  [WINDOW_IDS.weekAll]: 'weekly',
  code_review_5h: 'review-5h',
  code_review_week: 'review-wk',
};

/**
 * The default view: header, one block per window (label, bar, percent,
 * detail), warnings. Pure — every input (color, width, "now") is passed
 * in, so this is fully snapshot-testable without a TTY.
 */
export function renderDashboard(report: UsageReport, opts: DashboardOptions): string {
  const palette = createPalette(opts.colorEnabled);
  const columns = opts.columns ?? DEFAULT_COLUMNS;
  const nowMs = parseFetchedAt(report.fetchedAt);

  const lines: string[] = [...renderHeader(report, palette), ''];

  report.windows.forEach((w, idx) => {
    lines.push(...renderWindowBlock(w, palette, columns, nowMs));
    if (idx < report.windows.length - 1) lines.push('');
  });

  if (report.windows.length === 0) {
    lines.push(`${GUTTER}${palette.dim(NO_WINDOWS_MESSAGE)}`);
  }

  appendWarnings(lines, report.warnings, palette, true);

  return lines.join('\n');
}

/** `--compact`: one line per window, no header, no box — built for embedding. */
export function renderCompactDashboard(report: UsageReport, opts: DashboardOptions): string {
  const palette = createPalette(opts.colorEnabled);
  const nowMs = parseFetchedAt(report.fetchedAt);

  const lines = report.windows.map((w) => renderCompactLine(w, palette, nowMs));

  if (report.windows.length === 0) {
    lines.push(palette.dim(NO_WINDOWS_MESSAGE));
  }

  appendWarnings(lines, report.warnings, palette, false);

  return lines.join('\n');
}

function parseFetchedAt(fetchedAt: string): number {
  const ms = Date.parse(fetchedAt);
  return Number.isNaN(ms) ? Date.now() : ms;
}

function renderHeader(report: UsageReport, palette: Palette): string[] {
  const title = palette.accent(TITLE);
  const { email, plan } = report.account;

  const parts = [email, plan, creditsPhrase(report.credits)].filter(
    (part): part is string => part !== null,
  );
  if (parts.length === 0) {
    return [`${GUTTER}${title}`];
  }

  const identity = parts.join(' · ');
  const fetched = `fetched ${formatFetchedAt(report.fetchedAt)}`;
  return [
    `${GUTTER}${title}`,
    `${GUTTER}${palette.text(identity)}${HEADER_GAP}${palette.dim(fetched)}`,
  ];
}

/** Only worth a mention when the account actually has credits to draw on. */
function creditsPhrase(credits: UsageCredits | null): string | null {
  if (!credits) return null;
  if (credits.unlimited) return 'unlimited credits';
  if (!credits.hasCredits) return null;
  return credits.balance !== null ? `credits ${credits.balance}` : 'credits available';
}

function renderWindowBlock(
  w: UsageWindow,
  palette: Palette,
  columns: number,
  nowMs: number,
): string[] {
  const narrow = columns < NARROW_THRESHOLD;
  const barWidth = narrow
    ? NARROW_BAR_WIDTH
    : clamp(Math.round(columns * 0.35), MIN_BAR_WIDTH, MAX_BAR_WIDTH);

  const fillColor = severityColor(palette, w.percentUsed);
  const bar = renderBar(w.percentUsed, barWidth, fillColor, palette.track);
  const percentText = palette.bold(fillColor(formatPercent(w.percentUsed).padStart(4)));
  const detail = palette.dim(windowDetailText(w, nowMs));

  const labelLine = `${GUTTER}${palette.text(w.label)}`;

  if (narrow) {
    return [labelLine, `${GUTTER}${bar}  ${percentText}`, `${GUTTER}  ${detail}`];
  }
  return [labelLine, `${GUTTER}${bar}  ${percentText}      ${detail}`];
}

function renderCompactLine(w: UsageWindow, palette: Palette, nowMs: number): string {
  const fillColor = severityColor(palette, w.percentUsed);
  const bar = renderBar(w.percentUsed, COMPACT_BAR_WIDTH, fillColor, palette.track);
  const name = compactName(w).padEnd(12);
  const percent = palette.bold(fillColor(formatPercent(w.percentUsed)));
  const reset = palette.dim(formatResetPhrase(w.resetsAt, nowMs));
  return `${name}${bar} ${percent}  ${reset}`;
}

/**
 * used/limit fraction when a real limit is known; for ratio-unit windows
 * (the live service, cap unknown to us) the percent already IS the
 * measurement, so the reset phrase plus — when local logs had anything to
 * say — a "~1.2M tokens" scale hint; otherwise a bare "(estimated)" count.
 */
function windowDetailText(w: UsageWindow, nowMs: number): string {
  const resetPhrase = formatResetPhrase(w.resetsAt, nowMs);

  if (w.limit !== null) {
    return `${abbreviateNumber(w.used)} / ${abbreviateNumber(w.limit)} ${unitLabel(w.unit)} · ${resetPhrase}`;
  }
  if (w.unit === 'ratio') {
    const hint = w.localTokens !== null ? ` · ~${abbreviateNumber(w.localTokens)} tokens` : '';
    return `${resetPhrase}${hint}`;
  }
  const estimatedSuffix = w.estimated ? ' (estimated)' : '';
  return `${abbreviateNumber(w.used)} ${unitLabel(w.unit)}${estimatedSuffix} · ${resetPhrase}`;
}

function compactName(w: UsageWindow): string {
  return (
    COMPACT_NAMES[w.id] ??
    w.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 12)
  );
}

function appendWarnings(
  lines: string[],
  warnings: string[],
  palette: Palette,
  withGutter: boolean,
): void {
  if (warnings.length === 0) return;
  if (withGutter) lines.push('');
  for (const warning of warnings) {
    const prefix = withGutter ? GUTTER : '';
    lines.push(`${prefix}${palette.warn('⚠')} ${palette.dim(warning)}`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
