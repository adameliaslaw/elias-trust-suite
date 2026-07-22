'use strict';
// Issue #18 stopgap regression tests: Matterproof must NOT emit client-facing
// bills (LEDES/HTML invoices, LawPay links) unless an operator explicitly opts
// in with BILLABLE_ALLOW_CLIENT_EXPORTS=1. Internal reports (text/csv) stay
// available. Covers both surfaces: the CLI and the HTTP dashboard.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = (test) => {
  const store = require('../src/store');
  const bin = path.resolve(__dirname, '..', 'bin', 'billable.js');

  // Run the CLI with the client-export flag FORCED OFF, regardless of what the
  // outer harness set (run.js opts the whole suite in). Seed a reviewed entry
  // so there is real billable work to (refuse to) export.
  function envWithoutFlag() {
    const env = { ...process.env };
    delete env.BILLABLE_ALLOW_CLIENT_EXPORTS;
    return env;
  }
  function envWithFlag() {
    return { ...process.env, BILLABLE_ALLOW_CLIENT_EXPORTS: '1' };
  }

  function seedBillableEntry() {
    // A completed, reviewed sitting: prompt -> tool -> stop, then mark reviewed.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'billable-gate-'));
    const env = { ...process.env, BILLABLE_HOME: home };
    const run = (args, opts = {}) =>
      execFileSync('node', [bin, ...args], { env, encoding: 'utf8', ...opts });
    run(['config', 'rate', '250']);
    run(['add', '--minutes', '30', '--desc', 'Reviewed legal research', '--client', 'Acme', '--date', '2026-07-15']);
    return { home, env };
  }

  test('#18: CLI refuses LEDES/HTML client bills by default, emits no file', () => {
    const { home } = seedBillableEntry();
    const outFile = path.join(home, 'invoice.ledes.txt');
    const env = { ...envWithoutFlag(), BILLABLE_HOME: home };

    for (const format of ['ledes', 'html']) {
      let failed = false;
      try {
        execFileSync('node', [bin, 'report', '--format', format, '--out', outFile],
          { env, encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        failed = true;
        assert.match(String(e.stderr), /disabled pending review enforcement \(issue #18\)/);
      }
      assert.ok(failed, `report --format ${format} must exit non-zero when exports are disabled`);
      assert.ok(!fs.existsSync(outFile), `report --format ${format} must not write a bill file`);
    }
  });

  test('#18: internal text/csv reports stay available without the flag', () => {
    const { home } = seedBillableEntry();
    const env = { ...envWithoutFlag(), BILLABLE_HOME: home };
    const text = execFileSync('node', [bin, 'report'], { env, encoding: 'utf8' });
    assert.match(text, /Reviewed legal research/);
    const csv = execFileSync('node', [bin, 'report', '--format', 'csv'], { env, encoding: 'utf8' });
    assert.match(csv, /date,client,matter,activity_code/);
  });

  test('#18: LEDES export works once the operator opts in', () => {
    const { home } = seedBillableEntry();
    const env = { ...envWithFlag(), BILLABLE_HOME: home };
    const ledes = execFileSync('node', [bin, 'report', '--format', 'ledes'], { env, encoding: 'utf8' });
    assert.match(ledes, /^LEDES1998B\[\]/);
  });

  test('#18: CLI refuses a LawPay payment link by default', () => {
    const { home } = seedBillableEntry();
    const env = { ...envWithoutFlag(), BILLABLE_HOME: home };
    execFileSync('node', [bin, 'config', 'lawpayPageUrl', 'https://secure.lawpay.com/pages/t/operating'],
      { env, encoding: 'utf8' });
    // Review the entry so it WOULD be billable — proving the gate blocks even
    // valid, reviewed work, not merely unreviewed work.
    let failed = false;
    try {
      execFileSync('node', [bin, 'lawpay', 'link', '--client', 'Acme'], { env, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr), /issue #18/);
    }
    assert.ok(failed, 'lawpay link must be refused when client exports are disabled');
  });

  test('#18: HTTP server refuses /export.ledes and /api/lawpay/link by default', async () => {
    const { createServer } = require('../src/server');
    const saved = process.env.BILLABLE_ALLOW_CLIENT_EXPORTS;
    delete process.env.BILLABLE_ALLOW_CLIENT_EXPORTS;
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const ledes = await fetch(base + '/export.ledes');
      assert.strictEqual(ledes.status, 403);
      const html = await fetch(base + '/export.html');
      assert.strictEqual(html.status, 403);
      const link = await fetch(base + '/api/lawpay/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: 'Acme' }),
      });
      assert.strictEqual(link.status, 403);
      // Internal exports remain reachable.
      assert.strictEqual((await fetch(base + '/export.csv')).status, 200);
      assert.strictEqual((await fetch(base + '/export.txt')).status, 200);
    } finally {
      server.close();
      if (saved === undefined) delete process.env.BILLABLE_ALLOW_CLIENT_EXPORTS;
      else process.env.BILLABLE_ALLOW_CLIENT_EXPORTS = saved;
    }
  });
};
