/**
 * Money helpers — integer-cents math for trust accounting (audit issue #10).
 *
 * Amounts remain stored in Firestore as dollar numbers (no data migration
 * required), but ALL calculation-layer work — summation, comparison, and
 * reconciliation identities — is performed in integer cents, which are exact
 * in IEEE-754 doubles up to 2^53. This eliminates float-drift false
 * positives/negatives and removes the $0.01 tolerance that let one-cent
 * discrepancies report as "Reconciled".
 */

/** Convert a dollar amount to integer cents (rounded to the nearest cent). */
export const toCents = (amount: number | null | undefined): number =>
  Math.round((amount ?? 0) * 100);

/** Convert integer cents back to dollars for storage/display. */
export const fromCents = (cents: number): number => cents / 100;

/** Sum dollar amounts exactly, returning integer cents. */
export const sumToCents = (amounts: (number | null | undefined)[]): number =>
  amounts.reduce((sum, amount) => sum + toCents(amount), 0);

/** Exact difference between two dollar amounts, in cents. */
export const diffCents = (a: number | null | undefined, b: number | null | undefined): number =>
  toCents(a) - toCents(b);
