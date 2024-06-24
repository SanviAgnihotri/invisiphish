import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, fetchSessionToken, redeemSessionVerifier } from '@/lib/api';
import { AuthLayout } from '@/pages/auth/AuthLayout';

interface Diagnostic {
  label: string;
  detail: string;
}

/** The marker that tells the callback route it is running inside a popup. */
const POPUP_MARKER = 'neon_popup';

/** The message the popup sends back to the window that opened it. */
const POPUP_MESSAGE = 'neon-auth:oauth-complete';

/**
 * Where Google sends the browser back to.
 *
 * The Auth service creates the session and hands it over in the URL of this
 * callback as a one-time `neon_auth_session_verifier`. The verifier is
 * redeemed with
 *
 *     GET {NEON_AUTH_BASE_URL}/get-session?neon_auth_session_verifier=...
 *
 * which has to happen in the browser, because it is checked against the
 * session challenge cookie the Auth service set when the sign-in started -
 * a cookie only the browser holds, and host-only to the Auth service's
 * domain.
 *
 * When the sign-in happens in a popup, this route does not redeem anything
 * itself. It passes the verifier back to the window that opened the popup
 * and closes, because the window that started the sign-in is the one holding
 * the challenge cookie for that attempt.
 *
 * When it cannot, the page says exactly what it tried, because the reason
 * lives in the browser and nowhere else.
 */
export const GoogleCallback: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [message, setMessage] = useState('Finishing sign-in...');
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const started = useRef(false);

  useEffect(() => {
    // The effect runs twice in development, and the second run must not
    // redeem the verifier a second time: it is good for one use only.
    if (started.current) return;
    started.current = true;

    const verifier = searchParams.get('neon_auth_session_verifier') ?? '';

    // Inside a popup: hand the verifier back to the opener and close.
    if (searchParams.get(POPUP_MARKER) === '1' && window.opener) {
      window.opener.postMessage(
        { type: POPUP_MESSAGE, verifier },
        window.location.origin,
      );
      window.close();
      return;
    }

    const finish = async () => {
      const report: Diagnostic[] = [];

      const other = [...searchParams.keys()].filter(
        (key) => key !== 'neon_auth_session_verifier' && key !== POPUP_MARKER,
      );
      report.push({
        label: 'Callback URL',
        detail: verifier
          ? `verifier ${verifier.slice(0, 8)}...${other.length ? `, ${other.join(', ')}` : ''}`
          : `no verifier${other.length ? `, ${other.join(', ')}` : ''}`,
      });

      try {
        const providers = await api.authProviders();
        report.push({ label: 'Auth service', detail: providers.authBaseUrl || '(not configured)' });

        // The redemption is the step the verifier exists for.
        const redeemed = await redeemSessionVerifier(providers.authBaseUrl, verifier);
        report.push({ label: 'Verifier', detail: redeemed.detail });
        if (!redeemed.ok) throw new Error(redeemed.detail);

        // The session token this application's API can check.
        const token = await fetchSessionToken(providers.authBaseUrl);
        report.push({
          label: 'Session token',
          detail: token ? 'received' : 'the Auth service did not give one',
        });
        if (!token) throw new Error('The Auth service did not issue a session token.');

        await api.signInWithToken(token);
        setDiagnostics(report);
        navigate('/dashboard', { replace: true });
      } catch (error) {
        const text = error instanceof Error ? error.message : 'Google sign-in failed';
        report.push({ label: 'Failure', detail: text });
        setDiagnostics(report);
        setMessage(text);
        setTimeout(() => navigate(`/login?error=${encodeURIComponent(text)}`), 4000);
      }
    };

    void finish();
  }, [navigate, searchParams]);

  return (
    <AuthLayout title={message}>
      {diagnostics.length > 0 && (
        <div className="rounded-lg border border-zinc-200 text-left">
          <div className="border-b border-zinc-200 px-3.5 py-2 text-xs font-medium text-zinc-500">
            What happened
          </div>
          <dl className="space-y-2 px-3.5 py-3 text-sm">
            {diagnostics.map((item) => (
              <div key={item.label} className="grid grid-cols-3 gap-2">
                <dt className="text-zinc-500">{item.label}</dt>
                <dd className="col-span-2 break-all font-mono text-xs text-zinc-900">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </AuthLayout>
  );
};
