import { publicAuthUrl, sessionTokenFromSetCookies, signInWithPassword, signOut, signUpWithPassword } from './_lib/auth';
import { saveProfile, withUser } from './_lib/db';
import {
  originIsSecure,
  sessionClearedCookie,
  sessionCookie,
  verifySessionToken,
} from './_lib/jwt';
import {
  HttpError,
  applyCors,
  headerValue,
  readJson,
  requireMethod,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from './_lib/http';

interface AuthBody {
  action?: 'signIn' | 'signUp' | 'signOut' | 'signInWithToken';
  email?: string;
  password?: string;
  name?: string;
  organization?: string;
  /** A session token the Auth service issued. */
  token?: string;
}

/**
 * Sign in, sign up and sign out.
 *
 * Every answer here settles the session with one first-party cookie. A
 * password sign-in or sign-up answers with the Auth service's session cookie
 * shaped for its own domain - which a browser may or may not keep - so its
 * value is copied into this application's own cookie and it is that cookie
 * which `get session` reads from then on. The token therefore never reaches
 * client-side JavaScript either way.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    applyCors(req, res);

    const method = (req.method ?? 'GET').toUpperCase();

    // Which ways of signing in this deployment offers, and where the Auth
    // service lives. The page asks before it draws a button it cannot
    // honour.
    if (method === 'GET') {
      res.status(200).json({
        emailPassword: true,
        google: true,
        authBaseUrl: publicAuthUrl(),
      });
      return;
    }

    requireMethod(req, ['POST']);

    const body = (await readJson(req)) as AuthBody;
    const action = body.action ?? 'signIn';

    // The Auth service needs the origin of the request that reached this API:
    // it builds the callback URL from it and checks it against the trusted
    // origins. It is the browser's own origin, forwarded unchanged.
    const origin = headerValue(req.headers, 'origin');

    if (action === 'signOut') {
      const cookie = headerValue(req.headers, 'cookie');
      const result = await signOut(cookie, origin);

      // Every clearing cookie goes out in one call: this application's own
      // session cookie, and the ones the Auth service asked to have cleared.
      //
      // They go out whether or not the Auth service agreed. The Auth service
      // refuses the request when the origin is not one of its trusted ones -
      // and a caller whose cookie is still standing is signed in after
      // signing out, which is the opposite of what was asked for.
      res.setHeader('Set-Cookie', [
        ...result.setCookies,
        sessionClearedCookie(originIsSecure(origin)),
      ]);

      // If it refused the request, the cookies never came, so the caller has
      // to be told rather than left with a session it believes has ended.
      if (result.error) throw new HttpError(502, result.error);

      res.status(200).json({ ok: true });
      return;
    }

    // Take a session token from the browser and turn it into this
    // application's own session.
    //
    // A Google sign-in happens in the browser, because the Auth service's
    // OAuth state is held in cookies on the Auth service's own domain and a
    // cookie cannot be set for a domain by a server that is not on it. What
    // the browser can bring back is the session token, a JWT the Auth
    // service signs and publishes the key for, so the signature is checked
    // here rather than the token being taken on trust.
    if (action === 'signInWithToken') {
      const token = (body.token ?? '').trim();
      if (!token) throw new HttpError(400, 'token is required');

      const claims = await verifySessionToken(token, publicAuthUrl());
      if (!claims) throw new HttpError(401, 'The session token is not valid');

      const maxAge = Math.max(0, claims.expiresAt - Math.floor(Date.now() / 1000));
      res.setHeader('Set-Cookie', sessionCookie(token, maxAge, originIsSecure(origin)));

      await saveProfile(claims.userId, claims.email, claims.name || claims.email, null);

      res.status(200).json({
        user: { id: claims.userId, email: claims.email, name: claims.name },
      });
      return;
    }

    const email = (body.email ?? '').trim();
    const password = body.password ?? '';

    if (!email || !password) {
      throw new HttpError(400, 'Email and password are required');
    }

    if (action === 'signUp') {
      const name = (body.name ?? '').trim();
      if (!name) throw new HttpError(400, 'Name is required');

      const result = await signUpWithPassword(email, password, name, origin);
      if (result.error || !result.data) throw new HttpError(401, result.error ?? 'Sign up failed');

      const cookies = [...result.setCookies];

      // The Auth service's own session cookie may not survive the browser's
      // cookie rules, so the session also gets a first-party cookie of this
      // application's own - the one /api/session reads from ever after.
      const session = sessionTokenFromSetCookies(result.setCookies);
      if (session) {
        cookies.push(
          sessionCookie(session.value, session.maxAgeSeconds, originIsSecure(origin)),
        );
      }

      res.setHeader('Set-Cookie', cookies);

      // The organisation is application metadata rather than an auth field.
      await saveProfile(
        result.data.userId,
        email,
        name,
        (body.organization ?? '').trim() || null,
      );

      res.status(200).json({ user: result.data.user });
      return;
    }

    const result = await signInWithPassword(email, password, origin);
    if (result.error || !result.data) throw new HttpError(401, result.error ?? 'Sign in failed');

    const cookies = [...result.setCookies];

    // The same first-party copy of the session, for a returning user.
    const session = sessionTokenFromSetCookies(result.setCookies);
    if (session) {
      cookies.push(sessionCookie(session.value, session.maxAgeSeconds, originIsSecure(origin)));
    }

    res.setHeader('Set-Cookie', cookies);

    await withUser(result.data.userId, async (client) => {
      await client.query(
        `update public.profiles set last_login_at = now() where user_id = $1`,
        [result.data?.userId],
      );
    }).catch(() => undefined);

    res.status(200).json({ user: result.data.user });
  } catch (error) {
    sendError(res, error);
  }
}
