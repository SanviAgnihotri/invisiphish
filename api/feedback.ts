import { getSession } from './_lib/auth';
import { withUser } from './_lib/db';
import {
  HttpError,
  applyCors,
  headerValue,
  readJson,
  requireMethod,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from './_lib/http';

interface FeedbackBody {
  analysisId?: string;
  verdict?: 'confirmed_phishing' | 'confirmed_legitimate' | 'incorrect';
  note?: string;
}

const VALID_VERDICTS = new Set([
  'confirmed_phishing',
  'confirmed_legitimate',
  'incorrect',
]);

/**
 * Record a user correction.
 *
 * Feedback is stored but is *not* applied to the pattern repository straight
 * away. Promotion requires several distinct users to agree, which is the
 * poisoning defence described in the paper's limitations section.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    applyCors(req, res);
    requireMethod(req, ['POST']);

    const cookie = headerValue(req.headers, 'cookie');
    const { data: session } = await getSession(cookie);
    if (!session) throw new HttpError(401, 'Not signed in');

    const body = (await readJson(req)) as FeedbackBody;

    if (!body.analysisId) throw new HttpError(400, 'analysisId is required');
    if (!body.verdict || !VALID_VERDICTS.has(body.verdict)) {
      throw new HttpError(400, 'verdict must be one of confirmed_phishing, confirmed_legitimate, incorrect');
    }

    await withUser(session.userId, async (client) => {
      const inserted = await client.query(
        `insert into public.feedback (analysis_id, user_id, verdict, note)
         select $1, $2, $3, $4
          where exists (
            select 1 from public.analysis_results
             where id = $1 and user_id = $2
          )
         returning id`,
        [body.analysisId, session.userId, body.verdict, (body.note ?? '').trim() || null],
      );

      if (inserted.rowCount === 0) {
        throw new HttpError(404, 'Analysis not found');
      }

      await client.query(
        `select app.write_audit('feedback', 'feedback', $1, $2::jsonb)`,
        [body.analysisId, JSON.stringify({ verdict: body.verdict })],
      );
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
}
