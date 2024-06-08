import { describe, expect, it } from 'vitest';
import { analyzeUrl, analyzeUrls, registrableDomain } from '../src/lib/ml/urlIntel';

const codes = (url: string) => analyzeUrl(url)?.signals.map((signal) => signal.code) ?? [];

describe('registrable domain extraction', () => {
  it('handles simple domains', () => {
    expect(registrableDomain('example.com')).toBe('example.com');
  });

  it('handles multi-part public suffixes', () => {
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
  });

  it('handles subdomains', () => {
    expect(registrableDomain('paypal.com.secure-login.tk')).toBe('secure-login.tk');
  });
});

describe('URL intelligence', () => {
  it('flags a numeric IP host', () => {
    expect(codes('http://192.168.1.10/login')).toContain('IP_HOST');
  });

  it('flags a brand name hidden in the subdomain', () => {
    expect(codes('https://paypal.com.secure-login.tk/verify')).toContain('BRAND_IN_SUBDOMAIN');
  });

  it('flags a homoglyph brand', () => {
    expect(codes('https://paypa1-secure.tk/')).toContain('BRAND_HOMOGLYPH');
  });

  it('flags punycode hosts', () => {
    expect(codes('https://xn--80ak6aa92e.com/')).toContain('PUNYCODE');
  });

  it('flags link shorteners', () => {
    expect(codes('https://bit.ly/3xYzAbC')).toContain('SHORTENER');
  });

  it('flags userinfo deception', () => {
    expect(codes('https://paypal.com@evil.example.org/')).toContain('USERINFO_DECEPTION');
  });

  it('flags missing https', () => {
    expect(codes('http://example.org/login')).toContain('NO_HTTPS');
  });

  it('flags credential keywords in the path', () => {
    expect(codes('https://example.org/account/verify-login')).toContain('SUSPICIOUS_PATH');
  });

  it('flags suspicious top-level domains', () => {
    expect(codes('https://account-check.tk/')).toContain('SUSPICIOUS_TLD');
  });

  it('produces no signals for a plain https site', () => {
    const analysis = analyzeUrl('https://example.org/articles/hello');

    expect(analysis?.signals).toHaveLength(0);
    expect(analysis?.score).toBe(0);
  });

  it('raises the score as signals accumulate', () => {
    const clean = analyzeUrl('https://example.org/')?.score ?? 0;
    const risky = analyzeUrl('http://paypal.com.secure-login.tk/account/verify')?.score ?? 0;

    expect(risky).toBeGreaterThan(clean);
    expect(risky).toBeLessThanOrEqual(1);
  });

  it('returns null for a non-URL string', () => {
    expect(analyzeUrl('not a url')).toBeNull();
  });

  it('extracts every URL in a block of text', () => {
    const analyses = analyzeUrls('visit https://bit.ly/abc and http://10.0.0.1/x');

    expect(analyses).toHaveLength(2);
    expect(analyses[0].signals.map((signal) => signal.code)).toContain('SHORTENER');
    expect(analyses[1].signals.map((signal) => signal.code)).toContain('IP_HOST');
  });
});
