import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAuthPath, getCodexHome, getSessionsDir } from '../src/core/paths.js';

describe('getCodexHome', () => {
  const original = process.env.CODEX_HOME;

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  });

  it('defaults to ~/.codex resolved via os.homedir()', () => {
    delete process.env.CODEX_HOME;
    expect(getCodexHome()).toBe(join(homedir(), '.codex'));
  });

  it('honors CODEX_HOME, the same override Codex itself reads', () => {
    process.env.CODEX_HOME = '/custom/codex-home';
    expect(getCodexHome()).toBe('/custom/codex-home');
  });

  it('ignores a blank CODEX_HOME', () => {
    process.env.CODEX_HOME = '   ';
    expect(getCodexHome()).toBe(join(homedir(), '.codex'));
  });
});

describe('derived paths', () => {
  it('locates auth.json directly under the Codex home', () => {
    expect(getAuthPath('/x')).toBe(join('/x', 'auth.json'));
  });

  it('locates the session rollout tree under sessions/', () => {
    expect(getSessionsDir('/x')).toBe(join('/x', 'sessions'));
  });
});
