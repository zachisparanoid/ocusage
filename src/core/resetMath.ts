/**
 * Pure time math for "when does this window reset" and "how old is this
 * snapshot". Kept free of any rendering/color concerns so it can be unit
 * tested without a TTY, and free of `Date.now()` defaults baked into call
 * sites so tests can pin `now`.
 */

/** Largest-two-units duration, e.g. "3d 4h", "18h 42m", "54m", "< 1m". */
export function formatDurationTwoUnits(ms: number): string {
  if (ms < 60_000) return '< 1m';

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Renders the full reset phrase for a window's detail line:
 *  - null resetsAt            -> "resets: unknown"
 *  - malformed or past resets -> "resetting…"
 *  - future resets            -> "resets in 3d 4h"
 */
export function formatResetPhrase(resetsAt: string | null, now: number = Date.now()): string {
  if (resetsAt === null) return 'resets: unknown';

  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return 'resetting…';

  const remainingMs = target - now;
  if (remainingMs <= 0) return 'resetting…';

  return `resets in ${formatDurationTwoUnits(remainingMs)}`;
}

/**
 * "12m ago" / "1h 50m ago" for a local snapshot's timestamp. A timestamp
 * slightly in the future (clock skew between the machine and the server
 * that stamped the rollout) reads as "< 1m ago" rather than a negative age.
 */
export function formatAgePhrase(asOf: string, now: number = Date.now()): string {
  const recorded = Date.parse(asOf);
  if (Number.isNaN(recorded)) return 'unknown';
  return `${formatDurationTwoUnits(Math.max(0, now - recorded))} ago`;
}
