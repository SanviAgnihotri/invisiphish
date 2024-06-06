/**
 * Intent / manipulation analysis.
 *
 * Phishing messages manipulate behaviour rather than carry sentiment, so this
 * module measures the social-engineering pressure in a message: urgency,
 * scarcity, authority impersonation, fear and reward baiting.
 *
 * Deliberately implemented as a deterministic, offline lexicon scorer. It has no
 * network latency, no API cost and no rate limit, which means it can always act
 * as a stable baseline signal, and it is fully unit testable.
 */

import type { Evidence, ModuleId, ModuleResult } from '@/lib/ml/types';

export type IntentDimension = 'urgency' | 'scarcity' | 'authority' | 'fear' | 'reward';

export interface IntentScores {
  urgency: number;
  scarcity: number;
  authority: number;
  fear: number;
  reward: number;
  /** Mean of the five dimensions. */
  overall: number;
}

export interface IntentLexiconEntry {
  pattern: RegExp;
  weight: number;
}

const LEXICON: Record<IntentDimension, IntentLexiconEntry[]> = {
  urgency: [
    { pattern: /\b(immediate(ly)?|right away|right now|asap|as soon as possible|act now|urgent(ly)?|do not delay|expires? (in|soon)|last (chance|warning)|final notice)\b/i, weight: 0.9 },
    { pattern: /\b(don'?t delay|hurry|quick(ly)?|fast|now)\b/i, weight: 0.5 },
  ],
  scarcity: [
    { pattern: /\b(limited (time|offer|availability)|only (the first|remaining|\d+)|last chance|while supplies last|exclusive offer|deal (expires|ends))\b/i, weight: 0.85 },
    { pattern: /\b(unavailable|out of stock|sold out|offer ends|expires (today|soon|tonight))\b/i, weight: 0.6 },
  ],
  authority: [
    { pattern: /\b(official|government|tax (authority|department)|police|court|legal (action|notice)|bank|your bank|ministry|regulator|law enforcement)\b/i, weight: 0.7 },
    { pattern: /\b(ceo|cfo|director|administrator|support team|help desk|it department|security team)\b/i, weight: 0.6 },
    { pattern: /\b(we have detected|suspicious activity was detected|your account (has been|was) (locked|suspended)|compliance)\b/i, weight: 0.85 },
  ],
  fear: [
    { pattern: /\b(penalty|prosecut|criminal charges|legal action|fine of|consequences|suspend(ed|ing)?|blocked|seized|repossession)\b/i, weight: 0.85 },
    { pattern: /\b(you (will|are going to) (lose|be|have)|danger|warning|failure to comply|unauthorised|unauthorized)\b/i, weight: 0.7 },
  ],
  reward: [
    { pattern: /\b(free (gift|prize|money|airspace|voucher)|claim your|you('ve| have) won|winner|congratulat\w+|cash prize|bonus)\b/i, weight: 0.9 },
    { pattern: /\b(refund|rebate|cashback|voucher|coupon|promo(tion)? code)\b/i, weight: 0.5 },
  ],
};

const DIMENSION_LABELS: Record<IntentDimension, string> = {
  urgency: 'Pressure to act immediately',
  scarcity: 'Scarcity and limited-time framing',
  authority: 'Impersonation of a legitimate authority',
  fear: 'Threatening consequences',
  reward: 'Promise of an unexpected reward',
};

const DIMENSION_ORDER: IntentDimension[] = ['urgency', 'scarcity', 'authority', 'fear', 'reward'];

function scoreDimension(text: string, dimension: IntentDimension): { score: number; hits: string[] } {
  let score = 0;
  const hits: string[] = [];

  for (const entry of LEXICON[dimension]) {
    const match = text.match(entry.pattern);
    if (!match) continue;
    hits.push(match[0].toLowerCase());
    // Multiple independent cues in the same dimension reinforce each other but
    // with diminishing returns, so the score stays inside 0..1.
    score += entry.weight * (1 + Math.max(0, hits.length - 2) * 0.15);
  }

  return { score: Math.min(1, Number(score.toFixed(4))), hits };
}

/** Score the manipulation cues present in a message. */
export function analyzeIntentScores(text: string): IntentScores {
  const scores: Partial<IntentScores> = {};

  for (const dimension of DIMENSION_ORDER) {
    scores[dimension] = scoreDimension(text, dimension).score;
  }

  const values = DIMENSION_ORDER.map((dimension) => scores[dimension] as number);
  const overall = values.reduce((sum, value) => sum + value, 0) / values.length;

  return { ...(scores as Required<Omit<IntentScores, 'overall'>>), overall: Number(overall.toFixed(4)) };
}

/**
 * Run the intent module and return it in the standard module shape.
 */
export function runIntentModule(
  text: string,
  moduleId: ModuleId = 'intent',
): ModuleResult {
  const startedAt = performance.now();

  try {
    const scores = analyzeIntentScores(text);
    const evidence: Evidence[] = [];

    for (const dimension of DIMENSION_ORDER) {
      const value = scores[dimension];
      if (value <= 0) continue;

      const { hits } = scoreDimension(text, dimension);
      evidence.push({
        id: `ev_intent_${dimension}`,
        kind: 'intent',
        module: moduleId,
        label: DIMENSION_LABELS[dimension],
        detail: `Detected cue${hits.length > 1 ? 's' : ''}: ${hits.slice(0, 4).join(', ')}.`,
        score: value,
        severity: value,
        meta: { dimension, hits },
      });
    }

    return {
      module: moduleId,
      status: 'ok',
      score: scores.overall,
      confidence: evidence.length === 0 ? 0.2 : Math.min(1, 0.5 + scores.overall / 2),
      evidence,
      latencyMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      module: moduleId,
      status: 'error',
      score: 0,
      confidence: 0,
      evidence: [],
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown error in intent analysis',
    };
  }
}
