'use strict';
// Transactional outbox on SQLite — makes a money mutation atomic with its audit
// append (#24, re-derived for SQLite in Phase 6 / #25).
//
// The problem is unchanged from the JSON era: a write handler makes two durable
// writes — the money mutation (company doc) and the record of it (the
// tamper-evident audit chain). A crash BETWEEN them leaves the two out of step:
// a persisted mutation with no audit event (a silent gap — worse than tampering,
// because verify() still passes), or an audit event for a mutation that never
// persisted.
//
// The JSON store solved this by riding the owed event INSIDE the company file so
// a single tmp-file+rename committed both. SQLite gives us the real thing: the
// company doc UPDATE and the owed-event INSERTs run in ONE transaction, so after
// COMMIT either BOTH are on disk or NEITHER is. The outbox is its own TABLE
// (lib/sqlite.js), which is where transactional exactly-once actually lives.
//
//   stage(conn, id, docText, events) — ONE atomic txn: doc + owed events commit
//                                      together (or roll back together).
//   flush(conn, id)                  — deliver each owed event to the chain
//                                      (idempotent on msg_id), deleting each row
//                                      as it lands → delivered exactly once.
//   commit(conn, id, docText, events)— stage then flush (the normal write path).
//   recoverAll(companiesFn)          — on boot, flush any rows a crash stranded.
//
// Exactly-once across crashes: appendIdempotent skips a msg_id already on the
// chain, so a crash AFTER the append but BEFORE the row-delete redelivers
// harmlessly on the next flush (append is a no-op, the delete then completes).
const crypto = require('crypto');
const audit = require('./audit');
const sqlite = require('./sqlite');

// Pending owed events for a company, oldest first (rowid is insert order).
function pending(conn, companyId) {
  return conn
    .prepare('SELECT msg_id, type, payload FROM outbox WHERE company_id = ? ORDER BY rowid')
    .all(companyId);
}

// ONE atomic transaction: persist the caller's already-applied doc mutation AND
// the owed audit event(s) together. On any failure the whole unit rolls back —
// neither the mutation nor the events persist. Returns the staged message ids.
function stage(conn, companyId, docText, events) {
  const list = Array.isArray(events) ? events : [events];
  const msgs = list.map((e) => ({ id: crypto.randomUUID(), type: e.type, payload: e.payload }));
  const putDoc = conn.prepare('INSERT OR REPLACE INTO company(id, doc) VALUES(?, ?)');
  const putMsg = conn.prepare('INSERT INTO outbox(msg_id, company_id, type, payload) VALUES(?, ?, ?, ?)');
  conn.exec('BEGIN IMMEDIATE');
  try {
    putDoc.run(companyId, docText);
    for (const m of msgs) putMsg.run(m.id, companyId, m.type, JSON.stringify(m.payload ?? null));
    conn.exec('COMMIT');
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw e;
  }
  return msgs.map((m) => m.id);
}

// Deliver every pending owed event to the tamper-evident chain, deleting each
// row once it lands. Idempotent: appendIdempotent skips a message already on the
// chain, so a replay after a partial crash cannot double-record.
async function flush(conn, companyId) {
  const rows = pending(conn, companyId);
  const del = conn.prepare('DELETE FROM outbox WHERE msg_id = ?');
  let delivered = 0;
  for (const r of rows) {
    await audit.appendIdempotent(companyId, r.type, JSON.parse(r.payload), r.msg_id);
    del.run(r.msg_id);
    delivered++;
  }
  return delivered;
}

// The whole transactional unit for a write handler: stage (atomic) then deliver.
function commit(conn, companyId, docText, events) {
  stage(conn, companyId, docText, events);
  return flush(conn, companyId);
}

// Boot-time recovery: redeliver any owed events a crash left in the outbox
// table. A per-company failure (e.g. a tampered chain that blocks the append) is
// logged, never fatal — one company's problem must not stop the others.
async function recoverAll(companiesFn) {
  const conn = sqlite.connect();
  let recovered = 0;
  for (const c of companiesFn()) {
    try {
      recovered += await flush(conn, c.id);
    } catch (e) {
      console.error(`outbox recovery failed for company ${c.id}:`, e.message);
    }
  }
  return recovered;
}

module.exports = { pending, stage, flush, commit, recoverAll };
