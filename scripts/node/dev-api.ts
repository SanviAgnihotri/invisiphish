/**
 * The API routes, served in development.
 *
 * In production the handlers in `api/` run as Vercel functions. In
 * development nothing serves them, so every `/api/*` call from the browser
 * is a 404 and the app cannot be used at all. This module mounts the same
 * handlers on the Vite dev server, on the same origin as the SPA, so the
 * session cookie is a first-party cookie and `credentials: 'include'` works.
 *
 * The handlers are written against the structural `ApiRequest`/`ApiResponse`
 * interfaces in `api/_lib/http.ts` rather than against the Vercel types, so
 * the same code runs in both places. This module is the adapter between Node's
 * HTTP objects and those two interfaces.
 *
 * The handlers are loaded with Vite's own module loader, so there is no build
 * step and no second copy of the source.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  write(chunk: string): void;
  setHeader(name: string, value: string | string[]): void;
  end(): void;
}

/** The routes the dev server serves, in the order they are matched. */
const ROUTES = [
  'session',
  'auth',
  'google-callback',
  'analyze',
  'analyses',
  'explain',
  'feedback',
] as const;

/** Read the whole request body as a string. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The request headers as the plain object the handlers expect. */
function readHeaders(request: IncomingMessage): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

/**
 * Adapt Node's response to the interface the handlers use.
 *
 * `setHeader` accumulates rather than sets immediately: `api/auth.ts` sets
 * `Set-Cookie` more than once - once for the Auth service's own cookie and
 * once for the clearing cookie - and a plain `res.setHeader` would lose the
 * first one. The accumulated headers, the cookies and the status are
 * materialized on the first write, `json` or `end`, which is also what lets
 * `api/explain.ts` begin a server-sent-events stream with an explicit
 * `Content-Type` without the adapter's own `application/json` overriding it.
 */
function adaptResponse(response: ServerResponse): ApiResponse {
  const cookies: string[] = [];
  const headers: [string, string | string[]][] = [];
  let status = 200;
  let committed = false;
  let ended = false;

  const flush = (): void => {
    if (committed || response.headersSent) return;
    committed = true;
    response.statusCode = status;
    for (const [name, value] of headers) response.setHeader(name, value);
    if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
  };

  const hasContentType = (): boolean =>
    headers.some(([name]) => name.toLowerCase() === 'content-type');

  const api: ApiResponse = {
    status(code: number) {
      status = code;
      return api;
    },
    setHeader(name: string, value: string | string[]) {
      if (name.toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) cookies.push(...value);
        else cookies.push(value);
        return;
      }
      if (committed || response.headersSent) return; // too late to matter
      headers.push([name, value]);
    },
    write(chunk: string) {
      if (ended) return;
      flush();
      response.write(chunk);
    },
    json(body: unknown) {
      if (ended) return;
      ended = true;
      // A handler that set its own Content-Type (a stream) wins.
      if (!hasContentType()) headers.push(['Content-Type', 'application/json']);
      flush();
      response.end(JSON.stringify(body));
    },
    end() {
      if (ended) return;
      ended = true;
      flush();
      response.end();
    },
  };

  return api;
}

/** Parse the body the way `api/_lib/http.ts` expects it. */
function parseBody(raw: string, contentType: string | undefined): unknown {
  if (raw.length === 0) return {};
  if (contentType && contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * The Vite plugin that serves the API in development.
 */
export function apiDevServer(): Plugin {
  return {
    name: 'invisiphish-api-dev-server',
    configResolved(config) {
      // The API handlers read their configuration from `process.env`, and
      // Vite only puts the `VITE_`-prefixed variables into `import.meta.env`.
      // The env files are therefore loaded into the process here, the way a
      // production runtime would provide them. A variable that is already in
      // the environment wins, so `DATABASE_URL=... npm run dev` still works.
      const env = loadEnv(config.mode, config.envDir ?? process.cwd(), '');

      for (const [key, value] of Object.entries(env)) {
        // A variable that is already in the environment wins, so
        // `DATABASE_URL=... npm run dev` still works. An empty value does not
        // count as set: Vite restarts the server in the same process when an
        // env file changes, and an empty string loaded on the first start
        // would otherwise wedge the later value out of the process for good.
        if (process.env[key] === undefined || process.env[key] === '') {
          process.env[key] = value;
        }
      }
    },
    configureServer(server) {
      // The module namespace is cached, but the handler is read from it on
      // every request. Caching the function itself would keep the handler
      // that was loaded first, so an edit to an API route - or to the library
      // it imports - would not take effect until the dev server was
      // restarted. The namespace is cheap to hold: Vite re-evaluates the
      // module behind it when a file changes.
      const modules = new Map<string, Promise<Record<string, unknown>>>();

      server.middlewares.use('/api', async (request, response, next) => {
        const route = (request.url ?? '').split('?')[0].replace(/^\/+|\/+$/g, '');

        if (!ROUTES.includes(route as (typeof ROUTES)[number])) {
          next();
          return;
        }

        try {
          let loaded = modules.get(route);
          if (!loaded) {
            loaded = server.ssrLoadModule(`/api/${route}.ts`) as Promise<
              Record<string, unknown>
            >;
            modules.set(route, loaded);
          }

          const module = await loaded;
          const handler = module.default as Handler | undefined;
          if (typeof handler !== 'function') {
            throw new Error(`api/${route}.ts has no default export`);
          }

          const raw = await readBody(request);
          const url = new URL(request.url ?? '/', 'http://localhost');

          const apiRequest: ApiRequest = {
            method: request.method,
            headers: readHeaders(request),
            body: parseBody(raw, request.headers['content-type']),
            query: Object.fromEntries(url.searchParams.entries()),
          };

          await handler(apiRequest, adaptResponse(response));
        } catch (error) {
          // A failure in the adapter must still be a JSON answer, never an
          // HTML error page: the browser client reads JSON either way. If
          // headers are already out - a stream that died mid-flight - the
          // connection is simply closed.
          const message = error instanceof Error ? error.message : 'Unexpected error';
          if (response.headersSent) {
            response.end();
          } else {
            response.statusCode = 500;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ error: message }));
          }
        }
      });
    },
  };
}
