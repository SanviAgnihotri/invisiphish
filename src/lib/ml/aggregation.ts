/**
 * Aggregation engine.
 *
 * Combines the parallel detection modules into a single classification while
 * retaining the traceable per-module evidence described in the system
 * architecture. Modules that failed or were skipped are dropped and their
 * weight is redistributed, so the pipeline degrades gracefully instead of
 * silently scoring a message on one weak signal.
 */

import type {
  AggregationResult,
  Evidence,
  ModuleId,
  ModuleResult,
  ScoreContribution,
  Verdict,
} from '@/lib/ml/types';

export interface ModuleWeight {
  module: ModuleId;
  weight: number;
  enabled: boolean;
}

export interface Thresholds {
  /** Score at or above which a message is treated as suspicious. */
  suspicious: number;
  /** Score at or above which a message is treated as phishing. */
  phishing: number;
}

/**
 * Default weights.
 *
 * These are starting values, not fitted ones. They are intentionally kept in a
 * single file so that they can be swept offline (`npm run eval`) and replaced
 * with values fitted on a held-out split.
 */
export const DEFAULT_WEIGHTS: ModuleWeight[] = [
  { module: 'semantic', weight: 0.4, enabled: true },
  { module: 'url-intel', weight: 0.25, enabled: true },
  { module: 'pattern', weight: 0.2, enabled: true },
  { module: 'intent', weight: 0.15, enabled: true },
];

export const DEFAULT_THRESHOLDS: Thresholds = {
  suspicious: 0.4,
  phishing: 0.7,
};

export interface AggregateOptions {
  weights?: ModuleWeight[];
  thresholds?: Thresholds;
  /** Ignore modules whose own confidence is below this value. */
  minConfidence?: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Fuse module results into a single score, verdict and confidence.
 */
export function aggregate(
  modules: ModuleResult[],
  options: AggregateOptions = {},
): AggregationResult {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const minConfidence = options.minConfidence ?? 0;

  const weightFor = new Map(weights.map((entry) => [entry.module, entry]));
  const configuredWeight = weights
    .filter((entry) => entry.enabled)
    .reduce((sum, entry) => sum + entry.weight, 0);

  const eligible = modules.filter((result) => {
    if (result.status !== 'ok') return false;
    const configured = weightFor.get(result.module);
    if (!configured || !configured.enabled) return false;
    if (result.confidence < minConfidence) return false;
    return true;
  });

  if (eligible.length === 0) {
    return {
      finalScore: 0,
      verdict: 'legitimate',
      confidence: 0,
      contributions: [],
      rankedEvidence: [],
    };
  }

  const eligibleWeight = eligible.reduce(
    (sum, result) => sum + (weightFor.get(result.module)?.weight ?? 0),
    0,
  );

  const contributions: ScoreContribution[] = eligible.map((result) => {
    const raw = weightFor.get(result.module)?.weight ?? 0;
    const weight = eligibleWeight === 0 ? 0 : raw / eligibleWeight;
    return {
      module: result.module,
      weight: Number(weight.toFixed(6)),
      score: result.score,
      contribution: Number((weight * result.score).toFixed(6)),
      status: result.status,
    };
  });

  const finalScore = contributions.reduce((sum, entry) => sum + entry.contribution, 0);

  // Agreement between modules, expressed as a weighted variance around the mean.
  const variance = contributions.reduce(
    (sum, entry) => sum + entry.weight * (entry.score - finalScore) ** 2,
    0,
  );
  const agreement = clamp01(1 - 2 * Math.sqrt(Math.max(0, variance)));

  // Confidence is damped by coverage: a score derived from one module out of
  // four must not be presented with the same confidence as a full ensemble.
  const coverage = configuredWeight === 0 ? 0 : clamp01(eligibleWeight / configuredWeight);
  const confidence = clamp01(agreement * coverage);

  const verdict: Verdict =
    finalScore >= thresholds.phishing
      ? 'phishing'
      : finalScore >= thresholds.suspicious
        ? 'suspicious'
        : 'legitimate';

  const rankedEvidence: Evidence[] = eligible
    .flatMap((result) => result.evidence)
    .map((evidence) => ({ ...evidence }))
    .sort((a, b) => b.score * b.severity - a.score * a.severity);

  return {
    finalScore: Number(finalScore.toFixed(6)),
    verdict,
    confidence: Number(confidence.toFixed(6)),
    contributions,
    rankedEvidence,
  };
}
