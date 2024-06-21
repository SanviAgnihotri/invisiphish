import { getSession } from './_lib/auth';
import {
  applyCors,
  headerValue,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from './_lib/http';

/**
 * Return the signed-in user, or null when there is no valid session.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    applyCors(req, res);

    const cookie = headerValue(req.headers, 'cookie');
    const { data } = await getSession(cookie);

    res.status(200).json({ user: data?.user ?? null });
  } catch (error) {
    sendError(res, error);
  }
}
