import { describe, expect, it } from 'vitest';
import {
  formatPattern,
  matchFrequentPatterns,
  mineAssociationRules,
  mineFrequentItemsets,
} from '../src/lib/ml/fpGrowth';
import { tokenizeMessage } from '../src/lib/ml/tokenize';

const CORPUS = [
  'verify your account urgent now',
  'verify your account urgent now',
  'verify your account immediately',
  'free prize claim now',
  'free prize claim now',
  'meeting tomorrow agenda',
];

const find = (itemsets: ReturnType<typeof mineFrequentItemsets>, key: string[]) => {
  const target = [...key].sort().join('|');
  return itemsets.find((itemset) => [...itemset.items].sort().join('|') === target);
};

describe('FP-Growth', () => {
  it('finds frequent single items with the correct support', () => {
    const itemsets = mineFrequentItemsets(CORPUS.map((text) => tokenizeMessage(text)), {
      minSupport: 0.3,
    });

    expect(find(itemsets, ['urgent'])?.support).toBe(2);
    expect(find(itemsets, ['account'])?.support).toBe(3);
    expect(find(itemsets, ['now'])?.support).toBe(4);
    expect(find(itemsets, ['prize'])?.support).toBe(2);
  });

  it('excludes items below the support threshold', () => {
    const itemsets = mineFrequentItemsets(CORPUS.map((text) => tokenizeMessage(text)), {
      minSupport: 0.3,
    });

    expect(find(itemsets, ['agenda'])).toBeUndefined();
    expect(find(itemsets, ['meeting'])).toBeUndefined();
  });

  it('finds frequent item pairs with the correct support', () => {
    const itemsets = mineFrequentItemsets(CORPUS.map((text) => tokenizeMessage(text)), {
      minSupport: 0.3,
    });

    expect(find(itemsets, ['account', 'verify'])?.support).toBe(3);
    expect(find(itemsets, ['urgent', 'now'])?.support).toBe(2);
    expect(find(itemsets, ['prize', 'claim'])?.support).toBe(2);
  });

  it('respects the minimum support ratio', () => {
    const itemsets = mineFrequentItemsets(CORPUS.map((text) => tokenizeMessage(text)), {
      minSupport: 0.5,
    });

    expect(itemsets.length).toBeGreaterThan(0);
    expect(itemsets.every((itemset) => itemset.supportRatio >= 0.5)).toBe(true);
  });

  it('produces association rules with confidence and lift', () => {
    const transactions = CORPUS.map((text) => tokenizeMessage(text));
    const itemsets = mineFrequentItemsets(transactions, { minSupport: 0.3 });
    const rules = mineAssociationRules(itemsets, transactions, { minConfidence: 0.5 });

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.confidence >= 0.5)).toBe(true);
    expect(rules.every((rule) => rule.confidence <= 1)).toBe(true);
    expect(rules.every((rule) => rule.lift >= 0)).toBe(true);
  });

  it('handles an empty corpus without throwing', () => {
    expect(mineFrequentItemsets([], { minSupport: 0.1 })).toEqual([]);
  });
});

describe('pattern matching', () => {
  const itemsets = mineFrequentItemsets(CORPUS.map((text) => tokenizeMessage(text)), {
    minSupport: 0.3,
  });

  it('matches a mined template inside a new message', () => {
    const tokens = tokenizeMessage('URGENT: verify your account now, act immediately');
    const matches = matchFrequentPatterns(tokens, itemsets);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((match) => match.items.includes('verify'))).toBe(true);
  });

  it('does not match an unrelated message', () => {
    const tokens = tokenizeMessage('meeting tomorrow agenda');
    expect(matchFrequentPatterns(tokens, itemsets)).toHaveLength(0);
  });

  it('formats a template readably', () => {
    expect(formatPattern(['verify', 'account'])).toBe('verify + account');
  });
});
