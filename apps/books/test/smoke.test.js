// End-to-end smoke test: boots the server against a temp data dir and
// exercises every API route. Run with `npm test`.
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

delete process.env.PLAID_CLIENT_ID;
delete process.env.PLAID_SECRET;

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-test-'));
process.env.QUICKBUCKS_NO_SEED = '1';
// Most route checks below run with auth explicitly disabled; the auth section
// flips it on and exercises the real login/session path.
process.env.QUICKBUCKS_DISABLE_AUTH = '1';

const { server, HOST } = require('../server');
const authLib = require('../lib/auth');

let BASE;

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  await new Promise(resolve => server.listen(0, resolve));
  BASE = `http://localhost:${server.address().port}`;
  let passed = 0;
  const check = (name, cond) => {
    assert.ok(cond, name);
    passed++;
    console.log('  ✓', name);
  };

  // settings
  let r = await req('GET', '/api/settings');
  check('GET settings', r.status === 200 && r.data.currency === 'USD');
  r = await req('PUT', '/api/settings', { companyName: 'Test Co' });
  check('PUT settings', r.data.companyName === 'Test Co');

  // customers
  r = await req('POST', '/api/customers', { name: '' });
  check('rejects empty customer name', r.status === 400);
  r = await req('POST', '/api/customers', { name: 'Alice', company: 'Acme', email: 'a@acme.com' });
  check('creates customer', r.status === 201 && r.data.id);
  const customer = r.data;

  // invoices
  r = await req('POST', '/api/invoices', { customerId: 'nope', date: '2026-01-01', items: [{ description: 'x', qty: 1, rate: 5 }] });
  check('rejects invoice with bad customer', r.status === 400);
  r = await req('POST', '/api/invoices', { customerId: customer.id, date: '2026-01-01', items: [] });
  check('rejects invoice with no items', r.status === 400);
  r = await req('POST', '/api/invoices', {
    customerId: customer.id, date: '2026-01-01', dueDate: '2026-01-31',
    items: [{ description: 'Consulting', qty: 10, rate: 150 }, { description: 'Setup fee', qty: 1, rate: 250 }]
  });
  check('creates invoice', r.status === 201 && r.data.number === 'INV-1001');
  check('computes total', r.data.total === 1750);
  check('overdue status derived from due date', r.data.status === 'overdue');
  const invoice = r.data;

  // payments
  r = await req('POST', `/api/invoices/${invoice.id}/payments`, { amount: 5000 });
  check('rejects overpayment', r.status === 400);
  r = await req('POST', `/api/invoices/${invoice.id}/payments`, { amount: 1000, date: '2026-02-01', method: 'Check' });
  check('records partial payment', r.data.status === 'partial' && r.data.balance === 750);
  r = await req('POST', `/api/invoices/${invoice.id}/payments`, { amount: 750, date: '2026-02-10' });
  check('marks paid when balance reaches zero', r.data.status === 'paid' && r.data.balance === 0);

  // draft flow
  r = await req('POST', '/api/invoices', {
    customerId: customer.id, date: '2026-03-01', dueDate: '2026-03-31', draft: true,
    items: [{ description: 'Retainer', qty: 1, rate: 500 }]
  });
  check('creates draft', r.data.status === 'draft');
  r = await req('POST', `/api/invoices/${r.data.id}/send`, {});
  check('mark sent clears draft', r.data.status !== 'draft');

  // expenses
  r = await req('POST', '/api/expenses', { vendor: 'Staples', amount: -5, date: '2026-02-05' });
  check('rejects negative expense', r.status === 400);
  r = await req('POST', '/api/expenses', { vendor: 'Staples', category: 'Office Supplies', amount: 42.5, date: '2026-02-05' });
  check('creates expense', r.status === 201);
  const expense = r.data;
  r = await req('PUT', `/api/expenses/${expense.id}`, { amount: 50 });
  check('updates expense', r.data.amount === 50);

  // customer balances + delete protection
  r = await req('GET', '/api/customers');
  check('customer shows billed totals', r.data[0].totalBilled === 2250);
  r = await req('DELETE', `/api/customers/${customer.id}`);
  check('blocks deleting customer with invoices', r.status === 400);

  // reports
  r = await req('GET', '/api/reports/pnl?from=2026-02-01&to=2026-02-28');
  check('P&L income on cash basis', r.data.totalIncome === 1750);
  check('P&L expenses in range', r.data.totalExpenses === 50);
  check('P&L net profit', r.data.netProfit === 1700);
  r = await req('GET', '/api/reports/aging');
  check('aging totals open balances', typeof r.data.total === 'number');

  // dashboard
  r = await req('GET', '/api/dashboard');
  check('dashboard aggregates', r.data.totalIncome === 1750 && r.data.monthly.length === 6);

  // invoice detail
  r = await req('GET', `/api/invoices/${invoice.id}`);
  check('invoice detail includes customer and company', r.data.customer.name === 'Alice' && r.data.company.name === 'Test Co');

  // auth flow: default-closed setup, login throttling, session lifecycle.
  // (Runs against the same server; QUICKBUCKS_DISABLE_AUTH is flipped per check.)
  r = await req('GET', '/api/auth-status');
  check('auth off only by explicit opt-out', r.data.protected === false && r.data.authenticated === true && r.data.setupRequired === false);
  delete process.env.QUICKBUCKS_DISABLE_AUTH;
  r = await req('GET', '/api/auth-status');
  check('first run reports setup required', r.data.setupRequired === true && r.data.authenticated === false);
  r = await req('GET', '/api/customers');
  check('first run locks the API until a password exists', r.status === 401 && r.data.setupRequired === true);
  r = await req('POST', '/api/password', { next: 'abc' });
  check('rejects short password', r.status === 400);
  r = await req('POST', '/api/password', { next: 'secret123' });
  check('sets password', r.status === 200 && r.data.protected === true);
  r = await req('GET', '/api/customers');
  check('blocks API without session', r.status === 401);
  r = await req('GET', '/api/auth-status');
  check('auth-status stays public', r.status === 200 && r.data.protected === true);
  r = await req('POST', '/api/login', { password: 'wrong' });
  check('rejects wrong password', r.status === 401);
  for (let i = 0; i < 4; i++) await req('POST', '/api/login', { password: 'wrong' });
  r = await req('POST', '/api/login', { password: 'wrong' });
  check('rate-limits after 5 failed logins', r.status === 429);
  authLib._reset(); // clear the lockout (and stray sessions) for the happy path
  const loginRes = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'secret123' })
  });
  const session = loginRes.headers.get('set-cookie').split(';')[0];
  check('login sets session cookie', loginRes.status === 200 && session.startsWith('qb_session='));
  let authed = await fetch(BASE + '/api/audit?limit=30', { headers: { cookie: session } });
  const loginAudits = (await authed.json()).entries
    .filter(e => e.type === 'http.write' && e.payload.path === '/api/login')
    .map(e => e.payload);
  check('login attempts land in the audit chain',
    loginAudits.some(e => e.status === 401) && loginAudits.some(e => e.status === 429) && loginAudits.some(e => e.status === 200));
  authed = await fetch(BASE + '/api/customers', { headers: { cookie: session } });
  check('session grants API access', authed.status === 200);
  const settingsRes = await fetch(BASE + '/api/settings', { headers: { cookie: session } });
  const settingsData = await settingsRes.json();
  check('settings never leaks password hash', !('passwordHash' in settingsData) && settingsData.protected === true);

  // #17: changing the password invalidates every existing session
  const pwRes = await fetch(BASE + '/api/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: session },
    body: JSON.stringify({ current: 'secret123', next: 'secret456' })
  });
  const session2 = pwRes.headers.get('set-cookie').split(';')[0];
  check('password change mints a fresh session', pwRes.status === 200 && session2.startsWith('qb_session='));
  authed = await fetch(BASE + '/api/customers', { headers: { cookie: session } });
  check('password change kills the old session', authed.status === 401);
  authed = await fetch(BASE + '/api/customers', { headers: { cookie: session2 } });
  check('new session works after password change', authed.status === 200);

  // #17: server-side expiry — an idle session stops working on its own
  const sess2 = authLib._sessions.get(session2.split('=')[1]);
  sess2.lastSeen = Date.now() - authLib.SESSION_IDLE_MS - 1000;
  authed = await fetch(BASE + '/api/customers', { headers: { cookie: session2 } });
  check('idle sessions expire server-side', authed.status === 401);

  // #14: explicit opt-out opens the API but never the backup while a password exists
  process.env.QUICKBUCKS_DISABLE_AUTH = '1';
  authed = await fetch(BASE + '/api/customers');
  check('QUICKBUCKS_DISABLE_AUTH opens the API', authed.status === 200);
  authed = await fetch(BASE + '/api/backup');
  check('backup still gated while a password exists', authed.status === 401);
  const login2 = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'secret456' })
  });
  const session3 = login2.headers.get('set-cookie').split(';')[0];
  authed = await fetch(BASE + '/api/backup', { headers: { cookie: session3 } });
  check('backup downloads with a session', authed.status === 200);
  // remove password so remaining checks run unauthenticated
  await fetch(BASE + '/api/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: session3 },
    body: JSON.stringify({ current: 'secret456', next: '' })
  });
  r = await req('GET', '/api/customers');
  check('removing password reopens API', r.status === 200);

  // #16: malformed input answers 400/401, never takes the process down
  r = await req('GET', '/api/invoices/%E0%A4%A');
  check('malformed URL encoding gets 400', r.status === 400);
  authed = await fetch(BASE + '/api/customers', { headers: { cookie: 'qb_session=%E0%A4%A' } });
  check('malformed session cookie does not crash', authed.status === 200);
  r = await req('GET', '/api/auth-status');
  check('server healthy after malformed input', r.status === 200);
  check('server binds loopback by default', HOST === '127.0.0.1');

  // ---- banking: CSV import + review flow ----
  r = await req('GET', '/api/bank/status');
  check('bank starts unconfigured', r.data.configured === false && r.data.connections.length === 0);
  r = await req('POST', '/api/bank/link-token', {});
  check('link-token requires Plaid config', r.status === 400);
  r = await req('POST', '/api/bank/sync', {});
  check('sync requires a connection', r.status === 400);

  const csv = [
    'Date,Description,Amount',
    '07/01/2026,"COMCAST CABLE, INC.",-89.99',
    '2026-07-02,CLIENT WIRE ALVAREZ,2750.00',
    '07/03/2026,COFFEE SHOP,($4.50)',
    '07/01/2026,"COMCAST CABLE, INC.",-89.99',
    'bad row,,'
  ].join('\n');
  r = await req('POST', '/api/bank/import-csv', { csv, accountLabel: 'Test Checking' });
  check('CSV import parses quoted/paren/US-date rows', r.data.added === 3 && r.data.duplicates === 1 && r.data.skipped === 1);
  r = await req('POST', '/api/bank/import-csv', { csv });
  check('re-import skips all as duplicates', r.data.added === 0 && r.data.duplicates === 4);

  r = await req('GET', '/api/bank/transactions?status=new');
  check('review feed lists imported rows', r.data.length === 3 && r.data[0].accountName === 'Test Checking');
  const comcast = r.data.find(t => t.name.startsWith('COMCAST'));
  const wire = r.data.find(t => t.name.includes('ALVAREZ'));
  const coffee = r.data.find(t => t.name === 'COFFEE SHOP');
  check('CSV signs preserved', comcast.amount === -89.99 && wire.amount === 2750);

  r = await req('POST', `/api/bank/transactions/${comcast.id}/expense`, { category: 'Utilities' });
  check('outflow becomes an expense', r.status === 200 && r.data.expense.amount === 89.99 && r.data.transaction.status === 'added');
  r = await req('GET', '/api/expenses');
  check('bank expense appears in expenses', r.data.some(e => e.id && e.vendor.startsWith('COMCAST')));
  r = await req('POST', `/api/bank/transactions/${wire.id}/expense`, {});
  check('inflow rejected as expense', r.status === 400);
  r = await req('POST', `/api/bank/transactions/${wire.id}/match`, { invoiceId: 'nope' });
  check('match requires valid invoice', r.status === 400);
  const invoicesNow = (await req('GET', '/api/invoices')).data;
  const retainer = invoicesNow.find(i => i.balance === 500);
  r = await req('POST', `/api/bank/transactions/${wire.id}/match`, { invoiceId: retainer.id });
  check('deposit larger than balance rejected', r.status === 400);
  r = await req('POST', `/api/bank/transactions/${coffee.id}/exclude`, {});
  check('exclude works', r.data.status === 'excluded');
  r = await req('POST', `/api/bank/transactions/${coffee.id}/restore`, {});
  check('restore works', r.data.status === 'new');

  // ---- banking: Plaid flow against a mock server ----
  const mockPlaid = http.createServer((mreq, mres) => {
    let body = '';
    mreq.on('data', c => body += c);
    mreq.on('end', () => {
      const send = o => { mres.writeHead(200, { 'Content-Type': 'application/json' }); mres.end(JSON.stringify(o)); };
      if (mreq.url === '/link/token/create') send({ link_token: 'link-mock-123' });
      else if (mreq.url === '/item/public_token/exchange') send({ access_token: 'access-mock-1', item_id: 'item-1' });
      else if (mreq.url === '/accounts/get') send({ accounts: [{ account_id: 'acc-1', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking', balances: { current: 5230.5 } }] });
      else if (mreq.url === '/transactions/sync') send({
        added: [
          { transaction_id: 'pt-1', account_id: 'acc-1', date: '2026-06-20', name: 'STAPLES STORE 112', merchant_name: 'Staples', amount: 84.12, pending: false, personal_finance_category: { primary: 'GENERAL_MERCHANDISE' } },
          { transaction_id: 'pt-2', account_id: 'acc-1', date: '2026-06-22', name: 'ACH DEPOSIT RAMAN', amount: -500, pending: false }
        ],
        modified: [], removed: [], next_cursor: 'cursor-1', has_more: false
      });
      else if (mreq.url === '/item/remove') send({ removed: true });
      else { mres.writeHead(404); mres.end('{}'); }
    });
  });
  await new Promise(resolve => mockPlaid.listen(0, resolve));
  process.env.QUICKBUCKS_PLAID_BASE_URL = `http://localhost:${mockPlaid.address().port}`;

  r = await req('PUT', '/api/bank/config', { clientId: 'test-client', secret: 'test-secret', env: 'sandbox' });
  check('saves Plaid config', r.status === 200 && r.data.configured === true);
  r = await req('GET', '/api/settings');
  check('settings never leaks Plaid keys', !('plaid' in r.data));
  r = await req('POST', '/api/bank/link-token', {});
  check('creates link token', r.data.link_token === 'link-mock-123');
  r = await req('POST', '/api/bank/exchange', { public_token: 'public-mock', institution: 'Mock Bank' });
  check('exchange stores connection without token', r.status === 201 && r.data.institution === 'Mock Bank' && !('accessToken' in r.data));
  check('connection has account balances', r.data.accounts[0].balance === 5230.5);
  const connId = r.data.id;
  r = await req('POST', '/api/bank/sync', {});
  check('sync pulls transactions', r.data.added === 2 && r.data.errors.length === 0);
  r = await req('GET', '/api/bank/transactions?status=new');
  const staples = r.data.find(t => t.plaidId === 'pt-1');
  const deposit = r.data.find(t => t.plaidId === 'pt-2');
  check('Plaid signs normalized (out negative, in positive)', staples.amount === -84.12 && deposit.amount === 500);
  check('account name resolved', staples.accountName === 'Mock Bank Checking ••1234');
  r = await req('POST', '/api/bank/sync', {});
  check('re-sync does not duplicate', r.data.added === 0);
  r = await req('POST', `/api/bank/transactions/${deposit.id}/match`, { invoiceId: retainer.id });
  check('deposit matches invoice to paid', r.data.invoice.status === 'paid' && r.data.transaction.status === 'matched');
  r = await req('DELETE', `/api/bank/connections/${connId}`);
  check('disconnect removes connection', r.status === 200);
  r = await req('GET', '/api/bank/status');
  check('status reflects disconnect', r.data.connections.length === 0);
  mockPlaid.close();

  // ---- payroll ----
  r = await req('GET', '/api/payroll/settings');
  check('payroll rates default to zero', r.data.njEmployerUiRate === 0);
  r = await req('POST', '/api/payroll/employees', { firstName: 'Pat', lastName: '' });
  check('employee requires full name', r.status === 400);
  r = await req('POST', '/api/payroll/employees', {
    firstName: 'Pat', lastName: 'Salaried', payType: 'salary', annualSalary: 104000,
    payFrequency: 'biweekly',
    fed: { filingStatus: 'single' }, nj: { rateTable: 'A' }
  });
  check('creates employee', r.status === 201);
  const emp1 = r.data;
  r = await req('POST', '/api/payroll/runs', { payDate: '2026-06-19', periodStart: '2026-06-06', periodEnd: '2026-06-19' });
  check('run blocked until employer rates set', r.status === 400);
  r = await req('PUT', '/api/payroll/settings', { njEmployerUiRate: 0.031, njEmployerTdiRate: 0.005 });
  check('saves employer rates', r.status === 200);

  r = await req('POST', '/api/payroll/runs', { payDate: '2026-06-19', periodStart: '2026-06-06', periodEnd: '2026-06-19' });
  check('creates draft run with computed checks', r.status === 201 && r.data.status === 'draft' && r.data.checks.length === 1);
  const run1 = r.data;
  const chk1 = run1.checks[0].computed;
  check('run matches engine hand-computed values', chk1.gross === 4000 && chk1.fit === 540.38 && chk1.njSit === 190.77);

  r = await req('PUT', `/api/payroll/runs/${run1.id}`, {
    checks: [{ employeeId: emp1.id, inputs: { bonus: 500 } }]
  });
  check('editing inputs recomputes', r.data.checks[0].computed.gross === 4500);
  r = await req('PUT', `/api/payroll/runs/${run1.id}`, {
    checks: [{ employeeId: emp1.id, inputs: { bonus: 0 } }]
  });
  check('inputs reset', r.data.checks[0].computed.gross === 4000);

  const expensesBefore = (await req('GET', '/api/expenses')).data.length;
  r = await req('POST', `/api/payroll/runs/${run1.id}/finalize`, {});
  check('finalizes run', r.data.status === 'finalized' && r.data.postedExpenseId);
  const netPay = r.data.totals.net;
  const expensesAfter = (await req('GET', '/api/expenses')).data;
  const payrollExp = expensesAfter.find(e => e.id === r.data.postedExpenseId);
  check('finalize posts net pay to books', expensesAfter.length === expensesBefore + 1 &&
    payrollExp.amount === netPay && payrollExp.category === 'Payroll' && payrollExp.date === '2026-06-19');
  r = await req('POST', `/api/payroll/runs/${run1.id}/finalize`, {});
  check('cannot finalize twice', r.status === 400);
  r = await req('DELETE', `/api/payroll/runs/${run1.id}`);
  check('cannot delete finalized run', r.status === 400);
  r = await req('DELETE', `/api/payroll/employees/${emp1.id}`);
  check('cannot delete employee with paychecks', r.status === 400);

  // liabilities: hand-computed from the engine values above
  r = await req('GET', '/api/payroll/liabilities');
  const bucket = key => r.data.buckets.find(b => b.bucket === key);
  check('federal 941 liability accrued', bucket('federal_941').balance === 540.38 + 248 + 58 + 248 + 58);
  check('NJ GIT liability accrued', bucket('nj_git').balance === 190.77);
  check('NJ DOL liability accrued', bucket('nj_dol').balance === Math.round((17 + 7.6 + 9.2 + 124 + 20) * 100) / 100);
  check('FUTA liability accrued', bucket('futa').balance === 24);

  r = await req('POST', '/api/payroll/liabilities/deposit', { bucket: 'federal_941', amount: 5000, date: '2026-06-22' });
  check('over-deposit rejected', r.status === 400);
  r = await req('POST', '/api/payroll/liabilities/deposit', { bucket: 'federal_941', amount: 1152.38, date: '2026-06-22', note: 'EFTPS #123' });
  check('deposit books expense and clears balance', r.status === 200 &&
    r.data.expense.category === 'Payroll Taxes' &&
    r.data.buckets.find(b => b.bucket === 'federal_941').balance === 0);

  // YTD caps flow through opening balances
  r = await req('POST', '/api/payroll/employees', {
    firstName: 'Casey', lastName: 'Capped', payType: 'salary', annualSalary: 104000,
    payFrequency: 'biweekly', fed: { filingStatus: 'single' }, nj: { rateTable: 'A' },
    ytdOpening: { year: 2026, ssWages: 183000, medicareWages: 183000, futaWages: 7000, njUiWages: 44800, njTdiWages: 100000 }
  });
  const emp2 = r.data;
  r = await req('POST', '/api/payroll/runs', { payDate: '2026-07-03', periodStart: '2026-06-20', periodEnd: '2026-07-03' });
  const chk2 = r.data.checks.find(c => c.employeeId === emp2.id).computed;
  check('opening YTD caps Social Security', chk2.ssTaxable === 1500);
  check('opening YTD zeroes FUTA and NJ UI', chk2.futaTaxable === 0 && chk2.njUiTaxable === 0);
  const chk1b = r.data.checks.find(c => c.employeeId === emp1.id).computed;
  check('prior finalized run feeds YTD', chk1b.gross === 4000);
  const run2id = r.data.id;
  r = await req('DELETE', `/api/payroll/runs/${run2id}`);
  check('draft run deletable', r.status === 200);

  r = await req('POST', '/api/payroll/runs', { payDate: '2031-01-09', periodStart: '2030-12-27', periodEnd: '2031-01-09' });
  check('unknown tax year rejected', r.status === 400 && /No tax tables/.test(r.data.error));

  // ---- multi-company + household taxes ----
  r = await req('GET', '/api/companies');
  check('one company by default, active', r.data.length === 1 && r.data[0].active === true);
  const company1 = r.data[0];
  r = await req('POST', '/api/companies', { name: 'Second LLC' });
  check('creates second company', r.status === 201 && r.data.id);
  const company2 = r.data;
  r = await req('POST', `/api/companies/${company2.id}/select`, {});
  check('company select works', r.status === 200);

  const asCompany2 = (method, url, body) => fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: `qb_company=${company2.id}` },
    body: body ? JSON.stringify(body) : undefined
  }).then(async res2 => ({ status: res2.status, data: await res2.json().catch(() => ({})) }));

  r = await asCompany2('GET', '/api/expenses');
  check('second company starts with empty books', r.data.length === 0);
  r = await asCompany2('POST', '/api/expenses', { vendor: 'Espresso Machines Inc', category: 'Other', amount: 8000, date: '2026-05-01' });
  check('expense lands in second company', r.status === 201);
  const c1Expenses = (await req('GET', '/api/expenses')).data;
  check('first company books unaffected (isolation)', !c1Expenses.some(e => e.vendor === 'Espresso Machines Inc'));
  r = await asCompany2('GET', '/api/payroll/employees');
  check('payroll is per-company', r.data.length === 0);

  r = await req('PUT', '/api/household/tax-profile', {
    filingStatus: 'married_jointly', wages: 50000, fedWithholding: 6000,
    companySstb: { [company1.id]: true }
  });
  check('saves household tax profile', r.status === 200 && r.data.filingStatus === 'married_jointly');
  r = await req('PUT', '/api/household/tax-profile', { filingStatus: 'married_separately' });
  check('rejects unknown filing status', r.status === 400);

  r = await req('GET', '/api/household/tax');
  check('household tax aggregates all companies', r.data.companies.length === 2);
  const c1Tax = r.data.companies.find(c => c.id === company1.id);
  const c2Tax = r.data.companies.find(c => c.id === company2.id);
  check('SSTB flag round-trips', c1Tax.sstb === true && c2Tax.sstb === false);
  check('second company net profit reflects its expense', c2Tax.ytd.netProfit === -8000);
  check('W-2 wages from payroll feed QBI data', c1Tax.w2Wages > 0);
  check('baseline is a full 1040 estimate', typeof r.data.baseline.totalTax === 'number' && r.data.baseline.deduction === 32200);
  const baselineTax = r.data.baseline.totalTax;

  r = await req('POST', '/api/household/scenario', {
    adjustments: { companies: { [company1.id]: { expenseDelta: 20000 } } }
  });
  check('expense scenario lowers the tax bill', r.data.scenario.totalTax < baselineTax && r.data.delta.totalTax < 0);
  check('scenario leaves the books untouched',
    (await req('GET', '/api/household/tax')).data.baseline.totalTax === baselineTax);

  // ---- deposit calendar + NACHA files ----
  r = await req('GET', '/api/payroll/deposits?year=2026');
  const fedJune = r.data.federal.find(g => g.key === '2026-06');
  check('deposit calendar groups the finalized run', fedJune && fedJune.amount === 1152.38 && fedJune.due === '2026-07-15');
  check('ACH starts unconfigured', r.data.achConfigured === false);
  r = await fetch(BASE + `/api/payroll/nacha/tax?bucket=federal_941&key=2026-06&year=2026`);
  check('NACHA blocked without ACH config', r.status === 400);

  r = await req('PUT', '/api/payroll/settings', {
    depositSchedule: 'monthly', njPayerType: 'quarterly', ein: '12-3456789', njTaxpayerId: '123456789000',
    ach: { bankRouting: '021200339', bankAccount: '999888', immediateDestination: '021200339', immediateOrigin: '1123456789', destinationName: 'TD BANK' },
    njAch: { routing: '031207607', account: '12345678' }
  });
  check('saves ACH + schedule settings', r.status === 200 && r.data.depositSchedule === 'monthly');

  let ach = await fetch(BASE + `/api/payroll/nacha/tax?bucket=federal_941&key=2026-06&year=2026`);
  check('federal 941 NACHA file downloads', ach.status === 200 &&
    (ach.headers.get('content-disposition') || '').includes('ach-federal_941'));
  let achBody = await ach.text();
  let achLines = achBody.trim().split('\n');
  check('NACHA file well-formed (94-char lines, full blocks)',
    achLines.length % 10 === 0 && achLines.every(l => l.length === 94));
  check('941 file pays the Treasury with a TXP addenda',
    achLines[2].startsWith('622061036000') && achLines[3].startsWith('705TXP*123456789*94105*'));

  ach = await fetch(BASE + `/api/payroll/nacha/tax?bucket=nj_git&key=2026-Q2&year=2026`);
  check('NJ GIT NACHA file uses the NJ TXP addendum', ach.status === 200 &&
    (await ach.text()).includes('TXP*B123456789000*01130*260630*T*'));

  r = await req('POST', '/api/payroll/employees', {
    firstName: 'Direct', lastName: 'NoBank', payType: 'salary', annualSalary: 60000,
    payFrequency: 'biweekly', paymentMethod: 'direct_deposit',
    fed: { filingStatus: 'single' }, nj: { rateTable: 'A' }
  });
  check('direct deposit requires bank details', r.status === 400);
  ach = await fetch(BASE + `/api/payroll/runs/${run1.id}/nacha`);
  check('PPD blocked when no employee has direct deposit', ach.status === 400);
  r = await req('PUT', `/api/payroll/employees/${emp1.id}`, {
    paymentMethod: 'direct_deposit', bankRouting: '031207607', bankAccount: '11122233', bankAccountType: 'checking'
  });
  check('employee switched to direct deposit', r.status === 200);
  ach = await fetch(BASE + `/api/payroll/runs/${run1.id}/nacha`);
  achBody = await ach.text();
  achLines = achBody.trim().split('\n');
  check('PPD direct-deposit file for the finalized run', ach.status === 200 &&
    achLines.every(l => l.length === 94) && achLines[1].includes('PPD') && achLines[2].startsWith('622031207607'));

  r = await req('POST', '/api/payroll/liabilities/deposit', { bucket: 'nj_git', periodKey: '2026-Q2', amount: 190.77, date: '2026-07-01' });
  check('deposit records against the obligation', r.status === 200);
  r = await req('GET', '/api/payroll/deposits?year=2026');
  const njQ2 = r.data.njGit.find(g => g.key === '2026-Q2');
  check('calendar shows the obligation as paid', njQ2.paid === 190.77 && njQ2.outstanding === 0);
  ach = await fetch(BASE + `/api/payroll/nacha/tax?bucket=nj_git&key=2026-Q2&year=2026`);
  check('paid obligation refuses another ACH file', ach.status === 400);

  // ---- quarterly filings (941 / NJ-927 / WR-30 / 940) ----
  // Finalized run: 2026-06-19, gross 4000, fit 540.38, ss 248×2, medicare 58×2.
  r = await req('GET', '/api/payroll/filings?year=2026&quarter=2');
  const f941 = r.data.f941;
  check('941 headcount and wages from the finalized run', f941.l1Employees === 1 && f941.l2Wages === 4000);
  check('941 line 12 matches the deposit-calendar liability', f941.l12TotalAfterCredits === 1152.38 && f941.l7Fractions === 0);
  check('941 line 13 skips the deposit booked without a period key',
    f941.l13Deposits === 0 && f941.l13Unattributed === 1152.38 && f941.l14BalanceDue === 1152.38);
  check('941 monthly liability lands in June', f941.monthlyLiability[6] === 1152.38 && f941.monthlyLiability[5] === 0);
  const nj927 = r.data.nj927;
  check('NJ-927 GIT and contributions', nj927.gitWithheld === 190.77 &&
    nj927.contributions.amount === Math.round((17 + 7.6 + 9.2 + 124 + 20) * 100) / 100 &&
    nj927.totalDue === Math.round((190.77 + 177.8) * 100) / 100 && nj927.due === '2026-07-30');
  check('WR-30 lists the employee with gross and check count',
    r.data.wr30.length === 1 && r.data.wr30[0].gross === 4000 && r.data.wr30[0].checks === 1);
  check('940 annual FUTA figures', r.data.f940.l7TaxableFutaWages === 4000 && r.data.f940.l8FutaTax === 24);
  r = await req('GET', '/api/payroll/filings?year=2026&quarter=1');
  check('empty quarter returns zeroed forms', r.data.f941.l2Wages === 0 && r.data.wr30.length === 0);

  // ---- multi-year taxes + 1040-ES plan ----
  r = await req('GET', '/api/household/tax?year=2023');
  check('unsupported tax year rejected', r.status === 400);
  r = await req('GET', '/api/household/tax?year=2025');
  check('2025 estimate served', r.status === 200 && r.data.baseline.year === 2025 && r.data.baseline.deduction === 31500);
  check('past-year ES plan is closed', r.data.esPlan.yearClosed === true);
  r = await req('PUT', '/api/household/tax-profile', { year: 2024, wages: 88000, fedWithholding: 9000 });
  check('saves a 2024 profile', r.status === 200);
  r = await req('GET', '/api/household/tax?year=2024');
  check('2024 profile isolated to its year', r.data.profile.wages === 88000 && r.data.baseline.wages === 88000);
  r = await req('GET', '/api/household/tax');
  check('2026 profile untouched by 2024 edits', r.data.profile.wages === 50000);
  check('ES plan present with safe-harbor basis', typeof r.data.esPlan.required === 'number' && r.data.esPlan.quarters.length === 4);
  r = await req('POST', '/api/household/scenario', { year: 2025, adjustments: {} });
  check('scenarios run against a past year', r.data.baseline.year === 2025);

  // ---- Schedule Elias (rental portfolio + borrowing power) ----
  r = await req('POST', '/api/household/properties', {
    nickname: 'Maple Duplex', monthsInService: 12,
    acquisition: { purchasePrice: 220000, landAllocationPct: 25 },
    financing: { monthlyPI: 950, monthlyTaxes: 333.33, monthlyInsurance: 100 },
    operations: {
      annualGrossRent: 30000,
      annualExpenses: { mortgageInterest: 8000, taxes: 4000, insurance: 1200, repairs: 2000, managementFees: 1800 }
    },
    depreciation: { useComputedDefault: true, annualByStrategy: { aggressive: 12000 } }
  });
  check('adds rental property', r.status === 201 && r.data.id);
  const propId = r.data.id;
  r = await req('POST', '/api/household/properties', { nickname: '' });
  check('property requires a nickname', r.status === 400);

  r = await req('GET', '/api/household/tax');
  const seAnalysis = r.data.scheduleElias.analysis;
  check('worksheet figures flow through the API', seAnalysis.portfolio.perProperty[0].netRental === 800);
  check('rental net reaches the 1040 baseline', r.data.baseline.scheduleELine5 === 7000);
  const taxWithRental = r.data.baseline.totalTax;

  r = await req('PUT', '/api/household/schedule-elias', {
    settings: { depreciationStrategy: 'aggressive' },
    borrower: { monthlyW2Income: 8000, monthlyNonHousingDebts: 500, primaryResidencePITIA: 2000,
      proposedPurchase: { targetPrice: 400000, downPaymentPct: 20, ratePct: 6, termMonths: 360, monthlyTaxes: 400, monthlyInsurance: 100 } },
    seb: {}
  });
  check('saves Schedule Elias settings + borrower', r.status === 200 && r.data.settings.depreciationStrategy === 'aggressive');
  r = await req('GET', '/api/household/tax');
  check('aggressive strategy cuts tax-side rental income', r.data.baseline.scheduleELine5 === 1000);
  check('but lender-side net rental is unchanged (add-back)', r.data.scheduleElias.analysis.portfolio.positiveNetRental === 800);
  check('DTI and max purchase computed', r.data.scheduleElias.analysis.borrowing.proposed.backEndDTI > 0 &&
    r.data.scheduleElias.analysis.borrowing.maxPurchase.maxPrice > 0);
  check('aggressive strategy lowers total tax', r.data.baseline.totalTax < taxWithRental);

  r = await req('POST', '/api/household/scenario', { adjustments: { depreciationStrategy: 'balanced' } });
  check('scenario reports both tax and borrowing outcomes',
    r.data.scenario.totalTax > r.data.baseline.totalTax &&
    r.data.borrowing.baseline.grossMonthlyQualifying === r.data.borrowing.scenario.grossMonthlyQualifying);
  r = await req('POST', '/api/household/scenario', { adjustments: { depreciationStrategy: 'nope' } });
  check('rejects unknown strategy in scenarios', r.status === 400);

  r = await req('PUT', '/api/household/schedule-elias', { settings: { sec469Handling: 'bogus' } });
  check('rejects bad §469 handling', r.status === 400);
  r = await req('DELETE', `/api/household/properties/${propId}`);
  check('deletes property', r.status === 200);
  r = await req('GET', '/api/household/tax');
  check('empty portfolio contributes nothing', r.data.baseline.scheduleELine5 === 0);

  // ---- NJ-1040 estimate ----
  r = await req('PUT', '/api/household/tax-profile', { njWithholding: 2500, njDependents: 2, propertyTaxPaid: 9000 });
  check('saves NJ profile fields', r.status === 200 && r.data.njDependents === 2);
  r = await req('GET', '/api/household/tax');
  check('NJ-1040 estimate rides along', r.data.nj && typeof r.data.nj.tax === 'number' &&
    r.data.nj.exemptions === 5000 && r.data.nj.payments === 2500);
  check('NJ gross floors business losses per category', r.data.nj.businessNet >= 0 && r.data.nj.rentalNet >= 0);
  r = await req('POST', '/api/household/scenario', { adjustments: {} });
  check('scenario carries the NJ comparison', r.data.nj && r.data.nj.baseline.tax === r.data.nj.scenario.tax && r.data.delta.njTax === 0);

  // ---- Schedule Elias Phase 2 (MACRS, Form 8582, sell-vs-hold) ----
  r = await req('POST', '/api/household/properties', {
    nickname: 'MACRS Duplex', monthsInService: 12,
    acquisition: { purchasePrice: 220000, landAllocationPct: 25, placedInServiceDate: '2026-07-15' },
    financing: { monthlyPI: 950, monthlyTaxes: 333.33, monthlyInsurance: 100, loanBalance: 150000 },
    operations: { annualGrossRent: 30000, annualExpenses: { mortgageInterest: 8000, taxes: 4000, insurance: 1200, repairs: 2000, managementFees: 1800 } },
    phase2: { costSegComponents: { five: 20000, fifteen: 30000 } }
  });
  check('adds Phase 2 property', r.status === 201 && r.data.acquisition.placedInServiceDate === '2026-07-15');
  const p2id = r.data.id;
  r = await req('PUT', '/api/household/schedule-elias', { settings: { depreciationStrategy: 'balanced', sec469Handling: 'suspend' } });
  r = await req('GET', '/api/household/tax');
  check('MACRS mid-month drives the portfolio (2,750 year one)',
    r.data.scheduleElias.analysis.portfolio.perProperty.find(p => p.id === p2id).depreciation === 2750);
  r = await req('PUT', '/api/household/schedule-elias', { settings: { depreciationStrategy: 'aggressive' } });
  r = await req('GET', '/api/household/tax');
  check('aggressive strategy computes cost-seg bonus (51,916.67)',
    r.data.scheduleElias.analysis.portfolio.perProperty.find(p => p.id === p2id).depreciation === 51916.67);

  r = await req('PUT', '/api/household/schedule-elias', {
    settings: { sec469Handling: 'phase2', activeParticipation: true, reProfessional: false, suspendedCarryforward: 5000 }
  });
  check('saves Form 8582 settings', r.status === 200 && r.data.settings.sec469Handling === 'phase2');
  r = await req('GET', '/api/household/tax');
  const s469 = r.data.scheduleElias.analysis.sec469;
  check('Form 8582 resolution runs', s469 && s469.mode === 'phase2' && typeof s469.suspendedEnd === 'number');
  check('resolved line 5 feeds the baseline', r.data.baseline.scheduleELine5 === s469.line5);

  r = await req('POST', `/api/household/properties/${p2id}/sell-preview`, { salePrice: 300000, sellingCostsPct: 6 });
  check('sell-vs-hold preview computes the sale', r.status === 200 &&
    r.data.amountRealized === 282000 && typeof r.data.saleTax === 'number' && typeof r.data.netAfterTax === 'number');
  r = await req('POST', `/api/household/properties/${p2id}/sell-preview`, { salePrice: 0 });
  check('sell preview requires a price', r.status === 400);

  // reset so later sections see a clean portfolio
  await req('PUT', '/api/household/schedule-elias', { settings: { sec469Handling: 'suspend', depreciationStrategy: 'balanced', suspendedCarryforward: 0 } });
  r = await req('DELETE', `/api/household/properties/${p2id}`);
  check('Phase 2 property cleaned up', r.status === 200);

  // ---- NJ sales tax (trust-fund accounting) ----
  r = await req('PUT', '/api/settings', { salesTax: { enabled: true, ratePct: 6.625, monthlyRemitter: false } });
  check('enables sales tax on the company', r.status === 200);
  r = await req('POST', '/api/customers', { name: 'Cafe Walk-ins' });
  const cafeCust = r.data;
  r = await req('POST', '/api/invoices', {
    customerId: cafeCust.id, date: '2026-04-01', dueDate: '2026-04-01',
    items: [
      { description: 'Card sales (prepared food & drink)', qty: 1, rate: 1000, taxable: true },
      { description: 'Whole-bean retail', qty: 1, rate: 200 }
    ]
  });
  check('taxed invoice: subtotal 1,200 + tax 66.25', r.data.subtotal === 1200 && r.data.tax === 66.25 && r.data.total === 1266.25);
  const taxedInv = r.data;
  r = await req('POST', `/api/invoices/${taxedInv.id}/payments`, { amount: 1266.25, date: '2026-04-05' });
  check('payment settles the tax-inclusive total', r.data.status === 'paid');

  r = await req('GET', '/api/reports/pnl?from=2026-04-01&to=2026-04-30');
  check('P&L excludes collected sales tax from income', r.data.totalIncome === 1200);
  r = await req('GET', '/api/salestax?year=2026');
  check('sales tax ledger tracks the trust balance', r.data.collected === 66.25 && r.data.balance === 66.25);
  const q2st = r.data.schedule.find(e => e.key === '2026-Q2');
  check('ST-50 scheduled for the 20th after quarter end', q2st.type === 'ST-50' && q2st.due === '2026-07-20' && q2st.outstanding === 66.25);

  const expenseCountBefore = (await req('GET', '/api/expenses')).data.length;
  r = await req('POST', '/api/salestax/remit', { periodKey: '2026-Q2', amount: 66.25, date: '2026-07-14', note: 'NJ portal #ST123' });
  check('remittance clears the balance', r.data.summary.balance === 0);
  check('remittance is NOT booked as an expense', (await req('GET', '/api/expenses')).data.length === expenseCountBefore);
  r = await req('POST', '/api/salestax/remit', { amount: -5, periodKey: '2026-Q2' });
  check('rejects invalid remittance', r.status === 400);

  // ---- recurring invoices ----
  const invoicesBefore = (await req('GET', '/api/invoices')).data.length;
  r = await req('POST', '/api/recurring', {
    customerId: cafeCust.id,
    items: [{ description: 'Monthly retainer', qty: 1, rate: 1500 }],
    frequency: 'monthly', nextDate: '2026-05-10', termsDays: 30
  });
  check('creates recurring template', r.status === 201);
  const tplId = r.data.id;
  const invoicesAfter = (await req('GET', '/api/invoices')).data;
  const generated = invoicesAfter.filter(i => i.recurringId === tplId);
  check('past-due template caught up on original dates', generated.length === 3 &&
    generated.some(i => i.date === '2026-05-10') && generated.some(i => i.date === '2026-07-10'));
  check('invoice count grew by the generated periods', invoicesAfter.length === invoicesBefore + 3);
  r = await req('GET', '/api/recurring');
  check('template advanced past today', r.data[0].nextDate === '2026-08-10' && r.data[0].customerName === 'Cafe Walk-ins');
  const genCountBefore = (await req('GET', '/api/invoices')).data.length;
  check('generation is idempotent', (await req('GET', '/api/invoices')).data.length === genCountBefore);
  r = await req('PUT', `/api/recurring/${tplId}`, { active: false });
  check('template pauses', r.data.active === false);
  r = await req('DELETE', `/api/recurring/${tplId}`);
  check('template deletes', r.status === 200);
  r = await req('POST', '/api/recurring', { customerId: 'nope', items: [], nextDate: '2026-08-01' });
  check('template validation runs', r.status === 400);

  // ---- billable time tracking ----
  r = await req('POST', '/api/time', { customerId: 'nope', date: '2026-07-01', hours: 1, rate: 350, description: 'x' });
  check('time entry requires a real customer', r.status === 400);
  r = await req('POST', '/api/customers', { name: 'Litigation Client', company: 'BigCo Inc' });
  const timeCust = r.data;
  r = await req('POST', '/api/time', { customerId: timeCust.id, date: '2026-07-02', matter: 'Smith v. Jones', description: 'Hearing prep', hours: 2.5, rate: 350 });
  check('logs a time entry with computed amount', r.status === 201 && r.data.amount === 875 && r.data.status === 'unbilled');
  const timeE1 = r.data;
  r = await req('POST', '/api/time', { customerId: timeCust.id, date: '2026-07-01', matter: 'Smith v. Jones', description: 'Intake call', hours: 1.2, rate: 350 });
  const timeE2 = r.data;
  r = await req('POST', '/api/time', { customerId: timeCust.id, date: '2026-07-03', description: 'CLE webinar', hours: 1, rate: 0, billable: false });
  check('non-billable time tracked', r.status === 201 && r.data.status === 'non-billable');
  r = await req('GET', '/api/time/wip');
  const wipRow = r.data.find(g => g.customerId === timeCust.id);
  check('WIP totals the unbilled billable hours', wipRow && wipRow.hours === 3.7 && wipRow.amount === 1295 && wipRow.entries === 2);

  r = await req('POST', '/api/time/invoice', { customerId: timeCust.id });
  check('WIP converts to a draft invoice, one line per entry', r.status === 201 &&
    r.data.entriesBilled === 2 && r.data.items.length === 2 && r.data.total === 1295 &&
    r.data.status === 'draft' && r.data.items[0].description.includes('Intake call'));
  const timeInv = r.data;
  check('time lines are non-taxable (professional services)', timeInv.tax === 0);
  r = await req('GET', `/api/time?status=billed`);
  check('billed entries link to the invoice', r.data.length === 2 && r.data.every(t => t.invoiceId === timeInv.id));
  r = await req('PUT', `/api/time/${timeE1.id}`, { hours: 3 });
  check('billed entry cannot be edited', r.status === 400);
  r = await req('DELETE', `/api/time/${timeE2.id}`);
  check('billed entry cannot be deleted', r.status === 400);
  r = await req('POST', '/api/time/invoice', { customerId: timeCust.id });
  check('nothing left to bill after conversion', r.status === 400);
  r = await req('DELETE', `/api/invoices/${timeInv.id}`);
  check('deleting the invoice releases the time', r.status === 200 &&
    (await req('GET', '/api/time/wip')).data.find(g => g.customerId === timeCust.id).entries === 2);
  r = await req('POST', '/api/time/invoice', { customerId: timeCust.id, entryIds: [timeE1.id] });
  check('subset billing by entry ids', r.status === 201 && r.data.entriesBilled === 1 && r.data.total === 875);

  // ---- bank feed rules ----
  r = await req('POST', '/api/bank/rules', { match: 'comcast', category: 'Nope' });
  check('rule requires a real category', r.status === 400);
  r = await req('POST', '/api/bank/rules', { match: 'comcast', category: 'Utilities', vendor: 'Comcast' });
  check('creates bank rule', r.status === 201);
  r = await req('POST', '/api/bank/import-csv', {
    csv: 'Date,Description,Amount\n07/10/2026,COMCAST CABLE JULY,-89.99\n07/11/2026,MYSTERY VENDOR,-10.00',
    accountLabel: 'Rules test'
  });
  check('new statement rows imported', r.data.added === 2);
  r = await req('GET', '/api/bank/transactions?status=new');
  const comcastTxn = r.data.find(t => t.name === 'COMCAST CABLE JULY');
  check('feed annotates the rule match', comcastTxn.ruleMatch && comcastTxn.ruleMatch.category === 'Utilities');
  r = await req('POST', '/api/bank/apply-rules', {});
  check('apply-rules categorizes matching outflows', r.data.applied === 1);
  const ruleExp = (await req('GET', '/api/expenses')).data.find(e => e.vendor === 'Comcast' && e.amount === 89.99);
  check('rule-created expense uses the rule vendor/category', ruleExp && ruleExp.category === 'Utilities');
  r = await req('GET', '/api/bank/transactions?status=new');
  check('unmatched transactions stay in review', r.data.some(t => t.name === 'MYSTERY VENDOR'));

  // ---- Dripos imports: timecards into a pay run, daily sales into invoices ----
  r = await req('POST', '/api/payroll/employees', {
    firstName: 'Maya', lastName: 'Barista', email: 'jane@shop.com',
    payType: 'hourly', hourlyRate: 22, payFrequency: 'biweekly',
    fed: { filingStatus: 'single' }, nj: { rateTable: 'A' }
  });
  const empMaya = r.data;
  r = await req('POST', '/api/payroll/runs', { payDate: '2026-08-21', periodStart: '2026-08-08', periodEnd: '2026-08-21' });
  const importRun = r.data;
  const driposTimecards = 'Employee,Email,Date,Total Hours,Tips\n' +
    'Jane Doe,jane@shop.com,07/06/2026,8.5,41.25\n' +
    'Jane Doe,jane@shop.com,07/07/2026,9.0,38.00\n' +
    'Jane Doe,jane@shop.com,07/08/2026,9.0,12.75\n' +
    'Jane Doe,jane@shop.com,07/09/2026,9.0,0\n' +
    'Jane Doe,jane@shop.com,07/10/2026,9.0,22.00\n' +
    'Bob Smith,bob@shop.com,07/06/2026,6.0,18.50\n';
  r = await req('POST', `/api/payroll/runs/${run1.id}/import-timecards`, { csv: driposTimecards });
  check('timecards refuse a finalized run', r.status === 400);
  r = await req('POST', `/api/payroll/runs/${importRun.id}/import-timecards`, { csv: driposTimecards });
  check('timecards fill hours, weekly OT, and tips by email match', r.status === 200 &&
    r.data.updated === 1 && r.data.unmatched.length === 1 && r.data.otSource.includes('computed weekly'));
  const mayaChk = r.data.run.checks.find(c => c.employeeId === empMaya.id);
  check('imported check recomputed: 40h + 4.5 OT + $114 tips', mayaChk.inputs.hours === 40 &&
    mayaChk.inputs.otHours === 4.5 && mayaChk.inputs.tips === 114 && mayaChk.computed.gross === 1142.50);
  await req('DELETE', `/api/payroll/runs/${importRun.id}`);

  const driposSales = 'Date,Net Sales,Tax,Tips\n' +
    '07/14/2026,812.40,53.82,61.00\n' +
    '07/15/2026,"1,040.25",68.92,74.50\n';
  r = await req('POST', '/api/sales/import-csv', { csv: driposSales });
  check('sales import books paid taxable invoices per day', r.status === 200 &&
    r.data.imported === 2 && r.data.tipsTotal === 135.50 && r.data.warnings.length === 0);
  const salesInvs = (await req('GET', '/api/invoices')).data.filter(i => i.customerName === 'Daily sales');
  check('imported day matches POS: net + computed tax, paid', salesInvs.length === 2 &&
    salesInvs.some(i => i.total === 866.22 && i.status === 'paid'));
  r = await req('GET', '/api/salestax?year=2026');
  check('imported sales feed the trust ledger', r.data.balance === 122.74);
  r = await req('POST', '/api/sales/import-csv', { csv: driposSales });
  check('re-importing the same days is safe', r.data.imported === 0 && r.data.duplicates === 2);
  r = await req('POST', '/api/sales/import-csv', { csv: 'Foo,Bar\n1,2\n' });
  check('sales import validates headers', r.status === 400);

  // ---- receipt attachments on expenses ----
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await req('POST', '/api/expenses', { vendor: 'Office Depot', category: 'Office Supplies', amount: 42.10, date: '2026-07-16' });
  const receiptExp = r.data;
  r = await req('POST', `/api/expenses/${receiptExp.id}/receipt`, { name: 'staples.png', type: 'image/png', dataBase64: PNG_1PX });
  check('uploads a photo receipt', r.status === 200 && r.data.receipt.mime === 'image/png' && r.data.receipt.size > 0);
  let receiptRes = await fetch(BASE + `/api/expenses/${receiptExp.id}/receipt`);
  check('streams the receipt back inline', receiptRes.status === 200 &&
    receiptRes.headers.get('content-type') === 'image/png' &&
    (await receiptRes.arrayBuffer()).byteLength === r.data.receipt.size);
  const receiptsDir = path.join(process.env.QUICKBUCKS_DATA_DIR, 'receipts');
  check('receipt bytes live on disk, not in the JSON', fs.readdirSync(receiptsDir).length === 1 &&
    fs.readdirSync(process.env.QUICKBUCKS_DATA_DIR)
      .filter(f => f.endsWith('.json'))
      .every(f => !fs.readFileSync(path.join(process.env.QUICKBUCKS_DATA_DIR, f), 'utf8').includes('iVBORw0KGgo')));
  r = await req('POST', `/api/expenses/${receiptExp.id}/receipt`, { name: 'receipt.pdf', type: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 test').toString('base64') });
  check('re-upload replaces the receipt', r.status === 200 && r.data.receipt.mime === 'application/pdf' &&
    fs.readdirSync(receiptsDir).length === 1);
  r = await req('POST', `/api/expenses/${receiptExp.id}/receipt`, { name: 'evil.exe', type: 'application/octet-stream', dataBase64: PNG_1PX });
  check('rejects non-photo/PDF types', r.status === 400);
  r = await req('DELETE', `/api/expenses/${receiptExp.id}/receipt`);
  check('removes the receipt', r.status === 200 && !r.data.receipt && fs.readdirSync(receiptsDir).length === 0);
  await req('POST', `/api/expenses/${receiptExp.id}/receipt`, { name: 'again.png', type: 'image/png', dataBase64: PNG_1PX });
  r = await req('DELETE', `/api/expenses/${receiptExp.id}`);
  check('deleting the expense deletes its receipt file', r.status === 200 && fs.readdirSync(receiptsDir).length === 0);

  // ---- backup download + PWA assets ----
  const backupLib = require('../lib/backup');
  await req('POST', `/api/expenses/${(await req('POST', '/api/expenses', { vendor: 'Backup Test', category: 'Other', amount: 1, date: '2026-07-16' })).data.id}/receipt`,
    { name: 'r.png', type: 'image/png', dataBase64: PNG_1PX });
  const backupRes = await fetch(BASE + '/api/backup');
  check('backup downloads as a tar attachment', backupRes.status === 200 &&
    backupRes.headers.get('content-type') === 'application/x-tar' &&
    (backupRes.headers.get('content-disposition') || '').includes('quickbucks-backup-'));
  const tarNames = backupLib.entryNames(Buffer.from(await backupRes.arrayBuffer()));
  check('backup contains the books, household data, and receipts',
    tarNames.includes('quickbucks-data/global.json') &&
    tarNames.filter(n => /company-.*\.json$/.test(n)).length === 2 &&
    tarNames.some(n => n.startsWith('quickbucks-data/receipts/')));
  r = await fetch(BASE + '/manifest.json');
  check('PWA manifest served', r.status === 200 && (await r.json()).display === 'standalone');
  r = await fetch(BASE + '/sw.js');
  check('service worker served as JS', r.status === 200 && (r.headers.get('content-type') || '').includes('javascript'));
  r = await fetch(BASE + '/icon-192.png');
  check('app icon served', r.status === 200 && r.headers.get('content-type') === 'image/png');

  // ---- NJ-1040-ES plan, 1099-NEC tracker, audit log ----
  r = await req('PUT', '/api/household/tax-profile', { priorYearNjTax: 100 });
  check('saves prior-year NJ tax', r.status === 200 && r.data.priorYearNjTax === 100);
  r = await req('GET', '/api/household/tax');
  check('NJ-ES plan uses the 100%-of-prior-year harbor', r.data.njEsPlan.required === 100 &&
    r.data.njEsPlan.basis === '100% of prior-year NJ tax' && r.data.njEsPlan.quarters.length === 4);

  await req('POST', '/api/expenses', { vendor: 'Cleaning Crew LLC', category: 'Other', amount: 700, date: '2026-07-01', paymentMethod: 'Check' });
  await req('POST', '/api/expenses', { vendor: 'cleaning crew llc', category: 'Other', amount: 100, date: '2026-07-02', paymentMethod: 'Credit card' });
  r = await req('POST', '/api/vendors/1099', { name: 'Cleaning Crew LLC', tracked: true });
  check('marks a 1099 vendor', r.status === 200 && r.data.tracked === true);
  r = await req('GET', '/api/vendors/1099?year=2026');
  const necVendor = r.data.vendors.find(v => v.name === 'Cleaning Crew LLC');
  check('1099 report splits card from reportable payments (case-insensitive vendor merge)',
    necVendor && necVendor.reportable === 700 && necVendor.cardTotal === 100 && necVendor.needs1099 === true);
  check('payroll expenses stay out of the 1099 report', !r.data.vendors.some(v => v.name.toLowerCase().includes('payroll')));
  await req('POST', '/api/vendors/1099', { name: 'Cleaning Crew LLC', tracked: false });
  r = await req('GET', '/api/vendors/1099?year=2026');
  check('untracked vendor no longer flagged', r.data.vendors.find(v => v.name === 'Cleaning Crew LLC').needs1099 === false);

  r = await req('GET', '/api/audit');
  // H1: /api/audit surfaces the TAMPER-EVIDENT chain, not db.auditLog.
  check('audit endpoint returns the verified chain envelope',
    r.data && r.data.verified && Array.isArray(r.data.entries));
  check('audit chain verifies as tamper-evident', r.data.verified.ok === true && r.data.verified.entries > 0);
  const auditEntries = r.data.entries;
  const httpWrites = auditEntries.filter(e => e.type === 'http.write');
  check('audit chain records mutations, newest first (as chained entries)',
    auditEntries.length > 0 && httpWrites[0].payload.method === 'POST' &&
    httpWrites[0].payload.path === '/api/vendors/1099' && httpWrites[0].payload.status === 200);
  check('audit entries are hash-chained (seq + 64-hex hash), not the forgeable log',
    auditEntries.every(e => Number.isInteger(e.seq) && /^[0-9a-f]{64}$/.test(e.hash)));
  check('audit chain never records reads', httpWrites.every(e => e.payload.method !== 'GET'));

  // static
  const page = await fetch(BASE + '/');
  check('serves the app', page.status === 200 && (await page.text()).includes('QuickBucks'));
  const spa = await fetch(BASE + '/invoices');
  check('SPA fallback works', spa.status === 200);

  console.log(`\nAll ${passed} checks passed.`);
  server.close();
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
