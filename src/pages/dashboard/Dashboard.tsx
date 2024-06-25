import React, { useEffect, useRef, useState } from 'react';
import { LogOut, Upload } from 'lucide-react';
import { api, applyExplanationEvent, clearBrowserCookies, emptyExplainState, type ExplainStreamState } from '@/lib/api';
import { Brand } from '@/components/Brand';
import { preloadClientModel } from '@/lib/ml/clientSemantic';
import { VerdictCard } from '@/pages/dashboard/VerdictCard';
import { ScoreBreakdown } from '@/pages/dashboard/ScoreBreakdown';
import { EvidenceList } from '@/pages/dashboard/EvidenceList';
import { ExplanationCard } from '@/pages/dashboard/ExplanationCard';
import { FeedbackWidget } from '@/pages/dashboard/FeedbackWidget';
import type { AnalysisReport } from '@/lib/ml/types';

export const Dashboard: React.FC = () => {
  const [processedCount, setProcessedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /** Only the latest analysis is on the page; scanning a new file replaces it. */
  const [report, setReport] = useState<AnalysisReport | null>(null);

  /** The explanation's live stream state - connecting, writing, verified. */
  const [explanation, setExplanation] = useState<ExplainStreamState>(() => emptyExplainState());
  /** The in-flight generation; aborting it is what "latest only" means here. */
  const explanationAbort = useRef<AbortController | null>(null);

  /** The phishing probability the browser computed for the latest message. */
  const [clientScore, setClientScore] = useState<number | null>(null);

  // The checkpoint is large, so it loads in the background and the page does
  // not wait for it.
  useEffect(() => {
    preloadClientModel();
    return () => explanationAbort.current?.abort();
  }, []);

  const requestExplanation = (target: AnalysisReport) => {
    explanationAbort.current?.abort();
    const controller = new AbortController();
    explanationAbort.current = controller;

    setExplanation({ ...emptyExplainState(), phase: 'connecting' });

    api
      .explain(target, {
        signal: controller.signal,
        onEvent: (event) => {
          // A run replaced mid-flight by a newer one must not paint.
          if (controller.signal.aborted) return;
          setExplanation((state) => applyExplanationEvent(state, event));
        },
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setExplanation((state) => ({
          ...state,
          phase: 'error',
          error: caught instanceof Error ? caught.message : 'The explanation could not be generated',
        }));
      });
  };

  const analyzeText = async (text: string) => {
    setLoading(true);
    setError('');

    try {
      const { report, clientSemantic } = await api.analyze(text);
      // Only the latest analysis stays on the page: scanning another file
      // removes the previous file's result cards from the DOM.
      setReport(report);
      setProcessedCount((count) => count + 1);
      setClientScore(clientSemantic.status === 'ready' ? clientSemantic.score : null);
      // The rationale starts streaming as soon as the verdict is known.
      requestExplanation(report);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the selection so scanning the same file a second time still
    // fires a change event: the browser raises none while the previous file
    // is still attached to the input.
    event.target.value = '';
    if (!file) return;
    await analyzeText(await file.text());
  };

  const signOut = async () => {
    // The cookies go first, at the click, and the session ends with them:
    // the cookie jar is emptied before the request that ends the session on
    // the server even starts.
    clearBrowserCookies();
    await api.signOut().catch(() => undefined);
    window.location.replace('/');
  };

  return (
    <div className="min-h-screen bg-zinc-50/60 text-zinc-950">
      {/* ---------- Top bar ---------- */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-6">
          <Brand />

          <div className="flex items-center gap-2">
            <button type="button" onClick={signOut} className="btn-secondary h-8">
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scan a message</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Select a file; the verdict arrives with its reasoning, streamed beside the evidence it cites.
          </p>
        </div>

        {/* One grid, one seam: every row splits at the same 7/5 line, so the
            page reads as a single instrument panel instead of loose boxes. */}
        <div className="mt-6 grid gap-4 lg:grid-cols-12">
          {/* ---------- Upload ---------- */}
          <div className="card p-3 lg:col-span-7">
            {error && (
              <div className="error-banner mb-3">
                <span className="break-words">{error}</span>
              </div>
            )}

            <label
              className={`flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-8 text-center transition-colors ${
                loading
                  ? 'cursor-wait border-zinc-200 bg-zinc-50'
                  : 'cursor-pointer border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50'
              }`}
            >
              <span
                className={`grid h-9 w-9 place-items-center rounded-full border bg-white ${
                  loading
                    ? 'border-zinc-200 text-zinc-300'
                    : 'border-zinc-200 text-zinc-400'
                }`}
              >
                <Upload className="h-4 w-4" />
              </span>
              <span className="mt-2 text-sm font-medium text-zinc-900">
                {loading ? 'Analyzing…' : 'Select a file'}
              </span>
              <span className="mt-0.5 text-xs text-zinc-500">
                .txt · .csv · .json — analysed as a single message
              </span>
              <input
                type="file"
                onChange={handleFileUpload}
                disabled={loading}
                accept=".txt,.csv,.json"
                className="sr-only"
              />
            </label>
          </div>

          {/* ---------- Counter ---------- */}
          <div className="card flex flex-col p-6 lg:col-span-5">
            <p className="text-sm text-zinc-500">Processed</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">{processedCount}</p>
            <p className="mt-auto pt-4 text-xs leading-relaxed text-zinc-400">
              Only the latest result stays on the page. The full history is stored server-side.
            </p>
          </div>

          {/* ---------- The latest analysis ---------- */}
          {report && (
            <>
              {/* The verdict is the first and biggest thing on the page. */}
              <div className="lg:col-span-7">
                <VerdictCard
                  verdict={report.verdict}
                  finalScore={report.finalScore}
                  confidence={report.confidence}
                  clientScore={clientScore}
                />
              </div>
              <div className="lg:col-span-5">
                <ScoreBreakdown contributions={report.contributions} modules={report.modules} />
              </div>

              {/* The rationale streams here while the model writes; the
                  evidence it cites sits beside it, ids matching ids. */}
              <div className="lg:col-span-7">
                <ExplanationCard
                  stream={explanation}
                  onRegenerate={() => requestExplanation(report)}
                />
              </div>
              <div className="lg:col-span-5">
                <EvidenceList evidence={report.evidence} />
              </div>

              {report.id && (
                <div className="lg:col-span-12">
                  <FeedbackWidget analysisId={report.id} />
                </div>
              )}
            </>
          )}
        </div>

        {/* ---------- Empty state ---------- */}
        {!report && (
          <div className="py-20 text-center">
            <p className="text-sm font-medium text-zinc-900">Nothing scanned yet</p>
            <p className="mt-1 text-sm text-zinc-500">Select a file above to begin.</p>
          </div>
        )}
      </main>
    </div>
  );
};
