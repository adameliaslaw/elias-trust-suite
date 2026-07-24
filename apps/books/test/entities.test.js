// Proves books CONSUMES @elias/entities (not shelf-ware): the lib/entities.js
// adapter lifts books' local company/customer/principal ids into canonical,
// suite-wide ids, and GET /api/companies now surfaces the firm's canonical id.
const assert = require('assert');
const E = require('@elias/entities');
const adapter = require('../lib/entities');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

check('company → canonical firm id', () => {
  const co = { id: 'lz4k9m0abc', name: 'Elias Counsel' };
  const id = adapter.firmIdFor(co);
  assert.strictEqual(id, 'firm_lz4k9m0abc');
  assert.strictEqual(E.entityKindOf(id), 'firm');
  assert.strictEqual(E.localIdOf(id), co.id);
});

check('customer → canonical client id', () => {
  const cust = { id: 'k9x2ab', name: 'Acme Corp' };
  const id = adapter.clientIdFor(cust);
  assert.strictEqual(id, 'clnt_k9x2ab');
  assert.strictEqual(E.entityKindOf(id), 'client');
});

check('named principal → canonical user id by principal id', () => {
  const id = adapter.userIdFor({ id: 'p1', username: 'jane', role: 'bookkeeper' });
  assert.strictEqual(id, 'usr_p1');
  assert.strictEqual(E.entityKindOf(id), 'user');
});

check('default owner (no principal record) → stable usr_owner', () => {
  assert.strictEqual(adapter.userIdFor(null), 'usr_owner');
  assert.strictEqual(adapter.userIdFor(undefined), 'usr_owner');
  assert.strictEqual(adapter.userIdFor({ username: null }), 'usr_owner');
});

check('canonical ids round-trip through the shared parser', () => {
  const co = { id: 'abc123', name: 'X' };
  const id = adapter.firmIdFor(co);
  assert.ok(E.isEntityId(id, 'firm'));
  assert.ok(!E.isEntityId(id, 'client'));
  const parsed = E.parseEntityId(id);
  assert.deepStrictEqual(parsed, { kind: 'firm', localId: 'abc123' });
});

check('adapter re-exports the shared package', () => {
  assert.strictEqual(adapter.entities, E);
});

console.log(`All ${passed} @elias/entities adapter checks passed`);
