/**
 * Browser-side API client.
 *
 * The browser never talks to the database directly: it calls the API routes,
 * which verify the session and let Row Level Security decide what the caller
 * may read or write. That keeps database credentials off the client and makes
 * the API the single audited boundary.
 */

import type { AnalysisReport, Evidence, Explanation, GroundednessReport } from '@/lib/ml/types';
import { scoreInBrowser } from '@/lib/ml/clientSemantic';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `Request failed (${response.status})`;
    throw new Error(message);
  }

  return body as T;
}

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
}

/** What the deployment offers, and where the Auth service lives. */
export interface AuthProviders {
  emailPassword: boolean;
  google: boolean;
  /** The Auth service's URL, with its mount point. */
  authBaseUrl: string;
}

/**
 * The Auth service's address, known at build time.
 *
 * It is a constant - the same value the API hands out - and the sign-in
 * page needs it to draw the Google button in its first paint. Fetching it
 * would make the button appear a moment after the page, which reads as a
 * broken page rather than as a loaded one.
 */
export const AUTH_BASE_URL: string =
  typeof __VIGIL_AUTH_BASE_URL__ === 'undefined' ? '' : __VIGIL_AUTH_BASE_URL__;

/**
 * Ask the Auth service for the token of the session it holds.
 *
 * The browser is the only party that can do this: the session lives in a
 * cookie on the Auth service's own domain. The token it answers with is a
 * JWT the Auth service signs, and the API checks the signature itself.
 */
export async function fetchSessionToken(authBaseUrl: string): Promise<string | null> {
  if (!authBaseUrl) return null;

  try {
    const response = await fetch(`${authBaseUrl}/token`, { credentials: 'include' });
    if (!response.ok) return null;

    const body = (await response.json()) as { token?: string };
    return typeof body.token === 'string' ? body.token : null;
  } catch {
    return null;
  }
}

/**
 * Redeem the one-time verifier the Auth service handed back.
 *
 * A Google sign-in ends with the Auth service redirecting the browser to
 * this application's callback with a `neon_auth_session_verifier` in the
 * query string. It has to be redeemed against the session challenge cookie
 * the Auth service set when the sign-in started, which only the browser
 * holds, so the redemption happens here rather than on the server.
 *
 * Redeeming it puts the session cookie where the browser can use it - in the
 * partition of this origin - which is the whole point of the verifier: the
 * cookie the OAuth callback set belongs to a different partition, because
 * that response came from the Auth service's domain rather than from here.
 */
export async function redeemSessionVerifier(
  authBaseUrl: string,
  verifier: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!authBaseUrl) return { ok: false, detail: 'the Auth service is not configured' };
  if (!verifier) return { ok: false, detail: 'no verifier in the callback' };

  try {
    const url = `${authBaseUrl}/get-session?neon_auth_session_verifier=${encodeURIComponent(verifier)}`;
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
      return {
        ok: false,
        detail: body.message ?? body.code ?? `the Auth service answered ${response.status}`,
      };
    }

    return { ok: true, detail: 'redeemed' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'the redemption request failed',
    };
  }
}

/**
 * Start a Google sign-in in a popup.
 *
 * The Auth service holds the state of the attempt - and the session challenge
 * cookie it checks the verifier against - on its own domain. A full-page
 * redirect puts the OAuth round trip in a different partition from the one
 * that started it, and the challenge cookie does not travel with it. A popup
 * keeps the round trip in one place, which is what the Auth service's own
 * client does.
 *
 * The popup is left to do the whole round trip; it hands the verifier back
 * through `onVerifier`, and the window that opened it redeems it.
 */
/**
 * Turn a refusal from the Auth service into something worth reading.
 *
 * The commonest refusal is "Invalid origin": the Auth service only accepts
 * requests from origins it has been told to trust, and a deployment on a new
 * domain has to be added to that list before it can sign anybody in. Saying
 * that is more use than "Google sign-in could not be started".
 */
async function describeFailure(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string; code?: string };
    const detail = body.error ?? body.message ?? body.code;
    if (!detail) return fallback;
    if (/origin/i.test(detail)) {
      return 'This deployment is not a trusted origin for the Auth service yet, so it cannot sign anybody in.';
    }
    return detail;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* The explanation stream                                              */
/* ------------------------------------------------------------------ */

/**
 * The events the explanation endpoint streams.
 *
 * `summary`, `bullet-delta` and `action-delta` bring text as the model
 * writes it. `bullet` announces a finished bullet with the evidence ids it
 * will be judged by, and `action` a finished recommended action. `done` is
 * authoritative: it carries the fully validated object, so the live text the
 * reader watched is replaced by what survived verification.
 */
export type ExplanationStreamEvent =
  | { type: 'model'; model: string }
  | { type: 'summary'; text: string }
  | { type: 'bullet-delta'; index: number; text: string }
  | { type: 'bullet'; index: number; text: string; evidenceIds: string[] }
  | { type: 'action-delta'; index: number; text: string }
  | { type: 'action'; index: number; text: string }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      explanation: Explanation;
      groundedness: GroundednessReport;
      removedBulletIndexes: number[];
      generated: boolean;
      model?: string;
    };

/** The validated outcome that rides the `done` event. */
export interface ExplanationResult {
  explanation: Explanation;
  groundedness: GroundednessReport;
  removedBulletIndexes: number[];
  generated: boolean;
  model?: string;
}

/** One streamed claim: the text as read so far, and the ids once known. */
export interface ExplainStreamBullet {
  index: number;
  text: string;
  evidenceIds: string[];
}

/** What the dashboard holds while - and after - the explanation streams. */
export interface ExplainStreamState {
  phase: 'idle' | 'connecting' | 'streaming' | 'done' | 'error';
  model?: string;
  summary: string;
  bullets: ExplainStreamBullet[];
  actions: string[];
  outcome?: ExplanationResult;
  error?: string;
}

export const emptyExplainState = (): ExplainStreamState => ({
  phase: 'idle',
  summary: '',
  bullets: [],
  actions: [],
});

/** A bullet's slot, appending when it is new (the stream is ordered). */
function upsertBullet(
  bullets: ExplainStreamBullet[],
  index: number,
  patch: { text?: string; evidenceIds?: string[] },
): ExplainStreamBullet[] {
  const at = bullets.findIndex((bullet) => bullet.index === index);
  if (at === -1) {
    return [...bullets, { index, text: patch.text ?? '', evidenceIds: patch.evidenceIds ?? [] }];
  }
  const next = bullets.slice();
  next[at] = { ...next[at], ...patch };
  return next;
}

/**
 * A streamed piece of a claim.
 *
 * The server sends only the characters written since the last piece, so they
 * are appended here. Replacing them instead would show one fragment at a time
 * - the claim would flicker through its own letters rather than being
 * written, which is the one thing the live rationale has to get right.
 */
function appendBulletText(
  bullets: ExplainStreamBullet[],
  index: number,
  text: string,
): ExplainStreamBullet[] {
  const at = bullets.findIndex((bullet) => bullet.index === index);
  if (at === -1) {
    return [...bullets, { index, text, evidenceIds: [] }];
  }
  const next = bullets.slice();
  next[at] = { ...next[at], text: next[at].text + text };
  return next;
}

/** Fold one stream event into the card's state. */
export function applyExplanationEvent(
  state: ExplainStreamState,
  event: ExplanationStreamEvent,
): ExplainStreamState {
  switch (event.type) {
    case 'model':
      return { ...state, model: event.model };

    case 'summary':
      return {
        ...state,
        phase: 'streaming',
        summary: state.summary + event.text,
      };

    case 'bullet-delta':
      return {
        ...state,
        phase: 'streaming',
        bullets: appendBulletText(state.bullets, event.index, event.text),
      };

    case 'bullet':
      return {
        ...state,
        phase: 'streaming',
        bullets: upsertBullet(state.bullets, event.index, {
          text: event.text,
          evidenceIds: event.evidenceIds,
        }),
      };

    case 'action-delta': {
      // The action is written out character by character, like the claims.
      const actions = state.actions.slice();
      if (actions.length <= event.index) {
        actions.push(...Array.from({ length: event.index - actions.length }, () => ''));
      }
      actions[event.index] = (actions[event.index] ?? '') + event.text;
      return { ...state, phase: 'streaming', actions };
    }

    case 'action': {
      const actions = state.actions.slice();
      if (actions.length <= event.index) {
        // The stream is ordered; gaps only appear if a provider skips.
        actions.push(...Array.from({ length: event.index - actions.length }, () => ''));
      }
      actions[event.index] = event.text;
      return { ...state, phase: 'streaming', actions: actions.filter(Boolean) };
    }

    case 'done': {
      // The validated claim list is a subsequence of the streamed one and
      // the removed indexes are named: the survivors keep their original
      // positions, which the card keys on - nothing re-fades at `done`.
      const validated = event.explanation.bullets ?? [];
      const streamedCount =
        state.bullets.length > 0 ? state.bullets.length : validated.length + event.removedBulletIndexes.length;
      const removedSet = new Set(event.removedBulletIndexes);
      const originals: number[] = [];
      for (let index = 0; index < streamedCount; index += 1) {
        if (!removedSet.has(index)) originals.push(index);
      }
      return {
        ...state,
        phase: 'done',
        model: event.model,
        summary: event.explanation.summary ?? '',
        bullets: validated.map((bullet, at) => ({
          index: originals[at] ?? at,
          text: bullet.text,
          evidenceIds: bullet.evidenceIds ?? [],
        })),
        actions: event.explanation.recommendedActions ?? [],
        outcome: {
          explanation: event.explanation,
          groundedness: event.groundedness,
          removedBulletIndexes: event.removedBulletIndexes,
          generated: event.generated,
          model: event.model,
        },
      };
    }

    case 'error':
      return { ...state, phase: 'error', error: event.message };

    default:
      return state;
  }
}

/**
 * Generate an explanation, streamed.
 *
 * The answer arrives as server-sent events; every piece is handed to
 * `onEvent` as it lands. The returned promise settles with the validated
 * outcome from the `done` event, or rejects when the stream reports an
 * error or ends without one.
 *
 * A response that is not a stream - a deployment whose runtime buffers, or
 * an older backend - is still accepted: its JSON body is shaped like the
 * `done` event, so the caller cannot tell the difference.
 */
async function streamExplanation(
  report: AnalysisReport,
  options: { onEvent?: (event: ExplanationStreamEvent) => void; signal?: AbortSignal } = {},
): Promise<ExplanationResult> {
  const response = await fetch('/api/explain', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }

  const onEvent = (event: ExplanationStreamEvent) => options.onEvent?.(event);
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('text/event-stream')) {
    // A buffered, non-streaming backend: same fields the `done` event carries.
    const body = (await response.json()) as Partial<ExplanationResult>;
    const result: ExplanationResult = {
      explanation: body.explanation ?? { summary: '', bullets: [], recommendedActions: [] },
      groundedness:
        body.groundedness ?? {
          score: 0,
          validBullets: 0,
          invalidBullets: 0,
          unknownEvidenceIds: [],
          droppedBullets: [],
        },
      removedBulletIndexes: [],
      generated: body.generated ?? false,
      ...(body.model ? { model: body.model } : {}),
    };
    onEvent({
      type: 'done',
      explanation: result.explanation,
      groundedness: result.groundedness,
      removedBulletIndexes: result.removedBulletIndexes,
      generated: result.generated,
      model: result.model,
    });
    return result;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('The explanation stream could not be read');

  const decoder = new TextDecoder();
  let buffer = '';
  const finals: ExplanationResult[] = [];

  const consumeFrame = (frame: string): void => {
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      // Lines that do not start with `data:` are keepalive comments or field
      // lines; neither carries a payload here.
      if (!line.startsWith('data:')) continue;
      const content = line.slice(5).trim();
      if (!content || content === '[DONE]') continue;

      let event: ExplanationStreamEvent;
      try {
        event = JSON.parse(content) as ExplanationStreamEvent;
      } catch {
        continue;
      }

      if (event.type === 'done') {
        finals.push({
          explanation: event.explanation,
          groundedness: event.groundedness,
          removedBulletIndexes: event.removedBulletIndexes,
          generated: event.generated,
          model: event.model,
        });
      }
      if (event.type === 'error') {
        throw new Error(event.message);
      }
      onEvent(event);
    }
  };

  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        consumeFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim().length > 0) consumeFrame(buffer);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  void reader.cancel().catch(() => undefined);

  const final = finals.length > 0 ? finals[finals.length - 1] : null;
  if (!final) throw new Error('The explanation stream ended without a result');
  return final;
}

/**
 * Clear the cookies the browser is holding for this site.
 *
 * The session cookie is http-only, so a script cannot delete it - the
 * browser will not let it - and the server clears that one in answer to the
 * sign-out request. What a script *can* clear is everything the page set for
 * itself, and none of it should outlive the session it belonged to: the
 * cookie jar is emptied here, at the moment the visitor asks to leave.
 */
export function clearBrowserCookies(): void {
  if (typeof document === 'undefined') return;

  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (!name) continue;

    // Both ways round: a cookie set with Secure and one set without it are
    // separate entries, and only the matching one is replaced.
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
  }
}

export const api = {
  session: () =>
    request<{ user: SessionUser | null }>('/api/session').catch(() => ({ user: null })),

  /**
   * Which ways of signing in this deployment offers.
   *
   * The page asks before it draws a button it cannot honour: a deployment
   * without Google credentials would otherwise show a button that fails.
   */
  authProviders: () =>
    request<AuthProviders>('/api/auth').catch(() => ({
      emailPassword: true,
      google: false,
      authBaseUrl: '',
    })),

  signIn: (email: string, password: string) =>
    request<{ user: SessionUser }>('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ action: 'signIn', email, password }),
    }),

  /**
   * Start a Google sign-in in a popup.
   *
   * The Auth service holds the state of the attempt - and the session
   * challenge cookie the verifier is checked against - on its own domain. A
   * full-page redirect puts the OAuth round trip in a different partition from
   * the one that started it, and the challenge cookie does not travel with
   * it, so the verifier cannot be redeemed afterwards. A popup keeps the
   * round trip in one place, which is what the Auth service's own client
   * does for the same reason.
   *
   * The popup does the whole round trip and hands the verifier back through
   * `onVerifier`; the window that opened it redeems it.
   */
  signInWithGoogle: async (
    authBaseUrl: string,
    callbackUrl: string,
    onVerifier: (verifier: string) => void,
    onError: (message: string) => void,
  ) => {
    // The popup lands on the callback route with this marker, and the
    // callback route uses it to tell that it is running inside a popup.
    const popupCallback = `${callbackUrl}?neon_popup=1`;

    const response = await fetch(`${authBaseUrl}/sign-in/social`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        callbackURL: popupCallback,
        disableRedirect: true,
      }),
    });

    if (!response.ok) {
      onError(await describeFailure(response, 'Google sign-in could not be started'));
      return;
    }

    const body = (await response.json()) as { url?: string };
    if (!body.url) {
      onError('Google sign-in could not be started');
      return;
    }

    const popup = window.open(body.url, 'neon_oauth_popup', 'width=500,height=700,popup=yes');
    if (!popup) {
      onError('The sign-in window was blocked. Allow popups for this site and try again.');
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'neon-auth:oauth-complete') return;

      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      try {
        popup.close();
      } catch {
        // the popup closed itself
      }

      const verifier = event.data.verifier as string | undefined;
      if (!verifier) {
        onError('Google sign-in did not finish');
        return;
      }

      onVerifier(verifier);
    };

    window.addEventListener('message', onMessage);

    // If the user closes the window, no message is coming.
    const poll = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(poll);
      window.removeEventListener('message', onMessage);
      onError('Google sign-in was closed');
    }, 500);

    setTimeout(() => {
      clearInterval(poll);
      window.removeEventListener('message', onMessage);
    }, 120_000);
  },

  /**
   * Redeem a verifier and finish the sign-in.
   *
   * The verifier comes back from the popup. It is redeemed here, in the
   * window that started the attempt, because the challenge cookie it is
   * checked against is in this window's jar.
   */
  completeGoogleSignIn: async (authBaseUrl: string, verifier: string) => {
    const redeemed = await redeemSessionVerifier(authBaseUrl, verifier);
    if (!redeemed.ok) throw new Error(redeemed.detail);

    const token = await fetchSessionToken(authBaseUrl);
    if (!token) throw new Error('The Auth service did not issue a session token.');

    return api.signInWithToken(token);
  },

  /**
   * Hand a session token to the API, which turns it into this application's
   * own session.
   */
  signInWithToken: (token: string) =>
    request<{ user: SessionUser }>('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ action: 'signInWithToken', token }),
    }),

  signUp: (email: string, password: string, name: string, organization: string) =>
    request<{ user: SessionUser }>('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ action: 'signUp', email, password, name, organization }),
    }),

  /**
   * Sign out.
   *
   * Two things have to end: this application's own session, and the Auth
   * service's. The Auth service's session lives in a cookie on its own
   * domain, so only the browser can clear it - the API's request never
   * carries that cookie - and a Google sign-in has one.
   *
   * The two are cleared independently: the Auth service is asked to end its
   * own session even if the call to this application's API did not land, so
   * a failed request cannot leave a session that signs the visitor straight
   * back in.
   */
  signOut: async () => {
    // The cookie jar is emptied first, at the click: the session is over
    // before the round trip even starts.
    clearBrowserCookies();

    let result: { ok: boolean } | null = null;

    try {
      result = await request<{ ok: boolean }>('/api/auth', {
        method: 'POST',
        body: JSON.stringify({ action: 'signOut' }),
      });
    } catch {
      // The Auth service is still asked below, and the browser ends up
      // without a session either way.
    }

    if (AUTH_BASE_URL) {
      try {
        await fetch(`${AUTH_BASE_URL}/sign-out`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch {
        // The application's own session has already ended, which is what the
        // user asked for. A session left behind on the Auth service's domain
        // cannot sign anyone back into this application on its own.
      }
    }

    return result ?? { ok: true };
  },

  /**
   * Analyse a message.
   *
   * When the browser can run the classifier, the score it computes is sent
   * with the message and the server uses it. The raw message still reaches
   * the API - the other modules run there - but the semantic module's opinion
   * is the browser's, computed on the device.
   */
  analyze: async (text: string) => {
    const semantic = await scoreInBrowser(text);

    const response = await request<{ report: AnalysisReport }>('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        text,
        ...(semantic.status === 'ready' ? { semantic: { score: semantic.score, confidence: semantic.confidence } } : {}),
      }),
    });

    return { ...response, clientSemantic: semantic };
  },

  /**
   * Explain an analysis. Streams the rationale as it is written; the
   * promise settles with the validated outcome. See `streamExplanation`.
   */
  explain: (
    report: AnalysisReport,
    options: { onEvent?: (event: ExplanationStreamEvent) => void; signal?: AbortSignal } = {},
  ) => streamExplanation(report, options),

  feedback: (analysisId: string, verdict: 'confirmed_phishing' | 'confirmed_legitimate' | 'incorrect', note?: string) =>
    request<{ ok: boolean }>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ analysisId, verdict, note }),
    }),

  analyses: () => request<{ analyses: AnalysisReport[] }>('/api/analyses'),
};

export type { AnalysisReport, Evidence, Explanation, GroundednessReport };
