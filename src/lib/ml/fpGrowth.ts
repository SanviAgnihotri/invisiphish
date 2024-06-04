/**
 * FP-Growth - frequent pattern mining over message transactions.
 *
 * Implements Han, Pei & Yin (SIGMOD 2000): build an FP-tree from the
 * transactions, then recursively mine conditional trees to enumerate frequent
 * itemsets. Also produces association rules (confidence / lift) and matches
 * mined templates back against live messages.
 *
 * The algorithm is intentionally dependency-free and pure so it can be unit
 * tested and re-run from `npm run eval`.
 *
 * Scalability note: mining is combinatorially explosive on large corpora of
 * long documents. On 66k email bodies at 1% support and length 6 the number of
 * itemsets reaches millions and exhausts the heap, so the number of itemsets
 * is capped. The cap keeps the strongest templates, which are found first
 * because the tree is mined in ascending item frequency.
 */

export interface FrequentItemset {
  /** Items in the order the tree produced them. */
  items: string[];
  /** Number of transactions containing every item in the set. */
  support: number;
  /** support / total transactions. */
  supportRatio: number;
}

export interface AssociationRule {
  antecedent: string[];
  consequent: string[];
  support: number;
  /** P(consequent | antecedent). */
  confidence: number;
  /** How much more likely the consequent is given the antecedent (>1 means useful). */
  lift: number;
}

export interface PatternMatch {
  items: string[];
  support: number;
  supportRatio: number;
}

export interface MiningOptions {
  /** Minimum support as a fraction of transactions, 0..1. */
  minSupport?: number;
  /** Maximum number of items in a reported itemset. */
  maxLength?: number;
  /** Hard cap on the number of itemsets produced. */
  maxItemsets?: number;
}

interface FpNode {
  item: string | null;
  count: number;
  parent: FpNode | null;
  children: Map<string, FpNode>;
  /** Next node in the header chain for the same item. */
  link: FpNode | null;
}

function createNode(item: string | null, parent: FpNode | null): FpNode {
  return { item, count: 0, parent, children: new Map(), link: null };
}

function itemSupport(transactions: string[][]): Map<string, number> {
  const support = new Map<string, number>();
  for (const transaction of transactions) {
    for (const item of new Set(transaction)) {
      support.set(item, (support.get(item) ?? 0) + 1);
    }
  }
  return support;
}

/**
 * Build an FP-tree, keeping only items that reach `minCount`.
 * Items are ordered by descending global support, as the paper requires.
 */
function buildFpTree(transactions: string[][], minCount: number) {
  const support = itemSupport(transactions);
  const frequent = new Set(
    [...support.entries()].filter(([, count]) => count >= minCount).map(([item]) => item),
  );

  const ranked = [...frequent].sort((a, b) => {
    const delta = (support.get(b) ?? 0) - (support.get(a) ?? 0);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  const order = new Map(ranked.map((item, index) => [item, index]));

  const root = createNode(null, null);
  const header = new Map<string, FpNode>();

  for (const transaction of transactions) {
    const items = [...new Set(transaction)]
      .filter((item) => frequent.has(item))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

    let node = root;
    for (const item of items) {
      let child = node.children.get(item);
      if (!child) {
        child = createNode(item, node);
        node.children.set(item, child);
        // The header always points at the most recent node for an item and each
        // new node links back to the previous one, so walking the chain from the
        // head visits every node for that item.
        child.link = header.get(item) ?? null;
        header.set(item, child);
      }
      child.count += 1;
      node = child;
    }
  }

  return { root, header };
}

/** Support of an item inside a (possibly conditional) tree. */
function chainCount(header: Map<string, FpNode>, item: string): number {
  let count = 0;
  let node: FpNode | null = header.get(item) ?? null;
  for (; node; node = node.link) count += node.count;
  return count;
}

/**
 * Conditional pattern base for an item.
 *
 * Each node in the header chain contributes one path per unit of its count, so
 * transaction multiplicity is preserved. Without this, a template that occurs in
 * two identical messages would be discarded by the min-support filter.
 */
function conditionalPatternBase(header: Map<string, FpNode>, item: string): string[][] {
  const base: string[][] = [];
  let node: FpNode | null = header.get(item) ?? null;
  for (; node; node = node.link) {
    const path: string[] = [];
    let parent = node.parent;
    while (parent && parent.item !== null) {
      path.push(parent.item);
      parent = parent.parent;
    }
    if (path.length === 0) continue;
    path.reverse();
    for (let repeat = 0; repeat < node.count; repeat += 1) base.push([...path]);
  }
  return base;
}

function mineTree(
  header: Map<string, FpNode>,
  minCount: number,
  prefix: string[],
  total: number,
  maxLength: number,
  maxItemsets: number,
  out: FrequentItemset[],
): void {
  if (out.length >= maxItemsets) return;

  // Least frequent item first, as in the original algorithm.
  const items = [...header.keys()].sort(
    (a, b) => chainCount(header, a) - chainCount(header, b),
  );

  for (const item of items) {
    if (out.length >= maxItemsets) return;

    const pattern = [...prefix, item];
    const support = chainCount(header, item);

    out.push({ items: pattern, support, supportRatio: total === 0 ? 0 : support / total });

    if (pattern.length >= maxLength) continue;

    const base = conditionalPatternBase(header, item);
    if (base.length === 0) continue;

    const conditional = buildFpTree(base, minCount);
    if (conditional.header.size === 0) continue;

    mineTree(
      conditional.header,
      minCount,
      pattern,
      total,
      maxLength,
      maxItemsets,
      out,
    );
  }
}

/**
 * Mine all frequent itemsets with support >= minSupport.
 */
export function mineFrequentItemsets(
  transactions: string[][],
  options: MiningOptions = {},
): FrequentItemset[] {
  const { minSupport = 0.01, maxLength = 6, maxItemsets = 20_000 } = options;
  const total = transactions.length;
  if (total === 0) return [];

  const minCount = Math.max(1, Math.ceil(minSupport * total));
  const { header } = buildFpTree(transactions, minCount);
  if (header.size === 0) return [];

  const out: FrequentItemset[] = [];
  mineTree(header, minCount, [], total, maxLength, maxItemsets, out);

  // Deduplicate defensively: two tree paths can describe the same item set.
  const merged = new Map<string, FrequentItemset>();
  for (const itemset of out) {
    const key = [...itemset.items].sort().join('|');
    const existing = merged.get(key);
    if (!existing || itemset.support > existing.support) {
      merged.set(key, { ...itemset, items: [...itemset.items].sort() });
    }
  }

  return [...merged.values()]
    .sort(
      (a, b) => b.supportRatio - a.supportRatio || b.items.length - a.items.length,
    )
    .slice(0, maxItemsets);
}

/**
 * Derive association rules from frequent itemsets.
 */
export function mineAssociationRules(
  itemsets: FrequentItemset[],
  transactions: string[][],
  options: { minConfidence?: number; maxLength?: number } = {},
): AssociationRule[] {
  const { minConfidence = 0.5, maxLength = 6 } = options;
  const total = transactions.length;
  if (total === 0) return [];

  const postings = buildPostings(transactions);

  const rules: AssociationRule[] = [];
  for (const itemset of itemsets) {
    if (itemset.items.length < 2) continue;

    for (let mask = 1; mask < (1 << itemset.items.length) - 1; mask += 1) {
      const antecedent = itemset.items.filter((_, index) => (mask & (1 << index)) !== 0);
      const consequent = itemset.items.filter((_, index) => (mask & (1 << index)) === 0);
      if (antecedent.length === 0 || consequent.length === 0) continue;
      if (antecedent.length + consequent.length > maxLength) continue;

      const antecedentSupport = countContaining(postings, antecedent);
      if (antecedentSupport === 0) continue;

      const confidence = itemset.support / antecedentSupport;
      if (confidence < minConfidence) continue;

      const consequentSupport = countContaining(postings, consequent);
      const lift = consequentSupport === 0 ? 0 : confidence / (consequentSupport / total);

      rules.push({
        antecedent,
        consequent,
        support: itemset.support,
        confidence,
        lift,
      });
    }
  }

  return rules.sort((a, b) => b.lift - a.lift || b.confidence - a.confidence);
}

/**
 * Inverted index from an item to the transactions that contain it.
 *
 * Counting support this way is linear in the size of the posting lists rather
 * than in the number of transactions, which is what makes scoring tens of
 * thousands of mined templates against a large corpus practical.
 *
 * `minSupport` drops items that cannot appear in a frequent itemset. On a
 * corpus of long documents that removes the overwhelming majority of tokens
 * and keeps the index small enough to build comfortably.
 */
export function buildPostings(
  transactions: string[][],
  minSupport = 0,
): Map<string, Set<number>> {
  const postings = new Map<string, Set<number>>();
  const counts = new Map<string, number>();

  transactions.forEach((transaction, index) => {
    for (const item of new Set(transaction)) {
      let list = postings.get(item);
      if (!list) {
        list = new Set<number>();
        postings.set(item, list);
      }
      list.add(index);
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
  });

  if (minSupport <= 0) return postings;

  const threshold = Math.max(1, Math.ceil(minSupport * transactions.length));
  for (const [item, count] of counts) {
    if (count < threshold) postings.delete(item);
  }

  return postings;
}

/** How many transactions contain every one of `items`. */
export function countContaining(
  postings: Map<string, Set<number>>,
  items: string[],
): number {
  if (items.length === 0) return 0;

  let shortest: Set<number> | null = null;
  for (const item of items) {
    const list = postings.get(item);
    if (!list) return 0;
    if (!shortest || list.size < shortest.size) shortest = list;
  }
  if (!shortest) return 0;

  const others = items
    .map((item) => postings.get(item)!)
    .filter((list) => list !== shortest);

  let count = 0;
  for (const index of shortest) {
    if (others.every((list) => list.has(index))) count += 1;
  }

  return count;
}

/**
 * Match mined templates against a live message.
 *
 * A template matches when every one of its items is present in the message.
 * The template's mining support is used as the confidence of the match.
 */
export function matchFrequentPatterns(
  tokens: string[],
  itemsets: FrequentItemset[],
): PatternMatch[] {
  const present = new Set(tokens);
  const matches: PatternMatch[] = [];

  for (const itemset of itemsets) {
    if (itemset.items.length === 0) continue;
    if (!itemset.items.every((item) => present.has(item))) continue;
    matches.push({
      items: itemset.items,
      support: itemset.support,
      supportRatio: itemset.supportRatio,
    });
  }

  return matches.sort(
    (a, b) => b.supportRatio - a.supportRatio || b.items.length - a.items.length,
  );
}

/** Render an itemset as a readable template fragment. */
export function formatPattern(items: string[]): string {
  return items.join(' + ');
}
