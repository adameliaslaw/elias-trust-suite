// Transactional-outbox crash-atomicity (#24).
//
// Proves the money mutation and its audit append land as ONE unit:
//   - a crash after save() but before delivery leaves the owed event durable in
//     the outbox (never a silent gap), and recovery delivers it exactly once;
//   - a crash after the append but before the outbox-clear does NOT double
//     record on the next flush (idempotent on the outbox message id);
//   - the whole store.commit() unit persists mutation + chain event together.
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-outbox-'));
process.env.QUICKBUCKS_NO_SEED = '1';
process.env.QUICKBUCKS_DISABLE_AUTH = '1';

const store = require('../lib/store');
const outbox = require('../lib/outbox');
const audit = require('../lib/audit');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name);
    console.error(e);
    process.exit(1);
  }
}

function countChain(companyId, type) {
  return audit.entries(companyId, 0).then(es => es.filter(e => e.type === type).length);
}

async function main() {
  const co = store.companies()[0].id;

  await test('crash after save() but before delivery: the owed event survives in the outbox', async () => {
    const db = store.load(co);
    // Apply a money mutation AND stage its owed audit event, then persist both
    // atomically — but "crash" before the relay delivers to the chain.
    db.invoices.push({ id: 'inv-x', customerId: 'c1', date: '2026-01-01', items: [], payments: [], draft: false });
    outbox.enqueue(db, 'invoice.created', {
      invoiceId: 'inv-x', clientId: 'c1', totalCents: '15000', source: 'manual', actor: 'local@test'
    });
    store.save(db);

    // Simulate the crash + restart: drop the in-memory cache and re-read disk.
    store._evict(co);
    audit._reset();
    const reloaded = store.load(co);

    // The mutation persisted, and the owed audit event is still pending — NOT a
    // silent gap. The chain does not yet carry the event.
    assert.ok(reloaded.invoices.find(i => i.id === 'inv-x'), 'mutation persisted');
    assert.strictEqual(reloaded.outbox.length, 1, 'owed event durable in the outbox');
    assert.strictEqual(await countChain(co, 'invoice.created'), 0, 'not yet on the chain');
  });

  await test('recovery delivers the pending event exactly once and clears the outbox', async () => {
    store._evict(co);
    audit._reset();
    const recovered = await outbox.recoverAll(store.companies, store.load, store.save);
    assert.strictEqual(recovered, 1, 'recovery delivered one owed event');

    store._evict(co);
    audit._reset();
    const db = store.load(co);
    assert.strictEqual(db.outbox.length, 0, 'outbox cleared after delivery');
    assert.strictEqual(await countChain(co, 'invoice.created'), 1, 'event on the chain exactly once');
    assert.strictEqual((await audit.verify(co)).ok, true, 'chain still verifies');

    // Recovery again is a no-op — nothing left owed.
    store._evict(co); audit._reset();
    assert.strictEqual(await outbox.recoverAll(store.companies, store.load, store.save), 0);
    assert.strictEqual(await countChain(co, 'invoice.created'), 1, 'still exactly one');
  });

  await test('crash after append but before outbox-clear: flush is idempotent (no double record)', async () => {
    // Recover the delivered message id from the chain, then re-stage a message
    // with the SAME id (as if the append landed but the clear-save was lost).
    const es = await audit.entries(co, 0);
    const delivered = es.find(e => e.type === 'invoice.created');
    const dupId = delivered.payload.outboxId;
    assert.ok(dupId, 'delivered payload carries the outbox id');

    const db = store.load(co);
    db.outbox.push({ id: dupId, type: 'invoice.created', payload: {
      invoiceId: 'inv-x', clientId: 'c1', totalCents: '15000', source: 'manual', actor: 'local@test'
    } });
    store.save(db);

    store._evict(co); audit._reset();
    const reloaded = store.load(co);
    await outbox.flush(reloaded, co, store.save);
    assert.strictEqual(await countChain(co, 'invoice.created'), 1, 'idempotent: still exactly one on the chain');
    assert.strictEqual(reloaded.outbox.length, 0, 'the replayed message is cleared');
  });

  await test('store.commit persists mutation and chain event together', async () => {
    store._evict(co); audit._reset();
    const db = store.load(co);
    db.expenses.push({ id: 'exp-1', amount: 42, category: 'Office Supplies', date: '2026-01-02' });
    await store.commit(db, co, 'expense.created', {
      expenseId: 'exp-1', amountCents: '4200', category: 'Office Supplies', actor: 'local@test'
    });
    assert.strictEqual(db.outbox.length, 0, 'committed events drained');

    store._evict(co); audit._reset();
    const reloaded = store.load(co);
    assert.ok(reloaded.expenses.find(e => e.id === 'exp-1'), 'mutation persisted');
    assert.strictEqual(await countChain(co, 'expense.created'), 1, 'audit event delivered');
    assert.strictEqual((await audit.verify(co)).ok, true, 'chain verifies');
  });

  console.log(`\n  outbox.test.js: ${passed} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
