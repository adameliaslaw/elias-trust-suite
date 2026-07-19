// Tamper-evident audit chain regression tests (@elias/audit wiring).
//
// Pins: exact-cents payload conversion (never floats), chain verification,
// tamper detection (alter / delete / reorder), verify-on-open, and the
// route-level wiring (semantic money events + Layer A http.write coverage).
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-audit-'));
process.env.QUICKBUCKS_NO_SEED = '1';
process.env.QUICKBUCKS_DISABLE_AUTH = '1';

const audit = require('../lib/audit');
const { AuditLog, AuditIntegrityError, FsJsonlStorage } = require('@elias/audit');

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

function readChainLines(companyId) {
  return fs.readFileSync(audit.chainFile(companyId), 'utf8').trim().split('\n');
}

function writeChainLines(companyId, lines) {
  fs.writeFileSync(audit.chainFile(companyId), lines.join('\n') + '\n');
}

async function main() {
  // --- exact money: cents strings, never floats ---
  await test('centsStr: half-cent rounds half-up, away from zero', () => {
    assert.strictEqual(audit.centsStr(20.025), '2003');   // the 1.5h x $13.35 class
    assert.strictEqual(audit.centsStr(1.005), '101');
    assert.strictEqual(audit.centsStr(-1.005), '-101');
  });
  await test('centsStr: float-noise snaps to intended cents', () => {
    assert.strictEqual(audit.centsStr(0.1 + 0.2 + 0.3 - 0.6), '0');
    assert.strictEqual(audit.centsStr(1750), '175000');
  });

  // --- chain round-trip ---
  const CO = 'testco';
  await test('append + verify round-trip', async () => {
    await audit.append(CO, 'invoice.created', {
      invoiceId: 'inv1', clientId: 'c1', totalCents: audit.centsStr(20.025),
      source: 'manual', actor: 'local@test'
    });
    await audit.append(CO, 'http.write', { method: 'POST', path: '/api/invoices', status: 201, actor: 'local@test' });
    await audit.append(CO, 'payroll.payment', {
      paymentId: 'run1:emp1', employeeId: 'emp1', amountCents: '150000',
      payPeriod: '2026-01', method: 'ach', initiatedBy: 'local@test', idempotencyKey: 'run1:emp1'
    });
    const v = await audit.verify(CO);
    assert.deepStrictEqual(v, { ok: true, entries: 3 });
  });

  await test('money payloads are stored as decimal strings, never floats', () => {
    const entries = readChainLines(CO).map(l => JSON.parse(l));
    assert.strictEqual(entries[0].payload.totalCents, '2003');
    assert.strictEqual(typeof entries[0].payload.totalCents, 'string');
    assert.strictEqual(entries[2].payload.amountCents, '150000');
    assert.ok(!JSON.stringify(entries).match(/"totalCents":\s*\d/));
  });

  // --- tamper detection ---
  await test('altered payload is detected and names the first bad seq', async () => {
    const lines = readChainLines(CO);
    const e = JSON.parse(lines[0]);
    e.payload.totalCents = '999999';
    lines[0] = JSON.stringify(e);
    writeChainLines(CO, lines);
    audit._reset();
    const v = await audit.verify(CO);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.atSeq, 0);
    assert.match(v.error, /hash mismatch/);
  });

  await test('verify-on-open throws AuditIntegrityError on tampered chain', async () => {
    audit._reset();
    await assert.rejects(
      AuditLog.open(new FsJsonlStorage(audit.chainFile(CO))),
      err => err instanceof AuditIntegrityError && err.atSeq === 0
    );
  });

  await test('deleted middle line breaks the chain (seq gap)', async () => {
    const lines = readChainLines(CO);           // restore a good chain first
    const good = JSON.parse(lines[0]);
    good.payload.totalCents = '2003';
    // Rebuild a fresh, valid 3-entry chain instead of hand-repairing hashes.
    audit._reset();
    fs.unlinkSync(audit.chainFile(CO));
    await audit.append(CO, 'http.write', { method: 'POST', path: '/a', status: 200, actor: 't' });
    await audit.append(CO, 'http.write', { method: 'POST', path: '/b', status: 200, actor: 't' });
    await audit.append(CO, 'http.write', { method: 'POST', path: '/c', status: 200, actor: 't' });
    void good;
    const cur = readChainLines(CO);
    cur.splice(1, 1);                            // delete the middle entry
    writeChainLines(CO, cur);
    audit._reset();
    const v = await audit.verify(CO);
    assert.strictEqual(v.ok, false);
    // The verifier names the entry AFTER the gap (seq 2 found where seq 1
    // belongs) — the gap itself is the missing line.
    assert.strictEqual(v.atSeq, 2);
  });

  await test('reordered entries break prevHash linkage', async () => {
    const cur = readChainLines(CO);
    // current file is already broken from the previous test; rebuild valid
    audit._reset();
    fs.unlinkSync(audit.chainFile(CO));
    await audit.append(CO, 'http.write', { method: 'POST', path: '/a', status: 200, actor: 't' });
    await audit.append(CO, 'http.write', { method: 'POST', path: '/b', status: 200, actor: 't' });
    await audit.append(CO, 'http.write', { method: 'POST', path: '/c', status: 200, actor: 't' });
    const lines = readChainLines(CO);
    [lines[1], lines[2]] = [lines[2], lines[1]];
    writeChainLines(CO, lines);
    audit._reset();
    const v = await audit.verify(CO);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.atSeq, 2);   // seq-2 entry found at line 1
    void cur;
  });

  // --- route-level wiring (server boot against the same tmp dir) ---
  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, resolve));
  const BASE = `http://localhost:${server.address().port}`;
  const req = async (method, url, body) => {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  let companyId;
  await test('semantic + Layer A events chained from real routes', async () => {
    let r = await req('GET', '/api/companies');
    companyId = r.data[0].id;
    r = await req('POST', '/api/customers', { name: 'Alice', company: 'Acme', email: 'a@acme.com' });
    assert.strictEqual(r.status, 201);
    const customer = r.data;
    r = await req('POST', '/api/invoices', {
      customerId: customer.id, date: '2026-01-01', dueDate: '2026-01-31',
      items: [{ description: 'Consulting', qty: 10, rate: 150 }]
    });
    assert.strictEqual(r.status, 201);
    const inv = r.data;
    r = await req('POST', `/api/invoices/${inv.id}/payments`, { amount: 500, date: '2026-01-05' });
    assert.strictEqual(r.status, 200);
    const v = await audit.verify(companyId);
    assert.strictEqual(v.ok, true);
    const types = readChainLines(companyId).map(l => JSON.parse(l).type);
    assert.ok(types.includes('invoice.created'), 'invoice.created present');
    assert.ok(types.includes('invoice.payment_recorded'), 'payment present');
    assert.ok(types.includes('http.write'), 'Layer A http.write present');
    const created = readChainLines(companyId).map(l => JSON.parse(l)).find(e => e.type === 'invoice.created');
    assert.strictEqual(created.payload.totalCents, '150000');
    assert.strictEqual(created.payload.source, 'manual');
  });

  await test('GET /api/audit/chain reports chain status', async () => {
    const r = await req('GET', '/api/audit/chain');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.entries >= 5);
  });

  await test('tampered chain flips /api/audit/chain to ok:false with atSeq', async () => {
    const lines = readChainLines(companyId);
    const e = JSON.parse(lines[1]);
    e.payload.path = '/api/_FORGED_';
    lines[1] = JSON.stringify(e);
    writeChainLines(companyId, lines);
    audit._reset();
    const r = await req('GET', '/api/audit/chain');
    assert.strictEqual(r.data.ok, false);
    assert.strictEqual(r.data.atSeq, 1);
  });

  await new Promise(resolve => server.close(resolve));
  console.log(`\n  audit.test.js: ${passed} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
