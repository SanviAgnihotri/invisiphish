/**
 * The session token the Auth service issues as a JWT.
 *
 * The Auth service keeps its session in a signed cookie that belongs to its
 * own domain, so a session it creates during a Google sign-in never reaches
 * this application's origin. The raw session token is not accepted in place
 * of that cookie either, so it cannot be carried over by hand.
 *
 * What the service does offer is a JWT for the session it holds, and the
 * public key that verifies it. That is the bridge: the browser, which does
 * hold the session, asks for the token and hands it to this API, and this API
 * checks the signature itself instead of taking the browser's word for it.
 *
 * The token is short-lived - a quarter of an hour - so the browser asks for a
 * fresh one when it needs it, for as long as the session itself lasts.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface SessionClaims {
  /** The user's id, which is what the database keys on. */
  userId: string;
  email: string;
  name: string;
  /** When the token stops being valid, in seconds since the epoch. */
  expiresAt: number;
}

let keys: ReturnType<typeof createRemoteJWKSet> | null = null;
let keysFor: string | null = null;

/**
 * The public keys of the Auth service.
 *
 * They are fetched once and cached; the service rotates them by publishing a
 * new key id, and `jose` refetches when it meets one it does not know.
 */
function publicKeys(authBaseUrl: string) {
  if (!keys || keysFor !== authBaseUrl) {
    const url = `${authBaseUrl.replace(/\/+$/, '')}/.well-known/jwks.json`;
    keys = createRemoteJWKSet(new URL(url));
    keysFor = authBaseUrl;
  }
  return keys;
}

/** The name of the cookie this application keeps its own session in. */
export const SESSION_COOKIE = 'invisiphish_session';

/**
 * The name of the Auth service's own session cookie.
 *
 * A password sign-up or sign-in is answered with that cookie, shaped for the
 * Auth service's own domain. The browser cannot always keep it (the
 * `__Secure-` prefix, `SameSite=None` and `Partitioned` depend on the scheme
 * and the browser), so its value is what gets copied into the first-party
 * cookie above.
 */
export const AUTH_SESSION_COOKIE_NAME = '__Secure-neon-auth.session_token';

/**
 * How long a session lasts.
 *
 * Observed straight from the Auth service, which sets this same Max-Age on its
 * own session cookie: one week. The first-party cookie takes the same value
 * so the two end together.
 */
export const AUTH_SESSION_MAX_AGE_SECONDS = 604800;

/**
 * Whether an origin is served over https.
 *
 * The `Secure` cookie attribute means "this cookie must never travel over a
 * plain http page". In development the app runs on http://localhost — where
 * browsers disagree about the prefix rules — so the attribute is only set for
 * https origins, and let localhost have a plain cookie.
 */
export function originIsSecure(origin?: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The issuer and audience of the Auth service's tokens.
 *
 * They are the origin of the Auth service's own base URL, without its path.
 */
function issuerOf(authBaseUrl: string): string {
  return new URL(authBaseUrl).origin;
}

/**
 * Check a session token and return what it says about the user.
 *
 * Returns null when the token is missing, malformed, expired, or signed by
 * somebody else. A caller must treat that as "not signed in", never as
 * "signed in as nobody".
 */
export async function verifySessionToken(
  token: string | undefined,
  authBaseUrl: string,
): Promise<SessionClaims | null> {
  if (!token) return null;

  try {
    const issuer = issuerOf(authBaseUrl);
    const { payload } = await jwtVerify(token, publicKeys(authBaseUrl), {
      issuer,
      audience: issuer,
      // The service's own clock decides: the token says when it expires, and
      // the library's default of no tolerance would only add clock skew.
      clockTolerance: 5,
    });

    const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!userId) return null;

    return {
      userId,
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : '',
      expiresAt: typeof payload.exp === 'number' ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}

/** Read the session cookie out of a cookie header. */
export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }

  return undefined;
}

/**
 * The cookie that carries the session token.
 *
 * `Secure` is only issued for https origins, and left off http development,
 * where a Secure cookie is at the mercy of each browser's rules.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure = true): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The cookie that clears the session. */
export function sessionClearedCookie(secure = true): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Whether a payload looks like a session token at all. */
export function looksLikeSessionToken(value: string | undefined): boolean {
  return typeof value === 'string' && value.split('.').length === 3;
}
