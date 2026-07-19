// Exact-money regression tests for the iolta money bridge.
// Zero-dependency runner (node assert via tsx), matching the suite's style.
// Covers the boundary cases trust accounting cannot get wrong:
// half-cent ties (both signs), float-noise self-heal, exact summation,
// and the three-way reconciliation identity.
import assert from 'node:assert/strict';
import { toCents, fromCents, sumToCents, diffCents, round2, dec } from '../src/money';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- The bug this wiring fixes: Math.round(amount * 100) -------------------
test('toCents(1.005) rounds half-up to 101 (was 100 with Math.round(1.005*100))', () => {
  assert.equal(toCents(1.005), 101);
});

test('toCents(-1.005) rounds away from zero to -101 (was -100: Math.round ties toward +Infinity)', () => {
  assert.equal(toCents(-1.005), -101);
});

test('toCents(2.675) = 268 (classic float-representation tie)', () => {
  assert.equal(toCents(2.675), 268);
});

test('sign symmetry: receipts and disbursements round identically in magnitude', () => {
  for (const v of [0.005, 1.005, 2.675, 13.335, 20.025, 100.005]) {
    assert.equal(toCents(-v), -toCents(v), `asymmetry at ${v}`);
  }
});

// --- Boundary values -------------------------------------------------------
test('toCents handles null/undefined/zero as 0', () => {
  assert.equal(toCents(null), 0);
  assert.equal(toCents(undefined), 0);
  assert.equal(toCents(0), 0);
});

test('float-noise stored dollars self-heal to intended cents', () => {
  assert.equal(toCents(20.029999999999998), 2003); // 1.5h x $13.35 stored as float
  assert.equal(toCents(0.30000000000000004), 30); // 0.1 + 0.2
  assert.equal(toCents(-20.029999999999998), -2003);
});

test('the misbilling case from books/billable: 20.025 is 2003 cents, not 2002', () => {
  assert.equal(toCents(20.025), 2003);
});

test('toCents rejects scientific-notation-magnitude numbers instead of guessing', () => {
  assert.throws(() => toCents(1e21), /non-decimal/);
});

test('dec() rejects non-decimal numbers', () => {
  assert.throws(() => dec(1e-7), /non-decimal/);
  assert.equal(dec(13.35), '13.35');
});

// --- Exact summation -------------------------------------------------------
test('sumToCents is exact where float addition is not', () => {
  assert.equal(sumToCents([0.1, 0.2]), 30);
  assert.equal(sumToCents([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]), 100);
  // Per-entry rounding: each -50.005 is -5001 cents on entry, so a $100.01
  // receipt against two -$50.005 disbursements leaves a real -1 cent gap.
  assert.equal(sumToCents([100.01, -50.005, -50.005]), -1);
});

test('sumToCents skips null/undefined/0 like the ledger reducers do', () => {
  assert.equal(sumToCents([null, undefined, 0, 12.34]), 1234);
});

test('large trust balances stay exact', () => {
  assert.equal(sumToCents([999999.99, 0.01]), 100000000);
});

// --- Differences and rounding ---------------------------------------------
test('diffCents is exact for reconciliation leg comparisons', () => {
  assert.equal(diffCents(1000.10, 1000.1), 0); // same money, different float literals
  assert.equal(diffCents(0.3, 0.1), 20);
  assert.equal(diffCents(-5.005, 5.005), -1002); // -501 - 501
});

test('round2 is an exact drop-in replacement for Math.round(n * 100) / 100', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round2(20.025), 20.03);
});

test('fromCents/toCents round-trip is identity on cent-quantized values', () => {
  for (const c of [0, 1, -1, 101, -101, 123456789, -987654321]) {
    assert.equal(toCents(fromCents(c)), c);
  }
});

// --- Three-way reconciliation identity -------------------------------------
test('three-way legs computed through the bridge reconcile to the penny', () => {
  // Statement $10,000.00; one outstanding check of $250.005 (clears after
  // month end, negative), one deposit in transit of $250.005. Half-cent
  // inputs round half-up on entry, symmetric by sign.
  const statementCents = toCents(10000);
  const outstandingCents = sumToCents([-250.005]);
  const inTransitCents = sumToCents([250.005]);
  const adjustedBankCents = statementCents + outstandingCents + inTransitCents;
  const bookCents = sumToCents([9750, 500.005, -250.005]);
  const clientLedgerCents = sumToCents([9750, 500.005, -250.005]);
  assert.equal(outstandingCents, -25001);
  assert.equal(inTransitCents, 25001);
  assert.equal(adjustedBankCents, 1000000);
  assert.equal(bookCents, 1000000);
  assert.equal(clientLedgerCents, 1000000);
  assert.equal(diffCents(fromCents(adjustedBankCents), fromCents(bookCents)), 0);
});

console.log(`\n${passed} tests passed`);
