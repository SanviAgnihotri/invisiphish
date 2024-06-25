import React from 'react';
import type { Verdict } from '@/lib/ml/types';

const STYLES: Record<Verdict, { chip: string; label: string }> = {
  phishing: {
    chip: 'bg-red-50 text-red-700',
    label: 'Phishing',
  },
  suspicious: {
    chip: 'bg-amber-50 text-amber-700',
    label: 'Suspicious',
  },
  legitimate: {
    chip: 'bg-emerald-50 text-emerald-700',
    label: 'Likely legitimate',
  },
};

interface VerdictCardProps {
  verdict: Verdict;
  finalScore: number;
  confidence: number;
  latencyMs?: number;
  /** The browser's own phishing probability for the same message, when the
      on-device model was ready to run. Reporting it keeps the server verdict
      checkable against an independent reading. */
  clientScore?: number | null;
}

/** The verdict itself: risk score and confidence, nothing else. */
export const VerdictCard: React.FC<VerdictCardProps> = ({
  verdict,
  finalScore,
  confidence,
  latencyMs,
  clientScore = null,
}) => {
  const style = STYLES[verdict];

  return (
    <div className="card flex h-full flex-col p-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${style.chip}`}>
            {style.label}
          </span>
          <p className="mt-3 text-5xl font-semibold tabular-nums tracking-tight text-zinc-950">
            {(finalScore * 100).toFixed(1)}
            <span className="text-xl text-zinc-400">%</span>
          </p>
          <p className="text-sm text-zinc-500">phishing risk</p>
        </div>

        <dl className="flex gap-8 text-right">
          <div>
            <dt className="text-xs text-zinc-500">Confidence</dt>
            <dd className="mt-0.5 text-lg font-medium tabular-nums text-zinc-950">
              {(confidence * 100).toFixed(1)}%
            </dd>
          </div>
          {latencyMs !== undefined && (
            <div>
              <dt className="text-xs text-zinc-500">Latency</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums text-zinc-950">{latencyMs} ms</dd>
            </div>
          )}
        </dl>
      </div>

      {clientScore !== null && (
        <p className="mt-auto border-t border-zinc-100 pt-4 text-xs text-zinc-400">
          Browser classifier: {(clientScore * 100).toFixed(1)}% phishing probability
        </p>
      )}
    </div>
  );
};
