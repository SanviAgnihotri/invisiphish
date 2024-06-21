/**
 * Session state for the app.
 *
 * The session cookie is http-only and managed by Neon Auth, so the browser
 * asks the API for the current session. The hook re-checks when the tab
 * regains focus, which covers sign-in, sign-out and cookie expiry.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, fetchSessionToken, type SessionUser } from '@/lib/api';

export interface SessionState {
  user: SessionUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useSession(): SessionState {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user: current } = await api.session();
      setUser(current);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Renew a session that has run out.
   *
   * The token the Auth service issues lasts a quarter of an hour, while the
   * session behind it lasts longer. When the API says there is no session,
   * the Auth service may still hold one - it does for a Google sign-in, where
   * the session lives on the Auth service's own domain - so the browser asks
   * it for a fresh token and hands that over instead.
   *
   * A user who signed in with an email and a password has nothing to renew:
   * that session is the Auth service's own cookie, and it lasts as long as
   * the Auth service says it does.
   */
  const renew = useCallback(async () => {
    try {
      const providers = await api.authProviders();
      const token = await fetchSessionToken(providers.authBaseUrl);
      if (!token) return false;

      await api.signInWithToken(token);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { user: current } = await api.session();

      if (!current) {
        const renewed = await renew();
        if (renewed) {
          const { user: renewed_user } = await api.session();
          setUser(renewed_user);
          setLoading(false);
          return;
        }
      }

      setUser(current);
      setLoading(false);
    })();
  }, [renew]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };

    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [refresh]);

  return { user, loading, refresh };
}

/**
 * A cheap "is anyone signed in?" check.
 *
 * The hook above also tries to renew a session that has run out, which is
 * worth doing on a private page and worth avoiding on a public one: the
 * landing page only needs to know whether to offer a sign-in or a dashboard,
 * and the sign-in page only needs to know whether to get out of the way.
 */
export function useCurrentUser(): { user: SessionUser | null; loading: boolean } {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const check = () => {
      api
        .session()
        .then(({ user: current }) => {
          if (active) setUser(current);
        })
        .catch(() => {
          if (active) setUser(null);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };

    check();

    // A sign-in in another tab changes what this page should offer.
    const onFocus = () => {
      if (document.visibilityState === 'visible') check();
    };

    document.addEventListener('visibilitychange', onFocus);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  return { user, loading };
}
