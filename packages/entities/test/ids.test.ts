import { describe, it, expect } from 'vitest';
import {
  ENTITY_KINDS,
  isEntityKind,
  prefixForKind,
  makeEntityId,
  firmId,
  clientId,
  matterId,
  userId,
  parseEntityId,
  tryParseEntityId,
  isEntityId,
  entityKindOf,
  localIdOf,
  slugifyLocalId,
  deriveLocalId,
  deriveEntityId,
} from '../src/index.js';

describe('entity kinds + prefixes', () => {
  it('exposes exactly the four canonical kinds', () => {
    expect([...ENTITY_KINDS]).toEqual(['firm', 'client', 'matter', 'user']);
  });

  it('isEntityKind is a fail-closed guard', () => {
    expect(isEntityKind('firm')).toBe(true);
    expect(isEntityKind('user')).toBe(true);
    expect(isEntityKind('company')).toBe(false);
    expect(isEntityKind('')).toBe(false);
    expect(isEntityKind(42)).toBe(false);
    expect(isEntityKind(null)).toBe(false);
  });

  it('every kind has a distinct short prefix', () => {
    const prefixes = ENTITY_KINDS.map(prefixForKind);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixForKind('firm')).toBe('firm');
    expect(prefixForKind('client')).toBe('clnt');
    expect(prefixForKind('matter')).toBe('mtr');
    expect(prefixForKind('user')).toBe('usr');
  });
});

describe('makeEntityId / format', () => {
  it('formats a prefixed id from a valid local id', () => {
    expect(makeEntityId('firm', 'abc123')).toBe('firm_abc123');
    expect(makeEntityId('client', 'k9x2')).toBe('clnt_k9x2');
    expect(makeEntityId('matter', 'general')).toBe('mtr_general');
    expect(makeEntityId('user', 'jane')).toBe('usr_jane');
  });

  it('convenience constructors match makeEntityId', () => {
    expect(firmId('abc123')).toBe(makeEntityId('firm', 'abc123'));
    expect(clientId('abc123')).toBe(makeEntityId('client', 'abc123'));
    expect(matterId('abc123')).toBe(makeEntityId('matter', 'abc123'));
    expect(userId('abc123')).toBe(makeEntityId('user', 'abc123'));
  });

  it('accepts real-world local id shapes from the three apps', () => {
    // books uid() — base36 timestamp+random, no separators
    expect(makeEntityId('client', 'lz4k9m0abc')).toBe('clnt_lz4k9m0abc');
    // iolta composite account id — trust__<uid>, underscores preserved
    expect(makeEntityId('firm', 'trust__WkX92aBc')).toBe('firm_trust__WkX92aBc');
    // uuid (books outbox) — hyphens allowed
    const u = '550e8400-e29b-41d4-a716-446655440000';
    expect(makeEntityId('user', u)).toBe(`usr_${u}`);
    // billable sha1 hex tag
    expect(makeEntityId('matter', 'a1b2c3d4e5f6')).toBe('mtr_a1b2c3d4e5f6');
  });

  it('fails closed on an unknown kind', () => {
    // @ts-expect-error — 'company' is not an EntityKind
    expect(() => makeEntityId('company', 'x')).toThrow();
  });

  it('rejects empty / whitespace / unsafe local ids', () => {
    expect(() => makeEntityId('firm', '')).toThrow();
    expect(() => makeEntityId('firm', '   ')).toThrow();
    expect(() => makeEntityId('firm', 'has space')).toThrow();
    expect(() => makeEntityId('firm', 'has/slash')).toThrow();
    expect(() => makeEntityId('firm', 'has|pipe')).toThrow();
    expect(() => makeEntityId('firm', '_leadingsep')).toThrow(); // must start alnum
    expect(() => makeEntityId('firm', '-leadinghyphen')).toThrow();
    // @ts-expect-error — runtime guard against non-string
    expect(() => makeEntityId('firm', 123)).toThrow();
  });
});

describe('parseEntityId / round-trip', () => {
  it('round-trips kind + localId for every kind', () => {
    for (const kind of ENTITY_KINDS) {
      const id = makeEntityId(kind, 'trust__abc-123');
      const parsed = parseEntityId(id);
      expect(parsed.kind).toBe(kind);
      expect(parsed.localId).toBe('trust__abc-123');
    }
  });

  it('splits only on the FIRST underscore so local underscores survive', () => {
    const parsed = parseEntityId('firm_trust__abc');
    expect(parsed.kind).toBe('firm');
    expect(parsed.localId).toBe('trust__abc');
  });

  it('parseEntityId throws on malformed input', () => {
    expect(() => parseEntityId('nope')).toThrow(); // no separator
    expect(() => parseEntityId('firm_')).toThrow(); // empty local id
    expect(() => parseEntityId('xyz_abc')).toThrow(); // unknown prefix
    expect(() => parseEntityId('FIRM_abc')).toThrow(); // prefix is lowercase
    expect(() => parseEntityId(null)).toThrow(); // accepts unknown, throws at runtime
  });

  it('tryParseEntityId returns null instead of throwing', () => {
    expect(tryParseEntityId('nope')).toBeNull();
    expect(tryParseEntityId('xyz_abc')).toBeNull();
    expect(tryParseEntityId('firm_abc')).toEqual({ kind: 'firm', localId: 'abc' });
  });

  it('entityKindOf / localIdOf are the parsed projections', () => {
    expect(entityKindOf('mtr_estate')).toBe('matter');
    expect(localIdOf('mtr_estate')).toBe('estate');
    expect(() => entityKindOf('bad')).toThrow();
  });
});

describe('isEntityId guard', () => {
  it('accepts a well-formed id, optionally constrained to a kind', () => {
    const id = firmId('abc');
    expect(isEntityId(id)).toBe(true);
    expect(isEntityId(id, 'firm')).toBe(true);
    expect(isEntityId(id, 'client')).toBe(false);
  });

  it('rejects non-ids and never throws', () => {
    expect(isEntityId('nope')).toBe(false);
    expect(isEntityId('xyz_abc')).toBe(false);
    expect(isEntityId('')).toBe(false);
    expect(isEntityId(undefined)).toBe(false);
    expect(isEntityId(123)).toBe(false);
    expect(isEntityId({})).toBe(false);
  });
});

describe('slugifyLocalId (free-text → safe local id)', () => {
  it('normalizes billable-style free text into a valid local id', () => {
    const slug = slugifyLocalId('Acme Estate Plan');
    expect(slug).toBe('acme-estate-plan');
    expect(isEntityId(makeEntityId('matter', slug))).toBe(true);
  });

  it('collapses runs of unsafe characters and trims edges', () => {
    expect(slugifyLocalId('  Smith,  Jane / Trust!! ')).toBe('smith-jane-trust');
    expect(slugifyLocalId('a---b')).toBe('a-b');
  });

  it('throws when nothing slug-able remains (caller should hash instead)', () => {
    expect(() => slugifyLocalId('   ')).toThrow();
    expect(() => slugifyLocalId('!!!')).toThrow();
    expect(() => slugifyLocalId('')).toThrow();
  });
});

describe('deriveLocalId / deriveEntityId (content-addressed natural keys)', () => {
  it('is deterministic and stable for the same parts', () => {
    const a = deriveLocalId('Acme Corp', 'Estate Plan');
    const b = deriveLocalId('Acme Corp', 'Estate Plan');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(isEntityId(makeEntityId('matter', a))).toBe(true);
  });

  it('is unambiguous across the part boundary (no delimiter collision)', () => {
    // ['a','bc'] must not collide with ['ab','c']
    expect(deriveLocalId('a', 'bc')).not.toBe(deriveLocalId('ab', 'c'));
  });

  it('gives billable client|matter the SAME canonical matter id every export', () => {
    const first = deriveEntityId('matter', 'Acme Corp', 'General');
    const again = deriveEntityId('matter', 'Acme Corp', 'General');
    expect(first).toBe(again);
    expect(entityKindOf(first)).toBe('matter');
  });

  it('requires at least one part', () => {
    expect(() => deriveLocalId()).toThrow();
  });
});
