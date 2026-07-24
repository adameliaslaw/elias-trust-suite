// Transactional-outbox crash-atomicity on SQLite (#24, re-derived Phase 6 / #25).
//
// Proves the money mutation and its audit append land as ONE unit, now backed by
// a SQLite transaction + a real outbox table:
//   - stage() commits the company doc AND the owed events in ONE transaction; a
//     failure mid-transaction rolls BOTH back (nothing persists);
//   - a crash after commit but before delivery leaves the owed event durable in
//     the outbox table (never a silent gap), and recovery delivers it exactly
//     once and clears the row;
//   - a crash after the append but before the row-delete does NOT double record
//     on the next flush (idempotent on the outbox message id);
//   - the whole store.commit() unit persists mutation + chain event together.
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-outbox-'));
process.env.QUICKBUCKS_NO_SEED = '1';
process.env.QUICKBUCKS_DISABLE_AUTH = '1';

const store = require('../lib/store');
const outbox = require('../lib/outbox');
const audit = require('../lib/audit');
const sqlite = require('../lib/sqlite');

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

const conn = () => sqlite.connect();
function outboxRows(companyId) {
  return conn().prepare('SELECT msg_id, type, payload FROM outbox WHERE company_id=? ORDER BY rowid').all(companyId);
}
function countChain(companyId, type) {
  return audit.entries(companyId, 0).then(es => es.filter(e => e.type === type).length);
}

const PAYLOAD = { invoiceId: 'inv-x', clientId: 'c1', totalCents: '15000', source: 'manual', actor: 'local@test' };

async function main() {
  const co = store.companies()[0].id;

  await test('stage() is atomic: a failure mid-transaction rolls back BOTH doc + owed event', async () => {
    // Pre-seat a row id, then force the staged event to collide with it (PK
    // violation) — the whole transaction, including the doc mutation, must roll
    // back. Nothing persists.
    conn().prepare('INSERT INTO outbox(msg_id, company_id, type, payload) VALUES(?,?,?,?)')
      .run('collide-1', co, 'seed', '{}');
    const db = store.load(co);
    db.invoices.push({ id: 'must-not-persist', customerId: 'c1', date: '2026-01-01', items: [], payments: [], draft: false });
    const origUUID = crypto.randomUUID;
    crypto.randomUUID = () => 'collide-1';  // makes the INSERT collide
    let threw = false;
    try { outbox.stage(conn(), co, store._docText(db), [{ type: 'invoice.created', payload: PAYLOAD }]); }
    catch { threw = true; }
    crypto.randomUUID = origUUID;
    assert.ok(threw, 'stage surfaced the transaction failure');

    store._evict(co);
    const reloaded = store.load(co);
    assert.ok(!reloaded.invoices.find(i => i.id === 'must-not-persist'), 'doc mutation rolled back');
    assert.strictEqual(outboxRows(co).filter(r => r.msg_id !== 'collide-1').length, 0, 'no owed event persisted');
    // Clean up the seed row so later assertions start from empty.
    conn().prepare('DELETE FROM outbox WHERE msg_id=?').run('collide-1');
  });

  await test('crash after commit but before delivery: the owed event survives in the outbox table', async () => {
    // Apply a money mutation and commit it, but make DELIVERY fail (as if the
    // process died right after the atomic commit, before the relay ran).
    const db = store.load(co);
    db.invoices.push({ id: 'inv-x', customerId: 'c1', date: '2026-01-01', items: [], payments: [], draft: false });
    const realAppend = audit.appendIdempotent;
    audit.appendIdempotent = async () => { throw new Error('simulated crash during delivery'); };
    let threw = false;
    try { await store.commit(db, co, 'invoice.created', PAYLOAD); } catch { threw = true; }
    audit.appendIdempotent = realAppend;
    assert.ok(threw, 'delivery failed after the atomic commit');

    // Simulate the restart: drop caches and re-read the durable store.
    store._evict(co); audit._reset();
    const reloaded = store.load(co);
    assert.ok(reloaded.invoices.find(i => i.id === 'inv-x'), 'mutation persisted (committed atomically)');
    assert.strictEqual(outboxRows(co).length, 1, 'owed event durable in the outbox table');
    assert.strictEqual(await countChain(co, 'invoice.created'), 0, 'not yet on the chain');
  });

  await test('recovery delivers the pending event exactly once and clears the outbox', async () => {
    store._evict(co); audit._reset();
    const recovered = await outbox.recoverAll(store.companies);
    assert.strictEqual(recovered, 1, 'recovery delivered one owed event');
    assert.strictEqual(outboxRows(co).length, 0, 'outbox row cleared after delivery');
    assert.strictEqual(await countChain(co, 'invoice.created'), 1, 'event on the chain exactly once');
    assert.strictEqual((await audit.verify(co)).ok, true, 'chain still verifies');

    // Recovery again is a no-op — nothing left owed.
    store._evict(co); audit._reset();
    assert.strictEqual(await outbox.recoverAll(store.companies), 0, 'nothing left to recover');
    assert.strictEqual(await countChain(co, 'invoice.created'), 1, 'still exactly one');
  });

  await test('crash after append but before row-delete: flush is idempotent (no double record)', async () => {
    // Recover the delivered message id from the chain, then re-insert an outbox
    // row with the SAME id (as if the append landed but the row-delete was lost).
    const es = await audit.entries(co, 0);
    const delivered = es.find(e => e.type === 'invoice.created');
    const dupId = delivered.payload.outboxId;
    assert.ok(dupId, 'delivered payload carries the outbox id');

    conn().prepare('INSERT INTO outbox(msg_id, company_id, type, payload) VALUES(?,?,?,?)')
      .run(dupId, co, 'invoice.created', JSON.stringify(PAYLOAD));

    store._evict(co); audit._reset();
    await outbox.flush(conn(), co);
    assert.strictEqual(await countChain(co, 'invoice.created'), 1, 'idempotent: still exactly one on the chain');
    assert.strictEqual(outboxRows(co).length, 0, 'the replayed row is cleared');
  });

  await test('store.commit persists mutation and chain event together', async () => {
    store._evict(co); audit._reset();
    const db = store.load(co);
    db.expenses.push({ id: 'exp-1', amount: 42, category: 'Office Supplies', date: '2026-01-02' });
    const delivered = await store.commit(db, co, 'expense.created', {
      expenseId: 'exp-1', amountCents: '4200', category: 'Office Supplies', actor: 'local@test'
    });
    assert.strictEqual(delivered, 1, 'the committed event was delivered');
    assert.strictEqual(outboxRows(co).length, 0, 'committed events drained from the table');

    store._evict(co); audit._reset();
    const reloaded = store.load(co);
    assert.ok(reloaded.expenses.find(e => e.id === 'exp-1'), 'mutation persisted');
    assert.strictEqual(await countChain(co, 'expense.created'), 1, 'audit event delivered');
    assert.strictEqual((await audit.verify(co)).ok, true, 'chain verifies');
  });

  console.log(`\n  outbox.test.js: ${passed} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
