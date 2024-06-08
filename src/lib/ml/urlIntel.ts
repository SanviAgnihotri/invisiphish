/**
 * URL intelligence - structural heuristics for phishing links.
 *
 * Pure and network-free so it can be unit tested exhaustively. Domain
 * registration metadata (age, registrar) is added separately by the
 * domain-intelligence module, which can fail without taking this module down.
 */

export interface UrlSignal {
  code: string;
  label: string;
  detail: string;
  /** Evidence strength for this signal, 0..1. */
  weight: number;
}

export interface UrlAnalysis {
  id: string;
  url: string;
  scheme: string;
  host: string;
  registrableDomain: string;
  signals: UrlSignal[];
  /** Combined phishing propensity, 0..1. */
  score: number;
}

import type { Evidence } from '@/lib/ml/types';

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

/** Brands commonly impersonated in phishing lures. */
const BRANDS = [
  'paypal', 'apple', 'icloud', 'microsoft', 'office365', 'outlook', 'amazon',
  'google', 'gmail', 'netflix', 'facebook', 'instagram', 'whatsapp', 'linkedin',
  'twitter', 'chase', 'wellsfargo', 'bankofamerica', 'citibank', 'hsbc',
  'barclays', 'santander', 'dhl', 'fedex', 'ups', 'usps', 'royalmail', 'inpost',
  'coinbase', 'binance', 'metamask', 'ledger', 'trezor', 'steam', 'roblox',
  'disney', 'spotify', 'dropbox', 'adobe', 'docusign', 'zoom', 'slack',
];

/** TLDs with a disproportionate share of phishing infrastructure. */
const SUSPICIOUS_TLDS = new Set([
  'tk', 'ml', 'ga', 'cf', 'gq', 'top', 'xyz', 'zip', 'mov', 'work', 'rest',
  'buzz', 'click', 'link', 'cam', 'quest', 'monster', 'cyou', 'icu', 'surf',
  'wang', 'sbs', 'buzz', 'fit', 'monster', 'lol', 'autos', 'bond', 'cfd',
]);

const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'rb.gy', 't.ly', 'tiny.cc', 's.id', 'adf.ly',
  'short.io', 'lnkd.in', 'soo.gd', 'clck.ru', 'v.gd', 'qr.ae', 'tiny.one',
]);

const SUSPICIOUS_PATH_TOKENS = [
  'login', 'signin', 'log-in', 'verify', 'verification', 'validate', 'account',
  'update', 'confirm', 'secure', 'security', 'billing', 'payment', 'invoice',
  'wallet', 'recover', 'recovery', 'reset', 'unlock', 'suspended', 'webscr',
  'credential', 'password', 'otp', 'otp-code', 'auth', 'signin',
];

const RISKY_EXTENSIONS = ['.php', '.html', '.htm', '.asp', '.aspx', '.jsp', '.exe', '.scr', '.zip'];

const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.in', 'net.in', 'org.in', 'com.au',
  'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx', 'co.za', 'com.sg', 'co.jp',
  'co.kr', 'com.cn', 'com.tr', 'com.tw', 'co.il', 'com.ar', 'com.pl', 'com.ua',
]);

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Naive registrable-domain extraction with a small public-suffix exception list. */
export function registrableDomain(host: string): string {
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/** Normalise the character substitutions phishers use to imitate brands. */
function normaliseConfusables(value: string): string {
  return value
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/rn/g, 'm');
}

/**
 * Detect brand names impersonated in a host, e.g.
 * `paypal.com.secure-login.tk` (subdomain), `paypal-secure.tk` (domain) or
 * `paypa1-secure.tk` (look-alike characters).
 */
function detectBrandImpersonation(
  host: string,
): { brand: string; kind: 'subdomain' | 'domain' | 'homoglyph' } | null {
  const domain = registrableDomain(host);
  const labels = host.split('.');
  const domainLabels = domain.split('.');
  const subdomain = labels
    .slice(0, Math.max(0, labels.length - domainLabels.length))
    .join('.');
  const tld = domain.split('.').pop() ?? '';

  for (const brand of BRANDS) {
    if (subdomain.includes(brand)) return { brand, kind: 'subdomain' };

    // The brand sits inside the registrable domain, e.g. `paypal-secure.tk`.
    // A domain that is exactly `<brand>.<tld>` is the legitimate one.
    if (domain.includes(brand) && domain !== `${brand}.${tld}`) {
      return { brand, kind: 'domain' };
    }

    // Look-alike substitutions: paypa1, amaz0n, g00gle, rnicrosoft.
    const normalised = normaliseConfusables(domain);
    if (normalised !== domain && normalised.includes(brand) && !domain.includes(brand)) {
      return { brand, kind: 'homoglyph' };
    }
  }

  return null;
}

/**
 * Analyse a single URL and return its signals plus a combined score.
 * Returns null for strings that are not parseable URLs.
 */
export function analyzeUrl(rawUrl: string, id = 'ev_url'): UrlAnalysis | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const signals: UrlSignal[] = [];
  const domain = registrableDomain(host);

  const add = (code: string, label: string, detail: string, weight: number) =>
    signals.push({ code, label, detail, weight });

  if (isIpv4(host)) {
    add('IP_HOST', 'Numeric IP address used as the host', `The link points at ${host} instead of a domain name.`, 0.85);
  }

  if (host.includes('xn--')) {
    add('PUNYCODE', 'Punycode (internationalised) domain', `The host ${host} contains an encoded Unicode label.`, 0.7);
  }

  const brand = detectBrandImpersonation(host);
  if (brand?.kind === 'subdomain') {
    add(
      'BRAND_IN_SUBDOMAIN',
      'Brand name placed in the subdomain',
      `The subdomain of ${domain} contains "${brand.brand}", which is used to make the link look legitimate.`,
      0.9,
    );
  } else if (brand?.kind === 'domain') {
    add(
      'BRAND_IN_DOMAIN',
      'Brand name inside a non-brand domain',
      `The domain ${domain} contains "${brand.brand}", so the real domain is not the one the brand owns.`,
      0.75,
    );
  } else if (brand?.kind === 'homoglyph') {
    add(
      'BRAND_HOMOGLYPH',
      'Brand name imitated with look-alike characters',
      `The host ${domain} imitates "${brand.brand}" using substituted characters.`,
      0.8,
    );
  }

  const tld = host.split('.').pop() ?? '';
  if (SUSPICIOUS_TLDS.has(tld)) {
    add('SUSPICIOUS_TLD', 'Top-level domain frequently abused for phishing', `.${tld} is heavily used for short-lived phishing infrastructure.`, 0.55);
  }

  if (SHORTENERS.has(domain)) {
    add('SHORTENER', 'Link shortener hides the real destination', `${domain} redirects to an undisclosed address.`, 0.45);
  }

  if (parsed.username || parsed.password) {
    add('USERINFO_DECEPTION', 'Credentials embedded before the real host', `Everything before the "@" can be ignored by the browser.`, 0.9);
  }

  if (parsed.protocol === 'http:') {
    add('NO_HTTPS', 'Link is not encrypted', 'Traffic and any details you enter can be read in transit.', 0.3);
  }

  const subdomainLabels = host.split('.').length - domain.split('.').length;
  if (subdomainLabels >= 3) {
    add('EXCESSIVE_SUBDOMAINS', 'Unusually deep subdomain chain', `The host uses ${subdomainLabels} subdomain levels to bury the real domain.`, 0.35);
  }

  const labelHyphens = (host.match(/-/g) ?? []).length;
  if (labelHyphens >= 3) {
    add('EXCESSIVE_HYPHENS', 'Host contains many hyphens', `Hyphen-heavy hosts such as "${host}" are a common throwaway-domain pattern.`, 0.4);
  }

  const path = parsed.pathname.toLowerCase();
  const pathToken = SUSPICIOUS_PATH_TOKENS.find((token) => path.includes(token));
  if (pathToken) {
    add('SUSPICIOUS_PATH', 'Link path contains a credential or payment keyword', `The path contains "${pathToken}", a common lure in credential-harvesting pages.`, 0.5);
  }

  const riskyExtension = RISKY_EXTENSIONS.find((extension) => path.endsWith(extension));
  if (riskyExtension) {
    add('RISKY_EXTENSION', 'Link points directly at an executable or script resource', `The path ends in "${riskyExtension}".`, 0.6);
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    add('NON_STANDARD_PORT', 'Link uses a non-standard port', `Traffic is directed to port ${parsed.port} instead of a normal web port.`, 0.5);
  }

  // Noisy-OR combination: each independent signal raises the overall score.
  const score = 1 - signals.reduce((remainder, signal) => remainder * (1 - signal.weight), 1);

  return {
    id,
    url: rawUrl,
    scheme: parsed.protocol.replace(':', ''),
    host,
    registrableDomain: domain,
    signals,
    score: Number(score.toFixed(4)),
  };
}

/** Extract and analyse every URL in a block of text. */
export function analyzeUrls(text: string): UrlAnalysis[] {
  const matches = text.match(URL_PATTERN) ?? [];
  return matches
    .map((url, index) => analyzeUrl(url, `ev_url_${index + 1}`))
    .filter((analysis): analysis is UrlAnalysis => analysis !== null);
}

/**
 * Run the URL module in the standard module shape.
 *
 * A message with no links is reported as `skipped`: the module has nothing to
 * say, and pretending otherwise would let a link-free message inherit a
 * spurious zero score instead of an honest "no signal".
 */
export function runUrlModule(text: string): {
  module: 'url-intel';
  status: 'ok' | 'skipped';
  score: number;
  confidence: number;
  evidence: Evidence[];
  latencyMs: number;
  error?: string;
} {
  const startedAt = performance.now();
  const analyses = analyzeUrls(text);

  if (analyses.length === 0) {
    return {
      module: 'url-intel',
      status: 'skipped',
      score: 0,
      confidence: 0,
      evidence: [],
      latencyMs: performance.now() - startedAt,
      error: 'No URLs found in the message.',
    };
  }

  const evidence: Evidence[] = [];

  for (const analysis of analyses) {
    for (const signal of analysis.signals) {
      evidence.push({
        id: `${analysis.id}_${signal.code.toLowerCase()}`,
        kind: 'url',
        module: 'url-intel',
        label: signal.label,
        detail: signal.detail,
        score: signal.weight,
        severity: signal.weight,
        meta: { url: analysis.url, host: analysis.host, signal: signal.code },
      });
    }
  }

  // The message is as suspicious as its worst link.
  const score = Math.max(...analyses.map((analysis) => analysis.score));

  return {
    module: 'url-intel',
    status: 'ok',
    score,
    confidence: Math.min(1, 0.4 + analyses.length * 0.15),
    evidence,
    latencyMs: performance.now() - startedAt,
  };
}
