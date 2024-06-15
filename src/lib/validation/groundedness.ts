/**
 * Groundedness validation for generated explanations.
 *
 * The paper's explainability claim is that the generative module is "constrained
 * to cite only features computed by Vigil". This module is where that
 * constraint is actually enforced: after the model writes an explanation, every
 * claim is checked against the evidence table, and anything that cannot be traced
 * back to computed evidence is dropped.
 *
 * The check is deterministic and offline, which makes it testable and makes it
 * usable as a release gate: an explanation whose groundedness falls below a
 * threshold is never shown to the user.
 */

import type { AllowedAction, Evidence, Explanation, GroundednessReport } from '@/lib/ml/types';

/**
 * Catalogue of recommended actions.
 *
 * Actions are drawn from a closed vocabulary so that the model cannot invent
 * advice. The `evidenceKinds` field records which computed signals justify the
 * action, which lets the caller derive the action set deterministically.
 */
export const RECOMMENDED_ACTIONS: AllowedAction[] = [
  {
    id: 'do-not-click',
    text: 'Do not click any link or open any attachment in this message.',
    evidenceKinds: ['url', 'domain', 'pattern', 'semantic', 'intent'],
  },
  {
    id: 'no-credentials',
    text: 'Do not enter passwords, card details, or one-time codes on any page reached from this message.',
    evidenceKinds: ['url', 'domain', 'semantic'],
  },
  {
    id: 'verify-out-of-band',
    text: 'Verify the request through a channel you already trust, such as the official site or the number printed on your card.',
    evidenceKinds: ['url', 'domain', 'semantic', 'intent'],
  },
  {
    id: 'inspect-sender',
    text: 'Inspect the real sender address and reply-to domain rather than the display name.',
    evidenceKinds: ['pattern', 'semantic', 'intent'],
  },
  {
    id: 'slow-down',
    text: 'Treat urgency, scarcity, or reward pressure as a warning sign and take time to verify.',
    evidenceKinds: ['intent'],
  },
  {
    id: 'report-and-delete',
    text: 'Report this message to your security team and then delete it.',
    evidenceKinds: ['semantic', 'pattern', 'intent', 'url', 'domain'],
  },
];

/**
 * Derive the recommended actions purely from the computed evidence.
 *
 * This is used as the deterministic floor: even if the generative layer returns
 * nothing usable, the user still receives advice that is justified by evidence.
 */
export function deriveRecommendedActions(
  evidence: Evidence[],
  catalogue: AllowedAction[] = RECOMMENDED_ACTIONS,
): string[] {
  const kinds = new Set(evidence.map((item) => item.kind));
  return catalogue
    .filter((action) => action.evidenceKinds.some((kind) => kinds.has(kind)))
    .map((action) => action.text);
}

export interface ValidationOptions {
  catalogue?: AllowedAction[];
  /** Explanations below this groundedness score are considered unusable. */
  minGroundedness?: number;
}

export interface ValidationOutcome {
  /** The explanation with ungrounded content removed. */
  explanation: Explanation;
  report: GroundednessReport;
  /** True when the explanation cleared the groundedness threshold. */
  acceptable: boolean;
}

/**
 * Validate a generated explanation against the evidence table.
 *
 * A bullet is rejected when it cites no evidence, or when it cites evidence ids
 * that were never computed. Recommended actions are rejected when they are not
 * in the closed catalogue.
 */
export function validateExplanation(
  explanation: Explanation,
  evidence: Evidence[],
  options: ValidationOptions = {},
): ValidationOutcome {
  const catalogue = options.catalogue ?? RECOMMENDED_ACTIONS;
  const minGroundedness = options.minGroundedness ?? 0.5;

  const knownIds = new Set(evidence.map((item) => item.id));
  const unknownEvidenceIds = new Set<string>();
  const droppedBullets: { text: string; reason: string }[] = [];

  const validBullets: Explanation['bullets'] = [];
  let invalidBullets = 0;

  for (const bullet of explanation.bullets ?? []) {
    const cited = (bullet.evidenceIds ?? []).filter((id) => knownIds.has(id));

    if ((bullet.evidenceIds ?? []).length === 0) {
      invalidBullets += 1;
      droppedBullets.push({ text: bullet.text, reason: 'The claim cites no computed evidence.' });
      continue;
    }

    for (const id of bullet.evidenceIds) {
      if (!knownIds.has(id)) unknownEvidenceIds.add(id);
    }

    if (cited.length === 0) {
      invalidBullets += 1;
      droppedBullets.push({
        text: bullet.text,
        reason: `The claim cites unknown evidence: ${(bullet.evidenceIds ?? []).join(', ')}.`,
      });
      continue;
    }

    validBullets.push({ text: bullet.text, evidenceIds: cited });
  }

  const allowedTexts = new Set(catalogue.map((action) => action.text));
  const recommendedActions = (explanation.recommendedActions ?? []).filter((action) =>
    allowedTexts.has(action),
  );

  const totalBullets = validBullets.length + invalidBullets;
  const score = totalBullets === 0 ? 0 : Number((validBullets.length / totalBullets).toFixed(4));

  const report: GroundednessReport = {
    score,
    validBullets: validBullets.length,
    invalidBullets,
    unknownEvidenceIds: [...unknownEvidenceIds],
    droppedBullets,
  };

  const cleaned: Explanation = {
    summary: explanation.summary ?? '',
    bullets: validBullets,
    recommendedActions:
      recommendedActions.length > 0
        ? recommendedActions
        : deriveRecommendedActions(evidence, catalogue),
  };

  return {
    explanation: cleaned,
    report,
    acceptable: score >= minGroundedness,
  };
}

/**
 * Render the evidence table as the compact, closed input block that the
 * generative layer is allowed to use.
 *
 * The raw message is deliberately *not* included: the model receives computed
 * findings, not attacker-controlled text, which removes the prompt-injection
 * surface from the explanation step entirely.
 */
export function buildEvidenceTable(evidence: Evidence[]): string {
  if (evidence.length === 0) return '(no evidence was computed for this message)';

  return evidence
    .map((item) => {
      const detail = item.detail.replace(/\s+/g, ' ').slice(0, 240);
      return `- [${item.id}] (${item.kind}, score ${item.score.toFixed(2)}) ${item.label}: ${detail}`;
    })
    .join('\n');
}
