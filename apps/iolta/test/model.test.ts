// Multi-tenant doc-id scoping regression tests (issue #15).
//
// The bug: `statementBalances`/`reconciliations` docs used bare month IDs
// (e.g. `2026-07`) and the account was hardcoded `iolta-trust`. The first user
// to write a month owned that document for EVERYONE, and multiple trust
// accounts were impossible. Reproducing assertion: two firms/accounts (and two
// users) must map the same calendar month to DISTINCT doc ids — no collision.
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import {
  defaultAccountId,
  periodDocId,
  monthFromPeriodDocId,
} from '../src/model';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test('two users share a calendar month WITHOUT a doc-id collision (the #15 bug)', () => {
  const alice = defaultAccountId('uid-alice');
  const bob = defaultAccountId('uid-bob');
  assert.notEqual(alice, bob);

  const month = '2026-07';
  const aliceDoc = periodDocId(alice, month);
  const bobDoc = periodDocId(bob, month);

  // The old model: both would be the bare id `2026-07` → first writer wins.
  assert.notEqual(aliceDoc, bobDoc, 'same month must not collide across users');
  assert.ok(aliceDoc.endsWith('2026-07'));
  assert.ok(bobDoc.endsWith('2026-07'));
});

test('one user with two trust accounts keeps months separate', () => {
  const trust = 'trust__uid-alice';
  const escrow = 'escrow__uid-alice';
  const month = '2026-07';
  assert.notEqual(periodDocId(trust, month), periodDocId(escrow, month));
});

test('no account id is hardcoded to "iolta-trust"', () => {
  const acct = defaultAccountId('uid-alice');
  assert.ok(!acct.includes('iolta-trust'));
  assert.ok(acct.includes('uid-alice'));
});

test('periodDocId round-trips its month for readers that key by month', () => {
  const acct = defaultAccountId('uid-alice');
  const docId = periodDocId(acct, '2026-03');
  assert.equal(monthFromPeriodDocId(docId), '2026-03');
});

test('periodDocId rejects a malformed month', () => {
  const acct = defaultAccountId('uid-alice');
  assert.throws(() => periodDocId(acct, '2026-3'));
  assert.throws(() => periodDocId(acct, 'not-a-month'));
});

test('defaultAccountId requires a uid', () => {
  assert.throws(() => defaultAccountId(''));
});

console.log(`\n${passed} passed`);
