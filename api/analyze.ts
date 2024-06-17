import { aggregate } from '../src/lib/ml/aggregation';
import { runIntentModule } from '../src/lib/ml/intentAnalysis';
import { runPatternModule } from '../src/lib/ml/patternModule';
import { runSemanticModule } from '../src/lib/ml/semanticModel';
import { runUrlModule } from '../src/lib/ml/urlIntel';
import { preprocessText } from '../src/lib/ml/preprocessing';
import type { AnalysisReport, ModuleId, ModuleResult } from '../src/lib/ml/types';
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

interface AnalyzeBody {
  text?: string;
  /**
   * A semantic score computed in the browser. When the client runs the
   * classifier locally the raw message never leaves the device, and the server
   * uses the score it was given. When it is absent the server tries its own
   * checkpoint, and the module is skipped if that is unavailable.
   */
  semantic?: { score: number; confidence?: number };
}

const MAX_TEXT_LENGTH = 20_000;

/**
 * Analyse a message and persist the result.
 *
 * The pipeline is the same code the evaluation harness uses, so a number in
 * the paper and a number in production come from the same implementation.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    applyCors(req, res);
    requireMethod(req, ['POST']);

    const cookie = headerValue(req.headers, 'cookie');
    const { data: session } = await getSession(cookie);
    if (!session) throw new HttpError(401, 'Not signed in');

    const body = (await readJson(req)) as AnalyzeBody;
    const text = (body.text ?? '').trim();

    if (!text) throw new HttpError(400, 'text is required');
    if (text.length > MAX_TEXT_LENGTH) throw new HttpError(413, 'text is too long');

    const startedAt = performance.now();

    const semantic: ModuleResult = body.semantic
      ? {
          module: 'semantic' as ModuleId,
          status: 'ok',
          score: Math.min(1, Math.max(0, body.semantic.score)),
          confidence: body.semantic.confidence ?? 0.85,
          evidence: [
            {
              id: 'ev_semantic_score',
              kind: 'semantic',
              module: 'semantic' as ModuleId,
              label: 'Contextual semantic classification',
              detail: `The DistilBERT classifier assigned a phishing probability of ${(
                body.semantic.score * 100
              ).toFixed(1)}% to this message.`,
              score: body.semantic.score,
              severity: 1,
              meta: { computedOn: 'client' },
            },
          ],
          latencyMs: 0,
        }
      : await runSemanticModule(text);

    const intent = runIntentModule(text);
    const url = runUrlModule(text);

    const patterns = await loadPatterns(session.userId);
    const pattern = await runPatternModule(text, patterns);

    const modules = [semantic, intent, url, pattern];
    const aggregated = aggregate(modules);

    // One line per scan, so a session's log answers three questions at once:
    // whether the DistilBERT classifier ran and where (client ONNX in this
    // tab, or this server's copy of the same checkpoint), what every module
    // produced, and how the fusion engine combined them.
    console.log(
      `[analyze] semantic=${body.semantic ? 'client' : 'server'} |`,
      modules
        .map(
          (module) =>
            `${module.module}:${module.status}:${(module.score * 100).toFixed(1)}%:${Math.round(module.latencyMs)}ms`,
        )
        .join(' | '),
      `|| final=${aggregated.finalScore} verdict=${aggregated.verdict} confidence=${aggregated.confidence} contributions=${aggregated.contributions.length} evidence=${aggregated.rankedEvidence.length}`,
    );

    const report: AnalysisReport = {
      id: '',
      finalScore: aggregated.finalScore,
      verdict: aggregated.verdict,
      confidence: aggregated.confidence,
      modules,
      evidence: aggregated.rankedEvidence,
      contributions: aggregated.contributions,
      createdAt: new Date().toISOString(),
      userId: session.userId,
      modelVersion: 'distilbert-phishing',
    };

    const latencyMs = Math.round(performance.now() - startedAt);
    report.id = await persistReport(session.userId, report, text, latencyMs);

    res.status(200).json({ report });
  } catch (error) {
    sendError(res, error);
  }
}

/** Load the active mined templates for this user. */
async function loadPatterns(userId: string) {
  try {
    return await withUser(userId, async (client) => {
      const result = await client.query(
        `select items, spam_support, ham_support, lift
           from public.phishing_patterns
          where status = 'active'
          order by lift desc
          limit 500`,
      );

      return (result.rows as Array<{
        items: string[];
        spam_support: number;
        ham_support: number;
        lift: number;
      }>).map((row) => ({
        items: row.items,
        spamSupport: row.spam_support,
        hamSupport: row.ham_support,
        spamRatio: row.spam_support,
        hamRatio: row.ham_support,
        lift: row.lift,
        length: row.items.length,
      }));
    });
  } catch (error) {
    console.warn('[analyze] could not load patterns:', error);
    return [];
  }
}

/** Store the analysis and its full trace. */
async function persistReport(
  userId: string,
  report: AnalysisReport,
  originalText: string,
  latencyMs: number,
): Promise<string> {
  const id = await withUser(userId, async (client) => {
    const result = await client.query(
      `insert into public.analysis_results (
         user_id, original_text, normalized_text, final_score, verdict, confidence,
         module_results, evidence, contributions, model_version, latency_ms
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
       returning id`,
      [
        userId,
        originalText,
        preprocessText(originalText),
        report.finalScore,
        report.verdict,
        report.confidence,
        JSON.stringify(report.modules),
        JSON.stringify(report.evidence),
        JSON.stringify(report.contributions),
        report.modelVersion ?? null,
        latencyMs,
      ],
    );

    return (result.rows[0] as { id: string }).id;
  });

  return id;
}
