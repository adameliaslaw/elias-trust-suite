'use strict';
// Tamper-evident audit for billable, built on @elias/audit primitives.
//
// TWO artifacts, both hash-chained with the @elias/audit chain format:
//
//  1. ledger.jsonl (the raw event ledger) — chained IN PLACE: every new
//     event is stamped with seq/prevHash/hash before it hits the file.
//     Events written before chaining existed ("legacy") cannot be retro-
//     chained, so they are bound by a ledger.legacy_anchored entry
//     (eventCount + sha256 of the legacy bytes) in audit.jsonl — altering
//     any legacy line breaks that anchor.
//
//  2. audit.jsonl — semantic mutation events as full AuditEntry lines:
//     entry.override_written (attorney edits: the highest tamper incentive),
//     lawpay.request_created / lawpay.payment_recorded, config.changed
//     (keys only — config holds API keys and OAuth tokens), clio.entry_synced,
//     ledger.legacy_anchored.
//
// Multi-process safety: Claude Code hooks fire `billable log` from
// concurrent processes. A lockfile serializes the read-tail → compute →
// append critical section, so two processes can never seal the same seq
// (which would fork the chain permanently).
//
// Everything here is SYNCHRONOUS: one-shot CLI invocations must never exit
// with an audit append still in flight.
const fs = require('fs');
const { computeEntryHash, stableStringify, sha256Hex, GENESIS_HASH } = require('@elias/audit');

const CHAIN_FIELDS = new Set(['seq', 'prevHash', 'hash']);
// Ledger events carry their metadata as ts/type; the chain body maps those
// to timestamp/type and treats every other field as the payload.
const LEDGER_META_FIELDS = new Set(['seq', 'prevHash', 'hash', 'ts', 'type']);

const LOCK_STALE_MS = 30_000;   // a holder this old is dead (crash/kill)
const LOCK_TIMEOUT_MS = 10_000; // give up waiting for a live holder

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- lockfile: mkdir-style atomic create, stale reclaim, bounded wait ---
function acquireLock(targetFile) {
  const lock = `${targetFile}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);   // stale holder: crashed mid-append
          continue;
        }
      } catch { /* lock vanished between stat and unlink — retry */ }
      if (Date.now() > deadline) throw new Error(`audit: timed out waiting for ${lock}`);
      sleepSync(5);
    }
  }
}

function releaseLock(targetFile, fd) {
  try { fs.closeSync(fd); } catch { /* already closed */ }
  try { fs.unlinkSync(`${targetFile}.lock`); } catch { /* reclaimed already */ }
}

function readLastLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null; // file does not exist yet
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, chunk, 0, chunk.length, Math.max(0, size - chunk.length));
    const text = chunk.toString('utf8').replace(/\n+$/, '');
    const idx = text.lastIndexOf('\n');
    return idx === -1 ? text : text.slice(idx + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Chain state of a file's current tail, read INSIDE the lock.
function tailState(file) {
  const last = parseLine(readLastLine(file));
  if (last && typeof last.hash === 'string' && Number.isInteger(last.seq)) {
    return { seq: last.seq + 1, prevHash: last.hash, hasLegacy: false, firstChained: false };
  }
  // No chained tail: either an empty file or a legacy-only ledger.
  let exists = false;
  try { exists = fs.statSync(file).size > 0; } catch { /* missing */ }
  return { seq: 0, prevHash: GENESIS_HASH, hasLegacy: exists, firstChained: exists };
}

/**
 * Stamp a raw ledger event with chain fields and append it, atomically
 * under the lockfile. The event keeps its flat shape ({ts, type, ...}) so
 * every existing reader works unchanged; seq/prevHash/hash are additive.
 * The hash seals body {seq, timestamp: ts, type, payload: other fields} —
 * the @elias/audit chain format — so the suite's verifier logic applies.
 */
function appendStampedEvent(ledgerFile, event) {
  const fd = acquireLock(ledgerFile);
  try {
    const tail = tailState(ledgerFile);
    const body = {
      seq: tail.seq,
      timestamp: event.ts,
      type: event.type,
      payload: Object.fromEntries(Object.entries(event).filter(([k]) => !LEDGER_META_FIELDS.has(k))),
    };
    const stamped = {
      ...event,
      seq: tail.seq,
      prevHash: tail.prevHash,
      hash: computeEntryHash(tail.prevHash, body),
    };
    fs.appendFileSync(ledgerFile, JSON.stringify(stamped) + '\n', { mode: 0o600 });
    return { stamped, firstChainedWithLegacy: tail.firstChained };
  } finally {
    releaseLock(ledgerFile, fd);
  }
}

/** Append a full AuditEntry line to a semantic chain file (audit.jsonl). */
function appendChainedEntry(file, type, payload, timestamp) {
  const fd = acquireLock(file);
  try {
    const tail = tailState(file);
    const ts = timestamp || new Date().toISOString();
    const body = { seq: tail.seq, timestamp: ts, type, payload };
    const entry = { ...body, prevHash: tail.prevHash, hash: computeEntryHash(tail.prevHash, body) };
    fs.appendFileSync(file, stableStringify(entry) + '\n', { mode: 0o600 });
    return entry;
  } finally {
    releaseLock(file, fd);
  }
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(l => l.trim()).map(l => ({ raw: l, parsed: parseLine(l) }));
}

/**
 * Bind pre-chain legacy ledger events: write ledger.legacy_anchored into
 * audit.jsonl with the count and sha256 of the legacy prefix bytes. Written
 * at most once; verifyLedger() requires it whenever a legacy prefix exists.
 */
function ensureLegacyAnchor(ledgerFile, auditFile) {
  const lines = readJsonl(ledgerFile);
  const legacy = [];
  for (const l of lines) {
    if (l.parsed && typeof l.parsed.hash === 'string') break; // chained region starts
    legacy.push(l.raw);
  }
  if (!legacy.length) return false;
  const anchored = readJsonl(auditFile).some(l => l.parsed && l.parsed.type === 'ledger.legacy_anchored');
  if (anchored) return false;
  appendChainedEntry(auditFile, 'ledger.legacy_anchored', {
    eventCount: legacy.length,
    sha256: sha256Hex(legacy.join('\n') + '\n'),
    actor: 'local',
  });
  return true;
}

/** Semantic append: anchor legacy first if needed, then chain the event. */
function appendSemantic(auditFile, ledgerFile, type, payload) {
  ensureLegacyAnchor(ledgerFile, auditFile);
  return appendChainedEntry(auditFile, type, payload);
}

/**
 * Verify both chains. Returns { ok, entries, chainedEvents, legacyEvents,
 * error?, atSeq? }. Recomputes every hash; names the first bad seq.
 */
function verifyLedger(ledgerFile, auditFile) {
  // 1. The semantic chain must verify standalone.
  const auditLines = readJsonl(auditFile);
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < auditLines.length; i += 1) {
    const e = auditLines[i].parsed;
    if (!e || !Number.isInteger(e.seq) || e.seq !== i) {
      return { ok: false, entries: auditLines.length, error: `audit.jsonl line ${i}: bad or missing seq`, atSeq: i };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, entries: auditLines.length, error: `audit.jsonl line ${i}: prevHash linkage broken`, atSeq: i };
    }
    const expected = computeEntryHash(e.prevHash, { seq: e.seq, timestamp: e.timestamp, type: e.type, payload: e.payload });
    if (e.hash !== expected) {
      return { ok: false, entries: auditLines.length, error: `audit.jsonl line ${i}: hash mismatch — entry altered after sealing`, atSeq: i };
    }
    prevHash = e.hash;
  }

  // 2. Ledger: legacy prefix must match its anchor; chained suffix must verify.
  const lines = readJsonl(ledgerFile);
  let split = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].parsed && typeof lines[i].parsed.hash === 'string') { split = i; break; }
  }
  const legacy = lines.slice(0, split);
  const chained = lines.slice(split);
  for (const l of chained) {
    if (!l.parsed || typeof l.parsed.hash !== 'string') {
      return { ok: false, entries: lines.length, error: 'ledger.jsonl: unchained event found after chained events', atSeq: null };
    }
  }
  if (legacy.length) {
    const anchor = auditLines.map(l => l.parsed).find(e => e && e.type === 'ledger.legacy_anchored');
    const digest = sha256Hex(legacy.map(l => l.raw).join('\n') + '\n');
    if (!anchor) {
      return { ok: false, entries: lines.length, error: `ledger.jsonl: ${legacy.length} legacy events have no anchor in audit.jsonl`, atSeq: null };
    }
    if (anchor.payload.eventCount !== legacy.length || anchor.payload.sha256 !== digest) {
      return { ok: false, entries: lines.length, error: 'ledger.jsonl: legacy events do not match their anchor (altered, reordered, or removed)', atSeq: null };
    }
  }
  prevHash = GENESIS_HASH;
  for (let i = 0; i < chained.length; i += 1) {
    const e = chained[i].parsed;
    if (e.seq !== i) {
      return { ok: false, entries: lines.length, error: `ledger.jsonl chained event: seq ${e.seq}, expected ${i} (gap or reorder)`, atSeq: e.seq };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, entries: lines.length, error: `ledger.jsonl chained event ${i}: prevHash linkage broken`, atSeq: i };
    }
    const payload = Object.fromEntries(Object.entries(e).filter(([k]) => !LEDGER_META_FIELDS.has(k)));
    const expected = computeEntryHash(e.prevHash, { seq: e.seq, timestamp: e.ts, type: e.type, payload });
    if (e.hash !== expected) {
      return { ok: false, entries: lines.length, error: `ledger.jsonl chained event ${i}: hash mismatch — event altered after sealing`, atSeq: i };
    }
    prevHash = e.hash;
  }
  return {
    ok: true,
    entries: auditLines.length,
    chainedEvents: chained.length,
    legacyEvents: legacy.length,
  };
}

module.exports = {
  appendStampedEvent,
  appendChainedEntry,
  appendSemantic,
  ensureLegacyAnchor,
  verifyLedger,
  CHAIN_FIELDS,
};
