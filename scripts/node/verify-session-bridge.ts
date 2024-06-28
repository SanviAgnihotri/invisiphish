/**
 * Check the session bridge that a Google sign-in depends on.
 *
 * A Google sign-in happens in the browser, because the Auth service's OAuth
 * state lives in cookies on the Auth service's own domain. What the browser
 * can bring back afterwards is the session token - a JWT the Auth service
 * signs - and this application's API has to accept it by checking the
 * signature itself, against the Auth service's published key.
 *
 * This script exercises that path without a browser and without Google:
 *
 *   1. it signs up with an email and a password, and keeps the cookie;
 *   2. it asks the Auth service for the session token of that session;
 *   3. it hands the token to the API the way the callback route does;
 *   4. it checks that the API now knows who the caller is;
 *   5. it checks that a forged token is refused.
 *
 * Usage:
 *     pnpm dev            # in another shell
 *     pnpm verify:session
 */
interface Provider {
  email: string;
  password: string;
  name: string;
}

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const AUTH_URL = process.env.NEON_AUTH_BASE_URL ?? '';

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function remember(jar: Map<string, string>, response: Response): void {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair, ...attributes] = value.split(';');
    const index = pair.indexOf('=');
    if (index === -1) continue;

    const name = pair.slice(0, index).trim();
    const content = pair.slice(index + 1).trim();
    const maxAge = attributes.find((a) => a.trim().toLowerCase().startsWith('max-age='));

    if (content === '' || (maxAge !== undefined && Number(maxAge.split('=')[1].trim()) <= 0)) {
      jar.delete(name);
    } else {
      jar.set(name, content);
    }
  }
}

async function authRequest(
  path: string,
  body: unknown,
  jar: Map<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${AUTH_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(BASE).origin,
      ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
    },
    body: JSON.stringify(body),
  });

  remember(jar, response);
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function check(label: string, ok: boolean, detail = ''): boolean {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`);
  return ok;
}

console.log(`== InvisiPhish session bridge against ${BASE} ==\n`);

if (!AUTH_URL) {
  console.log('NEON_AUTH_BASE_URL is not set.');
  process.exit(1);
}

const provider: Provider = {
  email: `bridge-${Date.now()}@example.com`,
  password: 'bridge-password-123',
  name: 'Bridge Probe',
};

const jar = new Map<string, string>();

// 1. An account, and a session for it.
const signedUp = await authRequest('/sign-up/email', provider, jar);
if (!check('signed up with the Auth service', Boolean(signedUp.user))) {
  console.log(JSON.stringify(signedUp).slice(0, 300));
  process.exit(1);
}

// 2. The session token, which is what a Google sign-in would bring back.
const tokenResponse = await fetch(`${AUTH_URL}/token`, {
  headers: { Cookie: cookieHeader(jar) },
});
const tokenBody = (await tokenResponse.json()) as { token?: string };
const token = tokenBody.token ?? '';

if (!check('the Auth service issued a session token', Boolean(token))) {
  console.log(JSON.stringify(tokenBody).slice(0, 300));
  process.exit(1);
}

// 3. The token, handed over the way the callback route does it.
const exchange = await fetch(`${BASE}/api/auth`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'signInWithToken', token }),
});
const exchangeBody = (await exchange.json()) as { user?: { email?: string } };

check(
  'the API accepted the session token',
  exchange.ok && exchangeBody.user?.email === provider.email,
  exchangeBody.user?.email ?? JSON.stringify(exchangeBody).slice(0, 200),
);

// 4. The API now knows who the caller is.
const sessionCookie = exchange.headers.getSetCookie?.().find((value) =>
  value.startsWith('invisiphish_session='),
);
const sessionJar = new Map<string, string>();
remember(sessionJar, exchange);

const session = await fetch(`${BASE}/api/session`, {
  headers: { Cookie: cookieHeader(sessionJar) },
});
const sessionBody = (await session.json()) as { user?: { email?: string } };

check(
  'the API reads the session back',
  sessionBody.user?.email === provider.email,
  sessionBody.user?.email ?? JSON.stringify(sessionBody).slice(0, 200),
);
check('the session cookie is http-only', Boolean(sessionCookie?.includes('HttpOnly')));

// 5. A token that nobody signed must not be accepted.
const forged = `${token.split('.').slice(0, 2).join('.')}.forged`;
const forgedExchange = await fetch(`${BASE}/api/auth`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'signInWithToken', token: forged }),
});
check('a forged token is refused', forgedExchange.status === 401, `status ${forgedExchange.status}`);

console.log('\ndone.');
