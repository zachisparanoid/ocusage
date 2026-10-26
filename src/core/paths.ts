import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves the Codex home directory. Honors CODEX_HOME when set (the same
 * override the `codex` binary itself reads — confirmed via `strings` on the
 * native binary), otherwise defaults to `~/.codex` via os.homedir() so this
 * is correct on Windows (%USERPROFILE%\.codex), Linux, and macOS without
 * ever hardcoding a path separator.
 */
export function getCodexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), '.codex');
}

/** Codex's credential store: ChatGPT OAuth tokens or an API key. */
export function getAuthPath(codexHome: string = getCodexHome()): string {
  return join(codexHome, 'auth.json');
}

/** Root of the `sessions/YYYY/MM/DD/rollout-*.jsonl` transcript tree. */
export function getSessionsDir(codexHome: string = getCodexHome()): string {
  return join(codexHome, 'sessions');
}
