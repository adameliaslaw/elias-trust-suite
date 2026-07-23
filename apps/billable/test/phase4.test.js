'use strict';
// Phase 4 (epic #23) reproducing tests — registered into test/run.js's runner.
// These pin the Matterproof billing redesign:
//   #17  a billable minute exists ONLY when an attorney confirms human minutes;
//        inferred AI runtime defaults to zero and reaches no export.
//   #18  reviewed-only, mutually-exclusive, idempotent client billing — an
//        unreviewed, unconfirmed, or already-billed entry cannot reach a client.
//   rate snapshot at review time (no retroactive repricing).
//   M5   LEDES units are exact at any increment (units × rate === line total),
//        with correct multi-matter grouping.
//   M6   capturePrompts:false keeps prompt text out of the ledger on EVERY path.
//   fail-loud on malformed JSONL ledger records (surfaced, never silently dropped).
//   Clio OAuth: state + PKCE + callback timeout.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = (test) => {
  const store = require('../src/store');
  const { buildEntries, totals, entryId } = require('../src/entries');
  const { classifyForClient, isBilled, billedMarker } = require('../src/client-billing');
  const { ledesExport, FIELDS } = require('../src/ledes');
  const { feeCents } = require('../src/money');

  function freshHome() {
    process.env.BILLABLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'billable-p4-'));
    return process.env.BILLABLE_HOME;
  }

  const aiSession = (session, startMin, tools = ['Read', 'Edit']) => {
    const t = (m) => new Date(Date.UTC(2026, 6, 15, 10, m)).toISOString();
    const evs = [{ ts: t(startMin), type: 'prompt', session, detail: 'do work', cwd: '/proj' }];
    tools.forEach((tool, i) => evs.push({ ts: t(startMin + 1 + i), type: 'tool', session, tool, cwd: '/proj' }));
    evs.push({ ts: t(startMin + 1 + tools.length), type: 'stop', session });
    return evs;
  };

  // Parse a LEDES 1998B document into per-line field objects.
  function parseLedes(text) {
    const lines = text.trim().split('\n');
    assert.strictEqual(lines[0], 'LEDES1998B[]');
    const header = lines[1].slice(0, -2).split('|');
    return lines.slice(2).map((l) => {
      const cells = l.slice(0, -2).split('|');
      const o = {};
      header.forEach((h, i) => (o[h] = cells[i]));
      return o;
    });
  }

  // -------------------------------------------------------------------------
  // #17 — inferred attorney time defaults to zero
  // -------------------------------------------------------------------------
  test('#17: an AI entry with no confirmed minutes is non-billable and zero everywhere', () => {
    const config = { ...store.DEFAULT_CONFIG, rate: 400, aiCostPerHour: 6 };
    const [e] = buildEntries(aiSession('s1', 0), config);
    // The machine measured a runtime and offers a *suggestion*, but it is NOT time.
    assert.ok(e.suggestedHours > 0, 'machine suggestion is present as provenance');
    assert.ok(e.seconds > 0, 'AI runtime is retained as cost/provenance metadata');
    assert.strictEqual(e.hours, 0, 'billable hours default to zero');
    assert.strictEqual(e.confirmed, false);
    assert.strictEqual(e.billable, false);
    assert.strictEqual(e.amount, 0, 'no confirmed minutes => no fee');
    assert.ok(e.aiCost > 0, 'AI cost pass-through still computed from runtime');
    // Zero into any export: totals, and a LEDES even if it were reviewed.
    assert.strictEqual(totals([e]).amount, 0);
    const reviewedButUnconfirmed = buildEntries(aiSession('s1', 0), config, {
      [entryId('s1', new Date(Date.UTC(2026, 6, 15, 10, 0)).toISOString())]: { reviewed: true },
    });
    const rows = parseLedes(ledesExport(reviewedButUnconfirmed, config, { invoiceNumber: 'INV-1' }));
    assert.strictEqual(rows.length, 0, 'reviewed-but-unconfirmed contributes no LEDES line');
  });

  test('#17: a billable minute exists once an attorney confirms human minutes', () => {
    const config = { ...store.DEFAULT_CONFIG, rate: 400 };
    const id = entryId('s1', new Date(Date.UTC(2026, 6, 15, 10, 0)).toISOString());
    const [e] = buildEntries(aiSession('s1', 0), config, { [id]: { hours: 0.3, reviewed: true } });
    assert.strictEqual(e.confirmed, true);
    assert.strictEqual(e.billable, true);
    assert.strictEqual(e.hours, 0.3);
    assert.strictEqual(e.amount, 120); // 0.3 * 400
  });

  // -------------------------------------------------------------------------
  // #18 — reviewed-only, mutually-exclusive, idempotent billing
  // -------------------------------------------------------------------------
  test('#18: an unreviewed entry (even with confirmed minutes) cannot reach a client', () => {
    const config = { ...store.DEFAULT_CONFIG, rate: 400 };
    const id = entryId('s1', new Date(Date.UTC(2026, 6, 15, 10, 0)).toISOString());
    const entries = buildEntries(aiSession('s1', 0), config, { [id]: { hours: 0.3 } }); // confirmed, NOT reviewed
    const { ready, skipped } = classifyForClient(entries);
    assert.strictEqual(ready.length, 0);
    assert.strictEqual(skipped.unreviewed, 1);
    assert.strictEqual(parseLedes(ledesExport(entries, config, {})).length, 0);
  });

  test('#18: an already-billed entry cannot reach any client destination (mutual exclusivity)', () => {
    const config = { ...store.DEFAULT_CONFIG, rate: 400 };
    const id = entryId('s1', new Date(Date.UTC(2026, 6, 15, 10, 0)).toISOString());
    // Reviewed + confirmed, but already billed to LawPay.
    const over = { [id]: { hours: 0.3, reviewed: true, billed: { destination: 'lawpay', reference: 'MP-x', at: '2026-07-16' } } };
    const entries = buildEntries(aiSession('s1', 0), config, over);
    assert.ok(isBilled(over[id]));
    const { ready, skipped } = classifyForClient(entries);
    assert.strictEqual(ready.length, 0);
    assert.strictEqual(skipped.alreadyBilled, 1);
    // LEDES (a different destination) also refuses it — a second bill is a no-op.
    assert.strictEqual(parseLedes(ledesExport(entries, config, {})).length, 0);
  });

  test('#18: legacy lawpayRef/clioId markers still count as billed', () => {
    assert.ok(isBilled({ lawpayRef: 'MP-1' }));
    assert.ok(isBilled({ clioId: 9001 }));
    assert.deepStrictEqual(billedMarker({ clioId: 9001 }), { destination: 'clio', reference: '9001' });
    assert.strictEqual(isBilled({}), false);
    assert.strictEqual(isBilled(undefined), false);
  });

  // -------------------------------------------------------------------------
  // Rate snapshot at review time
  // -------------------------------------------------------------------------
  test('rate snapshot: changing the rate table does not move a reviewed entry', () => {
    const id = entryId('s1', new Date(Date.UTC(2026, 6, 15, 10, 0)).toISOString());
    const over = { [id]: { hours: 1.0, reviewed: true, rateSnapshot: 250 } };
    // Config rate is now 500, but the reviewed entry froze 250 at review time.
    const [e] = buildEntries(aiSession('s1', 0), { ...store.DEFAULT_CONFIG, rate: 500 }, over);
    assert.strictEqual(e.rate, 250);
    assert.strictEqual(e.amount, 250);
    // Re-price the table again — the frozen entry is unmoved.
    const [e2] = buildEntries(aiSession('s1', 0), { ...store.DEFAULT_CONFIG, rate: 999 }, over);
    assert.strictEqual(e2.amount, 250);
  });

  test('rate snapshot: the review write path freezes the current rate (once)', () => {
    const { reviewRateSnapshot } = require('../src/client-billing');
    // Reviewing at rate 250 freezes 250 into the override the server persists.
    const written = reviewRateSnapshot({ hours: 1.0, reviewed: true }, { rate: 250 }, undefined);
    assert.strictEqual(written.rateSnapshot, 250);
    // The frozen rate flows through to the entry amount even when the table moves.
    const id = entryId('s1', new Date(Date.UTC(2026, 6, 15, 10, 0)).toISOString());
    const [e] = buildEntries(aiSession('s1', 0), { ...store.DEFAULT_CONFIG, rate: 500 }, { [id]: written });
    assert.strictEqual(e.amount, 250);
    // A second review does NOT overwrite an existing snapshot.
    const again = reviewRateSnapshot({ reviewed: true, hours: 2 }, { rate: 999 }, written);
    assert.strictEqual(again.rateSnapshot, undefined, 'existing snapshot is preserved, not re-frozen');
    // Marking reviewed=false never snapshots.
    assert.strictEqual(reviewRateSnapshot({ reviewed: false }, { rate: 250 }, undefined).rateSnapshot, undefined);
  });

  // -------------------------------------------------------------------------
  // M5 — LEDES units exact at any increment; multi-matter grouping
  // -------------------------------------------------------------------------
  test('M5: LEDES units × unit cost === line total at tenth and quarter-hour increments', () => {
    const config = { ...store.DEFAULT_CONFIG, timekeeperId: 'AI1', firmId: 'AEL' };
    const mk = (id, client, matter, hours, rate) => ({
      id, date: '2026-07-15', client, matter, code: 'A103', description: 'Work.',
      steps: 3, seconds: 600, suggestedHours: hours, hours, confirmed: true,
      reviewed: true, writeOff: false, billed: null, manual: false,
      rate, amount: feeCents(hours, rate) / 100, aiCost: 0,
    });
    // 1.5h @ $13.35 (the classic half-cent case) and a quarter-hour increment.
    const entries = [mk('a', 'Acme', 'ACME-001', 1.5, 13.35), mk('b', 'Acme', 'ACME-001', 0.25, 13.35)];
    const rows = parseLedes(ledesExport(entries, config, { invoiceNumber: 'INV-9' }));
    const feeRows = rows.filter((r) => r['EXP/FEE/INV_ADJ_TYPE'] === 'F');
    assert.strictEqual(feeRows.length, 2);
    for (const r of feeRows) {
      const units = Number(r.LINE_ITEM_NUMBER_OF_UNITS);
      const unitCost = Number(r.LINE_ITEM_UNIT_COST);
      const lineTotal = Number(r.LINE_ITEM_TOTAL);
      // The invariant LEDES validators enforce: units × cost, computed EXACTLY
      // (never float64 — 1.5 × 13.35 = 20.025 loses precision as a double),
      // equals the line total to the cent. feeCents is the exact half-up math.
      assert.strictEqual(feeCents(units, unitCost), Math.round(lineTotal * 100),
        `units ${units} × cost ${unitCost} must equal line total ${lineTotal}`);
      // And the old bug is dead: units are never silently rounded to tenths.
      assert.strictEqual(units, Number(r.LINE_ITEM_NUMBER_OF_UNITS));
    }
    // The quarter-hour increment specifically survives (0.2 tenths bug is gone).
    assert.ok(feeRows.some((r) => Number(r.LINE_ITEM_NUMBER_OF_UNITS) === 0.25),
      'quarter-hour units are preserved exactly, not truncated to 0.2/0.3');
    // INVOICE_TOTAL equals the sum of the invoice's line totals.
    const invTotal = Number(feeRows[0].INVOICE_TOTAL);
    const sum = feeRows.reduce((s, r) => s + Math.round(Number(r.LINE_ITEM_TOTAL) * 100), 0);
    assert.strictEqual(Math.round(invTotal * 100), sum);
  });

  test('M5: multiple matters group into separate invoices, each self-consistent', () => {
    const config = { ...store.DEFAULT_CONFIG, timekeeperId: 'AI1', firmId: 'AEL' };
    const mk = (id, client, matter, hours, rate) => ({
      id, date: '2026-07-15', client, matter, code: 'A103', description: 'Work.',
      steps: 3, seconds: 600, suggestedHours: hours, hours, confirmed: true,
      reviewed: true, writeOff: false, billed: null, manual: false,
      rate, amount: feeCents(hours, rate) / 100, aiCost: 0,
    });
    const entries = [
      mk('a', 'Acme', 'ACME-001', 1.0, 200),
      mk('b', 'Acme', 'ACME-001', 0.5, 200),
      mk('c', 'Beta', 'BETA-002', 2.0, 300),
    ];
    const rows = parseLedes(ledesExport(entries, config, {}));
    const invoices = new Set(rows.map((r) => r.INVOICE_NUMBER));
    assert.strictEqual(invoices.size, 2, 'one invoice per client/matter');
    // Each matter's lines carry that matter's own client/matter + total.
    for (const inv of invoices) {
      const lr = rows.filter((r) => r.INVOICE_NUMBER === inv);
      const sameMatter = new Set(lr.map((r) => r.CLIENT_MATTER_ID));
      assert.strictEqual(sameMatter.size, 1);
      const invTotal = Math.round(Number(lr[0].INVOICE_TOTAL) * 100);
      const sum = lr.reduce((s, r) => s + Math.round(Number(r.LINE_ITEM_TOTAL) * 100), 0);
      assert.strictEqual(invTotal, sum);
      // LINE_ITEM_NUMBER restarts at 1 within each invoice.
      assert.strictEqual(lr[0].LINE_ITEM_NUMBER, '1');
    }
  });

  // -------------------------------------------------------------------------
  // M6 — capturePrompts:false on every write path
  // -------------------------------------------------------------------------
  test('M6: with capture off, store.appendEvent strips prompt text (any caller)', () => {
    const prevHome = process.env.BILLABLE_HOME;
    freshHome();
    try {
      store.writeConfig({ ...store.readConfig(), capturePrompts: false });
      store.appendEvent({ ts: '2026-07-15T10:00:00.000Z', type: 'prompt', session: 's', detail: 'SECRET CLIENT FACTS' });
      const ledger = fs.readFileSync(store.ledgerPath(), 'utf8');
      assert.ok(!ledger.includes('SECRET CLIENT FACTS'), 'prompt text never lands in the ledger');
    } finally {
      process.env.BILLABLE_HOME = prevHome;
    }
  });

  test('M6: with capture off, the extension / POST /api/log payload writes no prompt text', () => {
    // Exercise the exact path POST /api/log runs: a web-capture hook payload ->
    // eventFromHookPayload -> store.appendEvent. The scrub lives at that single
    // choke point, so every write path (CLI, dashboard, extension) is covered.
    const { eventFromHookPayload } = require('../src/hooks');
    const prevHome = process.env.BILLABLE_HOME;
    freshHome();
    try {
      store.writeConfig({ ...store.readConfig(), capturePrompts: false });
      const event = eventFromHookPayload({
        hook_event_name: 'UserPromptSubmit', session_id: 'web-1',
        prompt: 'PRIVILEGED MATTER SECRET', source: 'claude-web', client: 'Acme',
      });
      store.appendEvent(event);
      const ledger = fs.readFileSync(store.ledgerPath(), 'utf8');
      assert.ok(!ledger.includes('PRIVILEGED MATTER SECRET'), 'web capture honors capturePrompts:false');
      // The event itself is still recorded (routing/timing), just without the text.
      assert.ok(ledger.includes('"type":"prompt"'));
      assert.ok(ledger.includes('claude-web'), 'source/routing metadata is retained');
    } finally {
      process.env.BILLABLE_HOME = prevHome;
    }
  });

  // -------------------------------------------------------------------------
  // Fail loud on malformed JSONL
  // -------------------------------------------------------------------------
  test('malformed ledger records are surfaced, never silently dropped', () => {
    // Use a throwaway home and RESTORE the prior one: this suite's async tests
    // resume on a later tick and read whatever BILLABLE_HOME is set to, so a
    // deliberately-corrupt ledger must never be left as the active home.
    const prevHome = process.env.BILLABLE_HOME;
    freshHome();
    try {
      store.appendEvent({ ts: '2026-07-15T10:00:00.000Z', type: 'stop', session: 's' });
      // Corrupt the ledger with a non-JSON line (partial write / tampering).
      fs.appendFileSync(store.ledgerPath(), '{this is not valid json\n');
      let err;
      try { store.readEvents(); } catch (e) { err = e; }
      assert.ok(err, 'readEvents must throw on a malformed record');
      assert.match(err.message, /ledger\.jsonl/);
      assert.match(err.message, /line 2/, 'the bad line is named');
    } finally {
      process.env.BILLABLE_HOME = prevHome;
    }
  });

  // -------------------------------------------------------------------------
  // Clio OAuth hardening — state + PKCE + callback timeout
  // -------------------------------------------------------------------------
  test('Clio: authorize request carries state + PKCE S256 challenge', () => {
    const clio = require('../src/clio');
    const req = clio.buildAuthRequest({ clioClientId: 'cid' });
    const u = new URL(req.url);
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert.strictEqual(u.searchParams.get('client_id'), 'cid');
    assert.ok(req.state && req.state.length >= 16);
    assert.strictEqual(u.searchParams.get('state'), req.state);
    assert.ok(req.codeVerifier && req.codeVerifier.length >= 43);
    assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(u.searchParams.get('code_challenge'), req.codeChallenge);
    assert.notStrictEqual(req.codeChallenge, req.codeVerifier, 'challenge is a hash, not the verifier');
  });

  test('Clio: callback rejects a mismatched state (CSRF) and times out', async () => {
    const clio = require('../src/clio');
    const http = require('http');
    // Wrong state -> rejected. Attach the rejection assertion BEFORE driving
    // the callback so the promise never sits unhandled across I/O ticks.
    let listeningResolve;
    const listening = new Promise((r) => (listeningResolve = r));
    const p = clio.waitForCode({ port: 0, expectedState: 'good-state', timeoutMs: 2000, onListening: (pt) => listeningResolve(pt) });
    const rejection = assert.rejects(p, /state/i);
    const port = await listening;
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/callback?code=abc&state=WRONG' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    await rejection;

    // No callback at all within the timeout -> rejected, server closed.
    await assert.rejects(clio.waitForCode({ port: 0, expectedState: 's', timeoutMs: 150 }), /timed out/i);
  });

  test('Clio: token exchange sends the PKCE code_verifier', async () => {
    const clio = require('../src/clio');
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, body: opts.body });
      return { ok: true, json: async () => ({ access_token: 't', refresh_token: 'r', expires_in: 3600 }), text: async () => '' };
    };
    await clio.exchangeToken(
      { clioClientId: 'cid', clioClientSecret: 'sec' },
      { grant_type: 'authorization_code', code: 'abc', codeVerifier: 'verifier-123' },
      fetchImpl
    );
    const body = new URLSearchParams(calls[0].body);
    assert.strictEqual(body.get('code_verifier'), 'verifier-123');
    assert.strictEqual(body.get('code'), 'abc');
    assert.ok(!body.has('codeVerifier'), 'camelCase helper key is not leaked into the request');
  });
};
