import { useEffect, useState } from 'react';
import { api, AUTH_BASE_URL } from '../api';

/**
 * Where the Auth service lives.
 *
 * The build already knows the address, so the sign-in page can draw the
 * Google button in its first paint. A build made without that address - a
 * checkout without the deployment's configuration - falls back to asking the
 * API, and the button appears a moment later.
 */
export function useAuthBaseUrl(): string {
  const [url, setUrl] = useState(AUTH_BASE_URL);

  useEffect(() => {
    if (url) return;

    let active = true;
    void api.authProviders().then((providers) => {
      if (active) setUrl(providers.authBaseUrl);
    });

    return () => {
      active = false;
    };
  }, [url]);

  return url;
}
