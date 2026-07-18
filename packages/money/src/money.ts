/**
 * @elias/money — exact USD money arithmetic.
 *
 * Core rule for the whole suite: NO float64 money anywhere.
 * All amounts are integer cents held in a `bigint`, so a fractional cent
 * is unrepresentable and any accidental float is a compile-time error
 * (and a runtime TypeError) instead of a silent rounding bug.
 */

export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

export class MoneyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

const CENTS_PER_DOLLAR = 100n;

/** -?digits with optional . + 1-2 digits — the only accepted dollar literal. */
const DOLLAR_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
/** parse(): same, but allows a leading $ and strictly-grouped thousands commas. */
const PARSE_RE = /^(-?)\$?((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?$/;
/** Exact decimal factor for multiply(): -?digits with optional . + digits. */
const FACTOR_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

function assertCentsInput(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(
        'NOT_AN_INTEGER',
        `fromCents: expected integer cents, got ${String(value)}. ` +
          'Non-integer or unsafe number input is refused — no float64 money anywhere.',
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^-?\d+$/.test(s)) {
      throw new MoneyError('NOT_AN_INTEGER', `fromCents: malformed integer cents string ${JSON.stringify(value)}.`);
    }
    return BigInt(s);
  }
  throw new MoneyError('BAD_TYPE', `fromCents: unsupported input type ${typeof value}.`);
}

/** Exact rational for a decimal factor string: { sign, numerator, denominator }. */
function parseFactor(factor: string | number): { neg: boolean; num: bigint; den: bigint } {
  let text: string;
  if (typeof factor === 'number') {
    // Integers are exact; any fractional/NaN/Infinity number is refused (Billable NaN class).
    if (!Number.isSafeInteger(factor)) {
      throw new MoneyError(
        'BAD_FACTOR',
        `multiply: number factors must be safe integers, got ${String(factor)}. ` +
          'Pass an exact decimal string (e.g. "2.5") for non-integer factors.',
      );
    }
    text = String(factor);
  } else if (typeof factor === 'string') {
    text = factor.trim();
  } else {
    throw new MoneyError('BAD_FACTOR', `multiply: unsupported factor type ${typeof factor}.`);
  }
  const m = FACTOR_RE.exec(text);
  if (!m) {
    throw new MoneyError('BAD_FACTOR', `multiply: malformed factor ${JSON.stringify(factor)}. Use an exact decimal string.`);
  }
  const neg = m[1] === '-';
  const intPart = m[2] as string;
  const fracPart = m[3] ?? '';
  const num = BigInt(intPart + fracPart);
  const den = 10n ** BigInt(fracPart.length);
  return { neg, num, den };
}

/** Divide n/d rounding per mode. Sign is applied after rounding the magnitude. */
function divideRounded(neg: boolean, num: bigint, den: bigint, mode: RoundingMode): bigint {
  const q = num / den;
  const r = num % den;
  let rounded = q;
  if (r !== 0n) {
    const twice = r * 2n;
    switch (mode) {
      case 'down':
        break;
      case 'up':
        rounded = q + 1n;
        break;
      case 'half-up':
        if (twice >= den) rounded = q + 1n;
        break;
      case 'half-even':
        if (twice > den || (twice === den && q % 2n === 1n)) rounded = q + 1n;
        break;
    }
  }
  return neg ? -rounded : rounded;
}

function dollarsToCents(match: RegExpExecArray, raw: string): bigint {
  const neg = match[1] === '-';
  const intDigits = (match[2] as string).replace(/,/g, '');
  const fracDigits = (match[3] ?? '').padEnd(2, '0'); // "1.5" -> 50 cents, "1" -> 0 cents
  const cents = BigInt(intDigits) * CENTS_PER_DOLLAR + BigInt(fracDigits === '' ? '0' : fracDigits);
  if (fracDigits.length > 2) {
    // Unreachable via the regexes; kept as a defensive invariant.
    throw new MoneyError('SUBCENT', `Refusing sub-cent precision in ${JSON.stringify(raw)}.`);
  }
  return neg ? -cents : cents;
}

function formatGrouped(digits: string): string {
  const out: string[] = [];
  for (let i = digits.length; i > 0; i -= 3) {
    out.unshift(digits.slice(Math.max(0, i - 3), i));
  }
  return out.join(',');
}

/**
 * Immutable USD amount. Construct via Money.fromCents / fromDollars / parse / zero.
 * Every operation returns a new Money; cents are never exposed as a float.
 */
export class Money {
  private readonly cents: bigint;

  private constructor(cents: bigint) {
    this.cents = cents;
  }

  /** Integer cents. Accepts bigint, safe-integer number, or integer string. Rejects 1.5, NaN, Infinity. */
  static fromCents(cents: bigint | number | string): Money {
    return new Money(assertCentsInput(cents));
  }

  /**
   * Exact dollar amount from a STRING literal only: "1234.56", "-5", "0.10".
   * Floats are rejected by the type signature and at runtime. More than two
   * decimal places is rejected — rounding policy must be chosen explicitly
   * via multiply(), never smuggled in through parsing.
   */
  static fromDollars(dollars: string): Money {
    if (typeof dollars !== 'string') {
      throw new MoneyError('BAD_TYPE', `fromDollars: expected a string, got ${typeof dollars}. Never pass a float.`);
    }
    const m = DOLLAR_RE.exec(dollars.trim());
    if (!m) {
      throw new MoneyError(
        'MALFORMED',
        `fromDollars: malformed dollar string ${JSON.stringify(dollars)}. ` +
          'Expected "-?digits[.d{1,2}]" — e.g. "1234.56". Sub-cent precision and floats are refused.',
      );
    }
    return new Money(dollarsToCents(m, dollars));
  }

  /**
   * Strict parse of a user/bank-facing amount: accepts optional "$" and
   * correctly-grouped thousands commas (i.e. the inverse of format()).
   * Rejects floats, NaN, sub-cent precision, bad comma grouping, empty input.
   */
  static parse(input: string): Money {
    if (typeof input !== 'string') {
      throw new MoneyError('BAD_TYPE', `parse: expected a string, got ${typeof input}.`);
    }
    const s = input.trim();
    const m = PARSE_RE.exec(s);
    if (!m) {
      throw new MoneyError('MALFORMED', `parse: cannot parse ${JSON.stringify(input)} as a USD amount.`);
    }
    return new Money(dollarsToCents(m, input));
  }

  static zero(): Money {
    return new Money(0n);
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  subtract(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  negate(): Money {
    return new Money(-this.cents);
  }

  abs(): Money {
    return new Money(this.cents < 0n ? -this.cents : this.cents);
  }

  /**
   * Multiply by an exact factor. Accepts a safe-integer number or an exact
   * decimal string ("2.5", "0.075"). Fractional-cent results are rounded
   * half-up (away from zero) by default; override with { rounding }.
   * Float factors (0.1, NaN) are refused — use a string.
   */
  multiply(factor: string | number, opts?: { rounding?: RoundingMode }): Money {
    const { neg, num, den } = parseFactor(factor);
    const valueNeg = this.cents < 0n;
    const magnitude = (valueNeg ? -this.cents : this.cents) * num;
    const cents = divideRounded(neg !== valueNeg, magnitude, den, opts?.rounding ?? 'half-up');
    return new Money(cents);
  }

  /** percent may be an integer ("8" or 8) or exact decimal string ("7.5"). 100% = identity. */
  multiplyPercent(percent: string | number, opts?: { rounding?: RoundingMode }): Money {
    const { neg, num, den } = parseFactor(percent);
    const valueNeg = this.cents < 0n;
    const magnitude = (valueNeg ? -this.cents : this.cents) * num;
    const cents = divideRounded(neg !== valueNeg, magnitude, den * 100n, opts?.rounding ?? 'half-up');
    return new Money(cents);
  }

  /** Basis points: 1 bp = 0.01%. Integer bps only. 10_000 bp = identity. */
  multiplyBasisPoints(basisPoints: number | string, opts?: { rounding?: RoundingMode }): Money {
    const { neg, num, den } = parseFactor(basisPoints);
    if (den !== 1n) {
      throw new MoneyError('BAD_FACTOR', 'multiplyBasisPoints: basis points must be an integer.');
    }
    const valueNeg = this.cents < 0n;
    const magnitude = (valueNeg ? -this.cents : this.cents) * num;
    const cents = divideRounded(neg !== valueNeg, magnitude, 10_000n, opts?.rounding ?? 'half-up');
    return new Money(cents);
  }

  /** -1 | 0 | 1 — exact, no epsilon. */
  compare(other: Money): -1 | 0 | 1 {
    return this.cents < other.cents ? -1 : this.cents > other.cents ? 1 : 0;
  }

  /**
   * EXACT equality. There is deliberately no tolerance/epsilon parameter:
   * a 1-cent difference is a different amount of money. (Trust-account
   * reconciliation "tolerance" bugs start life as approximate equality.)
   */
  equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  /** Integer cents as bigint. */
  toCents(): bigint {
    return this.cents;
  }

  /** USD display string: "$1,234.56", "-$5.00". */
  format(): string {
    const neg = this.cents < 0n;
    const magnitude = neg ? -this.cents : this.cents;
    const dollars = magnitude / CENTS_PER_DOLLAR;
    const cents = magnitude % CENTS_PER_DOLLAR;
    const centsText = cents.toString().padStart(2, '0');
    return `${neg ? '-' : ''}$${formatGrouped(dollars.toString())}.${centsText}`;
  }

  toString(): string {
    return this.format();
  }

  /** JSON-safe representation: integer cents as a decimal string (bigint is not JSON-serializable). */
  toJSON(): string {
    return this.cents.toString();
  }

  /** Inverse of toJSON(). */
  static fromJSON(json: string): Money {
    return Money.fromCents(json);
  }
}
