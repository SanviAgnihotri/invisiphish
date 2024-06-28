#!/usr/bin/env node
/**
 * End-to-end check of the app against the real Neon database.
 *
 * It drives the dev server the way the browser does - same origin, cookies
 * kept - and walks the whole path: sign up, read the session, analyse a
 * message, list the analyses, ask for an explanation, leave feedback, sign
 * out. Every step prints the HTTP status and the interesting part of the
 * answer, so a failure says which step failed and why.
 *
 * Usage:
 *     npm run dev            # in another shell
 *     node scripts/verify-e2e.mjs [base-url]
 */
import fs from 'node:fs';

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:5173';

const PHISHING =
  'URGENT: Your account has been suspended. Verify your identity immediately at http://192.168.0.1/verify to avoid permanent closure.';
const LEGITIMATE = 'Hi Sarah, the meeting notes from Tuesday are attached. Let me know if you want me to walk through the Q3 numbers.';

let cookie = '';

/**
 * Keep the session cookie the way a browser does.
 *
 * A `Set-Cookie` with `Max-Age=0`, or with an expiry in the past, deletes
 * the cookie rather than setting it. The jar has to drop it, or it keeps a
 * token the server has already discarded and the check reports a session
 * that is still open after signing out.
 */
function cookiesFrom(response) {
  const values = response.headers.getSetCookie?.() ?? [];

  const jar = new Map();
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    jar.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }

  for (const value of values) {
    const [pair, ...attributes] = value.split(';');
    const index = pair.indexOf('=');
    if (index === -1) continue;

    const name = pair.slice(0, index).trim();
    const content = pair.slice(index + 1).trim();

    const maxAge = attributes.find((a) => a.trim().toLowerCase().startsWith('max-age='));
    const expires = attributes.find((a) => a.trim().toLowerCase().startsWith('expires='));
    const expired =
      (maxAge !== undefined && Number(maxAge.split('=')[1].trim()) <= 0) ||
      (expires !== undefined &&
        new Date(expires.slice(expires.indexOf('=') + 1).trim()) <= new Date());

    if (expired || content === '') jar.delete(name);
    else jar.set(name, content);
  }

  cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  return values;
}

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // A browser sends this on every request it makes, and the Auth service
      // refuses a sign-in without it: it builds the callback URL from the
      // origin and checks it against the trusted origins. The API forwards
      // it, so the check has to drive the app the way a browser would.
      Origin: new URL(BASE).origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookies = cookiesFrom(response);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: response.status, body, setCookies };
}

function show(label, result, extra = '') {
  const ok = result.status < 400;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${String(result.status).padEnd(4)} ${extra}`);
  if (!ok) console.log(`       ${JSON.stringify(result.body).slice(0, 300)}`);
  return ok;
}

const email = `probe-${Date.now()}@example.com`;
const password = 'probe-password-123';

console.log(`== InvisiPhish end-to-end check against ${BASE} ==\n`);

// 1. The session route, before anybody has signed in.
const session = await call('/api/session');
show('GET /api/session', session, JSON.stringify(session.body));

// 2. Sign up.
const signUp = await call('/api/auth', {
  method: 'POST',
  body: JSON.stringify({ action: 'signUp', email, password, name: 'Probe User', organization: 'Probe Org' }),
});
show('POST /api/auth signUp', signUp, `${email}`);
if (!show('', { status: signUp.status, body: signUp.body })) process.exit(1);

// 3. The session now.
const session2 = await call('/api/session');
show('GET /api/session (signed in)', session2, JSON.stringify(session2.body).slice(0, 160));

// 4. Analyse a phishing message, with the browser's own score.
const analysed = await call('/api/analyze', {
  method: 'POST',
  body: JSON.stringify({
    text: PHISHING,
    semantic: { score: 0.9999, confidence: 0.9999 },
  }),
});
show('POST /api/analyze (phishing)', analysed);
if (analysed.status < 400) {
  const report = analysed.body.report;
  console.log(
    `       verdict=${report.verdict} score=${Number(report.finalScore).toFixed(3)} ` +
      `modules=${report.modules.map((m) => `${m.module}:${m.status}`).join(',')} ` +
      `evidence=${report.evidence.length} id=${report.id}`,
  );
  if (!report.modules.some((m) => m.module === 'semantic' && m.status === 'ok')) {
    console.log('       NOTE: the semantic module did not run');
  }
}

// 5. The same for a legitimate message.
const analysed2 = await call('/api/analyze', {
  method: 'POST',
  body: JSON.stringify({ text: LEGITIMATE, semantic: { score: 0, confidence: 0.9999 } }),
});
show('POST /api/analyze (legitimate)', analysed2);
if (analysed2.status < 400) {
  const report = analysed2.body.report;
  console.log(`       verdict=${report.verdict} score=${Number(report.finalScore).toFixed(3)}`);
}

// 6. The history.
const analyses = await call('/api/analyses');
show('GET /api/analyses', analyses);
if (analyses.status < 400) {
  const rows = analyses.body.analyses ?? [];
  console.log(`       ${rows.length} analysis/analyses, newest ${rows[0]?.id ?? '-'}`);
}

// 7. The explanation. Without a model key this is the deterministic one.
if (analysed.status < 400) {
  const explained = await call('/api/explain', {
    method: 'POST',
    body: JSON.stringify({ report: analysed.body.report }),
  });
  show('POST /api/explain', explained);
  if (explained.status < 400) {
    console.log(
      `       generated=${explained.body.generated} ` +
        `groundedness=${explained.body.groundedness?.score} ` +
        `summary="${String(explained.body.explanation?.summary ?? '').slice(0, 90)}"`,
    );
  }

  // 8. Feedback.
  const feedback = await call('/api/feedback', {
    method: 'POST',
    body: JSON.stringify({ analysisId: analysed.body.report.id, verdict: 'confirmed_phishing' }),
  });
  show('POST /api/feedback', feedback);
}

// 9. Sign out.
const signOut = await call('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'signOut' }) });
show('POST /api/auth signOut', signOut);

const after = await call('/api/session');
show('GET /api/session (signed out)', after, JSON.stringify(after.body));

console.log('\ndone.');
