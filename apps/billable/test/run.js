'use strict';
// Zero-dependency test runner: node test/run.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.BILLABLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'billable-test-'));
// Phase 4 removed the BILLABLE_ALLOW_CLIENT_EXPORTS stopgap: client billing is
// now safe by STRUCTURE (reviewed-only + attorney-confirmed minutes + a single
// mutually-exclusive billed marker), enforced and proven in phase4.test.js — no
// deploy-time env switch to flip.

const { roundHours, activeSeconds, narrative, classifyTool } = require('../src/billing');
const { sumCents } = require('../src/money');
const { buildEntries, filterEntries, totals, applyOverride } = require('../src/entries');
const { eventFromHookPayload, installHooks } = require('../src/hooks');
const store = require('../src/store');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

test('rounds up to 6-minute increments with a minimum', () => {
  assert.strictEqual(roundHours(30, 0.1, 0.1), 0.1); // 30s -> minimum 0.1
  assert.strictEqual(roundHours(360, 0.1, 0.1), 0.1); // exactly 6 min
  assert.strictEqual(roundHours(361, 0.1, 0.1), 0.2); // just over -> round up
  assert.strictEqual(roundHours(3600, 0.1, 0.1), 1.0);
  assert.strictEqual(roundHours(0, 0.1, 0.2), 0.2); // custom minimum
  assert.strictEqual(roundHours(900, 0.25, 0.25), 0.25); // quarter-hour billing
});

test('caps idle gaps between steps', () => {
  const t0 = new Date('2026-07-15T10:00:00Z');
  const ts = [0, 60, 120, 3600 + 120].map((s) => new Date(t0.getTime() + s * 1000).toISOString());
  // gaps: 60s + 60s + 3480s(capped at 300s) = 420s
  assert.strictEqual(activeSeconds(ts, 5), 420);
});

test('classifies tools into UTBMS activity codes', () => {
  assert.strictEqual(classifyTool('Read').code, 'A104');
  assert.strictEqual(classifyTool('Edit').code, 'A103');
  assert.strictEqual(classifyTool('WebSearch').code, 'A102');
  assert.strictEqual(classifyTool('Bash').code, 'A110');
  assert.strictEqual(classifyTool('SomethingNew').code, 'A111');
});

test('generates attorney-style narratives', () => {
  const text = narrative({
    tools: ['Read', 'Read', 'Edit', 'Bash'],
    subject: 'fix the login bug',
  });
  assert.match(text, /Reviewed and analyzed 2 files/);
  assert.match(text, /drafted and revised 1 document/);
  assert.match(text, /re: fix the login bug\./);
  // singularization: 'inquiries' -> 'inquiry', not 'inquirie'
  assert.match(narrative({ tools: ['AskUserQuestion'], subject: 'x' }), /1 inquiry/);
});

test('money math is exact: no float64 fee or total drift', () => {
  // 1.5h x $13.35 = $20.025 -> half-up $20.03. Float round2 gave $20.02.
  // confirmed:true — these represent attorney-confirmed minutes (#17), the only
  // kind that price to a fee.
  const e = { writeOff: false, manual: false, hours: 1.5, seconds: 5400, confirmed: true };
  applyOverride(e, null, { rate: 13.35, aiCostPerHour: 0 });
  assert.equal(e.amount, 20.03);
  // half-cent boundary: 0.5h x $4.21 = $2.105 -> $2.11
  const e2 = { writeOff: false, manual: false, hours: 0.5, seconds: 1800, confirmed: true };
  applyOverride(e2, null, { rate: 4.21, aiCostPerHour: 0 });
  assert.equal(e2.amount, 2.11);
  // totals accumulate in integer cents: 0.1+0.2 style drift impossible
  const t = totals([{ amount: 0.1, aiCost: 0.06, hours: 0.1, steps: 1 },
                    { amount: 0.2, aiCost: 0.06, hours: 0.1, steps: 1 }]);
  assert.equal(t.amount, 0.3);
  assert.equal(t.aiCost, 0.12);
  // sumCents: LawPay/LEDES boundary never float-adds
  assert.equal(sumCents(19.99, 0.01), 2000);
  assert.equal(sumCents(0.1, 0.2), 30);
});

test('translates Claude Code hook payloads into ledger events', () => {
  const now = new Date('2026-07-15T10:00:00Z');
  const prompt = eventFromHookPayload(
    { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/x', prompt: 'do a thing' },
    now
  );
  assert.deepStrictEqual(prompt, {
    ts: '2026-07-15T10:00:00.000Z',
    session: 's1',
    cwd: '/x',
    type: 'prompt',
    detail: 'do a thing',
  });
  const tool = eventFromHookPayload({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Edit' }, now);
  assert.strictEqual(tool.type, 'tool');
  assert.strictEqual(tool.tool, 'Edit');
  assert.strictEqual(eventFromHookPayload({ hook_event_name: 'PreCompact' }, now), null);
});

test('builds one entry per prompt-to-stop task', () => {
  const config = { ...store.DEFAULT_CONFIG, rate: 100 };
  const t = (min) => new Date(Date.UTC(2026, 6, 15, 10, min)).toISOString();
  const events = [
    { ts: t(0), type: 'prompt', session: 's1', detail: 'fix bug', cwd: '/proj' },
    { ts: t(1), type: 'tool', session: 's1', tool: 'Read', cwd: '/proj' },
    { ts: t(2), type: 'tool', session: 's1', tool: 'Edit', cwd: '/proj' },
    { ts: t(8), type: 'stop', session: 's1' },
    { ts: t(20), type: 'prompt', session: 's1', detail: 'add tests', cwd: '/proj' },
    { ts: t(22), type: 'tool', session: 's1', tool: 'Write', cwd: '/proj' },
    { ts: t(23), type: 'stop', session: 's1' },
  ];
  const entries = buildEntries(events, config);
  assert.strictEqual(entries.length, 2);
  // #17: AI capture yields a SUGGESTION, not billable time. Billable hours are
  // zero until an attorney confirms minutes; nothing is billed automatically.
  assert.strictEqual(entries[0].suggestedHours, 0.2); // 8 minutes measured
  assert.strictEqual(entries[0].hours, 0);
  assert.strictEqual(entries[0].confirmed, false);
  assert.strictEqual(entries[0].billable, false);
  assert.strictEqual(entries[0].amount, 0);
  assert.strictEqual(entries[0].steps, 2);
  assert.match(entries[0].description, /re: fix bug/);
  assert.strictEqual(entries[1].suggestedHours, 0.1); // 3 minutes -> minimum 0.1
  assert.strictEqual(entries[1].hours, 0);
  // Once the attorney confirms minutes, the entry becomes billable.
  const id0 = require('../src/entries').entryId('s1', events[0].ts);
  const confirmed = buildEntries(events, config, { [id0]: { hours: 0.2, reviewed: true } });
  assert.strictEqual(confirmed[0].hours, 0.2);
  assert.strictEqual(confirmed[0].billable, true);
  assert.strictEqual(confirmed[0].amount, 20);
});

test('routes work to client/matter by project directory', () => {
  const config = {
    ...store.DEFAULT_CONFIG,
    projects: { '/proj': { client: 'Acme Corp', matter: 'ACME-001' } },
  };
  const events = [
    { ts: '2026-07-15T10:00:00Z', type: 'prompt', session: 's1', detail: 'x', cwd: '/proj/sub' },
    { ts: '2026-07-15T10:01:00Z', type: 'stop', session: 's1' },
  ];
  const [entry] = buildEntries(events, config);
  assert.strictEqual(entry.client, 'Acme Corp');
  assert.strictEqual(entry.matter, 'ACME-001');
});

test('manual entries, filtering, and totals', () => {
  const config = { ...store.DEFAULT_CONFIG, rate: 200 };
  const events = [
    { ts: '2026-07-14T12:00:00Z', type: 'manual', minutes: 30, description: 'Claude chat: reviewed contract', client: 'Acme' },
    { ts: '2026-07-15T12:00:00Z', type: 'manual', minutes: 12, description: 'Cowork session', client: 'Beta' },
  ];
  const entries = buildEntries(events, config);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].hours, 0.5);
  assert.strictEqual(entries[0].amount, 100);
  const filtered = filterEntries(entries, { from: '2026-07-15' });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].client, 'Beta');
  assert.strictEqual(totals(entries).hours, 0.7);
});

test('hook install is idempotent and preserves existing settings', () => {
  const file = path.join(process.env.BILLABLE_HOME, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  const added = installHooks(file);
  assert.deepStrictEqual(added, ['UserPromptSubmit', 'PostToolUse', 'Stop']);
  const again = installHooks(file);
  assert.deepStrictEqual(again, []);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(settings.model, 'opus'); // untouched
  assert.strictEqual(settings.hooks.Stop.length, 2); // existing hook kept
});

test('overrides adjust entries without touching the ledger', () => {
  const { entryId } = require('../src/entries');
  const config = { ...store.DEFAULT_CONFIG, rate: 100, aiCostPerHour: 6 };
  const events = [
    { ts: '2026-07-15T10:00:00.000Z', type: 'prompt', session: 's9', detail: 'x' },
    { ts: '2026-07-15T10:30:00.000Z', type: 'tool', session: 's9', tool: 'Read' },
    { ts: '2026-07-15T10:30:30.000Z', type: 'stop', session: 's9' },
  ];
  const id = entryId('s9', '2026-07-15T10:00:00.000Z');
  const plain = buildEntries(events, config)[0];
  assert.strictEqual(plain.reviewed, false);
  assert.ok(plain.aiCost > 0); // pass-through computed from actual runtime
  const adjusted = buildEntries(events, config, {
    [id]: { reviewed: true, hours: 0.3, description: 'Reviewed discovery responses.' },
  })[0];
  assert.strictEqual(adjusted.reviewed, true);
  assert.strictEqual(adjusted.hours, 0.3);
  assert.strictEqual(adjusted.amount, 30);
  assert.strictEqual(adjusted.description, 'Reviewed discovery responses.');
  const writtenOff = buildEntries(events, config, { [id]: { writeOff: true } })[0];
  assert.strictEqual(writtenOff.amount, 0);
  assert.strictEqual(writtenOff.aiCost, 0);
  assert.strictEqual(totals([writtenOff]).hours, 0);
});

test('LEDES 1998B export has well-formed rows', () => {
  const { ledesExport, FIELDS } = require('../src/ledes');
  const config = { ...store.DEFAULT_CONFIG, rate: 250, timekeeperId: 'AI1', firmId: 'AEL' };
  const entries = [
    { id: 'a', date: '2026-07-15', client: 'Acme', matter: 'ACME-001', code: 'A103',
      description: 'Drafted motion | with pipes', steps: 5, seconds: 600, hours: 0.2,
      confirmed: true, rate: 250, billed: null,
      amount: 50, aiCost: 1.25, manual: false, reviewed: true, writeOff: false },
    { id: 'b', date: '2026-07-15', client: 'Acme', matter: 'ACME-001', code: 'A104',
      description: 'written off', steps: 2, seconds: 60, hours: 0.1,
      confirmed: true, rate: 250, billed: null,
      amount: 0, aiCost: 0, manual: false, reviewed: true, writeOff: true },
  ];
  const out = ledesExport(entries, config, { invoiceNumber: 'INV-1' });
  const lines = out.trim().split('\n');
  assert.strictEqual(lines[0], 'LEDES1998B[]');
  assert.strictEqual(lines.length, 4); // header x2 + fee line + expense line (write-off excluded)
  for (const line of lines.slice(1)) {
    assert.ok(line.endsWith('[]'));
    assert.strictEqual(line.slice(0, -2).split('|').length, FIELDS.length);
  }
  assert.ok(!lines[2].includes('| with pipes')); // delimiter stripped from narrative
  assert.match(lines[3], /\|E\|/); // AI cost as expense line
  assert.match(lines[3], /E124/);
});

test('imports claude.ai conversation exports into deduplicated sittings', () => {
  const { parseClaudeExport, dedupe } = require('../src/importers');
  const config = { ...store.DEFAULT_CONFIG };
  const t = (h, m) => new Date(Date.UTC(2026, 6, 14, h, m)).toISOString();
  const data = [
    {
      uuid: 'c1',
      name: 'Venue transfer research',
      chat_messages: [
        { sender: 'human', created_at: t(9, 0) },
        { sender: 'assistant', created_at: t(9, 4) },
        { sender: 'human', created_at: t(9, 10) },
        // 5 hour gap -> new sitting
        { sender: 'assistant', created_at: t(14, 10) },
        { sender: 'human', created_at: t(14, 20) },
      ],
    },
    { uuid: 'c2', name: '', chat_messages: [] }, // ignored: no timestamps
  ];
  const events = parseClaudeExport(data, { client: 'Acme' }, config);
  assert.strictEqual(events.length, 2); // two sittings
  assert.strictEqual(events[0].importKey, 'c1#0');
  assert.match(events[0].description, /Venue transfer research/);
  assert.ok(events[0].minutes >= 10);
  // Re-import is a no-op once the first batch is in the ledger.
  assert.strictEqual(dedupe(events, events).length, 0);
});

test('web-captured prompts carry explicit client/matter routing', () => {
  const { eventFromHookPayload } = require('../src/hooks');
  const config = { ...store.DEFAULT_CONFIG };
  const ev = eventFromHookPayload(
    { hook_event_name: 'UserPromptSubmit', session_id: 'web-abc', prompt: 'Contract review: check indemnity',
      client: 'Acme Corp', source: 'claude-web' },
    new Date('2026-07-15T10:00:00Z')
  );
  assert.strictEqual(ev.client, 'Acme Corp');
  assert.strictEqual(ev.source, 'claude-web');
  const events = [
    ev,
    { ts: '2026-07-15T10:04:00.000Z', type: 'tool', session: 'web-abc', tool: 'WebSearch' },
    { ts: '2026-07-15T10:08:00.000Z', type: 'stop', session: 'web-abc' },
  ];
  const [entry] = buildEntries(events, config);
  assert.strictEqual(entry.client, 'Acme Corp');
  assert.strictEqual(entry.matter, 'Acme Corp'); // explicit client, no matter -> matter named after client
  assert.strictEqual(entry.source, 'claude-web');
  assert.strictEqual(entry.suggestedHours, 0.2); // 8 min of in-cap activity, measured
  assert.strictEqual(entry.hours, 0); // #17: not billable until an attorney confirms minutes
});

test('unit economics: actual vs billed hours, flat-fee margin', () => {
  const { buildEconomics, economicsReport } = require('../src/economics');
  const config = { ...store.DEFAULT_CONFIG, rate: 300, flatFees: { 'Acme|ACME-001': 1000 } };
  const entries = [
    { client: 'Acme', matter: 'ACME-001', steps: 10, seconds: 3600, hours: 1.1, amount: 330, aiCost: 12, writeOff: false, reviewed: true },
    { client: 'Acme', matter: 'ACME-001', steps: 5, seconds: 1800, hours: 0.6, amount: 180, aiCost: 6, writeOff: true, reviewed: true },
    { client: 'Beta', matter: 'BETA-002', steps: 2, seconds: 720, hours: 0.2, amount: 60, aiCost: 1, writeOff: false, reviewed: false },
  ];
  const rows = buildEconomics(entries, config);
  assert.strictEqual(rows.length, 2);
  const acme = rows.find((r) => r.client === 'Acme');
  assert.strictEqual(acme.actualHours, 1.5); // includes written-off work: it still cost time
  assert.strictEqual(acme.billedHours, 1.1); // write-off excluded from billed
  assert.strictEqual(acme.aiCost, 18);
  assert.strictEqual(acme.flatFee, 1000);
  assert.strictEqual(acme.margin, 982);
  assert.strictEqual(acme.effectiveRate, Math.round((1000 / 1.5) * 100) / 100);
  assert.match(economicsReport(rows, config), /Eff\. rate\/hr/);
});

test('Clio push: only reviewed+mapped entries, correct payload, records clioId', async () => {
  const { pushEntries, classifyForPush, activityBody } = require('../src/clio');
  const config = {
    ...store.DEFAULT_CONFIG,
    rate: 250,
    clioMatters: { 'Acme|ACME-001': 777 },
    clio: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  };
  const entries = [
    { id: 'e1', date: '2026-07-15', client: 'Acme', matter: 'ACME-001', description: 'Drafted motion.', hours: 0.3, amount: 75, confirmed: true, reviewed: true, writeOff: false },
    { id: 'e2', date: '2026-07-15', client: 'Acme', matter: 'ACME-001', description: 'x', hours: 0.1, amount: 25, confirmed: true, reviewed: false, writeOff: false },
    { id: 'e3', date: '2026-07-15', client: 'Zeta', matter: 'Z-1', description: 'x', hours: 0.1, amount: 25, confirmed: true, reviewed: true, writeOff: false },
    { id: 'e4', date: '2026-07-15', client: 'Acme', matter: 'ACME-001', description: 'x', hours: 0.1, amount: 25, confirmed: true, reviewed: true, writeOff: true },
  ];
  const { ready, skipped } = classifyForPush(entries, config, { e1: {} });
  assert.strictEqual(ready.length, 1);
  assert.deepStrictEqual(skipped, { unreviewed: 1, unconfirmed: 0, unmapped: 1, writeOff: 1, alreadyPushed: 0 });

  const body = activityBody(entries[0], 777, config);
  assert.strictEqual(body.data.quantity, 1080); // 0.3 hr in seconds
  assert.strictEqual(body.data.price, 250);
  assert.strictEqual(body.data.matter.id, 777);

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ data: { id: 9001 } }), text: async () => '' };
  };
  const { results } = await pushEntries(entries, config, {}, { fetchImpl });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].clioId, 9001);
  assert.match(calls[0].url, /\/api\/v4\/activities\.json$/);
  assert.match(calls[0].opts.headers.authorization, /Bearer tok/);
  assert.strictEqual(store.readOverrides().e1.clioId, 9001);

  // Dry run performs no API calls and records nothing.
  const dry = await pushEntries(entries, config, {}, { dryRun: true, fetchImpl: () => { throw new Error('no calls in dry run'); } });
  assert.strictEqual(dry.results.length, 1);
  assert.strictEqual(dry.results[0].dryRun, true);
});

test('LawPay link: gated on review, amount in cents, marks entries billed', () => {
  const { buildPaymentRequest, markRequested } = require('../src/lawpay');
  const { buildEntries } = require('../src/entries');
  const config = {
    ...store.DEFAULT_CONFIG,
    rate: 250,
    firmName: 'Adam Elias Law',
    lawpayPageUrl: 'https://secure.lawpay.com/pages/testfirm/operating',
  };
  const entries = [
    { id: 'p1', date: '2026-07-10', client: 'Acme', matter: 'ACME-001', description: 'Drafted will package.',
      steps: 5, seconds: 3600, hours: 1.0, amount: 250, aiCost: 6, confirmed: true, reviewed: true, writeOff: false },
    { id: 'p2', date: '2026-07-11', client: 'Acme', matter: 'ACME-001', description: 'x',
      steps: 2, seconds: 600, hours: 0.2, amount: 50, aiCost: 1, confirmed: true, reviewed: false, writeOff: false },
  ];
  const req = buildPaymentRequest(entries, config, { email: 'client@example.com' });
  assert.strictEqual(req.included.length, 1); // unreviewed entry excluded
  assert.strictEqual(req.skipped.unreviewed, 1);
  assert.strictEqual(req.amountCents, 25600); // $250 fees + $6 AI cost, in cents
  const url = new URL(req.url);
  assert.strictEqual(url.origin + url.pathname, 'https://secure.lawpay.com/pages/testfirm/operating');
  assert.strictEqual(url.searchParams.get('amount'), '25600');
  assert.strictEqual(url.searchParams.get('email'), 'client@example.com');
  assert.strictEqual(url.searchParams.get('reference'), req.reference);
  assert.match(url.searchParams.get('description'), /Adam Elias Law — Legal services, 2026-07-10 — 1\.0 hours/);
  assert.strictEqual(url.searchParams.get('readOnlyFields'), 'amount,description');

  // Marking stamps overrides and logs an audit event that never becomes time.
  markRequested(req);
  assert.strictEqual(store.readOverrides().p1.lawpayRef, req.reference);
  const auditEvents = store.readEvents().filter((e) => e.type === 'payment_request');
  assert.strictEqual(auditEvents.length, 1);
  assert.deepStrictEqual(auditEvents[0].entryIds, ['p1']);
  const rebuilt = buildEntries(store.readEvents(), config, store.readOverrides());
  assert.ok(!rebuilt.some((e) => e.session === 'unknown')); // audit event not billable

  // Second request skips already-billed work.
  const again = (() => { try { return buildPaymentRequest(entries, config, {}); } catch (e) { return e; } })();
  assert.ok(again instanceof Error); // p1 billed, p2 unreviewed -> nothing billable
  assert.match(again.message, /1 alreadyBilled/);

  // Unconfigured page URL fails with setup guidance.
  const noPage = (() => { try { return buildPaymentRequest(entries, { ...config, lawpayPageUrl: '' }, {}); } catch (e) { return e; } })();
  assert.match(noPage.message, /lawpayPageUrl/);
});

test('HTML statement embeds a Pay Now button when payUrl is given', () => {
  const { htmlInvoice } = require('../src/report');
  const config = { ...store.DEFAULT_CONFIG, rate: 250 };
  const entries = [{ id: 'x', date: '2026-07-10', client: 'Acme', matter: 'M', code: 'A103',
    description: 'Work.', steps: 1, seconds: 600, hours: 0.2, amount: 50, aiCost: 0,
    confirmed: true, rate: 250, billed: null, reviewed: true, writeOff: false }];
  const html = htmlInvoice(entries, config, { payUrl: 'https://secure.lawpay.com/pages/f/operating?amount=5000' });
  assert.match(html, /class="paybtn"/);
  assert.match(html, /Pay Now — \$50\.00/);
  assert.match(html, /secure\.lawpay\.com/);
  const plain = htmlInvoice(entries, config, {});
  assert.ok(!plain.includes('class="paybtn"')); // style rule exists, button element doesn't
});

test('payment requests: list, outstanding balance, mark paid, no double-settle', () => {
  const { listRequests, outstanding, markPaid } = require('../src/lawpay');
  const events = [
    { ts: '2026-07-10T12:00:00Z', type: 'payment_request', reference: 'MP-aaa', amountCents: 25600, description: 'July services', entryIds: ['p1'], email: 'c@x.com' },
    { ts: '2026-07-12T12:00:00Z', type: 'payment_request', reference: 'MP-bbb', amountCents: 10000, description: 'More work', entryIds: ['p2'] },
    { ts: '2026-07-13T12:00:00Z', type: 'payment_received', reference: 'MP-aaa', amountCents: 25600 },
  ];
  const requests = listRequests(events);
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].paid, true);
  assert.strictEqual(requests[0].paidAt, '2026-07-13');
  assert.strictEqual(requests[0].email, 'c@x.com');
  assert.strictEqual(requests[1].paid, false);
  assert.strictEqual(outstanding(requests), 10000);

  const settled = markPaid('MP-bbb', events); // appends to the real (temp) ledger
  assert.strictEqual(settled.amountCents, 10000);
  const dbl = (() => { try { return markPaid('MP-aaa', events); } catch (e) { return e; } })();
  assert.match(dbl.message, /already marked paid/);
  const unknown = (() => { try { return markPaid('MP-zzz', events); } catch (e) { return e; } })();
  assert.match(unknown.message, /No payment request/);
});

test('payment email: branded template and SendGrid payload', async () => {
  const { buildPaymentEmail, sendPaymentEmail } = require('../src/email');
  const config = { ...store.DEFAULT_CONFIG, firmName: 'Adam Elias Law', firmEmail: 'adam@adameliaslaw.com',
    firmPhone: '555-0100', sendgridApiKey: 'SG.test' };
  const { subject, html } = buildPaymentEmail(config, {
    clientName: 'Jane Doe', amountCents: 25600,
    description: 'Legal services <July>', payUrl: 'https://secure.lawpay.com/pages/f/operating?amount=25600',
  });
  assert.strictEqual(subject, 'Payment Request — $256.00 — Adam Elias Law');
  assert.match(html, /Dear Jane Doe/);
  assert.match(html, /Legal services &lt;July&gt;/); // client data is escaped
  assert.match(html, /Pay Now — \$256\.00/);
  assert.match(html, /CONFIDENTIALITY NOTICE/);

  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  await sendPaymentEmail(config, { to: 'jane@x.com', clientName: 'Jane Doe', amountCents: 25600,
    description: 'd', payUrl: 'https://x' }, fetchImpl);
  assert.strictEqual(calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.personalizations[0].to[0].email, 'jane@x.com');
  assert.strictEqual(body.from.email, 'adam@adameliaslaw.com');
  assert.match(calls[0].opts.headers.authorization, /Bearer SG\.test/);

  const noKey = await sendPaymentEmail({ ...config, sendgridApiKey: '' }, { to: 'x@x.com' }, fetchImpl)
    .catch((e) => e);
  assert.match(noKey.message, /SendGrid not configured/);
});

test('LAN auth: loopback exempt, token via query/bearer/cookie, rejects wrong token', async () => {
  const { authorize, isLoopback, createServer } = require('../src/server');
  const TOKEN = 'a'.repeat(32);
  const u = (path) => new URL(path, 'http://localhost');

  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('192.168.1.20'));

  // No token configured -> open (loopback-only bind).
  assert.strictEqual(authorize({ remoteAddress: '192.168.1.20', url: u('/'), headers: {} }, undefined).ok, true);
  // Loopback always allowed even with a token set (hooks + extension).
  assert.strictEqual(authorize({ remoteAddress: '127.0.0.1', url: u('/'), headers: {} }, TOKEN).ok, true);
  // LAN without credentials -> denied.
  assert.strictEqual(authorize({ remoteAddress: '192.168.1.20', url: u('/'), headers: {} }, TOKEN).ok, false);
  // Query token -> allowed, cookie set, token stripped from the redirect URL.
  const q = authorize({ remoteAddress: '192.168.1.20', url: u(`/?from=2026-07-01&token=${TOKEN}`), headers: {} }, TOKEN);
  assert.strictEqual(q.ok, true);
  assert.match(q.setCookie, /mp_token=.*HttpOnly/);
  assert.strictEqual(q.redirect, '/?from=2026-07-01');
  // Bearer and cookie both work; wrong values don't.
  assert.strictEqual(authorize({ remoteAddress: '10.0.0.5', url: u('/api/entries'), headers: { authorization: `Bearer ${TOKEN}` } }, TOKEN).ok, true);
  assert.strictEqual(authorize({ remoteAddress: '10.0.0.5', url: u('/api/entries'), headers: { cookie: `x=1; mp_token=${TOKEN}` } }, TOKEN).ok, true);
  assert.strictEqual(authorize({ remoteAddress: '10.0.0.5', url: u('/api/entries'), headers: { cookie: 'mp_token=' + 'b'.repeat(32) } }, TOKEN).ok, false);
  assert.strictEqual(authorize({ remoteAddress: '10.0.0.5', url: u(`/?token=${'b'.repeat(32)}`), headers: {} }, TOKEN).ok, false);

  // Integration: token-enabled server still serves loopback without auth,
  // and never leaks secrets through the config API.
  store.writeConfig({ ...store.readConfig(), serveToken: TOKEN, sendgridApiKey: 'SG.secret' });
  const server = createServer({ token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.strictEqual((await fetch(base + '/api/entries')).status, 200);
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.ok(!('serveToken' in cfg) && !('sendgridApiKey' in cfg));
  } finally {
    server.close();
  }
});

test('dashboard server: entries, override, capture API', async () => {
  const { createServer } = require('../src/server');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Set a rate first so reviewing an entry snapshots a meaningful rate.
    store.writeConfig({ ...store.readConfig(), rate: 100 });
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /Matterproof/);

    // Capture a manual event through the API, then see it in entries.
    const logRes = await fetch(base + '/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'manual', minutes: 30, description: 'API-captured research', client: 'Acme' }),
    });
    assert.strictEqual(logRes.status, 200);
    const data = await (await fetch(base + '/api/entries')).json();
    const entry = data.entries.find((e) => e.description === 'API-captured research');
    assert.ok(entry);
    assert.strictEqual(entry.reviewed, false);

    // Review it via override and confirm it sticks.
    await fetch(base + '/api/override', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: entry.id, reviewed: true, hours: 0.4 }),
    });
    const after = await (await fetch(base + '/api/entries')).json();
    const reviewed = after.entries.find((e) => e.id === entry.id);
    assert.strictEqual(reviewed.reviewed, true);
    assert.strictEqual(reviewed.hours, 0.4);

    const ledes = await (await fetch(base + '/export.ledes')).text();
    assert.match(ledes, /^LEDES1998B\[\]/);

    const bad = await fetch(base + '/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"nope":1}',
    });
    assert.strictEqual(bad.status, 400);

    // Payment loop over HTTP: link from reviewed entries -> listed -> paid.
    store.writeConfig({ ...store.readConfig(), lawpayPageUrl: 'https://secure.lawpay.com/pages/t/operating', rate: 100 });
    const linkRes = await fetch(base + '/api/lawpay/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'Acme' }),
    });
    assert.strictEqual(linkRes.status, 200);
    const link = await linkRes.json();
    assert.ok(link.url.startsWith('https://secure.lawpay.com/pages/t/operating?'));
    assert.ok(link.included >= 1);
    const reqData = await (await fetch(base + '/api/requests')).json();
    const listed = reqData.requests.find((r) => r.reference === link.reference);
    assert.ok(listed && !listed.paid);
    assert.strictEqual(reqData.outstandingCents >= link.amountCents, true);
    const paidRes = await fetch(base + '/api/requests/paid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: link.reference }),
    });
    assert.strictEqual(paidRes.status, 200);
    const after2 = await (await fetch(base + '/api/requests')).json();
    assert.strictEqual(after2.requests.find((r) => r.reference === link.reference).paid, true);
    // Second link for the same entries: everything is already billed.
    const again = await fetch(base + '/api/lawpay/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'Acme' }),
    });
    assert.strictEqual(again.status, 400);
  } finally {
    server.close();
  }
});

test('CLI end to end: log -> status -> report', () => {
  const bin = path.resolve(__dirname, '..', 'bin', 'billable.js');
  const env = { ...process.env };
  const run = (args, input) =>
    execFileSync('node', [bin, ...args], { env, input, encoding: 'utf8' });

  const day = new Date().toISOString().slice(0, 10);
  run(['log'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cli1', prompt: 'draft a motion' }));
  run(['log'], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'cli1', tool_name: 'Write' }));
  run(['log'], JSON.stringify({ hook_event_name: 'Stop', session_id: 'cli1' }));
  run(['add', '--minutes', '18', '--desc', 'Claude chat: legal research', '--client', 'Acme', '--date', day]);

  const status = run(['status']);
  assert.match(status, /entries/);

  const report = run(['report']);
  assert.match(report, /draft a motion/);
  assert.match(report, /legal research/);

  const csv = run(['report', '--format', 'csv']);
  assert.match(csv, /date,client,matter,activity_code/);

  const html = run(['report', '--format', 'html']);
  assert.match(html, /Statement of AI-Assisted Services/);

  const ledes = run(['report', '--format', 'ledes']);
  assert.match(ledes, /^LEDES1998B\[\]/);

  const malformed = run(['log'], 'not json'); // must not throw
  assert.strictEqual(malformed, '');

  // Privacy mode: prompt text stays out of the ledger.
  run(['config', 'capturePrompts', 'false']);
  run(['log'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cli2', prompt: 'SECRET CLIENT FACTS' }));
  run(['config', 'capturePrompts', 'true']);
  const ledger = fs.readFileSync(path.join(process.env.BILLABLE_HOME, 'ledger.jsonl'), 'utf8');
  assert.ok(!ledger.includes('SECRET CLIENT FACTS'));
});

test('server hardening: Host allowlist, fetch-metadata checks, JSON-only POSTs', async () => {
  const { createServer } = require('../src/server');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Raw helper: fetch() forbids setting Host/Origin/Sec-Fetch-* headers,
  // which are exactly the ones an attacker can't control either.
  const raw = (headers, method = 'GET', path = '/', body) => new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  try {
    // DNS rebinding: a Host that isn't loopback is refused even from 127.0.0.1.
    assert.strictEqual((await raw({ host: 'evil.example' })).status, 403);
    assert.strictEqual((await raw({ host: `localhost:${server.address().port}` })).status, 200);
    // Cross-site pages are refused; loopback origins are not.
    assert.strictEqual((await raw({ 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.strictEqual((await raw({ 'sec-fetch-site': 'same-site' })).status, 403);
    assert.strictEqual((await raw({ origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await raw({ origin: 'null' })).status, 403);
    assert.strictEqual((await raw({ origin: base })).status, 200);
    // POSTs must be JSON: browsers won't send that cross-origin without a
    // preflight this server never answers (kills drive-by form/fetch CSRF).
    assert.strictEqual(
      (await raw({ 'content-type': 'text/plain' }, 'POST', '/api/override', '{"id":"x"}')).status, 415);
    assert.strictEqual(
      (await raw({ 'content-type': 'application/x-www-form-urlencoded' }, 'POST', '/api/config', 'rate=1')).status, 415);
    assert.strictEqual(
      (await raw({}, 'POST', '/api/override', '{"id":"x"}')).status, 415);
  } finally {
    server.close();
  }
});

test('API validation: override hours bounded, log minutes capped, config numerics finite', async () => {
  const { createServer } = require('../src/server');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    // /api/override: hours must be a finite number in [0, 24] (issue #6).
    assert.strictEqual((await post('/api/override', { id: 'x', hours: 'abc' })).status, 400);
    assert.strictEqual((await post('/api/override', { id: 'x', hours: -5 })).status, 400);
    assert.strictEqual((await post('/api/override', { id: 'x', hours: 99999 })).status, 400);
    assert.strictEqual((await post('/api/override', { id: 'x', hours: 25 })).status, 400);
    const ok = await post('/api/override', { id: 'x', hours: 1.5, reviewed: 1 });
    assert.strictEqual(ok.status, 200);
    const okOverride = (await ok.json()).override;
    assert.strictEqual(okOverride.reviewed, true); // booleans coerced
    assert.strictEqual(okOverride.hours, 1.5);
    assert.strictEqual(typeof okOverride.rateSnapshot, 'number'); // rate frozen at review time
    // /api/log: manual minutes in (0, 960]; NaN and 1e9 rejected.
    assert.strictEqual((await post('/api/log', { type: 'manual', minutes: 1e9, description: 'x' })).status, 400);
    assert.strictEqual((await post('/api/log', { type: 'manual', minutes: 'abc', description: 'x' })).status, 400);
    assert.strictEqual((await post('/api/log', { type: 'manual', minutes: -3, description: 'x' })).status, 400);
    // /api/config: numerics must be finite and non-negative.
    assert.strictEqual((await post('/api/config', { rate: 'abc' })).status, 400);
    assert.strictEqual((await post('/api/config', { rate: -100 })).status, 400);
    assert.strictEqual((await post('/api/config', { rate: 0 })).status, 200);
    // lawpayPageUrl must be https (payment-page swap hardening, issue #5).
    assert.strictEqual((await post('/api/config', { lawpayPageUrl: 'http://evil.example/pay' })).status, 400);
    assert.strictEqual((await post('/api/config', { lawpayPageUrl: 'https://secure.lawpay.com/pages/t/operating' })).status, 200);
  } finally {
    server.close();
  }
});

test('applyOverride ignores non-finite/negative hours (defense in depth)', () => {
  const { entryId } = require('../src/entries');
  const config = { ...store.DEFAULT_CONFIG, rate: 100 };
  const events = [
    { ts: '2026-07-15T10:00:00.000Z', type: 'prompt', session: 's-nan', detail: 'x' },
    { ts: '2026-07-15T10:06:00.000Z', type: 'stop', session: 's-nan' },
  ];
  const id = entryId('s-nan', '2026-07-15T10:00:00.000Z');
  // #17: an AI entry is non-billable until confirmed — hours default to zero.
  const plain = buildEntries(events, config)[0];
  assert.strictEqual(plain.hours, 0);
  assert.strictEqual(plain.confirmed, false);
  assert.strictEqual(plain.amount, 0);
  // A poisoned override (hand-edited file, old bug) must not confirm the entry
  // or mint a NaN/negative amount: an invalid hours value is ignored, so the
  // entry stays unconfirmed and unbilled.
  for (const bad of ['abc', -5, NaN]) {
    const e = buildEntries(events, config, { [id]: { hours: bad } })[0];
    assert.strictEqual(e.hours, 0);
    assert.strictEqual(e.confirmed, false);
    assert.strictEqual(e.amount, 0);
  }
  // A VALID confirmation prices exactly.
  const good = buildEntries(events, config, { [id]: { hours: 0.1 } })[0];
  assert.strictEqual(good.hours, 0.1);
  assert.strictEqual(good.amount, 10);
});

test('ledger files and data directory are written owner-only (0600/0700)', () => {
  store.writeConfig(store.readConfig());
  store.appendEvent({ ts: '2026-07-15T10:00:00Z', type: 'manual', minutes: 5, description: 'perm check' });
  store.writeOverride('perm-check', { reviewed: true });
  if (process.platform !== 'win32') {
    for (const f of [store.configPath(), store.ledgerPath(), store.overridesPath()]) {
      assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, f);
    }
    assert.strictEqual(fs.statSync(store.homeDir()).mode & 0o777, 0o700);
  }
});

test('config CLI masks secrets unless --reveal', () => {
  const bin = path.resolve(__dirname, '..', 'bin', 'billable.js');
  const env = { ...process.env };
  const run = (args) => execFileSync('node', [bin, ...args], { env, encoding: 'utf8' });

  // Setting a secret does not echo the value back.
  assert.ok(!run(['config', 'sendgridApiKey', 'SG.supersecret-test']).includes('SG.supersecret-test'));
  assert.ok(!run(['config', 'serveToken', 'tok-secret-test']).includes('tok-secret-test'));
  // The full dump and single-key reads are masked...
  const dump = run(['config']);
  assert.ok(!dump.includes('SG.supersecret-test'));
  assert.ok(!dump.includes('tok-secret-test'));
  assert.match(dump, /--reveal/);
  assert.ok(!run(['config', 'sendgridApiKey']).includes('SG.supersecret-test'));
  // ...unless explicitly revealed. Values are really stored (not lost).
  assert.match(run(['config', '--reveal']), /SG\.supersecret-test/);
  assert.match(run(['config', 'serveToken', '--reveal']), /tok-secret-test/);
  // Non-secret values still print in full.
  assert.match(run(['config', 'rate']), /\d/);
});

// --- tamper-evident audit chains (@elias/audit wiring) ---
require('./audit.test.js')(test);

// --- Phase 4 (#23): confirmed-minutes billing, reviewed-only exports,
//     mutually-exclusive billed marker, LEDES units, capturePrompts, JSONL,
//     Clio OAuth hardening ---
require('./phase4.test.js')(test);

process.on('exit', () => {
  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
});
