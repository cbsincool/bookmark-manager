import { describe, it, expect } from 'vitest';
import { normalizeUrl, extractDomain, isLowInfoTitle } from '../urlUtils';

describe('normalizeUrl', () => {
  const opts = { stripUtm: true, stripTrailingSlash: true, stripHash: true };

  it('strips trailing slash', () => {
    expect(normalizeUrl('https://example.com/', opts)).toBe('https://example.com');
  });

  it('strips hash', () => {
    expect(normalizeUrl('https://example.com/page#section', opts)).toBe('https://example.com/page');
  });

  it('strips utm params but keeps others', () => {
    expect(normalizeUrl('https://example.com/page?utm_source=google&id=5', opts))
      .toBe('https://example.com/page?id=5');
  });

  it('strips all utm variants', () => {
    expect(normalizeUrl('https://example.com?utm_medium=cpc&utm_campaign=test', opts))
      .toBe('https://example.com');
  });

  it('handles missing protocol gracefully', () => {
    expect(normalizeUrl('example.com/page/', opts)).toBe('example.com/page');
  });

  it('respects disabled options', () => {
    const noStrip = { stripUtm: false, stripTrailingSlash: false, stripHash: false };
    expect(normalizeUrl('https://example.com/?utm_source=g#top', noStrip))
      .toBe('https://example.com/?utm_source=g#top');
  });
});

describe('extractDomain', () => {
  it('extracts domain from full URL', () => {
    expect(extractDomain('https://docs.python.org/3/tutorial/')).toBe('docs.python.org');
  });

  it('handles URL without protocol', () => {
    expect(extractDomain('github.com/user/repo')).toBe('github.com');
  });
});

describe('isLowInfoTitle', () => {
  it('detects generic titles', () => {
    expect(isLowInfoTitle('Home')).toBe(true);
    expect(isLowInfoTitle('首页')).toBe(true);
    expect(isLowInfoTitle('Untitled')).toBe(true);
  });

  it('detects short titles', () => {
    expect(isLowInfoTitle('Hi')).toBe(true);
  });

  it('passes normal titles', () => {
    expect(isLowInfoTitle('React Hooks Tutorial')).toBe(false);
  });
});
