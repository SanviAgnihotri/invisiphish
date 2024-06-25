import React from 'react';
import type { ModuleResult, ScoreContribution } from '@/lib/ml/types';

const MODULE_LABELS: Record<string, string> = {
  semantic: 'DistilBERT (semantic)',
  'url-intel': 'URL intelligence',
  pattern: 'FP-Growth patterns',
  intent: 'Intent analysis',
  'domain-intel': 'Domain intelligence',
};

interface ScoreBreakdownProps {
  contributions: ScoreContribution[];
  modules: ModuleResult[];
}

/**
 * Shows exactly how the final score was assembled.
 *
 * Modules that could not run are listed separately with their reason, so a
 * low confidence is always explainable.
 */
export const ScoreBreakdown: React.FC<ScoreBreakdownProps> = ({ contributions, modules }) => {
  const skipped = modules.filter((module) => module.status !== 'ok');

  return (
    <div className="card h-full p-6">
      <h3 className="text-sm font-medium text-zinc-900">Score breakdown</h3>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200">
            <th className="pb-2 text-left text-xs font-normal text-zinc-500">Module</th>
            <th className="pb-2 text-right text-xs font-normal text-zinc-500">Score</th>
            <th className="pb-2 text-right text-xs font-normal text-zinc-500">Weight</th>
            <th className="pb-2 text-right text-xs font-normal text-zinc-500">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {contributions.map((entry) => (
            <tr key={entry.module} className="border-b border-zinc-100 last:border-0">
              <td className="py-2 text-zinc-900">{MODULE_LABELS[entry.module] ?? entry.module}</td>
              <td className="py-2 text-right tabular-nums text-zinc-500">
                {(entry.score * 100).toFixed(1)}%
              </td>
              <td className="py-2 text-right tabular-nums text-zinc-500">
                {(entry.weight * 100).toFixed(1)}%
              </td>
              <td className="py-2 text-right font-medium tabular-nums text-zinc-950">
                {(entry.contribution * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {skipped.length > 0 && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          <p>
            {skipped.length} module{skipped.length === 1 ? '' : 's'} did not run. Their weight was
            redistributed, which lowers the reported confidence.
          </p>
          <ul className="mt-1 space-y-0.5">
            {skipped.map((module) => (
              <li key={module.module}>
                {MODULE_LABELS[module.module] ?? module.module}: {module.error ?? module.status}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
