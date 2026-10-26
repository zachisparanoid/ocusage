import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Dirent } from 'node:fs';
import { WINDOW_IDS } from '../types.js';
import type { RawUsageData, RawWindow, UsageCredits, WindowId } from '../types.js';
import { planLabel } from './credentials.js';
import { finiteNumber, firstString, isRecord, numberAt, readCredits } from './parse.js';
import { getSessionsDir } from './paths.js';
import { formatAgePhrase } from './resetMath.js';
import {
  FIVE_HOURS_SEC,
  mainWindowId,
  mainWindowLabel,
  ONE_WEEK_SEC,
  windowShort,
} from './windows.js';

/** Nothing shorter than the weekly window needs older events than this. */
export const LOOKBACK_MS = ONE_WEEK_SEC * 1000;

// Files at or under this size are read whole (as a Buffer, never decoded to
// a JS string in full — see accumulateWholeFile) instead of via
// createReadStream/readline. Purely a memory-safety ceiling against a
// pathological single file: real rollouts top out around 7MB, and the
// whole-file Buffer approach is several times faster than line streaming
// because the streaming cost is per-line setup overhead, not disk I/O.
export const STREAM_THRESHOLD_BYTES = 20 * 1024 * 1024;

const NEWLINE_BYTE = 10; // '\n'
// Only `token_count` events carry usage and rate-limit snapshots; every other
// line type (response_item, turn_context, token_usage_record, …) is skipped
// before it is ever decoded or parsed.
const TOKEN_COUNT_NEEDLE = Buffer.from('"token_count"');

export const LOCAL_ESTIMATE_WARNING =
  'Live usage unavailable — showing estimate from local session logs (limits unknown).';
export const LOCAL_SNAPSHOT_WARNING =
  'Live usage unavailable — showing the last usage snapshot Codex saved locally';

export interface SnapshotWindow {
  usedPercent: number;
  windowSeconds: number | null;
  resetsAtMs: number | null;
}

/**
 * The `rate_limits` object Codex writes on every `token_count` event: the
 * server's answer at that moment. Shape has been stable since 0.137.0
 * (`primary`/`secondary` with `used_percent`, `window_minutes`, `resets_at`
 * in epoch seconds); a pre-0.137 `resets_in_seconds` form is tolerated.
 */
export interface RateLimitSnapshot {
  timestampMs: number;
  planType: string | null;
  credits: UsageCredits | null;
  primary: SnapshotWindow | null;
  secondary: SnapshotWindow | null;
}

export interface TokenEvent {
  timestampMs: number;
  tokens: number;
}

export interface RolloutScan {
  /** Newest snapshot by event timestamp across every scanned file. */
  snapshot: RateLimitSnapshot | null;
  /** Per-event token increments inside the lookback window, oldest first. */
  events: TokenEvent[];
  unreadableFiles: number;
}

export interface LocalSourceOptions {
  codexHome?: string;
  now?: number;
}

interface Accumulator {
  snapshot: RateLimitSnapshot | null;
  events: TokenEvent[];
  unreadableFiles: number;
}

/**
 * Per-file parse state. `total_token_usage.total_tokens` is a running
 * total for the thread; the same total is re-emitted on some events
 * (observed 1–11 duplicates per file), so tokens are counted as the delta
 * between consecutive totals — a duplicate contributes 0 — instead of by
 * summing `last_token_usage`, which over-counts by up to ~5%.
 */
interface FileContext {
  prevTotal: number | null;
}

/** One pass over every rollout touched inside the lookback window. */
export async function scanRollouts(opts: LocalSourceOptions = {}): Promise<RolloutScan> {
  const now = opts.now ?? Date.now();
  const cutoff = now - LOOKBACK_MS;

  const allFiles = await findJsonlFiles(getSessionsDir(opts.codexHome));
  const relevantFiles = await filterByMtime(allFiles, cutoff);

  const acc: Accumulator = { snapshot: null, events: [], unreadableFiles: 0 };
  await accumulateFiles(relevantFiles, cutoff, acc);
  acc.events.sort((a, b) => a.timestampMs - b.timestampMs);

  return { snapshot: acc.snapshot, events: acc.events, unreadableFiles: acc.unreadableFiles };
}

export function sumTokensSince(events: TokenEvent[], startMs: number): number {
  let sum = 0;
  for (const event of events) {
    if (event.timestampMs >= startMs) sum += event.tokens;
  }
  return sum;
}

/**
 * The local fallback. Unlike a transcript-only estimate, Codex's rollouts
 * embed the server's own percentages, so when a snapshot exists the windows
 * carry real (if possibly stale) percentages, marked `estimated: true` and
 * dated in the warning. Without any snapshot this degrades to trailing
 * 5h / 7d token counts with no percentage, exactly like ccusage.
 */
export async function collectLocalUsage(opts: LocalSourceOptions = {}): Promise<RawUsageData> {
  const now = opts.now ?? Date.now();
  const scan = await scanRollouts({ codexHome: opts.codexHome, now });
  const warnings: string[] = [];

  if (scan.unreadableFiles > 0) {
    warnings.push(
      `Could not read ${scan.unreadableFiles} session log file${scan.unreadableFiles === 1 ? '' : 's'}; they were skipped.`,
    );
  }

  if (scan.snapshot) {
    const snapshot = scan.snapshot;
    const asOf = new Date(snapshot.timestampMs).toISOString();
    const windows: RawWindow[] = [];
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (window) windows.push(snapshotWindow(window, now, scan.events, warnings));
    }
    warnings.unshift(`${LOCAL_SNAPSHOT_WARNING} (${formatAgePhrase(asOf, now)}).`);
    return {
      source: 'local',
      account: { email: null, plan: planLabel(snapshot.planType) },
      credits: snapshot.credits,
      windows,
      warnings,
      asOf,
    };
  }

  if (scan.events.length > 0) {
    warnings.unshift(LOCAL_ESTIMATE_WARNING);
    const windows: RawWindow[] = [
      tokenWindow(
        WINDOW_IDS.session,
        FIVE_HOURS_SEC,
        sumTokensSince(scan.events, now - FIVE_HOURS_SEC * 1000),
      ),
      tokenWindow(WINDOW_IDS.weekAll, ONE_WEEK_SEC, sumTokensSince(scan.events, now - LOOKBACK_MS)),
    ];
    return {
      source: 'local',
      account: { email: null, plan: null },
      credits: null,
      windows,
      warnings,
      asOf: null,
    };
  }

  return {
    source: 'local',
    account: { email: null, plan: null },
    credits: null,
    windows: [],
    warnings,
    asOf: null,
  };
}

function snapshotWindow(
  window: SnapshotWindow,
  now: number,
  events: TokenEvent[],
  warnings: string[],
): RawWindow {
  const seconds = window.windowSeconds;
  const resetsAtMs = window.resetsAtMs;
  const stillOpen = resetsAtMs !== null && resetsAtMs > now;
  const resetSinceSnapshot = resetsAtMs !== null && !stillOpen;

  if (resetSinceSnapshot) {
    warnings.push(
      `The ${windowShort(seconds)} window has reset since Codex last recorded usage — run Codex to refresh.`,
    );
  }

  // Tokens since the current window opened: the snapshot's reset time minus
  // the window length while it is still open, or everything since the reset
  // once it has passed (the start of whatever window comes next).
  let start: number | null = null;
  if (stillOpen && seconds !== null) start = resetsAtMs - seconds * 1000;
  else if (resetSinceSnapshot) start = resetsAtMs;
  const localTokens =
    start === null || start < now - LOOKBACK_MS ? null : sumTokensSince(events, start);

  return {
    id: mainWindowId(seconds),
    label: mainWindowLabel(seconds),
    used: 0,
    limit: null,
    unit: 'ratio',
    percentUsed: resetSinceSnapshot ? 0 : window.usedPercent,
    resetsAt: stillOpen ? new Date(resetsAtMs).toISOString() : null,
    windowSeconds: seconds,
    localTokens,
    estimated: true,
  };
}

function tokenWindow(id: WindowId, seconds: number, used: number): RawWindow {
  return {
    id,
    label: mainWindowLabel(seconds),
    used,
    limit: null,
    unit: 'tokens',
    resetsAt: null,
    windowSeconds: seconds,
    estimated: true,
  };
}

async function findJsonlFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable directory — nothing to scan, not an error
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }

  await walk(rootDir);
  return results;
}

interface FileCandidate {
  path: string;
  /** Infinity when stat() itself failed, so the file still gets attempted
   *  (and its failure counted) via the streaming path below. */
  size: number;
}

/**
 * Rollouts are append-only, so a file's mtime is always >= the timestamp
 * of its last written line. Skipping files last touched before the cutoff
 * avoids reading logs that cannot possibly contain in-window activity. The
 * size captured here is reused to pick a read strategy without a second
 * stat() per file.
 */
async function filterByMtime(files: string[], cutoffMs: number): Promise<FileCandidate[]> {
  const checked = await Promise.all(
    files.map(async (file): Promise<FileCandidate | null> => {
      try {
        const info = await stat(file);
        return info.mtimeMs >= cutoffMs ? { path: file, size: info.size } : null;
      } catch {
        return { path: file, size: Infinity }; // let the read step surface/report the failure
      }
    }),
  );
  return checked.filter((f): f is FileCandidate => f !== null);
}

// Bounded concurrency across files: lets one file's disk I/O overlap with
// another file's parsing without opening everything at once.
const FILE_CONCURRENCY = 8;

async function accumulateFiles(
  files: FileCandidate[],
  cutoffMs: number,
  acc: Accumulator,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= files.length) return;
      await accumulateFile(files[i]!, cutoffMs, acc);
    }
  }
  const workerCount = Math.min(FILE_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function accumulateFile(
  file: FileCandidate,
  cutoffMs: number,
  acc: Accumulator,
): Promise<void> {
  const ctx: FileContext = { prevTotal: null };
  if (file.size <= STREAM_THRESHOLD_BYTES) {
    await accumulateWholeFile(file.path, cutoffMs, acc, ctx);
  } else {
    await accumulateFileStreaming(file.path, cutoffMs, acc, ctx);
  }
}

/**
 * Reads the whole file as a raw Buffer and finds line boundaries with
 * Buffer#indexOf (native code). Each line is only UTF-8 decoded if a cheap
 * byte-level search finds `"token_count"` in it first — the vast majority
 * of rollout bytes are tool output and reasoning, which never match.
 */
async function accumulateWholeFile(
  filePath: string,
  cutoffMs: number,
  acc: Accumulator,
  ctx: FileContext,
): Promise<void> {
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch {
    acc.unreadableFiles += 1;
    return;
  }

  let start = 0;
  let newlineIndex: number;
  while ((newlineIndex = buf.indexOf(NEWLINE_BYTE, start)) !== -1) {
    processBufferLine(buf, start, newlineIndex, cutoffMs, acc, ctx);
    start = newlineIndex + 1;
  }
  if (start < buf.length) {
    processBufferLine(buf, start, buf.length, cutoffMs, acc, ctx);
  }
}

function processBufferLine(
  buf: Buffer,
  start: number,
  end: number,
  cutoffMs: number,
  acc: Accumulator,
  ctx: FileContext,
): void {
  if (end <= start) return; // empty line
  const lineBuf = buf.subarray(start, end);
  if (lineBuf.indexOf(TOKEN_COUNT_NEEDLE) === -1) return;
  processLine(lineBuf.toString('utf8'), cutoffMs, acc, ctx);
}

/** True line-by-line streaming, never holding the whole file in memory —
 *  reserved for the rare file above STREAM_THRESHOLD_BYTES. */
async function accumulateFileStreaming(
  filePath: string,
  cutoffMs: number,
  acc: Accumulator,
  ctx: FileContext,
): Promise<void> {
  try {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.includes('"token_count"')) processLine(line, cutoffMs, acc, ctx);
    }
  } catch {
    acc.unreadableFiles += 1;
  }
}

function processLine(line: string, cutoffMs: number, acc: Accumulator, ctx: FileContext): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // corrupt line — skip silently
  }
  if (!isRecord(parsed) || parsed.type !== 'event_msg') return;
  const payload = parsed.payload;
  if (!isRecord(payload) || payload.type !== 'token_count') return;

  const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
  if (Number.isNaN(ts)) return;

  const info = payload.info;
  if (isRecord(info)) {
    const total = numberAt(info.total_token_usage, 'total_tokens');
    let delta: number | null;
    if (total !== null) {
      // A total that goes backwards means the counter restarted (resumed
      // thread); the new total is then the whole fresh series so far.
      delta = ctx.prevTotal === null || total < ctx.prevTotal ? total : total - ctx.prevTotal;
      ctx.prevTotal = total;
    } else {
      delta = numberAt(info.last_token_usage, 'total_tokens');
    }
    if (delta !== null && delta > 0 && ts >= cutoffMs) {
      acc.events.push({ timestampMs: ts, tokens: delta });
    }
  }

  const rateLimits = payload.rate_limits;
  if (isRecord(rateLimits) && (acc.snapshot === null || ts > acc.snapshot.timestampMs)) {
    const snapshot = readSnapshot(rateLimits, ts);
    if (snapshot) acc.snapshot = snapshot;
  }
}

function readSnapshot(
  rateLimits: Record<string, unknown>,
  timestampMs: number,
): RateLimitSnapshot | null {
  const primary = readSnapshotWindow(rateLimits.primary, timestampMs);
  const secondary = readSnapshotWindow(rateLimits.secondary, timestampMs);
  if (!primary && !secondary) return null;
  return {
    timestampMs,
    planType: firstString(rateLimits.plan_type),
    credits: readCredits(rateLimits.credits),
    primary,
    secondary,
  };
}

function readSnapshotWindow(value: unknown, eventTimestampMs: number): SnapshotWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = finiteNumber(value.used_percent);
  if (usedPercent === null) return null;

  const windowMinutes = finiteNumber(value.window_minutes);
  const windowSeconds =
    windowMinutes !== null ? windowMinutes * 60 : finiteNumber(value.limit_window_seconds);

  let resetsAtMs: number | null = null;
  const resetsAt = value.resets_at ?? value.reset_at;
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
    resetsAtMs = resetsAt * 1000;
  } else if (typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt))) {
    resetsAtMs = Date.parse(resetsAt);
  } else {
    const relative = finiteNumber(value.resets_in_seconds ?? value.reset_after_seconds);
    if (relative !== null) resetsAtMs = eventTimestampMs + relative * 1000;
  }

  return { usedPercent, windowSeconds, resetsAtMs };
}
