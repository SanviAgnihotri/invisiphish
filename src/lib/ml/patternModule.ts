/**
 * Pattern module: matches a message against recurring scam templates mined
 * with FP-Growth.
 *
 * Templates are mined from both classes so that each one carries a measured
 * *discriminative* strength rather than just a frequency. For a template `T`:
 *
 *   P(T | spam) / P(T | ham)  =  the likelihood ratio
 *
 * and the module score is the sigmoid of the summed log-likelihood ratio over
 * every template the message matches. A template that is just as common in
 * legitimate messages contributes nothing, which is exactly the behaviour the
 * paper needs from a "fast filter".
 */

import {
  buildPostings,
  countContaining,
  formatPattern,
  mineFrequentItemsets,
  type FrequentItemset,
} from '@/lib/ml/fpGrowth';
import { tokenizeMessage } from '@/lib/ml/tokenize';
import type { Evidence, ModuleResult } from '@/lib/ml/types';

export interface DiscriminativePattern {
  items: string[];
  /** Transactions containing the template, split by class. */
  spamSupport: number;
  hamSupport: number;
  /** P(template | spam). */
  spamRatio: number;
  /** P(template | ham). */
  hamRatio: number;
  /** P(template | spam) / P(template | ham). */
  lift: number;
  /** Number of items in the template. */
  length: number;
  /**
   * The rarest item in the template.
   *
   * Recurring campaigns produce a template and every one of its subsets, and
   * those subsets share their most distinctive token. Grouping on it keeps the
   * report to one representative per campaign instead of listing the same
   * campaign five times.
   *
   * Optional because templates loaded from the database do not carry the item
   * support statistics the miner would have used.
   */
  distinguishingItem?: string;
}

export interface PatternMiningOptions {
  /** Minimum support as a fraction of the combined corpus. */
  minSupport?: number;
  /** Minimum number of items for a template to be usable. */
  minLength?: number;
  maxLength?: number;
  /** Hard cap on mined itemsets, to bound memory on large corpora. */
  maxItemsets?: number;
  /** Hard cap on the templates kept after scoring. */
  maxPatterns?: number;
  /**
   * Support levels to try, from most to least specific.
   *
   * A single support threshold does not work across corpora: at 1% support a
   * corpus of 82k long email bodies yields only a handful of maximal
   * templates, while a corpus of 5k SMS yields thousands. The mining settings
   * are therefore searched and the most specific configuration that produces a
   * usable number of discriminative templates is kept.
   */
  supportLevels?: number[];
  /** Length levels to try, from most to least specific. */
  lengthLevels?: number[];
}

/**
 * Mine templates from both classes and keep the discriminative ones.
 *
 * Support is counted through an inverted index rather than by scanning every
 * transaction per template, which is what makes this usable on a corpus of
 * tens of thousands of long messages.
 */
export function mineDiscriminativePatterns(
  spamTransactions: string[][],
  hamTransactions: string[][],
  options: PatternMiningOptions = {},
): DiscriminativePattern[] {
  const {
    minSupport = 0.01,
    minLength = 2,
    maxLength = 4,
    maxItemsets = 20_000,
    maxPatterns = 3_000,
    supportLevels = [minSupport, minSupport / 2, minSupport / 4],
    lengthLevels = [maxLength, 3, 2],
  } = options;

  const combined = [...spamTransactions, ...hamTransactions];
  if (combined.length === 0) return [];

  const spamPostings = buildPostings(spamTransactions, minSupport);
  const hamPostings = buildPostings(hamTransactions, minSupport);

  // Support of each item across the *combined* corpus, used to find the most
  // distinctive token of each template. It has to be the combined count: an
  // item can be frequent overall while being below the threshold in each
  // class separately, and using the class counts would make every such item
  // look equally rare.
  const combinedPostings = buildPostings(combined, minSupport);
  const itemSupport = new Map<string, number>();
  for (const [item, list] of combinedPostings) itemSupport.set(item, list.size);

  const supportOf = (item: string) => itemSupport.get(item) ?? Number.MAX_SAFE_INTEGER;

  const score = (
    itemsets: FrequentItemset[],
  ): DiscriminativePattern[] => {
    const patterns: DiscriminativePattern[] = [];

    for (const itemset of itemsets) {
      if (itemset.items.length < minLength) continue;

      const spamSupport = countContaining(spamPostings, itemset.items);
      const hamSupport = countContaining(hamPostings, itemset.items);

      const spamRatio = spamSupport / Math.max(1, spamTransactions.length);
      const hamRatio = hamSupport / Math.max(1, hamTransactions.length);

      // Laplace smoothing keeps the ratio finite when a template never appears
      // in legitimate messages.
      const lift = (spamRatio + 1e-6) / (hamRatio + 1e-6);

      const distinguishingItem = itemset.items.reduce((rarest, item) =>
        supportOf(item) < supportOf(rarest) ? item : rarest,
      );

      patterns.push({
        items: itemset.items,
        spamSupport,
        hamSupport,
        spamRatio,
        hamRatio,
        lift,
        length: itemset.items.length,
        distinguishingItem,
      });
    }

    return patterns;
  };

  // Search from the most specific configuration outwards and stop at the
  // first one that produces a usable set of templates.
  let fallback: DiscriminativePattern[] = [];

  for (const support of supportLevels) {
    for (const length of lengthLevels) {
      if (length < minLength) continue;

      const itemsets = mineFrequentItemsets(combined, {
        minSupport: support,
        maxLength: length,
        maxItemsets,
      });
      if (itemsets.length === 0) continue;

      // Only the most specific itemsets are kept. A template and every one of
      // its subsets describe the same scam campaign, so the subsets are
      // dropped and the maximal template becomes the campaign's representative.
      const mostSpecific = itemsets.reduce(
        (longest, itemset) => Math.max(longest, itemset.items.length),
        0,
      );
      const candidates = itemsets.filter((itemset) => itemset.items.length === mostSpecific);

      const patterns = score(candidates);
      const usable = patterns.filter((pattern) => pattern.lift >= 1.5);

      if (usable.length > fallback.length) fallback = usable;

      // The retained set has to span several frequency tiers. A single
      // campaign's templates all share one support count, so a set made only
      // of them tells us nothing about the rest of the corpus.
      const tiers = new Set(usable.map((pattern) => pattern.spamSupport)).size;

      if (usable.length >= 10 && tiers >= 3) {
        // Selecting purely by lift lets one campaign monopolise the budget:
        // a template that never appears in legitimate mail has an enormous
        // lift, and all of its subsets share that. Templates are therefore
        // capped per support tier, so the retained set spans the whole
        // frequency range instead of a single campaign.
        const perTier = new Map<number, number>();
        const selected: DiscriminativePattern[] = [];

        for (const pattern of usable.sort(
          (a, b) => b.lift - a.lift || b.spamSupport - a.spamSupport,
        )) {
          const tier = pattern.spamSupport;
          const taken = perTier.get(tier) ?? 0;
          if (taken >= 20) continue;
          perTier.set(tier, taken + 1);
          selected.push(pattern);
          if (selected.length >= maxPatterns) break;
        }

        return selected;
      }
    }
  }

  return fallback
    .sort((a, b) => b.lift - a.lift || b.spamSupport - a.spamSupport)
    .slice(0, maxPatterns);
}

/**
 * An index from an item to the templates that contain it.
 *
 * Matching a message then only considers the templates that share at least
 * one token with it, instead of every mined template.
 */
export interface PatternIndex {
  byItem: Map<string, DiscriminativePattern[]>;
  patterns: DiscriminativePattern[];
}

/**
 * Indexes are cached against the pattern array they were built from.
 *
 * The evaluation harness and the API both score thousands of messages against
 * the same mined set; rebuilding the index per message turns a linear scan
 * into a quadratic one.
 */
const indexCache = new WeakMap<DiscriminativePattern[], PatternIndex>();

export function buildPatternIndex(patterns: DiscriminativePattern[]): PatternIndex {
  const cached = indexCache.get(patterns);
  if (cached) return cached;

  const byItem = new Map<string, DiscriminativePattern[]>();

  for (const pattern of patterns) {
    for (const item of pattern.items) {
      const list = byItem.get(item);
      if (list) list.push(pattern);
      else byItem.set(item, [pattern]);
    }
  }

  // The lists are ordered by lift so that the cap below keeps the strongest
  // templates when a message touches more patterns than the budget allows.
  for (const list of byItem.values()) {
    list.sort((a, b) => b.lift - a.lift);
  }

  const index: PatternIndex = { byItem, patterns };
  indexCache.set(patterns, index);
  return index;
}

export interface PatternModuleResult extends ModuleResult {
  matchedPatterns: DiscriminativePattern[];
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/**
 * Score a message against mined templates.
 */
export async function runPatternModule(
  text: string,
  patterns: DiscriminativePattern[] | PatternIndex,
  minLift = 1.5,
): Promise<PatternModuleResult> {
  const startedAt = performance.now();

  try {
    const index = Array.isArray(patterns)
      ? buildPatternIndex(patterns)
      : (patterns as PatternIndex);

    const tokens = new Set(tokenizeMessage(text));
    if (tokens.size === 0) {
      return {
        module: 'pattern',
        status: 'skipped',
        score: 0,
        confidence: 0,
        evidence: [],
        latencyMs: performance.now() - startedAt,
        error: 'No tokens to match against mined templates.',
        matchedPatterns: [],
      };
    }

    // Only templates that share a token with the message can match. The number
    // of candidates is capped: a long email can touch thousands of mined
    // templates, and only the strongest ones can matter.
    const MAX_CANDIDATES = 2_000;
    const candidates = new Set<DiscriminativePattern>();

    for (const token of tokens) {
      if (candidates.size >= MAX_CANDIDATES) break;
      const list = index.byItem.get(token);
      if (!list) continue;
      for (const pattern of list) {
        candidates.add(pattern);
        if (candidates.size >= MAX_CANDIDATES) break;
      }
    }

    const matched = [...candidates].filter(
      (pattern) =>
        pattern.lift >= minLift && pattern.items.every((item) => tokens.has(item)),
    );

    if (matched.length === 0) {
      return {
        module: 'pattern',
        status: 'ok',
        score: 0,
        confidence: 0.4,
        evidence: [],
        latencyMs: performance.now() - startedAt,
        matchedPatterns: [],
      };
    }

    // Sum the log-likelihood ratios of the matched templates.
    const logOdds = matched.reduce((sum, pattern) => sum + Math.log(pattern.lift), 0);
    const score = sigmoid(logOdds);

    const evidence: Evidence[] = matched.slice(0, 5).map((pattern, position) => ({
      id: `ev_pattern_${position + 1}`,
      kind: 'pattern',
      module: 'pattern',
      label: `Recurring scam template: ${formatPattern(pattern.items)}`,
      detail: `Appears in ${pattern.spamSupport} known malicious and ${pattern.hamSupport} known legitimate messages (lift ${pattern.lift.toFixed(1)}x).`,
      score: Math.min(1, Math.log(pattern.lift) / Math.log(20)),
      severity: Math.min(1, pattern.length / 4),
      meta: {
        items: pattern.items,
        lift: Number(pattern.lift.toFixed(3)),
        spamSupport: pattern.spamSupport,
        hamSupport: pattern.hamSupport,
      },
    }));

    return {
      module: 'pattern',
      status: 'ok',
      score,
      confidence: Math.min(1, 0.4 + matched.length / 10),
      evidence,
      latencyMs: performance.now() - startedAt,
      matchedPatterns: matched,
    };
  } catch (error) {
    return {
      module: 'pattern',
      status: 'error',
      score: 0,
      confidence: 0,
      evidence: [],
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown error in pattern matching',
      matchedPatterns: [],
    };
  }
}

/**
 * Human-readable summary of the strongest mined templates, for the paper.
 *
 * Near-duplicate templates are skipped: a recurring campaign produces a
 * template and every one of its subsets, and listing only the most specific
 * member of each family is far more informative.
 */
export function describeTopPatterns(
  patterns: DiscriminativePattern[],
  limit = 15,
): Array<{ template: string; spamSupport: number; hamSupport: number; lift: number }> {
  const reported: Array<{
    template: string;
    spamSupport: number;
    hamSupport: number;
    lift: number;
  }> = [];

  // A template and every one of its subsets describe the same scam campaign
  // and therefore carry the same support counts. Reporting one representative
  // per distinct support signature keeps the table informative instead of
  // listing the same campaign twenty times.
  const seenSignatures = new Set<string>();

  for (const pattern of patterns) {
    const signature = `${pattern.spamSupport}|${pattern.hamSupport}`;
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);

    reported.push({
      template: formatPattern(pattern.items),
      spamSupport: pattern.spamSupport,
      hamSupport: pattern.hamSupport,
      lift: Number(pattern.lift.toFixed(2)),
    });

    if (reported.length >= limit) break;
  }

  return reported;
}

export type { FrequentItemset };
