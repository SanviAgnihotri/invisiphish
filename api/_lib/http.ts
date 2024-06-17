/**
 * Small helpers shared by the API routes.
 *
 * The route handlers are written against a minimal structural interface rather
 * than the Vercel types, so the same handlers can be mounted by the Vercel
 * runtime, by the local development server, or by a test harness.
 */

export interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  /**
   * Stream a piece of the answer out.
   *
   * Headers, the status and any cookies are materialized on the first
   * write, so a route can start a server-sent-events response without
   * knowing anything about the underlying runtime. After the first write
   * the headers are on the wire and no further header can be changed.
   */
  write(chunk: string): void;
  /** `Set-Cookie` is the reason arrays are accepted: several cookies go out in one call. */
  setHeader(name: string, value: string | string[]): void;
  end(): void;
}

/** Read and parse a JSON body, with a size guard. */
export async function readJson(req: ApiRequest, limitBytes = 256 * 1024): Promise<unknown> {
  const raw = req.body;

  if (raw === undefined || raw === null) return {};

  if (typeof raw === 'string') {
    if (raw.length > limitBytes) throw new HttpError(413, 'Request body too large');
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Request body is not valid JSON');
    }
  }

  if (typeof raw === 'object') return raw;

  throw new HttpError(400, 'Unsupported request body');
}

/** Reject any method other than the allowed ones. */
export function requireMethod(req: ApiRequest, allowed: string[]): void {
  const method = (req.method ?? 'GET').toUpperCase();
  if (!allowed.includes(method)) {
    throw new HttpError(405, `Method ${method} not allowed`);
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Read a header that may arrive as a string or an array of strings. */
export function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Standard error envelope. */
export function sendError(res: ApiResponse, error: unknown): void {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message, details: error.details ?? null });
    return;
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  console.error('[api] unhandled error:', error);
  res.status(500).json({ error: message });
}

/**
 * Allow the browser to call the API from this application's own origin.
 *
 * The application and the API are served from the same origin, so a
 * cross-origin call is never legitimate. Answering every origin with `*`
 * would let any site on the internet read what this API says - the session,
 * the analyses, the evidence - so the origin is echoed only when it is the
 * one the request came to, and the credentials header goes with it.
 */
export function applyCors(req: ApiRequest, res: ApiResponse): void {
  const origin = headerValue(req.headers, 'origin');
  const host = headerValue(req.headers, 'host');

  if (origin && host) {
    try {
      if (new URL(origin).host === host) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
    } catch {
      // not a URL we can compare; no header, and the browser will block it
    }
  }

  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
