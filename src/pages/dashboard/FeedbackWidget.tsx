import React, { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';

interface FeedbackWidgetProps {
  analysisId: string;
}

/**
 * Lets the user confirm or correct a prediction.
 *
 * The correction is recorded but is not applied to the pattern repository
 * immediately: promotion requires several distinct users to agree, which is
 * the poisoning defence described in the paper's limitations.
 */
export const FeedbackWidget: React.FC<FeedbackWidgetProps> = ({ analysisId }) => {
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (verdict: 'confirmed_phishing' | 'confirmed_legitimate' | 'incorrect') => {
    setBusy(true);
    try {
      await api.feedback(analysisId, verdict);
      setSent(verdict);
    } catch {
      setSent('error');
    } finally {
      setBusy(false);
    }
  };

  if (sent && sent !== 'error') {
    return (
      <div className="card flex items-center gap-2.5 p-4">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
        <p className="text-sm text-zinc-500">Feedback recorded. Thank you.</p>
      </div>
    );
  }

  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="text-sm text-zinc-500">Is this verdict correct?</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => submit('confirmed_phishing')}
          className="btn-secondary h-8 border-red-200 text-red-700 hover:bg-red-50"
        >
          Phishing
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => submit('confirmed_legitimate')}
          className="btn-secondary h-8 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
        >
          Legitimate
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => submit('incorrect')}
          className="btn-secondary h-8"
        >
          Wrong verdict
        </button>
      </div>
      {sent === 'error' && (
        <p className="text-xs text-red-700">Could not record the feedback. Please try again.</p>
      )}
    </div>
  );
};
