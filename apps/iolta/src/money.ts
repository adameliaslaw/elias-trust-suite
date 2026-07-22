/**
 * Money helpers — exact bigint-cents math for trust accounting (audit issue #10),
 * now backed by @elias/money (same bridge pattern as apps/books/lib/money.js).
 *
 * Amounts remain stored in Firestore as dollar numbers (no data migration
 * required), but ALL calculation-layer work — summation, comparison, and
 * reconciliation identities — is performed in integer cents held as bigint,
 * which are exact. This eliminates float-drift false positives/negatives in
 * the three-way reconciliation and removes the $0.01 tolerance that let
 * one-cent discrepancies report as "Reconciled".
 *
 * Fixes the remaining half-cent class in the old Math.round(amount * 100):
 *   toCents(1.005)  was 100 (float 1.005*100 = 100.49999…), now 101
 *   toCents(-1.005) was -100 (Math.round ties toward +∞), now -101
 * Rounding is half-up, away from zero on the signed result — symmetric for
 * receipts and disbursements, matching the rest of the suite.
 *
 * This module is browser-safe: @elias/money is pure TypeScript + bigint
 * (no Node builtins), so it bundles into the Vite client. All ledger math
 * in this app is client-side; server.ts does no money math.
 */
import { Money } from '@elias/money';

/**
 * Exact decimal string for a JS number. String() is shortest round-trip,
 * so 13.35 -> '13.35'. String() switches to scientific notation for very
 * small (|n| < 1e-6) or very large (|n| >= 1e21) magnitudes; @elias/money's
 * factor parser only accepts plain decimals, so expand the notation here.
 * A tiny sub-cent leg (float noise, AI-extracted amounts) must round to 0
 * cents rather than crash the reconciliation summation. Absurd magnitudes are
 * caught later, at cents conversion, where exact safe-integer cents are
 * required.
 */
export function dec(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`dec: expected a finite number, got ${n}`);
  }
  const s = String(n);
  return /[eE]/.test(s) ? expandScientific(s) : s;
}

/** Expand a JS exponential literal ("1e-7", "1.5e-5", "1e+21") to plain decimal. */
function expandScientific(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) throw new Error(`dec: cannot expand number ${s}`);
  const [, sign, intPart, frac = '', expStr] = m;
  const exp = parseInt(expStr, 10);
  const digits = intPart + frac;
  const point = intPart.length + exp; // decimal point position within `digits`
  let out: string;
  if (point <= 0) {
    out = '0.' + '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    out = digits + '0'.repeat(point - digits.length);
  } else {
    out = digits.slice(0, point) + '.' + digits.slice(point);
  }
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return sign + out;
}

/**
 * Narrow exact bigint cents to a JS number, refusing values outside the safe
 * integer range — beyond it Number() silently loses precision, which trust
 * accounting must never do. This is the magnitude guard the old dec() faked by
 * rejecting scientific notation outright.
 */
function centsToNumber(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`money: amount exceeds exact safe integer cents (${cents})`);
  }
  return Number(cents);
}

/**
 * Dollars (number) -> exact Money, rounded half-up to the cent.
 * Converts via $1.00 x factor so 3+ decimal-place inputs (typed values,
 * AI-extracted amounts, legacy float noise) round half-up instead of being
 * rejected by fromDollars' strict 2dp literal. String(amount) is the exact
 * shortest decimal the float represents, so 0.1 + 0.2 style noise stored as
 * 20.029999999999998 snaps back to the intended cents on conversion.
 */
function dollars(n: number): Money {
  return Money.fromCents(100).multiply(dec(n));
}

/** Convert a dollar amount to integer cents, exact half-up (away from zero). */
export const toCents = (amount: number | null | undefined): number =>
  centsToNumber(dollars(amount ?? 0).toCents());

/** Convert integer cents back to dollars for storage/display. */
export const fromCents = (cents: number): number => cents / 100;

/** Sum dollar amounts exactly, returning integer cents. */
export const sumToCents = (amounts: (number | null | undefined)[]): number => {
  let total = Money.zero();
  for (const amount of amounts) {
    if (amount) total = total.add(dollars(amount));
  }
  return centsToNumber(total.toCents());
};

/** Exact difference between two dollar amounts, in cents. */
export const diffCents = (a: number | null | undefined, b: number | null | undefined): number =>
  toCents(a) - toCents(b);

/** Exact half-up cent rounding of a dollar number -> dollar number. */
export const round2 = (n: number): number => fromCents(toCents(n));
