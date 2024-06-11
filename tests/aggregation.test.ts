import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, aggregate } from '../src/lib/ml/aggregation';
import type { Evidence, ModuleResult } from '../src/lib/ml/types';

const evidence = (id: string, score: number, severity = 1): Evidence => ({
  id,
  kind: 'semantic',
  module: 'semantic',
  label: `Evidence ${id}`,
  detail: 'detail',
  score,
  severity,
});

const module = (
  id: ModuleResult['module'],
  status: ModuleResult['status'],
  score: number,
  confidence = 0.9,
  evidenceList: Evidence[] = [],
): ModuleResult => ({
  module: id,
  status,
  score,
  confidence,
  evidence: evidenceList,
  latencyMs: 1,
});

describe('aggregation engine', () => {
  it('renormalises weights over the modules that actually ran', () => {
    const result = aggregate([
      module('semantic', 'ok', 0.9),
      module('url-intel', 'ok', 0.7),
      module('pattern', 'error', 0, 0, []),
      module('intent', 'ok', 0.5),
    ]);

    // semantic .40, url .25, intent .15 -> total .80 -> renormalised .50/.3125/.1875
    expect(result.finalScore).toBeCloseTo(0.5 * 0.9 + 0.3125 * 0.7 + 0.1875 * 0.5, 5);
    expect(result.contributions).toHaveLength(3);
    expect(result.contributions.find((entry) => entry.module === 'pattern')).toBeUndefined();
  });

  it('assigns the correct verdict from the thresholds', () => {
    expect(aggregate([module('semantic', 'ok', 0.9)]).verdict).toBe('phishing');
    expect(aggregate([module('semantic', 'ok', 0.5)]).verdict).toBe('suspicious');
    expect(aggregate([module('semantic', 'ok', 0.1)]).verdict).toBe('legitimate');
  });

  it('returns a zero result when every module failed', () => {
    const result = aggregate([
      module('semantic', 'error', 0),
      module('url-intel', 'skipped', 0),
    ]);

    expect(result.finalScore).toBe(0);
    expect(result.verdict).toBe('legitimate');
    expect(result.confidence).toBe(0);
    expect(result.contributions).toHaveLength(0);
  });

  it('damps confidence when only part of the ensemble ran', () => {
    const full = aggregate([
      module('semantic', 'ok', 0.8),
      module('url-intel', 'ok', 0.8),
      module('pattern', 'ok', 0.8),
      module('intent', 'ok', 0.8),
    ]);
    const partial = aggregate([module('semantic', 'ok', 0.8)]);

    expect(full.confidence).toBeGreaterThan(partial.confidence);
    expect(partial.confidence).toBeLessThan(1);
  });

  it('penalises disagreement between modules', () => {
    const agreed = aggregate([
      module('semantic', 'ok', 0.8),
      module('url-intel', 'ok', 0.8),
    ]);
    const disagreed = aggregate([
      module('semantic', 'ok', 0.95),
      module('url-intel', 'ok', 0.1),
    ]);

    expect(agreed.confidence).toBeGreaterThan(disagreed.confidence);
  });

  it('ranks evidence by its contribution to the score', () => {
    const result = aggregate([
      module('semantic', 'ok', 0.8, 0.9, [evidence('ev_low', 0.1, 0.2)]),
      module('url-intel', 'ok', 0.9, 0.9, [evidence('ev_high', 0.9, 1)]),
    ]);

    expect(result.rankedEvidence[0].id).toBe('ev_high');
  });

  it('exposes thresholds and weights that can be overridden', () => {
    const result = aggregate([module('semantic', 'ok', 0.5)], {
      thresholds: { suspicious: 0.2, phishing: 0.3 },
      weights: [{ module: 'semantic', weight: 1, enabled: true }],
    });

    expect(result.verdict).toBe('phishing');
    expect(DEFAULT_THRESHOLDS.phishing).toBeGreaterThan(DEFAULT_THRESHOLDS.suspicious);
    expect(DEFAULT_WEIGHTS.every((entry) => entry.weight > 0)).toBe(true);
  });
});
