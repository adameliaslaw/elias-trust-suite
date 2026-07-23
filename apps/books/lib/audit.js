'use strict';
// Hash-chained, tamper-evident audit trail for books, via @elias/audit.
//
// One append-only JSONL chain per company at data/audit/company-<id>.jsonl —
// deliberately OUTSIDE the mutable company-<id>.json it audits, so the record
// of what happened is not inside the thing that could be altered.
// Verify-on-open: the first append after process start re-verifies the whole
// chain; tampering throws AuditIntegrityError and fails the request LOUDLY
// rather than silently writing to a broken log.
//
// Two layers:
//  A) http.write — every non-GET API call, path-level only (no bodies:
//     passwords and bank keys must never reach the log). Appended from the
//     dispatch hook AFTER the response; a chain failure there is logged to
//     stderr (the mutation already committed — failing the request would not
//     roll it back).
//  B) semantic events (invoice.created, payroll.payment, ...) — awaited
//     inside route handlers BEFORE the response, carrying exact-money
//     integer-cents strings via the @elias/money bridge. Never floats.
const path = require('path');
const { AuditLog, FsJsonlStorage } = require('@elias/audit');
const { DATA_DIR } = require('./global');
const money = require('./money');

const logs = new Map(); // companyId -> Promise<AuditLog>

function chainFile(companyId) {
  return path.join(DATA_DIR, 'audit', `company-${companyId}.jsonl`);
}

function openLog(companyId) {
  let p = logs.get(companyId);
  if (!p) {
    // Verify-on-open (default): a tampered chain rejects here and keeps
    // rejecting — the failure stays loud instead of being swallowed once.
    p = AuditLog.open(new FsJsonlStorage(chainFile(companyId)));
    logs.set(companyId, p);
  }
  return p;
}

async function append(companyId, type, payload) {
  const log = await openLog(companyId);
  await log.append(type, payload);
}

async function verify(companyId) {
  // Deliberately NOT the cached writer: verification must REPORT a broken
  // chain ({ok:false, atSeq}), not throw on open. Appends keep fail-loud
  // verify-on-open — those are the two correct behaviors for the two paths.
  const log = await AuditLog.open(new FsJsonlStorage(chainFile(companyId)), { verifyOnOpen: false });
  return log.verify();
}

// The tamper-evident chain entries themselves, newest-first, capped at `limit`.
// This is the record the audit UI must display — the hash-chained file OUTSIDE
// the mutable company-<id>.json — not db.auditLog (a plain, forgeable array
// living inside the very file it purports to audit). verifyOnOpen:false so a
// tampered chain still renders (the caller pairs this with verify() to show the
// integrity status); the entries carry seq/hash so the break is visible.
async function entries(companyId, limit = 100) {
  const log = await AuditLog.open(new FsJsonlStorage(chainFile(companyId)), { verifyOnOpen: false });
  const all = log.entries();
  const capped = limit > 0 ? all.slice(-limit) : all;
  return [...capped].reverse();
}

// Exact integer cents as a decimal string — the audit money contract.
// Never a float: all conversion goes through the @elias/money bridge.
function centsStr(dollarAmount) {
  const n = Number(dollarAmount) || 0;
  // Sub-half-cent magnitudes are float noise, not money (and can surface in
  // scientific notation, which the strict decimal parser rightly rejects).
  if (Math.abs(n) < 0.005) return '0';
  return money.dollars(n).toCents().toString();
}

// books is a single-user app behind one password; the meaningful actor
// distinction is WHERE the write came from.
function actor(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
  return `local@${ip}`;
}

// Test hook: drop cached logs (a fresh tmp DATA_DIR per test file).
function _reset() {
  logs.clear();
}

module.exports = { append, verify, entries, centsStr, actor, chainFile, _reset };
