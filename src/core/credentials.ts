import { readFile } from 'node:fs/promises';
import type { ResolvedCredentials } from '../types.js';
import { firstString, isRecord } from './parse.js';
import { getAuthPath } from './paths.js';

/**
 * Shape of `<codexHome>/auth.json`, taken from a real local install rather
 * than guessed. `auth_mode` values seen in the binary: "chatgpt", "apikey",
 * "chatgpt_auth_tokens". A ChatGPT sign-in stores OAuth tokens; an API-key
 * sign-in stores `OPENAI_API_KEY` with `tokens: null`.
 */
interface AuthFileShape {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  } | null;
  last_refresh?: string;
}

/**
 * The access token is a JWT whose claims carry the plan, account id and
 * email. We decode the payload without verifying the signature — this is a
 * read of our own local state to label the header, never a trust decision.
 */
const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';

const PLAN_LABELS: Record<string, string> = {
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  free: 'Free',
};

/** "plus" -> "Plus"; unrecognized values are title-cased rather than dropped. */
export function planLabel(planType: string | null): string | null {
  if (!planType) return null;
  const known = PLAN_LABELS[planType.toLowerCase()];
  if (known) return known;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

/** Decodes a JWT's payload segment (base64url JSON); null for anything that isn't a 3-part JWT. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads auth.json and returns the ChatGPT access token plus everything the
 * header needs, decoded from the token claims. Returns null (never throws)
 * when there is no usable access token — including the API-key sign-in
 * case, which `inspectAuthFile` exists to tell apart.
 */
export async function loadCredentials(codexHome?: string): Promise<ResolvedCredentials | null> {
  const filePath = getAuthPath(codexHome);
  const parsed = await tryReadJson<AuthFileShape>(filePath);
  const tokens = parsed?.tokens;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

  const access = decodeJwtPayload(accessToken) ?? {};
  const id = typeof tokens?.id_token === 'string' ? (decodeJwtPayload(tokens.id_token) ?? {}) : {};
  const accessAuth = claim(access[AUTH_CLAIM]);
  const idAuth = claim(id[AUTH_CLAIM]);
  const profile = claim(access[PROFILE_CLAIM]);

  return {
    accessToken,
    accountId: firstString(
      tokens?.account_id,
      accessAuth.chatgpt_account_id,
      idAuth.chatgpt_account_id,
    ),
    // JWT `exp` is epoch seconds; everything else in ocusage is epoch ms.
    expiresAt: typeof access.exp === 'number' ? access.exp * 1000 : null,
    planType: firstString(accessAuth.chatgpt_plan_type, idAuth.chatgpt_plan_type),
    email: firstString(profile.email, id.email),
    displayName: firstString(id.name),
    authMode: firstString(parsed?.auth_mode),
    filePath,
  };
}

export interface AuthFileSummary {
  exists: boolean;
  /** Signed in with an API key only — no ChatGPT plan, so no usage windows exist for this account. */
  apiKeyOnly: boolean;
}

/** Cheap classification of auth.json for the "why is there no live data" message. */
export async function inspectAuthFile(codexHome?: string): Promise<AuthFileSummary> {
  let raw: string;
  try {
    raw = await readFile(getAuthPath(codexHome), 'utf8');
  } catch {
    return { exists: false, apiKeyOnly: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, apiKeyOnly: false };
  }
  if (!isRecord(parsed)) return { exists: true, apiKeyOnly: false };

  const tokens = isRecord(parsed.tokens) ? parsed.tokens : null;
  const hasAccessToken = typeof tokens?.access_token === 'string' && tokens.access_token.length > 0;
  const hasApiKey = typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0;
  return {
    exists: true,
    apiKeyOnly: !hasAccessToken && (hasApiKey || parsed.auth_mode === 'apikey'),
  };
}

export function isTokenExpired(creds: ResolvedCredentials, now: number = Date.now()): boolean {
  return creds.expiresAt !== null && creds.expiresAt <= now;
}

function claim(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
