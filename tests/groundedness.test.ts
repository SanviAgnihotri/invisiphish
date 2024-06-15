import { describe, expect, it } from 'vitest';
import {
  RECOMMENDED_ACTIONS,
  buildEvidenceTable,
  deriveRecommendedActions,
  validateExplanation,
} from '../src/lib/validation/groundedness';
import type { Evidence, Explanation } from '../src/lib/ml/types';

const evidence: Evidence[] = [
  {
    id: 'ev_url_1',
    kind: 'url',
    module: 'url-intel',
    label: 'Brand name placed in the subdomain',
    detail: 'The subdomain of secure-login.tk contains "paypal".',
    score: 0.9,
    severity: 1,
  },
  {
    id: 'ev_pattern_1',
    kind: 'pattern',
    module: 'pattern',
    label: 'Known scam template',
    detail: 'Matches the template verify + account + urgent.',
    score: 0.7,
    severity: 0.8,
  },
];

const explanation: Explanation = {
  summary: 'The message uses a brand name in the subdomain of a low-reputation domain.',
  bullets: [
    { text: 'The link impersonates PayPal in the subdomain.', evidenceIds: ['ev_url_1'] },
    { text: 'It matches a known scam template.', evidenceIds: ['ev_pattern_1'] },
    { text: 'The sender is the chief executive.', evidenceIds: ['ev_fabricated'] },
    { text: 'You have won a free prize.', evidenceIds: [] },
  ],
  recommendedActions: [
    'Do not click any link or open any attachment in this message.',
    'Send the money to this address immediately.',
  ],
};

describe('groundedness validation', () => {
  it('drops bullets that cite unknown evidence', () => {
    const { report } = validateExplanation(explanation, evidence);

    expect(report.validBullets).toBe(2);
    expect(report.invalidBullets).toBe(2);
    expect(report.unknownEvidenceIds).toContain('ev_fabricated');
    expect(report.droppedBullets).toHaveLength(2);
  });

  it('keeps only bullets backed by real evidence', () => {
    const { explanation: cleaned } = validateExplanation(explanation, evidence);

    expect(cleaned.bullets).toHaveLength(2);
    expect(cleaned.bullets.every((bullet) => bullet.evidenceIds.length > 0)).toBe(true);
  });

  it('computes a groundedness score', () => {
    const { report } = validateExplanation(explanation, evidence);

    expect(report.score).toBeCloseTo(0.5, 4);
  });

  it('rejects recommended actions outside the closed catalogue', () => {
    const { explanation: cleaned } = validateExplanation(explanation, evidence);

    expect(cleaned.recommendedActions).toHaveLength(1);
    expect(cleaned.recommendedActions[0]).toBe(
      'Do not click any link or open any attachment in this message.',
    );
  });

  it('falls back to deterministically derived actions', () => {
    const { explanation: cleaned } = validateExplanation(
      { summary: 'x', bullets: [], recommendedActions: [] },
      evidence,
    );

    expect(cleaned.recommendedActions.length).toBeGreaterThan(0);
    expect(cleaned.recommendedActions).toEqual(
      deriveRecommendedActions(evidence, RECOMMENDED_ACTIONS),
    );
  });

  it('marks a low-groundedness explanation as unacceptable', () => {
    const { acceptable } = validateExplanation(explanation, evidence, { minGroundedness: 0.8 });

    expect(acceptable).toBe(false);
  });

  it('derives actions only from evidence kinds that are present', () => {
    const urlOnly = [evidence[0]];
    const actions = deriveRecommendedActions(urlOnly);

    expect(actions).toContain(
      'Do not enter passwords, card details, or one-time codes on any page reached from this message.',
    );
  });

  it('renders the closed evidence table without the raw message', () => {
    const table = buildEvidenceTable(evidence);

    expect(table).toContain('[ev_url_1]');
    expect(table).toContain('Brand name placed in the subdomain');
    expect(table).not.toContain('chief executive');
  });
});
