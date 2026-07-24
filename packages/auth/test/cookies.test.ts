import { describe, it, expect } from 'vitest';
import { parseCookieHeader } from '../src/cookies.js';

describe('parseCookieHeader', () => {
  it('parses multiple cookies', () => {
    expect(parseCookieHeader('qb_session=abc; qb_company=c1')).toEqual({
      qb_session: 'abc',
      qb_company: 'c1',
    });
  });

  it('decodes percent-escapes', () => {
    expect(parseCookieHeader('k=a%20b')).toEqual({ k: 'a b' });
  });

  it('keeps the raw value on a malformed escape instead of throwing', () => {
    expect(() => parseCookieHeader('k=%')).not.toThrow();
    expect(parseCookieHeader('k=%')).toEqual({ k: '%' });
  });

  it('tolerates empty / missing headers and stray segments', () => {
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('novalue; =noname; k=v')).toEqual({ k: 'v' });
  });
});
