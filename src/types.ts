/**
 * Canonical shapes shared by every data source, the normalizer, and the
 * renderer. `apiSource.ts` and `localSource.ts` both produce raw,
 * source-specific data; `normalize.ts` is the only place allowed to turn
 * that raw data into a `UsageReport`. Nothing downstream of normalize.ts
 * should need to know whether a number came from the network or a log file.
 *
 * Deliberately the same contract as ccusage's (plus `windowSeconds`,
 * `localTokens`, `credits`, `asOf`) so a status-bar script can read both
 * tools' `--json` with one code path.
 */

/** Stable identifiers for the windows ocusage always tries to surface. */
export const WINDOW_IDS = {
  /** Codex's `primary_window`: the rolling 5-hour allowance. */
  session: 'session_5h',
  /** Codex's `secondary_window`: the weekly allowance (all models). */
  weekAll: 'week_all',
} as const;

export type WindowId = (typeof WINDOW_IDS)[keyof typeof WINDOW_IDS] | (string & {});

export type UsageUnit = 'tokens' | 'messages' | 'requests' | 'ratio';

export type DataSourceKind = 'api' | 'local';

/** A single usage limit window (e.g. "the current 5-hour window"). */
export interface UsageWindow {
  /** Stable key: "session_5h" | "week_all" | others. */
  id: WindowId;
  /** Human label, e.g. "Current 5-hour window". */
  label: string;
  /** Consumed units in this window (see `unit`). */
  used: number;
  /** Cap for this window; null = unknown/unmetered (always null for Codex — OpenAI only exposes percentages). */
  limit: number | null;
  unit: UsageUnit;
  /** 0..100, clamped; computed if limit known, else derived/0. */
  percentUsed: number;
  /** ISO 8601 timestamp when this window resets; null if unknown. */
  resetsAt: string | null;
  /** Length of the window in seconds (18000 for 5h, 604800 for a week); null if unknown. */
  windowSeconds: number | null;
  /** Tokens counted from local session logs inside this window — a best-effort scale hint, null when unavailable. */
  localTokens: number | null;
  /** Where these numbers came from. */
  source: DataSourceKind;
  /** True when derived from local logs (not authoritative). */
  estimated: boolean;
}

export interface UsageAccount {
  /** Best-effort from the usage service or the login token; null if unavailable. */
  email: string | null;
  /** "Plus" | "Pro" | "Team" | "Business" | "Enterprise" | null. */
  plan: string | null;
}

/** Prepaid credits attached to the account, as the usage service reports them. */
export interface UsageCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Reported as a string by the service (e.g. "0", "12.50"); null if absent. */
  balance: string | null;
}

export interface UsageReport {
  account: UsageAccount;
  credits: UsageCredits | null;
  /** MUST contain session_5h and week_all when available. */
  windows: UsageWindow[];
  /** ISO timestamp of this run. */
  fetchedAt: string;
  /** ISO timestamp the numbers reflect: the run time for live data, the snapshot time for a local fallback. */
  asOf: string;
  source: DataSourceKind | 'mixed';
  /** Non-fatal notes surfaced to the user (dimmed). */
  warnings: string[];
}

export type SourceMode = 'auto' | 'api' | 'local';

export interface CliOptions {
  /** Machine-readable output. */
  json: boolean;
  /** Repaint on interval. */
  watch: boolean;
  /** Default 60, min 5. */
  intervalSec: number;
  /** Force plain output. */
  noColor: boolean;
  /** One-line-per-window, no big header. */
  compact: boolean;
  /** Force a source; default auto. */
  source: SourceMode;
}

/** ChatGPT OAuth credentials resolved from Codex's local `auth.json`. */
export interface ResolvedCredentials {
  accessToken: string;
  /** ChatGPT account id (workspace) sent as a request header; null if unknown. */
  accountId: string | null;
  /** Epoch ms (converted from the JWT's `exp` seconds); null if the token isn't a readable JWT. */
  expiresAt: number | null;
  /** Raw plan code from the token claims, e.g. "plus"; null if unknown. */
  planType: string | null;
  email: string | null;
  displayName: string | null;
  /** `auth_mode` from auth.json ("chatgpt", "apikey", …); null if absent. */
  authMode: string | null;
  filePath: string;
}

/** Raw window data a source produces before normalize.ts touches it. */
export interface RawWindow {
  id: WindowId;
  label: string;
  used: number;
  limit: number | null;
  unit: UsageUnit;
  /** Pre-computed 0..100 percent, when the source already knows it (ratio unit). */
  percentUsed?: number;
  resetsAt: string | null;
  windowSeconds: number | null;
  localTokens?: number | null;
  estimated: boolean;
}

/** Raw payload either data source hands to normalize.ts. */
export interface RawUsageData {
  source: DataSourceKind;
  account: UsageAccount;
  credits: UsageCredits | null;
  windows: RawWindow[];
  warnings: string[];
  /** When the numbers were recorded, if that differs from "now" (local snapshots); null otherwise. */
  asOf: string | null;
}
