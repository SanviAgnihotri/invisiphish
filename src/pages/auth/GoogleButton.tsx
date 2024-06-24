import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';

/**
 * The Google mark.
 *
 * Google's brand guidelines ask for the official four-colour G rather than a
 * monochrome one, so it is drawn here rather than pulled from an icon set.
 */
const GoogleMark: React.FC = () => (
  <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

interface GoogleButtonProps {
  /** The URL of the Auth service, with its mount point. */
  authBaseUrl: string;
  /** The wording on the button. */
  label?: string;
  /** The divider text between the button and the email form. */
  divider?: string;
}

/**
 * Sign in with Google.
 *
 * The Auth service runs the OAuth flow in a popup, because the state of the
 * attempt lives in cookies on the Auth service's own domain and a
 * full-page redirect loses them. The popup hands back a one-time verifier,
 * which this window redeems - it holds the challenge cookie that the
 * verifier is checked against - and the session token that follows is what
 * this application's API verifies.
 */
export const GoogleButton: React.FC<GoogleButtonProps> = ({
  authBaseUrl,
  label = 'Continue with Google',
  divider = 'or',
}) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleClick = async () => {
    setLoading(true);
    setError('');

    try {
      await api.signInWithGoogle(
        authBaseUrl,
        `${window.location.origin}/auth/google/callback`,
        async (verifier) => {
          try {
            await api.completeGoogleSignIn(authBaseUrl, verifier);
            navigate('/dashboard', { replace: true });
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : 'Google sign-in did not finish',
            );
            setLoading(false);
          }
        },
        (message) => {
          setError(message);
          setLoading(false);
        },
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start Google sign-in');
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading || !authBaseUrl}
        className="btn-secondary w-full"
      >
        <GoogleMark />
        {loading ? 'Waiting for Google…' : label}
      </button>

      {error && (
        <div className="error-banner mt-3">
          <span className="break-words">{error}</span>
        </div>
      )}

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-zinc-200" />
        <span className="text-xs text-zinc-400">{divider}</span>
        <span className="h-px flex-1 bg-zinc-200" />
      </div>
    </div>
  );
};
