'use strict';
// Transactional outbox — makes a money mutation atomic with its audit append.
//
// The problem (#24): a write handler does two separate disk writes —
//   1. save(db)                 -> company-<id>.json  (the money mutation)
//   2. audit.append(type, ...)  -> audit/company-<id>.jsonl  (the record of it)
// A crash BETWEEN them leaves the two out of step: a persisted mutation with no
// audit event (a silent gap — worse than tampering, because verify() still
// passes), or an audit event for a mutation that never persisted.
//
// The fix rides the owed audit event INSIDE the company JSON so it commits in
// the SAME atomic write as the mutation. save() is atomic (tmp file + rename),
// so after a save either BOTH the mutation and the owed event are on disk, or
// NEITHER is — never one without the other. A relay then delivers the owed
// event to the tamper-evident chain and clears it:
//
//   enqueue(db, event)  — stage the owed audit event in db.outbox (memory)
//   save(db)            — ATOMIC: mutation + owed event commit together
//   flush(db, id, save) — deliver each owed event to the chain, then clear+save
//
// Recovery (recoverAll, on boot) reruns flush for any db whose outbox survived a
// crash, so an interrupted delivery always completes. Delivery is idempotent on
// the message id (audit.appendIdempotent), so a crash between "appended" and
// "cleared" never double-records on the next flush.
const crypto = require('crypto');
const audit = require('./audit');

// Stage one owed audit event in the db. The message id is the idempotency key
// the chain dedups on, so a replay after a partial crash cannot double-append.
function enqueue(db, type, payload) {
  if (!Array.isArray(db.outbox)) db.outbox = [];
  const id = crypto.randomUUID();
  db.outbox.push({ id, type, payload });
  return id;
}

// Deliver every pending owed event to the tamper-evident chain, then clear the
// outbox and persist that (so a message is delivered exactly once across
// crashes). Idempotent: appendIdempotent skips a message already on the chain,
// so a crash after the append but before the clear-save replays harmlessly.
async function flush(db, companyId, save) {
  if (!Array.isArray(db.outbox) || db.outbox.length === 0) return 0;
  // Snapshot the ids being delivered; new enqueues during an await must not be
  // dropped by the clear below.
  const delivering = db.outbox.slice();
  for (const msg of delivering) {
    await audit.appendIdempotent(companyId, msg.type, msg.payload, msg.id);
  }
  const deliveredIds = new Set(delivering.map((m) => m.id));
  db.outbox = db.outbox.filter((m) => !deliveredIds.has(m.id));
  save(db);
  return delivering.length;
}

// The whole transactional unit: stage the owed event(s), persist them together
// with the caller's already-applied mutation, then deliver. `events` is a
// single {type, payload} or an array of them.
async function commit(db, companyId, save, events) {
  const list = Array.isArray(events) ? events : [events];
  for (const e of list) enqueue(db, e.type, e.payload);
  save(db);                 // atomic: the mutation + the owed audit events
  return flush(db, companyId, save);
}

// Boot-time recovery: redeliver any owed events a crash left in an outbox. A
// per-company failure (e.g. a tampered chain that blocks the append) is logged,
// never fatal — one company's problem must not stop the others or crash boot.
async function recoverAll(companiesFn, loadFn, saveFn) {
  let recovered = 0;
  for (const c of companiesFn()) {
    try {
      const db = loadFn(c.id);
      if (Array.isArray(db.outbox) && db.outbox.length) {
        recovered += await flush(db, c.id, saveFn);
      }
    } catch (e) {
      console.error(`outbox recovery failed for company ${c.id}:`, e.message);
    }
  }
  return recovered;
}

module.exports = { enqueue, flush, commit, recoverAll };
