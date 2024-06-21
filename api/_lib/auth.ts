/**
 * Neon Auth (Managed Better Auth) client for the API routes.
 *
 * Neon Auth is a managed REST service. Users, sessions and credentials live in
 * the `neon_auth` schema of the same Neon database, so identity and data
 * branch together.
 *
 * The session cookie is http-only and managed by the Auth service. The browser
 * never sees the token; the API route forwards the cookie and reads the
 * session from the Auth service.
 *
 * A Google sign-in is the exception: it happens in the browser, because the
 * Auth service's OAuth state is held in cookies on the Auth service's own
 * domain. What comes back is a session token - a JWT the Auth service signs
 * and publishes the key for - and `getSession` checks that signature itself.
 */

import {
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_MAX_AGE_SECONDS,
  looksLikeSessionToken,
  readSessionCookie,
  verifySessionToken,
} from './jwt';

export interface NeonAuthUser {
  id: string;
  email: string;
  name?: string | null;
}

export interface NeonAuthSession {
  id: string;
  userId: string;
  user: NeonAuthUser;
}

/**
 * The base URL of the Auth service.
 *
 * The Neon console hands out the Auth URL with the mount point in it, for
 * example `https://ep-xxx.neonauth.us-east-1.aws.neon.tech/neondb/auth`, and
 * the routes below are written as `/auth/sign-in/email` and friends. Both
 * halves carry the mount point, so the base is trimmed to the database URL
 * and the routes add it back. Without the trim the request would go to
 * `/neondb/auth/auth/sign-in/email`, which is not a route.
 */
function baseUrl(): string {
  const value = process.env.NEON_AUTH_BASE_URL;
  if (!value) throw new Error('Missing NEON_AUTH_BASE_URL');
  return value.replace(/\/+$/, '').replace(/\/auth$/, '');
}

/**
 * The URL of the Auth service, with its mount point.
 *
 * The browser needs this one: a Google sign-in happens in the browser,
 * because the Auth service's own OAuth state lives in cookies on the Auth
 * service's domain, and a cookie cannot be set for a domain by a server that
 * is not on it. It is not a secret - the Neon documentation has the same
 * value in the browser - but it is not something the browser should be told
 * twice, so the API hands it out.
 */
export function publicAuthUrl(): string {
  const value = process.env.NEON_AUTH_BASE_URL;
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

async function authRequest<T>(
  path: string,
  init: RequestInit & { cookie?: string; origin?: string } = {},
): Promise<{ data: T | null; error: string | null; setCookies: string[] }> {
  const headers = new Headers(init.headers);

  // The Auth service wants `Content-Type: application/json` on every request
  // that carries one, and it refuses a body that is empty while saying so:
  // `FST_ERR_CTP_EMPTY_JSON_BODY` for a body-less POST, and
  // `UNSUPPORTED_MEDIA_TYPE` when the content type is left off. A sign-out
  // carries nothing but the session cookie, so it is sent with an empty JSON
  // object.
  const body = init.body ?? (init.method && init.method !== 'GET' ? '{}' : undefined);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (init.cookie) headers.set('Cookie', init.cookie);

  // The Auth service refuses a sign-in or a sign-up that arrives without an
  // `Origin` header: it answers `MISSING_ORIGIN`, because it builds the
  // callback URL from the origin and checks it against the trusted origins.
  // The browser sends the header on every request it makes to this API, so it
  // is forwarded unchanged rather than invented here.
  if (init.origin) headers.set('Origin', init.origin);

  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    body,
    headers,
    redirect: 'manual',
  });

  const setCookies = readSetCookies(response.headers);

  if (!response.ok) {
    let message = `Auth request failed with ${response.status}`;
    try {
      const body = await response.json();
      message = body?.message ?? body?.error ?? message;
    } catch {
      // keep the status-based message
    }
    console.warn(`[auth] ${path} failed:`, message);
    return { data: null, error: message, setCookies };
  }

  const data = (await response.json()) as T;
  return { data, error: null, setCookies };
}

/**
 * The answer to a sign-in or a sign-up.
 *
 * Managed Better Auth returns the session token and the user. It does not
 * return the session object: that is `/auth/get-session`'s answer, and the
 * two are read by different functions.
 */
interface AuthResponse {
  token?: string;
  redirect?: boolean;
  session?: { id?: string; userId?: string };
  user: NeonAuthUser;
}

/**
 * Read every `Set-Cookie` header of a response.
 *
 * `Headers.getSetCookie()` is the way to do this, and Node has it. Not every
 * runtime that runs this code does: the dev server loads the API handlers
 * through Vite's module loader, and there `getSetCookie` can be missing, in
 * which case the cookies come back as one comma-joined string and have to be
 * split.
 *
 * The split has to be careful: an `Expires` attribute contains a comma of its
 * own (`Expires=Wed, 21 Oct 2026 04:52:53 GMT`), so a comma is only a
 * separator when what follows looks like the start of another cookie - a name
 * and an `=` - and not like a date.
 */
function readSetCookies(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') return getter.call(headers);

  const raw = headers.get('set-cookie');
  if (!raw) return [];

  return raw.split(/,(?=\s*[^\s;,=]+=)/).map((value) => value.trim());
}

/**
 * Reduce the answer to the session this application uses.
 *
 * The session id is not what the database keys on. The Row Level Security
 * policies read `request.jwt.claims ->> 'sub'`, and the API sets that to the
 * *user* id, so the user id is what has to be right. The token stands in for
 * the session id, which nothing in the application reads.
 */
function toSession(data: AuthResponse): NeonAuthSession {
  return {
    id: data.session?.id ?? data.token ?? '',
    userId: data.user.id,
    user: data.user,
  };
}

/** Sign in with an email and a password. */
export async function signInWithPassword(
  email: string,
  password: string,
  origin?: string,
): Promise<{ data: NeonAuthSession | null; error: string | null; setCookies: string[] }> {
  const result = await authRequest<AuthResponse>(
    '/auth/sign-in/email',
    { method: 'POST', body: JSON.stringify({ email, password }), origin },
  );

  if (result.error || !result.data?.user) {
    return { data: null, error: result.error ?? 'Sign in failed', setCookies: result.setCookies };
  }

  return { data: toSession(result.data), error: null, setCookies: result.setCookies };
}

/** Create an account with an email and a password. */
export async function signUpWithPassword(
  email: string,
  password: string,
  name: string,
  origin?: string,
): Promise<{ data: NeonAuthSession | null; error: string | null; setCookies: string[] }> {
  const result = await authRequest<AuthResponse>(
    '/auth/sign-up/email',
    { method: 'POST', body: JSON.stringify({ email, password, name }), origin },
  );

  if (result.error || !result.data?.user) {
    return { data: null, error: result.error ?? 'Sign up failed', setCookies: result.setCookies };
  }

  return { data: toSession(result.data), error: null, setCookies: result.setCookies };
}

/**
 * Read the current session.
 *
 * There are three ways to be signed in, and all of them end here, each within
 * reach of the cookie the browser brings back.
 *
 * 1. A Google sign-in, or any session minted by this API's own
 *    `signInWithToken` route, stored the session token - a JWT the Auth
 *    service signs and publishes the key for - in the first-party cookie. The
 *    signature is checked here against the service's own public key, without
 *    a round trip.
 *
 * 2. An email sign-up or sign-in copied the Auth service's session token
 *    (opaque, not published as a key this side can check) into the same
 *    first-party cookie. That value is presented to the Auth service shaped
 *    the way its own cookie looks, and the service decides.
 *
 * 3. Anything else - a jar that still holds the Auth service's own cookies
 *    from before the first-party arrangement - is forwarded as it arrives.
 *
 * Returning null means "not signed in", never "signed in as nobody".
 */
export async function getSession(
  cookie: string | undefined,
): Promise<{ data: NeonAuthSession | null; error: string | null }> {
  if (!cookie) return { data: null, error: null };

  const token = readSessionCookie(cookie);

  // 1. The signed session token this application issued itself.
  if (looksLikeSessionToken(token)) {
    const claims = await verifySessionToken(token, publicAuthUrl());

    if (claims) {
      return {
        data: {
          id: claims.userId,
          userId: claims.userId,
          user: {
            id: claims.userId,
            email: claims.email,
            name: claims.name,
          },
        },
        error: null,
      };
    }
  }

  // The Auth service reads its cookie by name; the first-party cookie goes
  // under a different one. When the jar does not already carry the service's
  // own name, the value the first-party cookie holds is swapped into that
  // shape, and a single round trip decides whose session it is.
  const hasAuthCookie = cookie
    .split(/;\s*/)
    .some((part) => part.trim().startsWith(`${AUTH_SESSION_COOKIE_NAME}=`));
  const prepared =
    token && !hasAuthCookie ? `${AUTH_SESSION_COOKIE_NAME}=${token}; ${cookie}` : cookie;

  const result = await authRequest<{ session: NeonAuthSession; user: NeonAuthUser } | null>(
    '/auth/get-session',
    { method: 'GET', cookie: prepared },
  );

  if (result.error || !result.data?.session || !result.data?.user) {
    return { data: null, error: null };
  }

  return {
    data: {
      id: result.data.session.id,
      userId: result.data.user.id,
      user: result.data.user,
    },
    error: null,
  };
}

/**
 * Sign in with a Google ID token.
 *
 * The Auth service verifies the token against the Google client it has been
 * configured with, creates the user if this is the first time, links the
 * Google account to an existing user with the same email, and answers with
 * the session cookie.
 *
 * The response is the one that mints the session, which is why it has to be
 * this server's request: the cookie it carries is host-only to the Auth
 * service's domain, and only the party that made the request can hand it on
 * to a browser on this application's origin.
 */
export async function signInWithGoogleIdToken(
  idToken: string,
  origin?: string,
): Promise<{ data: NeonAuthSession | null; error: string | null; setCookies: string[] }> {
  const result = await authRequest<AuthResponse>(
    '/auth/sign-in/social',
    {
      method: 'POST',
      body: JSON.stringify({ provider: 'google', idToken: { token: idToken } }),
      origin,
    },
  );

  if (result.error || !result.data?.user) {
    return { data: null, error: result.error ?? 'Google sign-in failed', setCookies: result.setCookies };
  }

  return { data: toSession(result.data), error: null, setCookies: result.setCookies };
}

/** Sign the current session out. */
export async function signOut(
  cookie: string | undefined,
  origin?: string,
): Promise<{ error: string | null; setCookies: string[] }> {
  const result = await authRequest<unknown>('/auth/sign-out', {
    method: 'POST',
    cookie,
    origin,
  });
  return { error: result.error, setCookies: result.setCookies };
}

/** Read a single cookie value from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Pick the session token out of the cookies the Auth service asked to set.
 *
 * A password sign-up or sign-in answers with the Auth service's session
 * cookie, shaped for its own domain. The browser cannot always keep it - the
 * `__Secure-` prefix, `SameSite=None` and `Partitioned` are at the mercy of
 * the scheme and the browser - so the route copies the value into this
 * application's own first-party cookie. The value is carried through
 * verbatim: it is a signed pair the service issued and expects back byte for
 * byte.
 */
export function sessionTokenFromSetCookies(
  setCookies: string[],
): { value: string; maxAgeSeconds: number } | null {
  for (const line of setCookies) {
    const pair = line.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator === -1) continue;

    const name = pair.slice(0, separator).trim();
    if (name !== AUTH_SESSION_COOKIE_NAME) continue;

    const value = pair.slice(separator + 1).trim();
    if (!value) continue;

    const maxAgeMatch = line.match(/Max-Age=(\d+)/i);
    const maxAgeSeconds = maxAgeMatch
      ? Number(maxAgeMatch[1])
      : AUTH_SESSION_MAX_AGE_SECONDS;

    // A cookie that clears itself is not a session.
    if (maxAgeSeconds <= 0) continue;

    return { value, maxAgeSeconds };
  }
  return null;
}
