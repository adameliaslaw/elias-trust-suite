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
 * so 13.35 -> '13.35'. Guards against scientific notation leaking into
 * @elias/money's factor parser (only reachable for absurd magnitudes).
 */
export function dec(n: number): string {
  const s = String(n);
  if (/[eE]/.test(s)) throw new Error(`dec: non-decimal number ${s}`);
  return s;
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
  Number(dollars(amount ?? 0).toCents());

/** Convert integer cents back to dollars for storage/display. */
export const fromCents = (cents: number): number => cents / 100;

/** Sum dollar amounts exactly, returning integer cents. */
export const sumToCents = (amounts: (number | null | undefined)[]): number => {
  let total = Money.zero();
  for (const amount of amounts) {
    if (amount) total = total.add(dollars(amount));
  }
  return Number(total.toCents());
};

/** Exact difference between two dollar amounts, in cents. */
export const diffCents = (a: number | null | undefined, b: number | null | undefined): number =>
  toCents(a) - toCents(b);

/** Exact half-up cent rounding of a dollar number -> dollar number. */
export const round2 = (n: number): number => fromCents(toCents(n));
