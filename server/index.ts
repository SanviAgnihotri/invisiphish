/**
 * The production server.
 *
 * On Vercel the API routes in `api/` are functions and the frontend is
 * static files. On a machine of our own there is no such thing, so this
 * serves both: the built frontend out of `dist/`, and the same API handlers
 * under `/api`.
 *
 * The handlers were written against structural interfaces rather than against
 * any runtime's request and response types - that is what let the same code
 * run on Vercel and in development - so mounting them here is a matter of
 * adapting Node's objects to those two interfaces, which is the whole of this
 * file.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATIC_DIR = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * Load the environment from a file, before anything that reads it.
 *
 * The handlers read their configuration from `process.env` when they are
 * imported, so this has to run first. The format is the one the application
 * already uses: `KEY=value`, one per line, `#` for a comment.
 */
function loadEnv(file: string): void {
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(process.env.ENV_FILE ?? path.join(ROOT, '.env.local'));

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

/**
 * The API routes.
 *
 * They are imported lazily so that the environment is in place before the
 * modules that read it are evaluated.
 */
const ROUTES: Record<string, () => Promise<{ default: Handler }>> = {
  session: () => import('../api/session'),
  auth: () => import('../api/auth'),
  analyze: () => import('../api/analyze'),
  analyses: () => import('../api/analyses'),
  explain: () => import('../api/explain'),
  feedback: () => import('../api/feedback'),
};

const handlers = new Map<string, Handler>();

async function handlerFor(route: string): Promise<Handler> {
  const cached = handlers.get(route);
  if (cached) return cached;

  const load = ROUTES[route];
  if (!load) throw new Error(`Unknown route: ${route}`);

  const module = await load();
  const handler = module.default;
  if (typeof handler !== 'function') {
    throw new Error(`api/${route}.ts has no default export`);
  }

  handlers.set(route, handler);
  return handler;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Read the whole body of a request. */
function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Adapt Node's response to the interface the handlers use. */
function adaptResponse(response: http.ServerResponse) {
  const cookies: string[] = [];
  let status = 200;
  let sent = false;

  const api = {
    status(code: number) {
      status = code;
      return api;
    },
    setHeader(name: string, value: string | string[]) {
      // `Set-Cookie` is set more than once: the Auth service's own cookie
      // and the one that clears it. A plain `setHeader` would lose the first.
      //
      // A caller may also hand over an array of cookies in one call. It has
      // to be flattened here: Node turns a nested array into a single
      // comma-joined header, and a browser reads that as one cookie whose
      // attributes continue into the next - so every cookie after the first
      // is silently dropped, including the one that clears the session.
      if (name.toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) cookies.push(...value);
        else cookies.push(value);
        return;
      }
      if (!response.headersSent) response.setHeader(name, value);
    },
    json(body: unknown) {
      if (sent) return;
      sent = true;
      if (!response.headersSent) {
        response.statusCode = status;
        if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      response.end(JSON.stringify(body));
    },
    /**
     * Write a piece of a streamed response.
     *
     * The explanation endpoint answers with server-sent events: each event
     * is written as the model produces it, and the response ends when the
     * answer is complete. Without this the stream never leaves the server,
     * and the reader is left with a rationale that began and went nowhere.
     */
    write(chunk: string) {
      if (sent) return;
      if (!response.headersSent) {
        response.statusCode = status;
        if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
        if (!response.hasHeader('Content-Type')) {
          response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        }
        if (!response.hasHeader('Cache-Control')) {
          response.setHeader('Cache-Control', 'no-cache, no-transform');
        }
        if (!response.hasHeader('Connection')) {
          response.setHeader('Connection', 'keep-alive');
        }
        // A proxy between here and the browser must not hold the stream back
        // in a buffer: the whole point is that the text arrives as it is
        // written.
        if (!response.hasHeader('X-Accel-Buffering')) {
          response.setHeader('X-Accel-Buffering', 'no');
        }
      }
      response.write(chunk);
    },
    end() {
      if (sent) return;
      sent = true;
      if (!response.headersSent) {
        response.statusCode = status;
        if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
      }
      response.end();
    },
  };

  return api;
}

/** Parse the body the way the handlers expect it. */
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

/** Serve a file from `dist/`, or the frontend itself for an unknown path. */
function serveStatic(pathname: string, response: http.ServerResponse): boolean {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = path.join(STATIC_DIR, relative);

  // Never serve anything outside the build directory.
  if (!candidate.startsWith(STATIC_DIR)) return false;

  // A path names either a file (`/favicon.svg`) or a page (`/login`, which is
  // built as `/login.html`). The prebuilt pages are served under their own
  // name, so the browser paints them without waiting for the bundle.
  const targets = relative ? [candidate, `${candidate}.html`] : [candidate];

  for (const target of targets) {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;

    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': fs.statSync(target).size,
      // The model is large and its contents never change under a name.
      'Cache-Control': target.includes('/models/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
    });
    fs.createReadStream(target).pipe(response);
    return true;
  }

  // The frontend is a single page application: every path it does not know
  // is a route in the browser, not a file on disk.
  const index = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(index)) {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    });
    fs.createReadStream(index).pipe(response);
    return true;
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    const route = url.pathname.slice('/api/'.length).replace(/\/+$/, '');

    try {
      const handler = await handlerFor(route);
      const raw = await readBody(request);

      const apiRequest = {
        method: request.method,
        headers: request.headers as Record<string, string | string[] | undefined>,
        body: parseBody(raw, request.headers['content-type']),
        query: Object.fromEntries(url.searchParams.entries()),
      };

      await handler(apiRequest, adaptResponse(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      console.error('[server]', error);

      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (serveStatic(url.pathname, response)) return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`InvisiPhish listening on http://${HOST}:${PORT}`);
  console.log(`  frontend: ${STATIC_DIR}`);
  console.log(`  auth    : ${process.env.NEON_AUTH_BASE_URL ?? '(not configured)'}`);
  console.log(`  model   : ${process.env.MODEL_DIR ?? '(default)'}`);
});
