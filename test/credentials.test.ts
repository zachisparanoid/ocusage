import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeJwtPayload,
  inspectAuthFile,
  isTokenExpired,
  loadCredentials,
  planLabel,
} from '../src/core/credentials.js';
import type { ResolvedCredentials } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'auth.sample.json');

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), 'ocusage-codexhome-'));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

async function writeAuth(content: unknown): Promise<void> {
  const raw = typeof content === 'string' ? content : JSON.stringify(content);
  await writeFile(join(codexHome, 'auth.json'), raw, 'utf8');
}

function b64u(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('decodeJwtPayload', () => {
  it('decodes the middle segment of a JWT without verifying it', () => {
    const token = `${b64u({ alg: 'none' })}.${b64u({ exp: 123, sub: 'x' })}.sig`;
    expect(decodeJwtPayload(token)).toEqual({ exp: 123, sub: 'x' });
  });

  it('handles base64url alphabet (- and _) and missing padding', () => {
    // "{\"a\":\"??>\"}" encodes with '/' and '+' in plain base64, '_' and '-' in base64url.
    const payload = { a: '??>', b: '~~~' };
    const token = `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
    expect(decodeJwtPayload(token)).toEqual(payload);
  });

  it('returns null for anything that is not a JWT', () => {
    expect(decodeJwtPayload('sk-not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('a.b')).toBeNull();
    expect(decodeJwtPayload(`a.${Buffer.from('not json').toString('base64url')}.c`)).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
});

describe('loadCredentials', () => {
  it('returns null when no auth.json exists', async () => {
    expect(await loadCredentials(codexHome)).toBeNull();
  });

  it('returns null when auth.json is not valid JSON', async () => {
    await writeAuth('{ definitely not json');
    expect(await loadCredentials(codexHome)).toBeNull();
  });

  it('returns null when only an API key is stored (no ChatGPT tokens)', async () => {
    await writeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture', tokens: null });
    expect(await loadCredentials(codexHome)).toBeNull();
  });

  it('returns null when tokens exist but carry no access token', async () => {
    await writeAuth({ auth_mode: 'chatgpt', tokens: { id_token: 'x', account_id: 'y' } });
    expect(await loadCredentials(codexHome)).toBeNull();
  });

  it('reads the token, expiry, plan, account and identity from the real-shape fixture', async () => {
    await writeAuth(await readFile(FIXTURE, 'utf8'));

    const creds = await loadCredentials(codexHome);
    expect(creds).not.toBeNull();
    expect(creds!.accessToken.split('.')).toHaveLength(3);
    // JWT exp is epoch seconds; ocusage keeps ms everywhere else.
    expect(creds!.expiresAt).toBe(4102444800000);
    expect(creds!.planType).toBe('plus');
    expect(creds!.accountId).toBe('acct-fixture-uuid');
    expect(creds!.email).toBe('you@example.com');
    expect(creds!.displayName).toBe('Example User'); // only the id_token carries `name`
    expect(creds!.authMode).toBe('chatgpt');
    expect(creds!.filePath).toBe(join(codexHome, 'auth.json'));
  });

  it('still returns usable credentials when the access token is opaque (not a JWT)', async () => {
    await writeAuth({ auth_mode: 'chatgpt', tokens: { access_token: 'opaque-token' } });
    const creds = await loadCredentials(codexHome);
    expect(creds!.accessToken).toBe('opaque-token');
    expect(creds!.expiresAt).toBeNull();
    expect(creds!.planType).toBeNull();
    expect(creds!.email).toBeNull();
    expect(creds!.accountId).toBeNull();
  });

  it('falls back to id_token claims for email and plan when the access token lacks them', async () => {
    const idToken = `h.${b64u({
      email: 'from-id@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-id' },
    })}.s`;
    const accessToken = `h.${b64u({ exp: 4102444800 })}.s`;
    await writeAuth({
      auth_mode: 'chatgpt',
      tokens: { access_token: accessToken, id_token: idToken },
    });

    const creds = await loadCredentials(codexHome);
    expect(creds!.email).toBe('from-id@example.com');
    expect(creds!.planType).toBe('pro');
    expect(creds!.accountId).toBe('acct-id');
  });
});

describe('inspectAuthFile', () => {
  it('reports a missing file', async () => {
    expect(await inspectAuthFile(codexHome)).toEqual({ exists: false, apiKeyOnly: false });
  });

  it('recognizes an API-key-only sign-in', async () => {
    await writeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture', tokens: null });
    expect(await inspectAuthFile(codexHome)).toEqual({ exists: true, apiKeyOnly: true });
  });

  it('does not call a ChatGPT sign-in API-key-only', async () => {
    await writeAuth(await readFile(FIXTURE, 'utf8'));
    expect(await inspectAuthFile(codexHome)).toEqual({ exists: true, apiKeyOnly: false });
  });
});

describe('planLabel', () => {
  it('maps known ChatGPT plan codes to display labels', () => {
    expect(planLabel('plus')).toBe('Plus');
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('team')).toBe('Team');
    expect(planLabel('business')).toBe('Business');
    expect(planLabel('enterprise')).toBe('Enterprise');
    expect(planLabel('free')).toBe('Free');
  });

  it('is case-insensitive on the input code', () => {
    expect(planLabel('PLUS')).toBe('Plus');
  });

  it('title-cases unknown plan codes instead of dropping them', () => {
    expect(planLabel('edu')).toBe('Edu');
  });

  it('returns null for a null plan', () => {
    expect(planLabel(null)).toBeNull();
  });
});

describe('isTokenExpired', () => {
  const base: ResolvedCredentials = {
    accessToken: 'x',
    accountId: null,
    expiresAt: null,
    planType: null,
    email: null,
    displayName: null,
    authMode: null,
    filePath: '/x',
  };

  it('is false when expiresAt is unknown', () => {
    expect(isTokenExpired({ ...base, expiresAt: null }, 1000)).toBe(false);
  });

  it('is false strictly before expiry and true at/after it', () => {
    expect(isTokenExpired({ ...base, expiresAt: 5000 }, 4999)).toBe(false);
    expect(isTokenExpired({ ...base, expiresAt: 5000 }, 5000)).toBe(true);
    expect(isTokenExpired({ ...base, expiresAt: 5000 }, 5001)).toBe(true);
  });
});
