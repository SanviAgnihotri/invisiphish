import { explainFromEvidence } from './_lib/explain';
import { withUser } from './_lib/db';
import { getSession } from './_lib/auth';
import type { AnalysisReport, Evidence } from '../src/lib/ml/types';
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

interface ExplainBody {
  report?: AnalysisReport;
}

/**
 * Generate an evidence-grounded explanation for an analysis - streamed.
 *
 * The answer is a server-sent events stream: the rationale pieces reach the
 * browser as the model writes them, and the validated object with its
 * groundedness report rides last as the `done` event.
 *
 * The generative model receives only the computed evidence, never the raw
 * message, and every claim it produces is validated against the evidence
 * table before the reader's final view of it.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  let streaming = false;
  try {
    applyCors(req, res);
    requireMethod(req, ['POST']);

    const cookie = headerValue(req.headers, 'cookie');
    const { data: session } = await getSession(cookie);
    if (!session) throw new HttpError(401, 'Not signed in');

    const body = (await readJson(req)) as ExplainBody;
    const report = body.report;
    if (!report) throw new HttpError(400, 'report is required');

    const evidence = (report.evidence ?? []) as Evidence[];
    if (evidence.length === 0) {
      throw new HttpError(422, 'No evidence was computed for this analysis');
    }

    // Past this point the answer is a stream, not a JSON envelope.
    streaming = true;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // The first events cost nothing, and the keepalive below holds the
    // connection open while the first model starts working.
    const keepalive = setInterval(() => res.write(': ping\n\n'), 10_000);

    try {
      const outcome = await explainFromEvidence(evidence, report.verdict, report.finalScore, send);

      await withUser(session.userId, async (client) => {
        await client.query(
          `update public.analysis_results
              set explanation = $1::jsonb, groundedness = $2::jsonb
            where id = $3 and user_id = $4`,
          [
            JSON.stringify(outcome.explanation),
            JSON.stringify(outcome.groundedness),
            report.id,
            session.userId,
          ],
        );

        await client.query(
          `select app.write_audit('explain', 'analysis_results', $1, $2::jsonb)`,
          [
            report.id,
            JSON.stringify({
              groundedness: outcome.groundedness.score,
              generated: outcome.generated,
              model: outcome.model ?? null,
            }),
          ],
        );
      }).catch((error) => console.warn('[explain] could not persist:', error));
    } catch (streamError) {
      const message =
        streamError instanceof Error ? streamError.message : 'The explanation could not be generated';
      console.warn('[explain] stream failed:', message);
      send({ type: 'error', message });
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  } catch (error) {
    if (streaming) {
      // The stream has already been announced; the reader gets the failure
      // as an event rather than as a JSON body that never arrives.
      const message = error instanceof Error ? error.message : 'Unexpected error';
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.end();
      } catch {
        // the connection is gone; nothing else to do
      }
      return;
    }
    sendError(res, error);
  }
}
