import React from 'react';
import type { Evidence } from '@/lib/ml/types';

const KIND_LABELS: Record<string, string> = {
  semantic: 'Semantic',
  url: 'URL',
  domain: 'Domain',
  pattern: 'Pattern',
  intent: 'Intent',
  lexical: 'Lexical',
};

interface EvidenceListProps {
  evidence: Evidence[];
}

/**
 * Every reason the system had, each with the stable id that the explanation
 * layer cites. Showing the ids makes the grounding of the rationale checkable
 * by eye. The card stretches with its grid row, so the evidence rail always
 * matches the height of the rationale beside it; a list longer than that
 * rail scrolls inside the card instead of pushing the rest of the page down.
 */
export const EvidenceList: React.FC<EvidenceListProps> = ({ evidence }) => {
  if (evidence.length === 0) {
    return (
      <div className="card h-full p-6">
        <h3 className="text-sm font-medium text-zinc-900">Evidence</h3>
        <p className="mt-2 text-sm text-zinc-500">No signals were computed for this message.</p>
      </div>
    );
  }

  return (
    <div className="card flex h-full flex-col p-6">
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-900">Evidence</h3>
        <span className="text-xs text-zinc-400">{evidence.length} items</span>
      </div>

      <ul className="mt-3 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {evidence.map((item) => (
          <li key={item.id} className="rounded-lg bg-zinc-50 px-3.5 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] font-medium text-zinc-950">{item.label}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
                {(item.score * 100).toFixed(0)}%
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-zinc-500">{item.detail}</p>
            <p className="mt-1 font-mono text-[11px] text-zinc-400">
              {item.id} · {KIND_LABELS[item.kind] ?? item.kind}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
};
