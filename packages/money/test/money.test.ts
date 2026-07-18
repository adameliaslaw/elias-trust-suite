import { describe, expect, it } from 'vitest';
import { Money, MoneyError } from '../src/index.js';

describe('fromCents', () => {
  it('accepts bigint, safe-integer number, and integer string', () => {
    expect(Money.fromCents(123n).toCents()).toBe(123n);
    expect(Money.fromCents(123).toCents()).toBe(123n);
    expect(Money.fromCents('123').toCents()).toBe(123n);
    expect(Money.fromCents(-45).toCents()).toBe(-45n);
  });

  it('rejects fractional, NaN, and infinite numbers', () => {
    expect(() => Money.fromCents(1.5)).toThrow(MoneyError);
    expect(() => Money.fromCents(Number.NaN)).toThrow(MoneyError);
    expect(() => Money.fromCents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => Money.fromCents(2 ** 53)).toThrow(MoneyError); // not a safe integer
  });

  it('rejects malformed strings', () => {
    expect(() => Money.fromCents('1.5')).toThrow(MoneyError);
    expect(() => Money.fromCents('')).toThrow(MoneyError);
    expect(() => Money.fromCents('abc')).toThrow(MoneyError);
  });
});

describe('fromDollars', () => {
  it('parses exact dollar strings', () => {
    expect(Money.fromDollars('0').toCents()).toBe(0n);
    expect(Money.fromDollars('1').toCents()).toBe(100n);
    expect(Money.fromDollars('1.5').toCents()).toBe(150n);
    expect(Money.fromDollars('0.10').toCents()).toBe(10n);
    expect(Money.fromDollars('-1234.56').toCents()).toBe(-123456n);
    expect(Money.fromDollars('1000000.00').format()).toBe('$1,000,000.00');
  });

  it('rejects sub-cent precision instead of silently rounding', () => {
    expect(() => Money.fromDollars('1.005')).toThrow(MoneyError);
    expect(() => Money.fromDollars('0.001')).toThrow(MoneyError);
  });

  it('rejects floats, NaN, and junk', () => {
    expect(() => Money.fromDollars(1.5 as unknown as string)).toThrow(MoneyError);
    expect(() => Money.fromDollars(Number.NaN as unknown as string)).toThrow(MoneyError);
    expect(() => Money.fromDollars('abc')).toThrow(MoneyError);
    expect(() => Money.fromDollars('')).toThrow(MoneyError);
    expect(() => Money.fromDollars('1.')).toThrow(MoneyError);
    expect(() => Money.fromDollars('.5')).toThrow(MoneyError);
    expect(() => Money.fromDollars('$1.00')).toThrow(MoneyError); // '$' belongs to parse(), not fromDollars
    expect(() => Money.fromDollars('1,000.00')).toThrow(MoneyError);
  });
});

describe('add / subtract', () => {
  it('adds and subtracts exactly, immutably', () => {
    const a = Money.fromDollars('10.01');
    const b = Money.fromDollars('0.02');
    expect(a.add(b).toCents()).toBe(1003n);
    expect(a.subtract(b).toCents()).toBe(999n);
    // operands unchanged
    expect(a.toCents()).toBe(1001n);
    expect(b.toCents()).toBe(2n);
  });

  it('handles negatives and zero', () => {
    expect(Money.fromCents(5).add(Money.fromCents(-5)).isZero()).toBe(true);
    expect(Money.zero().subtract(Money.fromCents(1)).toCents()).toBe(-1n);
    expect(Money.fromCents(-100).negate().toCents()).toBe(100n);
    expect(Money.fromCents(-100).abs().toCents()).toBe(100n);
  });
});

describe('multiply', () => {
  it('multiplies by exact integer and decimal-string factors', () => {
    expect(Money.fromDollars('10.00').multiply(3).toCents()).toBe(3000n);
    expect(Money.fromDollars('10.00').multiply('2.5').toCents()).toBe(2500n);
    expect(Money.fromDollars('99.99').multiply('0.01').toCents()).toBe(100n); // 99.99 cents -> half-up 100
  });

  it('computes 0.005 factors exactly (no float64 error)', () => {
    // 10.00 * 0.005 = 0.05 exactly. In float64, 10 * 0.005 = 0.050000000000000003.
    expect(Money.fromDollars('10.00').multiply('0.005').toCents()).toBe(5n);
    expect(Money.fromDollars('10.00').multiply('0.005').format()).toBe('$0.05');
  });

  it('rounds a half cent deterministically (half away from zero)', () => {
    // 1 cent * 0.5 = 0.5 cent -> rounds to 1 cent, not 0 and not float noise.
    expect(Money.fromCents(1).multiply('0.5').toCents()).toBe(1n);
    expect(Money.fromCents(-1).multiply('0.5').toCents()).toBe(-1n);
    // 3 * 0.5 = 1.5 -> 2
    expect(Money.fromCents(3).multiply('0.5').toCents()).toBe(2n);
    // 0.005 of a cent is below the half-cent tie -> 0
    expect(Money.fromCents(1).multiply('0.005').toCents()).toBe(0n);
  });

  it('supports explicit rounding modes', () => {
    expect(Money.fromCents(1).multiply('0.5', { rounding: 'down' }).toCents()).toBe(0n);
    expect(Money.fromCents(1).multiply('0.1', { rounding: 'up' }).toCents()).toBe(1n);
    // half-even: 0.5 -> 0 (even), 1.5 -> 2 (even)
    expect(Money.fromCents(1).multiply('0.5', { rounding: 'half-even' }).toCents()).toBe(0n);
    expect(Money.fromCents(3).multiply('0.5', { rounding: 'half-even' }).toCents()).toBe(2n);
  });

  it('rejects float factors (NaN-class input)', () => {
    expect(() => Money.fromDollars('10.00').multiply(0.1)).toThrow(MoneyError);
    expect(() => Money.fromDollars('10.00').multiply(Number.NaN)).toThrow(MoneyError);
    expect(() => Money.fromDollars('10.00').multiply('abc')).toThrow(MoneyError);
    expect(() => Money.fromDollars('10.00').multiply('')).toThrow(MoneyError);
  });

  it('multiplyPercent and multiplyBasisPoints', () => {
    expect(Money.fromDollars('200.00').multiplyPercent('7.5').toCents()).toBe(1500n);
    expect(Money.fromDollars('200.00').multiplyPercent(100).toCents()).toBe(20000n);
    expect(Money.fromDollars('1000.00').multiplyBasisPoints(50).toCents()).toBe(500n);
    expect(Money.fromDollars('1000.00').multiplyBasisPoints(10_000).toCents()).toBe(100000n);
    expect(() => Money.fromDollars('1.00').multiplyBasisPoints('1.5')).toThrow(MoneyError);
  });

  it('keeps signs correct', () => {
    expect(Money.fromDollars('-10.00').multiply(2).toCents()).toBe(-2000n);
    expect(Money.fromDollars('10.00').multiply(-2).toCents()).toBe(-2000n);
    expect(Money.fromDollars('-10.00').multiply('-2').toCents()).toBe(2000n);
  });
});

describe('compare / equals — exact, no tolerance', () => {
  it('a 1-cent difference must NOT pass equality (IOLTA tolerance bug)', () => {
    const ledger = Money.fromCents(100_000); // $1,000.00
    const bank = Money.fromCents(100_001); //   $1,000.01
    // There is intentionally no tolerance/epsilon API. 1 cent off is unequal, full stop.
    expect(ledger.equals(bank)).toBe(false);
    expect(ledger.compare(bank)).toBe(-1);
    expect(bank.compare(ledger)).toBe(1);
  });

  it('exact matches pass', () => {
    expect(Money.fromDollars('5.00').equals(Money.fromCents(500))).toBe(true);
    expect(Money.fromDollars('5.00').compare(Money.fromCents(500))).toBe(0);
  });
});

describe('isZero / signs', () => {
  it('classifies', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.fromCents(0).isZero()).toBe(true);
    expect(Money.fromCents(-1).isNegative()).toBe(true);
    expect(Money.fromCents(1).isPositive()).toBe(true);
    expect(Money.zero().isPositive()).toBe(false);
  });
});

describe('format / parse', () => {
  it('formats USD strings', () => {
    expect(Money.zero().format()).toBe('$0.00');
    expect(Money.fromCents(5).format()).toBe('$0.05');
    expect(Money.fromCents(100).format()).toBe('$1.00');
    expect(Money.fromCents(123_456).format()).toBe('$1,234.56');
    expect(Money.fromCents(-123_456).format()).toBe('-$1,234.56');
    expect(Money.fromCents(1_234_567_890n).format()).toBe('$12,345,678.90');
  });

  it('parses strictly: accepts format() output, rejects garbage', () => {
    expect(Money.parse('$1,234.56').toCents()).toBe(123_456n);
    expect(Money.parse('1234.56').toCents()).toBe(123_456n);
    expect(Money.parse('-$5.00').toCents()).toBe(-500n);
    expect(Money.parse('  $42  ').toCents()).toBe(4200n);

    expect(() => Money.parse('')).toThrow(MoneyError);
    expect(() => Money.parse('abc')).toThrow(MoneyError);
    expect(() => Money.parse('1,23,4.56')).toThrow(MoneyError); // bad comma grouping
    expect(() => Money.parse('1.005')).toThrow(MoneyError); // sub-cent
    expect(() => Money.parse(Number.NaN as unknown as string)).toThrow(MoneyError);
    expect(() => Money.parse(12.34 as unknown as string)).toThrow(MoneyError); // float input
  });

  it('round-trips format() through parse()', () => {
    for (const cents of [0n, 7n, 100n, 123_456n, -9_999n, 88_877_766_655n]) {
      const m = Money.fromCents(cents);
      expect(Money.parse(m.format()).equals(m)).toBe(true);
    }
  });
});

describe('serialization', () => {
  it('JSON.stringify works via cents-string toJSON (bigint never reaches JSON)', () => {
    const m = Money.fromDollars('1234.56');
    expect(JSON.stringify({ amount: m })).toBe('{"amount":"123456"}');
    expect(Money.fromJSON(m.toJSON()).equals(m)).toBe(true);
  });
});
