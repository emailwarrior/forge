// Google service-account auth (no user consent screen): an RS256-signed JWT is exchanged
// for a short-lived OAuth access token. Only node:crypto; the key never leaves the runner.
import { createSign } from 'node:crypto';
import { registerSecret, oauthCode, backoffMs } from './log.mjs';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'; // events only: read shared calendars' events, write the FORGE calendar
export const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export const b64url = (input) => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// GOOGLE_SA_KEY = the service-account JSON key file (raw JSON, or base64 of it).
export function parseServiceAccount(text) {
  let raw = String(text ?? '').trim();
  if (!raw) throw new Error('GOOGLE_SA_KEY is not set');
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8').trim();
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error('GOOGLE_SA_KEY is not valid service-account JSON'); }
  if (!sa || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string' || !sa.private_key.includes('PRIVATE KEY')) {
    throw new Error('GOOGLE_SA_KEY is missing client_email or private_key');
  }
  const privateKey = sa.private_key.includes('\\n') ? sa.private_key.replace(/\\n/g, '\n') : sa.private_key;
  registerSecret(privateKey);
  registerSecret(sa.private_key_id);
  return { clientEmail: sa.client_email, privateKey, privateKeyId: typeof sa.private_key_id === 'string' ? sa.private_key_id : null };
}

export function buildJwt({ clientEmail, privateKey, privateKeyId }, { nowMs = Date.now(), scope = CALENDAR_SCOPE, aud = GOOGLE_TOKEN_URL } = {}) {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  if (privateKeyId) header.kid = privateKeyId;
  const claims = { iss: clientEmail, scope, aud, iat, exp: iat + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey);
  return `${input}.${b64url(signature)}`;
}

// iat/exp must follow the real clock (Google checks them), so this ignores ctx.now().
export async function getGoogleAccessToken(ctx, sa, { scope = CALENDAR_SCOPE } = {}) {
  const assertion = buildJwt(sa, { nowMs: Date.now(), scope });
  const body = new URLSearchParams({ grant_type: JWT_BEARER, assertion }).toString();
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await ctx.fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      });
    } catch {
      if (attempt < 3) { await ctx.sleep(backoffMs(attempt)); continue; }
      throw new Error('Google auth: network error');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await ctx.sleep(backoffMs(attempt)); continue; }
    if (!res.ok || !data || typeof data.access_token !== 'string') {
      const code = oauthCode(data);
      throw new Error(`Google auth failed (HTTP ${res.status}${code ? ' ' + code : ''})`);
    }
    registerSecret(data.access_token);
    return data.access_token;
  }
}
