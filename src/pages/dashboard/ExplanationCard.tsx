import React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ExplainStreamState } from '@/lib/api';

interface ExplanationCardProps {
  /** The generation's live state, folded by `applyExplanationEvent`. */
  stream: ExplainStreamState;
  /** Regenerate adopts for the done and error states. */
  onRegenerate?: () => void;
}

/**
 * The streamed rationale.
 *
 * While the model writes, the text appears below a blinking caret and every
 * finished claim fades in with the evidence ids it cites. The `done` event
 * is authoritative: it replaces the live text with what survived
 * verification and brings the groundedness figure, so what a claim looked
 * like mid-stream is not a promise about the final reading.
 */
export const ExplanationCard: React.FC<ExplanationCardProps> = ({ stream, onRegenerate }) => {
  const { phase, summary, bullets, actions, outcome, error } = stream;
  const groundedness = outcome?.groundedness;
  const removed = outcome?.removedBulletIndexes ?? [];
  const streaming = phase === 'connecting' || phase === 'streaming';
  const hasContent = summary.length > 0 || bullets.length > 0 || actions.length > 0;

  /** The caret rides the last thing still being written. */
  const caret = (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse rounded-full bg-zinc-400 align-middle"
    />
  );

  return (
    <div className="card h-full p-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium text-zinc-900">Why this verdict</h3>

        <div className="flex items-center gap-1.5">
          {streaming && (
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-zinc-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-zinc-500" />
              </span>
              Writing
            </span>
          )}
          {phase === 'done' && outcome?.generated === false && (
            <span
              className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500"
              title="No model key is configured; the deterministic fallback answered"
            >
              fallback
            </span>
          )}
          {phase === 'done' && groundedness && (
            <span
              className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500"
              title="Fraction of claims that cite evidence computed by the pipeline"
            >
              grounded {(groundedness.score * 100).toFixed(0)}%
            </span>
          )}
          {phase !== 'connecting' && onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-950"
              title={phase === 'error' ? 'Retry' : 'Regenerate'}
            >
              <RefreshCw className="h-3 w-3" />
              {phase === 'error' ? 'Retry' : 'Regenerate'}
            </button>
          )}
        </div>
      </div>

      {streaming && !hasContent && (
        /* Connecting to the model: a quiet skeleton, not a static "Generating…". */
        <div className="mt-4 space-y-2.5" aria-hidden="true">
          <div className="h-3.5 w-4/5 animate-pulse rounded bg-zinc-100" />
          <div className="h-3.5 w-3/5 animate-pulse rounded bg-zinc-100" />
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-zinc-100" />
        </div>
      )}

      {error && phase === 'error' && (
        <div className="error-banner mt-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {(summary.length > 0 || bullets.length > 0) && phase !== 'error' && (
        <>
          {summary.length > 0 && (
            <p className="mt-3 text-[14.5px] leading-relaxed text-zinc-950">
              {summary}
              {streaming && bullets.length === 0 && caret}
            </p>
          )}

          {bullets.length > 0 && (
            <ul className="mt-3 space-y-2">
              {bullets.map((bullet, at) => (
                <motion.li
                  key={bullet.index}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22 }}
                  className="flex items-start gap-2.5 text-sm"
                >
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-300" />
                  <span className="text-zinc-600">
                    {bullet.text}
                    {streaming && at === bullets.length - 1 && caret}
                    {bullet.evidenceIds.length > 0 && (
                      <span className="ml-1.5 font-mono text-[11px] text-zinc-400">
                        {bullet.evidenceIds.join(', ')}
                      </span>
                    )}
                  </span>
                </motion.li>
              ))}
            </ul>
          )}
        </>
      )}

      {actions.length > 0 && (
        <div className="mt-4 border-t border-zinc-100 pt-4">
          <p className="text-xs font-medium text-zinc-500">What to do</p>
          <ul className="mt-1.5 space-y-1">
            {actions.map((action, index) => (
              <li key={index} className="text-sm text-zinc-900">
                {action}
              </li>
            ))}
          </ul>
        </div>
      )}

      {phase === 'done' && (
        <p className="mt-3 text-xs text-zinc-400">
          {removed.length > 0
            ? `${removed.length} claim${removed.length === 1 ? '' : 's'} did not survive verification and ${
                removed.length === 1 ? 'was' : 'were'
              } removed.`
            : `Every claim cites computed evidence.${
                outcome?.model ? ` Answered by ${outcome.model}.` : ''
              }`}
        </p>
      )}
    </div>
  );
};
