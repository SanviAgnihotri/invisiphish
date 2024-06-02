/**
 * Shared tokenisation for the pattern-mining pipeline.
 *
 * FP-Growth mining and pattern matching must agree exactly on how a message is
 * turned into a set of items, otherwise mined templates will never match live
 * traffic. Both sides therefore call this module.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'of', 'to', 'in',
  'on', 'at', 'by', 'for', 'with', 'about', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'we',
  'they', 'he', 'she', 'him', 'her', 'them', 'us', 'our', 'your', 'my', 'me',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'may', 'might', 'must', 'not', 'no', 'yes', 'up', 'out', 'from',
  'your', 'youre', 'its', 'am', 'all', 'any', 'each', 'how', 'what', 'when',
  'where', 'who', 'why', 'here', 'there', 'please', 'dear', 'sir', 'madam',
]);

/** Very light suffix stripping so "verify" and "verifying" land on the same item. */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * Longest token kept for pattern mining.
 *
 * Punctuation removal turns a URL into a single very long token, and a
 * phishing campaign that reuses one URL would then dominate the mined
 * templates. Long tokens carry no linguistic signal and URLs are handled by
 * the URL-intelligence module, so they are dropped here.
 */
const MAX_TOKEN_LENGTH = 24;

/**
 * Turn a message into the item set used for pattern mining.
 *
 * URLs are dropped from the token stream on purpose: they are handled by the
 * URL-intelligence module, and keeping them here would let a single attacker
 * controlled string dominate a mined template.
 */
export function tokenizeMessage(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(stem)
    .filter((token) => token.length >= 3)
    .filter((token) => token.length <= MAX_TOKEN_LENGTH)
    .filter((token) => !STOPWORDS.has(token));
}

/** Tokenise a whole corpus into FP-Growth transactions. */
export function buildTransactions(messages: string[]): string[][] {
  return messages.map((message) => [...new Set(tokenizeMessage(message))]);
}
