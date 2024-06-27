import { getSession } from './_lib/auth';
import { withUser } from './_lib/db';
import {
  HttpError,
  applyCors,
  headerValue,
  requireMethod,
  sendError,
  type ApiRequest,
  type ApiResponse,
} from './_lib/http';
import type { AnalysisReport, ModuleResult, ScoreContribution, Evidence } from '../src/lib/ml/types';

/**
 * The caller's own analyses, most recent first.
 *
 * The browser client calls this route to show a history, and it was the one
 * route the client referenced that did not exist: `src/lib/api.ts` has always
 * asked for `/api/analyses`, and the request had nothing to land on.
 *
 * The rows are read through `withUser`, so the caller's identity is in the
 * transaction and the Row Level Security policies decide what is visible. The
 * route does not filter by user id in the query: the policy does it, and a
 * route that filtered by hand could be wrong in a way the policy is not.
 */

/** How many analyses one page of history holds. */
const LIMIT = 50;

interface AnalysisRow {
  id: string;
  final_score: number;
  verdict: string;
  confidence: number;
  module_results: ModuleResult[];
  evidence: Evidence[];
  contributions: ScoreContribution[];
  model_version: string | null;
  created_at: string;
}

/** Rebuild the report the client already knows how to render. */
function toReport(row: AnalysisRow): AnalysisReport {
  return {
    id: row.id,
    finalScore: Number(row.final_score),
    verdict: row.verdict as AnalysisReport['verdict'],
    confidence: Number(row.confidence),
    modules: row.module_results ?? [],
    evidence: row.evidence ?? [],
    contributions: row.contributions ?? [],
    createdAt: new Date(row.created_at).toISOString(),
    modelVersion: row.model_version ?? undefined,
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    applyCors(req, res);
    requireMethod(req, ['GET']);

    const cookie = headerValue(req.headers, 'cookie');
    const { data: session } = await getSession(cookie);
    if (!session) throw new HttpError(401, 'Not signed in');

    const rows = await withUser(session.userId, async (client) => {
      const result = await client.query(
        `select id, final_score, verdict, confidence, module_results, evidence,
                contributions, model_version, created_at
           from public.analysis_results
          order by created_at desc
          limit $1`,
        [LIMIT],
      );

      return (result.rows as AnalysisRow[]).map(toReport);
    });

    res.status(200).json({ analyses: rows });
  } catch (error) {
    sendError(res, error);
  }
}
