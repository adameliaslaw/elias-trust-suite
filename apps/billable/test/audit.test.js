'use strict';
// Tamper-evident audit regression tests (@elias/audit wiring), registered
// into test/run.js's runner. Pins: in-place ledger chain structure, tamper
// detection (alter/delete/reorder), legacy anchoring, semantic events with
// exact-cents strings, and multi-process append safety (the lockfile).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = (test) => {
  const store = require('../src/store');
  const audit = require('../src/audit');

  function freshHome() {
    process.env.BILLABLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'billable-audit-'));
    return process.env.BILLABLE_HOME;
  }
  const readLines = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);

  test('audit: raw ledger events are hash-chained in place', () => {
    freshHome();
    store.appendEvent({ ts: '2026-01-01T10:00:00.000Z', type: 'prompt', detail: 'draft brief', session: 's1' });
    store.appendEvent({ ts: '2026-01-01T10:01:00.000Z', type: 'tool', tool: 'Edit', session: 's1' });
    store.appendEvent({ ts: '2026-01-01T10:02:00.000Z', type: 'stop', session: 's1' });
    const lines = readLines(store.ledgerPath());
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0].seq, 0);
    assert.strictEqual(lines[0].prevHash, 'GENESIS');
    assert.strictEqual(lines[1].prevHash, lines[0].hash);
    assert.strictEqual(lines[2].prevHash, lines[1].hash);
    assert.match(lines[0].hash, /^[0-9a-f]{64}$/);
    // Original event fields survive untouched (readers see the same shape).
    assert.strictEqual(lines[0].detail, 'draft brief');
    const v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.chainedEvents, 3);
    assert.strictEqual(v.legacyEvents, 0);
  });

  test('audit: altered historical event is detected, first bad seq named', () => {
    const lines = readLines(store.ledgerPath());
    lines[1].tool = 'FORGED';
    fs.writeFileSync(store.ledgerPath(), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.atSeq, 1);
    assert.match(v.error, /hash mismatch/);
  });

  test('audit: deleted and reordered chained events break verification', () => {
    freshHome();
    for (let i = 0; i < 4; i++) store.appendEvent({ ts: `2026-01-01T10:0${i}:00.000Z`, type: 'tool', tool: `T${i}`, session: 's' });
    const lines = readLines(store.ledgerPath());
    // delete middle
    const del = lines.slice(); del.splice(1, 1);
    fs.writeFileSync(store.ledgerPath(), del.map(l => JSON.stringify(l)).join('\n') + '\n');
    let v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, false);
    // reorder (restore first)
    fs.writeFileSync(store.ledgerPath(), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const re = lines.slice(); [re[1], re[2]] = [re[2], re[1]];
    fs.writeFileSync(store.ledgerPath(), re.map(l => JSON.stringify(l)).join('\n') + '\n');
    v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, false);
  });

  test('audit: pre-chain legacy events are anchored; tampering breaks the anchor', () => {
    freshHome();
    store.ensureHomeForTest ? store.ensureHomeForTest() : fs.mkdirSync(store.homeDir(), { recursive: true });
    // Two legacy lines written the pre-chain way (no chain fields).
    const legacy = [
      { ts: '2025-12-01T09:00:00.000Z', type: 'prompt', detail: 'old event 1', session: 'old' },
      { ts: '2025-12-01T09:05:00.000Z', type: 'stop', session: 'old' },
    ];
    fs.writeFileSync(store.ledgerPath(), legacy.map(l => JSON.stringify(l)).join('\n') + '\n');
    // First chained append must bind them.
    store.appendEvent({ ts: '2026-01-01T10:00:00.000Z', type: 'prompt', detail: 'new era', session: 's' });
    let v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.legacyEvents, 2);
    assert.strictEqual(v.chainedEvents, 1);
    const anchor = readLines(store.auditPath()).find(e => e.type === 'ledger.legacy_anchored');
    assert.ok(anchor, 'anchor entry exists');
    assert.strictEqual(anchor.payload.eventCount, 2);
    assert.match(anchor.payload.sha256, /^[0-9a-f]{64}$/);
    // Alter a legacy line: the chain itself still links, but the anchor dies.
    const lines = readLines(store.ledgerPath());
    lines[0].detail = 'quietly rewritten history';
    fs.writeFileSync(store.ledgerPath(), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /anchor/);
  });

  test('audit: override writes chain with before/after hours; integration stamps get own types', () => {
    freshHome();
    store.appendEvent({ ts: '2026-01-01T10:00:00.000Z', type: 'stop', session: 's' });
    store.writeOverride('entry-1', { hours: 2, reviewed: true });
    store.writeOverride('entry-1', { hours: 3 });
    store.writeOverride('entry-2', { lawpayRef: 'MP-123' });      // covered by lawpay events, not overrides
    store.writeOverride('entry-1', { clioId: 'clio-9' });
    const entries = readLines(store.auditPath()).filter(e => e.type !== 'ledger.legacy_anchored');
    const o1 = entries.filter(e => e.type === 'entry.override_written');
    assert.strictEqual(o1.length, 2);
    assert.strictEqual(o1[0].payload.hoursAfter, '2');
    assert.deepStrictEqual(o1[0].payload.fields, ['hours', 'reviewed']);
    assert.strictEqual(o1[1].payload.hoursBefore, '2');
    assert.strictEqual(o1[1].payload.hoursAfter, '3');
    const clio = entries.find(e => e.type === 'clio.entry_synced');
    assert.ok(clio && clio.payload.clioId === 'clio-9');
    const v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, true);
  });

  test('audit: config changes chain keys only, never values', () => {
    freshHome();
    store.appendEvent({ ts: '2026-01-01T10:00:00.000Z', type: 'stop', session: 's' });
    const config = { ...store.readConfig(), rate: 300, sendgridApiKey: 'SG.topsecret' };
    store.writeConfig(config);
    const entries = readLines(store.auditPath());
    const cc = entries.find(e => e.type === 'config.changed');
    assert.ok(cc, 'config.changed present');
    assert.ok(cc.payload.keys.includes('rate') && cc.payload.keys.includes('sendgridApiKey'));
    // The whole point: the chain records WHICH keys changed, never their values.
    // Assert structurally by scanning every leaf value in the semantic payloads
    // for the config values themselves. We check leaf *equality*, not a substring
    // of the serialized entries: chain hashes are 64-char hex and would randomly
    // contain a short numeric like "300" (~1-in-8 runs), making a substring test
    // flaky. Key names ('rate') legitimately appear in payload.keys and are fine.
    const leafValues = (v, out = []) => {
      if (Array.isArray(v)) v.forEach(x => leafValues(x, out));
      else if (v && typeof v === 'object') Object.values(v).forEach(x => leafValues(x, out));
      else out.push(v);
      return out;
    };
    const payloadLeaves = entries.flatMap(e => leafValues(e.payload));
    assert.ok(!payloadLeaves.includes('SG.topsecret'), 'secret value never logged');
    assert.ok(!payloadLeaves.includes(300) && !payloadLeaves.includes('300'), 'rate value not logged');
  });

  test('audit: lawpay request/payment chain with exact cents strings', () => {
    freshHome();
    store.appendEvent({ ts: '2026-01-01T10:00:00.000Z', type: 'stop', session: 's' });
    const lawpay = require('../src/lawpay');
    lawpay.markRequested({
      reference: 'MP-2026-0001', amountCents: 2003, included: [],
      description: 'January fees', email: 'client@example.com',
    });
    lawpay.markPaid('MP-2026-0001', store.readEvents());
    const entries = readLines(store.auditPath());
    const req = entries.find(e => e.type === 'lawpay.request_created');
    const paid = entries.find(e => e.type === 'lawpay.payment_recorded');
    assert.strictEqual(req.payload.amountCents, '2003');   // the 1.5h x $13.35 class: exact cents, as string
    assert.strictEqual(paid.payload.amountCents, '2003');
    const v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, true);
  });

  test('audit: concurrent processes cannot fork the chain (lockfile)', () => {
    freshHome();
    const child = path.resolve(__dirname, 'append-child.js');
    // 6 processes x 10 events hammering the same ledger at once.
    execFileSync('sh', ['-c', `for i in 1 2 3 4 5 6; do node "${child}" 10 & done; wait`], {
      env: { ...process.env },
      stdio: 'pipe',
    });
    const lines = readLines(store.ledgerPath());
    assert.strictEqual(lines.length, 60);
    const seqs = lines.map(l => l.seq).sort((a, b) => a - b);
    assert.deepStrictEqual(seqs, [...Array(60).keys()]);
    const v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.chainedEvents, 60);
  });

  test('audit: a ledger line larger than the tail window does not self-corrupt the chain (H2)', () => {
    freshHome();
    // A first, ordinary event...
    store.appendEvent({ ts: '2026-01-01T10:00:00.000Z', type: 'stop', session: 's' });
    // ...then an event whose serialized line exceeds the 8 KB tail window
    // (a real case: a lawpay bundle carrying hundreds of entryIds).
    const bigIds = Array.from({ length: 2000 }, (_, i) => `entry-${i}`);
    store.appendEvent({ ts: '2026-01-01T10:01:00.000Z', type: 'payment_request', entryIds: bigIds, session: 's' });
    const line2 = fs.readFileSync(store.ledgerPath(), 'utf8').trim().split('\n')[1];
    assert.ok(line2.length > 8192, 'precondition: the second line must exceed the tail window');

    // The NEXT append reads the tail to chain onto it. Before the fix the
    // oversized last line was read truncated → parseLine null → seq reset to
    // 0 with GENESIS prevHash, forking the chain.
    store.appendEvent({ ts: '2026-01-01T10:02:00.000Z', type: 'stop', session: 's' });
    const lines = readLines(store.ledgerPath());
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[2].seq, 2, 'seq must continue past the oversized line, not reset to 0');
    assert.strictEqual(lines[2].prevHash, lines[1].hash);
    const v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.strictEqual(v.ok, true, `chain must verify, got: ${v.error}`);
    assert.strictEqual(v.chainedEvents, 3);
    assert.strictEqual(v.legacyEvents, 0);
  });

  test('audit: bin audit-verify exits non-zero on tampering', () => {
    freshHome();
    store.appendEvent({ ts: '2026-01-01T10:00:00.000Z', type: 'stop', session: 's' });
    const bin = path.resolve(__dirname, '..', 'bin', 'billable.js');
    const env = { ...process.env };
    const ok = execFileSync('node', [bin, 'audit-verify'], { env, encoding: 'utf8' });
    assert.match(ok, /^ok/);
    const lines = readLines(store.ledgerPath());
    lines[0].session = 'FORGED';
    fs.writeFileSync(store.ledgerPath(), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    let failed = false;
    try {
      execFileSync('node', [bin, 'audit-verify'], { env, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr), /FAILED/);
    }
    assert.ok(failed, 'audit-verify must exit non-zero on tampering');
  });
};
