import { describe, expect, it } from 'vitest';
import {
  cite,
  isCited,
  materialize,
  citedLeaves,
  citationAt,
  resolveByDate,
  lookup,
  payrollRuleSet,
  payrollValues,
  ACH_SERVICE_CLASS
} from '../src/index.js';

describe('cite / isCited', () => {
  it('binds a value to its citation', () => {
    const c = cite(0.062, 'IRC §3101(a)', 'OASDI rate');
    expect(c.value).toBe(0.062);
    expect(c.cite.authority).toBe('IRC §3101(a)');
    expect(c.cite.locator).toBe('OASDI rate');
    expect(isCited(c)).toBe(true);
  });

  it('omits an undefined note rather than storing the key', () => {
    const c = cite(1, 'A', 'B');
    expect('note' in c.cite).toBe(false);
  });

  it('rejects non-cited values', () => {
    expect(isCited(0.062)).toBe(false);
    expect(isCited({ value: 1 })).toBe(false);
    expect(isCited(null)).toBe(false);
  });
});

describe('materialize', () => {
  it('strips citations to plain values, recursing through objects and arrays', () => {
    const structured = {
      rate: cite(0.062, 'a', 'b'),
      table: cite([[0, 0, 0.1], [100, 10, 0.2]], 'c', 'd'),
      nested: { base: cite(7000, 'e', 'f') },
      plain: 2026
    };
    expect(materialize(structured)).toEqual({
      rate: 0.062,
      table: [[0, 0, 0.1], [100, 10, 0.2]],
      nested: { base: 7000 },
      plain: 2026
    });
  });
});

describe('citedLeaves / citationAt', () => {
  it('flattens every cited constant with a dotted path', () => {
    const leaves = citedLeaves({ a: cite(1, 'A', 'x'), b: { c: cite(2, 'B', 'y') } });
    expect(leaves).toEqual([
      { path: 'a', value: 1, cite: { authority: 'A', locator: 'x' } },
      { path: 'b.c', value: 2, cite: { authority: 'B', locator: 'y' } }
    ]);
  });

  it('resolves a citation by path and throws on a bad path', () => {
    const params = payrollRuleSet(2026).params;
    expect(citationAt(params, 'SOCIAL_SECURITY_WAGE_BASE').authority).toMatch(/SSA/);
    expect(citationAt(params, 'FED_STANDARD.single').authority).toMatch(/15-T/);
    expect(() => citationAt(params, 'NOPE')).toThrow(/No rule parameter/);
    expect(() => citationAt(params, 'FED_STANDARD')).toThrow(/not a cited constant/);
  });
});

describe('payroll rule set', () => {
  it('exposes plain values matching the known 2026 constants', () => {
    const v = payrollValues(2026);
    expect(v.YEAR).toBe(2026);
    expect(v.SOCIAL_SECURITY_RATE).toBe(0.062);
    expect(v.SOCIAL_SECURITY_WAGE_BASE).toBe(184500);
    expect(v.MEDICARE_RATE).toBe(0.0145);
    expect(v.FUTA_RATE).toBe(0.006);
    expect(v.FUTA_WAGE_BASE).toBe(7000);
    expect(v.FED_STANDARD.single[1]).toEqual([7500, 0, 0.1]);
    expect(v.NJ_RATE_TABLES.A[0]).toEqual([0, 0, 0.015]);
    expect(v.NJ_UI_WAGE_BASE).toBe(44800);
    expect(v.ELECTIVE_DEFERRAL_LIMIT_402G).toBe(24500);
  });

  it('memoizes the materialized values (same reference)', () => {
    expect(payrollValues(2026)).toBe(payrollValues(2026));
  });

  it('throws with an actionable message for an unregistered year', () => {
    expect(() => payrollRuleSet(2031)).toThrow(/No payroll rule set for 2031/);
  });

  it('EVERY constant carries a non-empty authority and locator (the moat invariant)', () => {
    const leaves = citedLeaves(payrollRuleSet(2026).params);
    expect(leaves.length).toBeGreaterThan(20);
    for (const leaf of leaves) {
      expect(leaf.cite.authority.length, `authority for ${leaf.path}`).toBeGreaterThan(0);
      expect(leaf.cite.locator.length, `locator for ${leaf.path}`).toBeGreaterThan(0);
    }
  });
});

describe('registry / effective-date resolution', () => {
  it('finds the payroll set in effect on a date', () => {
    const rs = resolveByDate('payroll', 'US-NJ', '2026-07-23');
    expect(rs?.year).toBe(2026);
    expect(lookup('payroll', 'US-NJ', 2026)?.effectiveDate).toBe('2026-01-01');
  });

  it('returns undefined before any set takes effect', () => {
    expect(resolveByDate('payroll', 'US-NJ', '2025-12-31')).toBeUndefined();
  });
});

describe('NACHA service classes', () => {
  it('payroll credit-only batch is 220, mixed is 200', () => {
    expect(ACH_SERVICE_CLASS.CREDITS_ONLY.value).toBe('220');
    expect(ACH_SERVICE_CLASS.MIXED.value).toBe('200');
    expect(ACH_SERVICE_CLASS.CREDITS_ONLY.cite.authority).toMatch(/NACHA/);
  });
});
