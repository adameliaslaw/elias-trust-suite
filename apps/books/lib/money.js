'use strict';
// Exact-money bridge: all dollar arithmetic in books goes through
// @elias/money (bigint cents). JS floats appear only as exact decimal
// *boundary values* (user input, shortest-round-trip conversions) — never
// summed or multiplied as floats. Kills the float64 bug class, e.g.:
//   1.5h x $13.35 = $20.025 -> legacy round2 gave $20.02 (undercharge);
//   exact half-up gives $20.03. And round2(1.005) gave 1.00, now 1.01.
//
// Conventions (same as the rest of the suite):
// - every public helper takes and returns plain dollar NUMBERS, quantized
//   to whole cents, rounded half-up (away from zero — Python's
//   Decimal ROUND_HALF_UP, which the payroll engine is specified against)
// - products are computed at full precision and rounded ONCE
// - sums accumulate in integer cents
const { Money } = require('@elias/money');

// Exact decimal string for a JS number. String() is shortest round-trip,
// so 13.35 -> '13.35'. Guards against scientific notation leaking into
// @elias/money's factor parser (only reachable for absurd magnitudes).
function dec(n) {
  const s = String(n);
  if (/[eE]/.test(s)) throw new Error(`dec: non-decimal number ${s}`);
  return s;
}

// Snap float noise to 12 significant digits (the payroll engine's
// convention): 13.35 * 1.5 = 20.024999999999998 -> 20.025 before exact
// rounding, so an exactly-half result rounds UP instead of down.
function snapped(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x === 0) return 0;
  return Number(x.toPrecision(12));
}

// Dollars (number or numeric string) -> exact Money, half-up to the cent.
// Converts via $1.00 x factor so 3+ decimal-place inputs round half-up
// instead of being rejected by fromDollars' strict 2dp literal.
function dollars(n) {
  return Money.fromCents(100).multiply(dec(n));
}

// Exact half-up cent rounding of a dollar number -> dollar number.
// Drop-in replacement for Math.round(n * 100) / 100.
function round2(n) {
  return Number(dollars(n).toCents()) / 100;
}

// Integer cents of a dollar number, exact half-up.
function centsInt(n) {
  return Number(dollars(n).toCents());
}

// Parse an exact decimal string into sign/numerator/denominator bigints.
const DEC_RE = /^(-?)(\d+)(?:\.(\d+))?$/;
function parseDec(s) {
  const m = DEC_RE.exec(s);
  if (!m) throw new Error(`parseDec: malformed decimal ${JSON.stringify(s)}`);
  const frac = m[3] || '';
  return { neg: m[1] === '-', num: BigInt(m[2] + frac), den: 10n ** BigInt(frac.length) };
}

// num/den rounded half-up (away from zero on the signed result).
function divHalfUp(neg, num, den) {
  const q = num / den;
  const r = num % den;
  const rounded = r !== 0n && r * 2n >= den ? q + 1n : q;
  return neg ? -rounded : rounded;
}

// Exact product of decimal factors, expressed in cents and rounded ONCE,
// half-up: productCents(13.35, 1.5) = 2003. Numeric factors are snapped to
// 12 significant digits first so float noise can't cross a .5 boundary.
function productCents(...factors) {
  let num = 100n;
  let den = 1n;
  let neg = false;
  for (const f of factors) {
    const p = parseDec(dec(snapped(f)));
    if (p.num === 0n) return 0;
    neg = neg !== p.neg;
    num *= p.num;
    den *= p.den;
  }
  return Number(divHalfUp(neg, num, den));
}

// a * b * ... in dollars, exact, rounded half-up to the cent.
function mul(...factors) {
  return productCents(...factors) / 100;
}

// amount * pct / 100 in dollars, exact, single half-up rounding.
function percentOf(amount, pct) {
  return Number(dollars(amount).multiplyPercent(dec(snapped(pct))).toCents()) / 100;
}

// Exact sum of any number of cent-quantized dollar amounts -> dollars.
// Each term is snapped through dollars() first, so stored float noise
// (e.g. 20.029999999999998) self-heals to the intended cents.
function sum(...amounts) {
  let total = Money.zero();
  for (const a of amounts) {
    if (a) total = total.add(dollars(a));
  }
  return Number(total.toCents()) / 100;
}

const add = sum;

// a - b - c ... in exact cents.
function sub(a, ...rest) {
  return sum(a, ...rest.map(x => -x));
}

// Proportional split: amount * part / whole, half-up to the cent, computed
// in integer cents (no float ratio). Used to split a payment into the
// income and sales-tax portions of the invoice it pays down.
function shareOf(amount, part, whole) {
  const a = BigInt(dollars(amount).toCents());
  const p = BigInt(dollars(part).toCents());
  const w = BigInt(dollars(whole).toCents());
  if (w === 0n || a === 0n || p === 0n) return 0;
  const neg = (a < 0n) !== (p < 0n) !== (w < 0n);
  const abs = x => (x < 0n ? -x : x);
  const num = abs(a) * abs(p);
  const q = divHalfUp(false, num, abs(w));
  return Number(neg ? -q : q) / 100;
}

module.exports = { dec, snapped, dollars, round2, centsInt, productCents, mul, percentOf, sum, add, sub, shareOf };
