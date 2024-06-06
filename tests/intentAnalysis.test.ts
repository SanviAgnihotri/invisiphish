import { describe, expect, it } from 'vitest';
import { analyzeIntentScores, runIntentModule } from '../src/lib/ml/intentAnalysis';

describe('intent analysis', () => {
  it('detects urgency pressure', () => {
    const scores = analyzeIntentScores('URGENT: you must act now immediately');

    expect(scores.urgency).toBeGreaterThan(0.5);
  });

  it('detects scarcity framing', () => {
    const scores = analyzeIntentScores('Only the first 10 customers get this limited time offer');

    expect(scores.scarcity).toBeGreaterThan(0.4);
  });

  it('detects authority impersonation', () => {
    const scores = analyzeIntentScores('Your bank has detected suspicious activity on your account');

    expect(scores.authority).toBeGreaterThan(0.4);
  });

  it('detects threatened consequences', () => {
    const scores = analyzeIntentScores('Failure to comply will result in legal action and penalties');

    expect(scores.fear).toBeGreaterThan(0.4);
  });

  it('detects reward baiting', () => {
    const scores = analyzeIntentScores('Congratulations! You have won a free prize, claim it now');

    expect(scores.reward).toBeGreaterThan(0.4);
  });

  it('scores a benign message near zero', () => {
    const scores = analyzeIntentScores('The project meeting has moved to Thursday at 3pm.');

    expect(scores.overall).toBeLessThan(0.2);
  });

  it('never leaves the 0..1 range', () => {
    const scores = analyzeIntentScores(
      'URGENT FINAL NOTICE act now limited time only your bank detected fraud legal action prize winner free money',
    );

    for (const value of Object.values(scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('returns a module result with evidence', () => {
    const result = runIntentModule('URGENT: verify your account immediately or it will be suspended');

    expect(result.status).toBe('ok');
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.every((item) => item.id.startsWith('ev_intent_'))).toBe(true);
  });

  it('returns no evidence for a neutral message', () => {
    const result = runIntentModule('Lunch tomorrow?');

    expect(result.evidence).toHaveLength(0);
    expect(result.score).toBe(0);
  });
});
