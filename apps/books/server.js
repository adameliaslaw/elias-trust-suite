// QuickBucks — self-hosted small-business accounting app.
// Zero dependencies: Node's http module + a JSON file datastore.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, save, commit, commitMany, companies, createCompany, uid, decorateInvoice, round2, todayISO } = require('./lib/store');
const outbox = require('./lib/outbox');
const money = require('./lib/money');
const { loadGlobal, saveGlobal, taxProfileForYear } = require('./lib/global');
const tax1040 = require('./lib/tax1040');
const nj1040 = require('./lib/nj1040');
const { seedIfEmpty } = require('./lib/seed');
const auth = require('./lib/auth');
const plaid = require('./lib/plaid');
const { parseBankCSV } = require('./lib/csv');
const payroll = require('./lib/payroll/service');
const deposits = require('./lib/payroll/deposits');
const nacha = require('./lib/payroll/nacha');
const filings = require('./lib/payroll/filings');
const elias = require('./lib/schedule-elias');
const eliasP2 = require('./lib/elias-phase2');
const salestax = require('./lib/salestax');
const recurring = require('./lib/recurring');
const timetracking = require('./lib/timetracking');
const timecards = require('./lib/payroll/timecards');
const salesimport = require('./lib/salesimport');
const receipts = require('./lib/receipts');
const backup = require('./lib/backup');
const audit = require('./lib/audit');

const PORT = process.env.PORT || 3000;
// Bind to loopback by default: the app is built for a single machine (or a
// reverse proxy you control). Set QUICKBUCKS_HOST=0.0.0.0 to listen on the
// network — only do that with a password set.
const HOST = process.env.QUICKBUCKS_HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
};

// ---------- helpers ----------

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > maxBytes) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function badRequest(res, msg) { sendJSON(res, 400, { error: msg }); }
function notFound(res) { sendJSON(res, 404, { error: 'Not found' }); }

function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

// ---------- validation ----------

function validInvoice(b, db) {
  if (!b.customerId || !db.customers.find(c => c.id === b.customerId)) return 'A valid customer is required';
  if (!b.date) return 'Invoice date is required';
  if (!Array.isArray(b.items) || b.items.length === 0) return 'At least one line item is required';
  for (const it of b.items) {
    if (!it.description || !String(it.description).trim()) return 'Each line item needs a description';
    if (!(Number(it.qty) > 0)) return 'Line item quantity must be positive';
    if (Number(it.rate) < 0 || isNaN(Number(it.rate))) return 'Line item rate must be a non-negative number';
  }
  return null;
}

// ---------- API routes ----------

const routes = [];
function route(method, pattern, handler) {
  // pattern like /api/invoices/:id/payments
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
}

// -- auth (public routes; see PUBLIC_ROUTES below) --
// Append "; Secure" whenever the request actually arrived over TLS (directly or
// via a terminating proxy). A session/company cookie sent in cleartext — e.g.
// the server bound to 0.0.0.0 and reached over a LAN — is interceptable; Secure
// pins it to HTTPS. Omitted on plain-http localhost dev so login still works.
function secureAttr(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isTls = proto === 'https' || req.socket?.encrypted === true;
  return isTls ? '; Secure' : '';
}

// The password is household-level (global.json), shared by all companies.
route('GET', '/api/auth-status', (req, res) => {
  const g = loadGlobal();
  const setupRequired = !g.passwordHash && !auth.authDisabled();
  sendJSON(res, 200, {
    protected: !!g.passwordHash,
    setupRequired,
    authenticated: !setupRequired && (auth.authDisabled() || !g.passwordHash || auth.isAuthenticated(req))
  });
});
route('POST', '/api/login', async (req, res) => {
  // Throttle brute-force attempts per client IP before doing any scrypt work.
  const lockedMs = auth.loginLockedMs(req);
  if (lockedMs) {
    res.setHeader('Retry-After', Math.ceil(lockedMs / 1000));
    return sendJSON(res, 429, { error: 'Too many failed attempts — try again later' });
  }
  const b = await readBody(req);
  const g = loadGlobal();
  if (!g.passwordHash) return badRequest(res, 'No password is set');
  if (!auth.verifyPassword(String(b.password || ''), g.passwordHash)) {
    auth.recordLoginFail(req);
    // Chained: brute-force bursts must be visible in the tamper-evident log.
    await audit.append(req.companyId, 'auth.login_failed', {
      principal: 'local', reason: 'bad_password', ip: audit.actor(req).slice(6)
    });
    return sendJSON(res, 401, { error: 'Incorrect password' });
  }
  auth.resetLoginFails(req);
  const token = auth.createSession();
  res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secureAttr(req)}`);
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/logout', (req, res) => {
  auth.destroySession(auth.parseCookies(req).qb_session);
  res.setHeader('Set-Cookie', `qb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureAttr(req)}`);
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/password', async (req, res) => {
  const b = await readBody(req);
  const g = loadGlobal();
  if (g.passwordHash && !auth.verifyPassword(String(b.current || ''), g.passwordHash)) {
    return sendJSON(res, 401, { error: 'Current password is incorrect' });
  }
  const next = String(b.next || '');
  if (next === '') {
    g.passwordHash = null; // turn protection off
  } else {
    if (next.length < 6) return badRequest(res, 'Password must be at least 6 characters');
    g.passwordHash = auth.hashPassword(next);
  }
  saveGlobal();
  // Invalidate every existing session — a stolen cookie must not outlive the
  // password it was minted under. The caller gets a fresh one below so they
  // aren't locked out of their own session.
  auth.clearSessions();
  const token = auth.createSession();
  res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secureAttr(req)}`);
  await audit.append(req.companyId, 'auth.password_changed', { principal: 'local' });
  sendJSON(res, 200, { ok: true, protected: !!g.passwordHash });
});

// -- companies (household level) --
route('GET', '/api/companies', (req, res) => {
  sendJSON(res, 200, companies().map(c => ({ id: c.id, name: c.name, active: c.id === req.companyId })));
});
route('POST', '/api/companies', async (req, res) => {
  const b = await readBody(req);
  if (!b.name || !String(b.name).trim()) return badRequest(res, 'A name is required');
  const company = createCompany(b.name);
  sendJSON(res, 201, company);
});
route('POST', '/api/companies/:id/select', (req, res, db, params) => {
  const company = companies().find(c => c.id === params.id);
  if (!company) return notFound(res);
  res.setHeader('Set-Cookie', `qb_company=${company.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secureAttr(req)}`);
  sendJSON(res, 200, { ok: true, id: company.id, name: company.name });
});

// -- settings --
route('GET', '/api/settings', (req, res, db) => {
  // Never expose Plaid credentials; the password hash lives in global.json.
  const { passwordHash, plaid: plaidCfg, ...pub } = db.settings;
  sendJSON(res, 200, { ...pub, protected: !!loadGlobal().passwordHash });
});
route('PUT', '/api/settings', async (req, res, db) => {
  const b = await readBody(req);
  const allowed = ['companyName', 'currency', 'invoicePrefix', 'defaultTermsDays', 'defaultHourlyRate'];
  for (const k of allowed) if (k in b) db.settings[k] = b[k];
  if (b.salesTax && typeof b.salesTax === 'object') {
    const rate = Number(b.salesTax.ratePct);
    if ('ratePct' in b.salesTax && (isNaN(rate) || rate < 0 || rate > 30)) {
      return badRequest(res, 'Sales tax rate must be a percentage between 0 and 30');
    }
    db.settings.salesTax = {
      enabled: !!b.salesTax.enabled,
      ratePct: rate > 0 ? rate : salestax.NJ_SALES_TAX_RATE,
      monthlyRemitter: !!b.salesTax.monthlyRemitter
    };
  }
  // Keys only — values can carry secrets; which knob turned cannot. Atomic
  // with the save (#24): the mutation and its audit event commit as one unit.
  await commit(db, req.companyId, 'settings.changed', {
    keys: Object.keys(b), actor: audit.actor(req)
  });
  // Keep the household company registry in sync with the display name.
  if ('companyName' in b) {
    const reg = companies().find(c => c.id === req.companyId);
    if (reg) { reg.name = db.settings.companyName; saveGlobal(); }
  }
  sendJSON(res, 200, db.settings);
});
route('GET', '/api/categories', (req, res, db) => sendJSON(res, 200, db.expenseCategories));

// -- customers --
// Extracted verbatim into lib/routes/customers.js (Phase 6 / #25, third slice of
// the server split), wired in place so route-registration order is unchanged.
// Every customer mutation is a non-money path: each calls save(db) directly (no
// commit). The customer-only validCustomer validator moved into that module
// (no other callers); decorateInvoice stays shared and is threaded through deps.
require('./lib/routes/customers')(route, {
  sendJSON, notFound, badRequest, readBody,
  uid, todayISO, save,
  decorateInvoice, money
});

// -- invoices --
route('GET', '/api/invoices', (req, res, db) => {
  const list = db.invoices.map(inv => {
    const c = db.customers.find(x => x.id === inv.customerId);
    return { ...decorateInvoice(inv), customerName: c ? (c.company || c.name) : '(deleted)' };
  }).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  sendJSON(res, 200, list);
});
route('GET', '/api/invoices/:id', (req, res, db, params) => {
  const inv = db.invoices.find(x => x.id === params.id);
  if (!inv) return notFound(res);
  const customer = db.customers.find(c => c.id === inv.customerId) || null;
  sendJSON(res, 200, {
    ...decorateInvoice(inv),
    customer,
    company: { name: db.settings.companyName, currency: db.settings.currency }
  });
});
// Shared constructor: validates and appends an invoice (used by the POST
// route and by recurring-invoice generation). Throws on validation errors.
function createInvoice(db, b) {
  const err = validInvoice(b, db);
  if (err) throw new Error(err);
  const inv = {
    id: uid(),
    number: db.settings.invoicePrefix + db.settings.nextInvoiceNumber++,
    customerId: b.customerId,
    date: b.date,
    dueDate: b.dueDate || b.date,
    items: b.items.map(it => ({ description: String(it.description).trim(), qty: Number(it.qty), rate: round2(Number(it.rate)), taxable: !!it.taxable })),
    taxRate: b.items.some(it => it.taxable) ? salestax.salesTaxSettings(db).ratePct : 0,
    payments: [],
    draft: !!b.draft,
    notes: b.notes || '',
    createdAt: todayISO()
  };
  db.invoices.push(inv);
  return inv;
}

// Materialize any due recurring invoices. Generated invoices are money events:
// they are chained like manual ones.
//
// M8: this must NOT run inside a GET. Creating + persisting + audit-appending on
// a read makes the read non-idempotent (unsafe for prefetch/retries) and, worse,
// a tampered audit chain makes audit.append throw, turning an otherwise
// read-only dashboard/invoice list into a 400. It now runs from the recurring
// write path (immediate first bill) and from a startup+daily scheduler.
async function generateRecurring(db, companyId, actor) {
  const created = recurring.generateDue(db, createInvoice, todayISO());
  if (created.length) {
    // Persist the generated invoices and their audit events as one atomic unit
    // (#24) so a crash can't leave a materialized recurring invoice off the
    // tamper-evident chain.
    await commitMany(db, companyId, created.map(inv => ({
      type: 'invoice.created',
      payload: {
        invoiceId: inv.id, clientId: inv.customerId,
        totalCents: audit.centsStr(decorateInvoice(inv).total),
        source: 'recurring', actor
      }
    })));
  }
  return created;
}

// Sweep every company for due recurring invoices. Per-company failures (e.g. a
// tampered audit chain blocking the append) are logged, never fatal — one
// company's problem must not stop the others or crash startup.
async function materializeAllRecurring() {
  for (const c of companies()) {
    try {
      await generateRecurring(load(c.id), c.id, 'local@scheduler');
    } catch (e) {
      console.error(`recurring materialization failed for company ${c.id}:`, e.message);
    }
  }
}

// Materialize now, then daily. unref() so short-lived processes (tests) exit.
function scheduleRecurring() {
  materializeAllRecurring().catch(e => console.error('recurring materialization error:', e.message));
  const timer = setInterval(() => {
    materializeAllRecurring().catch(e => console.error('recurring materialization error:', e.message));
  }, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

route('POST', '/api/invoices', async (req, res, db) => {
  const b = await readBody(req);
  let inv;
  try {
    inv = createInvoice(db, b);
  } catch (e) {
    return badRequest(res, e.message);
  }
  await commit(db, req.companyId, 'invoice.created', {
    invoiceId: inv.id, clientId: inv.customerId,
    totalCents: audit.centsStr(decorateInvoice(inv).total),
    source: 'manual', actor: audit.actor(req)
  });
  sendJSON(res, 201, decorateInvoice(inv));
});
route('PUT', '/api/invoices/:id', async (req, res, db, params) => {
  const inv = db.invoices.find(x => x.id === params.id);
  if (!inv) return notFound(res);
  const b = await readBody(req);
  const merged = { ...inv, ...b };
  const err = validInvoice(merged, db);
  if (err) return badRequest(res, err);
  for (const k of ['customerId', 'date', 'dueDate', 'notes']) if (k in b) inv[k] = b[k];
  if ('draft' in b) inv.draft = !!b.draft;
  if ('items' in b) {
    inv.items = b.items.map(it => ({ description: String(it.description).trim(), qty: Number(it.qty), rate: round2(Number(it.rate)), taxable: !!it.taxable }));
    inv.taxRate = inv.items.some(it => it.taxable) ? (inv.taxRate || salestax.salesTaxSettings(db).ratePct) : 0;
  }
  await commit(db, req.companyId, 'invoice.updated', {
    invoiceId: inv.id, totalCents: audit.centsStr(decorateInvoice(inv).total),
    changedFields: Object.keys(b), actor: audit.actor(req)
  });
  sendJSON(res, 200, decorateInvoice(inv));
});
route('DELETE', '/api/invoices/:id', async (req, res, db, params) => {
  const idx = db.invoices.findIndex(x => x.id === params.id);
  if (idx === -1) return notFound(res);
  // Snapshot the total BEFORE removal — the chain is the record of what was deleted.
  const deletedTotal = decorateInvoice(db.invoices[idx]).total;
  db.invoices.splice(idx, 1);
  // Release any time entries billed on this invoice back to unbilled WIP.
  for (const t of db.timeEntries) if (t.invoiceId === params.id) t.invoiceId = null;
  await commit(db, req.companyId, 'invoice.deleted', {
    invoiceId: params.id, totalCents: audit.centsStr(deletedTotal), actor: audit.actor(req)
  });
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/invoices/:id/payments', async (req, res, db, params) => {
  const inv = db.invoices.find(x => x.id === params.id);
  if (!inv) return notFound(res);
  const b = await readBody(req);
  const amount = Number(b.amount);
  if (!(amount > 0)) return badRequest(res, 'Payment amount must be positive');
  const dInv = decorateInvoice(inv);
  const balance = dInv.balance;
  if (amount > balance + 0.005) return badRequest(res, `Payment exceeds remaining balance ($${balance.toFixed(2)})`);
  inv.payments.push({
    id: uid(), date: b.date || todayISO(), amount: round2(amount), method: b.method || 'Other',
    // Freeze the income/tax split against the invoice as it stands right now,
    // so a later edit can't restate this period's income or trust liability.
    taxSnapshot: salestax.taxSplitSnapshot(dInv)
  });
  inv.draft = false;
  await commit(db, req.companyId, 'invoice.payment_recorded', {
    invoiceId: inv.id, paymentCents: audit.centsStr(amount), actor: audit.actor(req)
  });
  sendJSON(res, 200, decorateInvoice(inv));
});
route('POST', '/api/invoices/:id/send', async (req, res, db, params) => {
  const inv = db.invoices.find(x => x.id === params.id);
  if (!inv) return notFound(res);
  inv.draft = false;
  const customer = db.customers.find(c => c.id === inv.customerId);
  await commit(db, req.companyId, 'invoice.sent', {
    invoiceId: inv.id, clientId: inv.customerId,
    amountCents: audit.centsStr(decorateInvoice(inv).total),
    sentBy: audit.actor(req), sentTo: (customer && customer.email) || ''
  });
  sendJSON(res, 200, decorateInvoice(inv));
});

// Import a Dripos (or similar) daily sales CSV: each day becomes a paid,
// taxable invoice for a walk-in customer, so income and the sales-tax
// trust ledger flow from the same books as hand-entered sales. Tips are
// not income (they belong to staff, via payroll) — the response totals
// them so you know what to expect in the next pay run.
route('POST', '/api/sales/import-csv', async (req, res, db) => {
  const b = await readBody(req);
  if (!b.csv || !String(b.csv).trim()) return badRequest(res, 'CSV content is required');
  let parsed;
  try {
    parsed = salesimport.parseSalesCSV(String(b.csv));
  } catch (e) {
    return badRequest(res, e.message);
  }
  if (!parsed.days.length) return badRequest(res, 'No sales rows with a parseable date were found');

  const customerName = String(b.customerName || 'Daily sales').trim() || 'Daily sales';
  let customer = db.customers.find(c => c.name === customerName);
  if (!customer) {
    customer = { id: uid(), name: customerName, company: '', email: '', phone: '', notes: 'Auto-created by the sales import', createdAt: todayISO() };
    db.customers.push(customer);
  }

  const existing = new Set(db.invoices.map(i => i.importKey).filter(Boolean));
  const warnings = [];
  let imported = 0, duplicates = 0, importedTotal = 0;
  const taxOn = salestax.salesTaxSettings(db).enabled;
  for (const day of parsed.days) {
    const key = `sales:${customer.id}:${day.date}`;
    if (existing.has(key)) { duplicates++; continue; }
    if (!(day.netSales > 0)) continue;
    let inv;
    try {
      inv = createInvoice(db, {
        customerId: customer.id,
        date: day.date,
        dueDate: day.date,
        items: [{ description: 'Daily sales (imported)', qty: 1, rate: day.netSales, taxable: true }],
        notes: 'Imported from the POS sales export'
      });
    } catch (e) {
      warnings.push(`${day.date}: ${e.message}`);
      continue;
    }
    inv.importKey = key;
    const dImport = decorateInvoice(inv);
    const total = dImport.total;
    inv.payments.push({
      id: uid(), date: day.date, amount: total, method: 'Card',
      taxSnapshot: salestax.taxSplitSnapshot(dImport)
    });
    inv.draft = false;
    existing.add(key);
    imported++;
    importedTotal = money.add(importedTotal, total);
    const computedTax = money.sub(total, day.netSales);
    if (day.tax && Math.abs(computedTax - day.tax) > 0.02) {
      warnings.push(`${day.date}: POS reported ${day.tax.toFixed(2)} tax but the books computed ${computedTax.toFixed(2)} — check the rate in Settings`);
    }
  }
  if (!taxOn && parsed.days.some(d => d.tax > 0)) {
    warnings.unshift('The POS collected sales tax but this company has sales tax turned off in Settings — imported sales were booked without tax');
  }
  // One batch event (not per-invoice): the chain records the import itself,
  // with the exact total of what it booked — atomic with the save (#24).
  await commit(db, req.companyId, 'sales.imported', {
    rowCount: imported, totalCents: audit.centsStr(importedTotal), source: 'csv', actor: audit.actor(req)
  });
  sendJSON(res, 200, { imported, duplicates, tipsTotal: parsed.tipsTotal, skipped: parsed.info.skipped, warnings });
});

// -- recurring invoices --
// Extracted into lib/routes/recurring.js as the fifth slice of the incremental
// server split (Phase 6 / #25). Registered here, in place, so route order is
// unchanged; the handlers close over the deps passed below instead of this
// file's module scope. Persistence preserved exactly: the template CRUD is
// non-money (GET reads; PUT/DELETE save(db)); POST is mixed — it calls
// generateRecurring (which commitManys any due invoices, source: 'recurring')
// then save(db) for the template. validInvoice (shared with invoices) and
// generateRecurring (shared with the boot scheduler — it closes over
// createInvoice/commitMany/decorateInvoice) stay defined in server.js and are
// threaded through deps, NOT moved.
require('./lib/routes/recurring')(route, {
  sendJSON, notFound, badRequest, readBody,
  save, recurring, validInvoice, generateRecurring, audit
});

// -- billable time --
// Extracted verbatim into lib/routes/time.js (Phase 6 / #25, fourth slice of the
// server split), wired in place so route-registration order is unchanged. A time
// entry carries hours + rate, so every mutation here is a money path: each
// commits (crash-atomic audit), and POST /api/time/invoice commits the rolled-up
// invoice.created event — do NOT convert to save(db). All time logic lives in the
// shared lib/timetracking module (no time-only validator to move); createInvoice
// and decorateInvoice stay shared and are threaded through deps, not moved.
require('./lib/routes/time')(route, {
  sendJSON, notFound, badRequest, readBody,
  todayISO, commit,
  createInvoice, decorateInvoice,
  timetracking, recurring, audit
});

// -- expenses + 1099-NEC vendor tracking + receipt attachments --
// Extracted into lib/routes/expenses.js as the second slice of the incremental
// server split (Phase 6 / #25). Registered here, in place, so route order is
// unchanged; the handlers close over the deps passed below instead of this
// file's module scope. The expense-only validExpense validator moved into that
// module with them (no other callers). Persistence preserved exactly: the money
// mutations (expense create/update/delete) commit; the non-money paths (1099
// tracking, receipt attach/delete) call save(db) directly.
require('./lib/routes/expenses')(route, {
  sendJSON, notFound, badRequest, readBody,
  uid, round2, todayISO, commit, save,
  audit, receipts, money
});

// -- banking --

function publicConnection(conn) {
  const { accessToken, cursor, ...pub } = conn;
  return pub;
}

function txnKey(t) {
  return `${t.date}|${t.amount}|${t.name.toLowerCase()}`;
}

route('GET', '/api/bank/status', (req, res, db) => {
  const cfg = plaid.getConfig(db);
  sendJSON(res, 200, {
    configured: cfg.configured,
    env: cfg.env,
    configSource: process.env.PLAID_CLIENT_ID ? 'env' : (db.settings.plaid ? 'settings' : null),
    connections: db.bankConnections.map(publicConnection),
    reviewCount: db.bankTransactions.filter(t => t.status === 'new').length
  });
});

route('PUT', '/api/bank/config', async (req, res, db) => {
  const b = await readBody(req);
  if (!b.clientId || !b.secret) return badRequest(res, 'Client ID and secret are required');
  const env = ['sandbox', 'production'].includes(b.env) ? b.env : 'sandbox';
  db.settings.plaid = { clientId: String(b.clientId).trim(), secret: String(b.secret).trim(), env };
  save(db);
  sendJSON(res, 200, { ok: true, configured: true, env });
});

route('DELETE', '/api/bank/config', (req, res, db) => {
  delete db.settings.plaid;
  save(db);
  sendJSON(res, 200, { ok: true });
});

route('POST', '/api/bank/link-token', async (req, res, db) => {
  const data = await plaid.createLinkToken(db);
  sendJSON(res, 200, { link_token: data.link_token });
});

route('POST', '/api/bank/exchange', async (req, res, db) => {
  const b = await readBody(req);
  if (!b.public_token) return badRequest(res, 'public_token is required');
  const { access_token, item_id } = await plaid.exchangePublicToken(db, b.public_token);
  const accountsData = await plaid.getAccounts(db, access_token);
  const conn = {
    id: uid(),
    itemId: item_id,
    institution: b.institution || 'Bank',
    accessToken: access_token,
    cursor: null,
    connectedAt: todayISO(),
    lastSync: null,
    accounts: accountsData.accounts.map(a => ({
      accountId: a.account_id,
      name: a.name,
      mask: a.mask || '',
      type: a.subtype || a.type,
      balance: a.balances.current
    }))
  };
  db.bankConnections.push(conn);
  save(db);
  sendJSON(res, 201, publicConnection(conn));
});

async function syncConnection(db, conn) {
  let added = 0, cursor = conn.cursor, hasMore = true;
  const existingPlaid = new Set(db.bankTransactions.map(t => t.plaidId).filter(Boolean));
  while (hasMore) {
    const page = await plaid.syncTransactions(db, conn.accessToken, cursor);
    for (const t of page.added) {
      if (existingPlaid.has(t.transaction_id)) continue;
      db.bankTransactions.push({
        id: uid(),
        source: 'plaid',
        plaidId: t.transaction_id,
        connectionId: conn.id,
        accountId: t.account_id,
        date: t.date,
        name: t.merchant_name || t.name,
        // Plaid: positive = money out. We store positive = money in.
        amount: round2(-t.amount),
        pending: !!t.pending,
        suggestedCategory: t.personal_finance_category ? t.personal_finance_category.primary : '',
        status: 'new'
      });
      added++;
    }
    for (const t of page.modified) {
      const existing = db.bankTransactions.find(x => x.plaidId === t.transaction_id);
      if (existing && existing.status === 'new') {
        existing.date = t.date;
        existing.name = t.merchant_name || t.name;
        existing.amount = round2(-t.amount);
        existing.pending = !!t.pending;
      }
    }
    for (const r of page.removed) {
      const idx = db.bankTransactions.findIndex(x => x.plaidId === r.transaction_id && x.status === 'new');
      if (idx !== -1) db.bankTransactions.splice(idx, 1);
    }
    cursor = page.next_cursor;
    hasMore = page.has_more;
  }
  conn.cursor = cursor;
  conn.lastSync = new Date().toISOString();
  try {
    const accountsData = await plaid.getAccounts(db, conn.accessToken);
    for (const a of accountsData.accounts) {
      const acct = conn.accounts.find(x => x.accountId === a.account_id);
      if (acct) acct.balance = a.balances.current;
    }
  } catch { /* balance refresh is best-effort */ }
  return added;
}

route('POST', '/api/bank/sync', async (req, res, db) => {
  if (!db.bankConnections.length) return badRequest(res, 'No bank connections to sync');
  const beforeLen = db.bankTransactions.length;
  let added = 0;
  const errors = [];
  for (const conn of db.bankConnections) {
    try {
      added += await syncConnection(db, conn);
    } catch (e) {
      errors.push(`${conn.institution}: ${e.message}`);
    }
  }
  // Exact signed net of the newly imported feed items (they are appended).
  const net = money.sum(...db.bankTransactions.slice(beforeLen).map(t => t.amount));
  await commit(db, req.companyId, 'bank.transactions_imported', {
    count: added, netCents: audit.centsStr(net), source: 'sync', actor: audit.actor(req)
  });
  sendJSON(res, 200, { added, errors, connections: db.bankConnections.map(publicConnection) });
});

route('DELETE', '/api/bank/connections/:id', async (req, res, db, params) => {
  const idx = db.bankConnections.findIndex(c => c.id === params.id);
  if (idx === -1) return notFound(res);
  const conn = db.bankConnections[idx];
  try { await plaid.removeItem(db, conn.accessToken); } catch { /* revoke is best-effort */ }
  db.bankConnections.splice(idx, 1);
  // Drop unreviewed feed items from this bank; reviewed ones already became
  // expenses/payments and live on independently.
  db.bankTransactions = db.bankTransactions.filter(t => !(t.connectionId === conn.id && t.status === 'new'));
  save(db);
  sendJSON(res, 200, { ok: true });
});

route('POST', '/api/bank/import-csv', async (req, res, db) => {
  const b = await readBody(req);
  if (!b.csv || !String(b.csv).trim()) return badRequest(res, 'CSV content is required');
  const { transactions, skipped } = parseBankCSV(String(b.csv), { flipSigns: !!b.flipSigns });
  const existing = new Set(db.bankTransactions.map(txnKey));
  let added = 0, duplicates = 0, net = 0;
  for (const t of transactions) {
    if (existing.has(txnKey(t))) { duplicates++; continue; }
    existing.add(txnKey(t));
    const amount = round2(t.amount);
    db.bankTransactions.push({
      id: uid(),
      source: 'csv',
      accountLabel: b.accountLabel || 'Imported',
      date: t.date,
      name: t.name,
      amount,
      status: 'new'
    });
    added++;
    net = money.add(net, amount);
  }
  await commit(db, req.companyId, 'bank.transactions_imported', {
    count: added, netCents: audit.centsStr(net), source: 'csv', actor: audit.actor(req)
  });
  sendJSON(res, 200, { added, duplicates, skipped });
});

// -- bank feed rules: "always categorize X as Y" --
function ruleFor(db, txn) {
  if (txn.amount >= 0) return null;   // rules act on money-out only
  const name = txn.name.toLowerCase();
  return db.bankRules.find(r => r.active !== false && name.includes(r.match.toLowerCase())) || null;
}

route('GET', '/api/bank/rules', (req, res, db) => sendJSON(res, 200, db.bankRules));
route('POST', '/api/bank/rules', async (req, res, db) => {
  const b = await readBody(req);
  if (!b.match || !String(b.match).trim()) return badRequest(res, 'A match text is required');
  if (!b.category || !db.expenseCategories.includes(b.category)) return badRequest(res, 'A valid expense category is required');
  const rule = {
    id: uid(),
    match: String(b.match).trim(),
    category: b.category,
    vendor: (b.vendor || '').trim(),
    active: true,
    createdAt: todayISO()
  };
  db.bankRules.push(rule);
  save(db);
  sendJSON(res, 201, rule);
});
route('DELETE', '/api/bank/rules/:id', (req, res, db, params) => {
  const idx = db.bankRules.findIndex(r => r.id === params.id);
  if (idx === -1) return notFound(res);
  db.bankRules.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { ok: true });
});

// Apply every rule to the review feed: matching outflows become categorized
// expenses in one shot (same effect as the per-transaction Add Expense).
route('POST', '/api/bank/apply-rules', (req, res, db) => {
  let applied = 0;
  for (const t of db.bankTransactions) {
    if (t.status !== 'new') continue;
    const rule = ruleFor(db, t);
    if (!rule) continue;
    const exp = {
      id: uid(),
      date: t.date,
      vendor: rule.vendor || t.name,
      category: rule.category,
      amount: round2(Math.abs(t.amount)),
      paymentMethod: 'Bank transfer',
      notes: `From bank feed via rule "${rule.match}"`,
      createdAt: todayISO()
    };
    db.expenses.push(exp);
    t.status = 'added';
    t.linkedExpenseId = exp.id;
    t.appliedRuleId = rule.id;
    applied++;
  }
  if (applied) save(db);
  sendJSON(res, 200, { applied });
});

route('GET', '/api/bank/transactions', (req, res, db, params, query) => {
  const status = query.get('status');
  const accountNames = {};
  for (const c of db.bankConnections) {
    for (const a of c.accounts) accountNames[a.accountId] = `${c.institution} ${a.name}${a.mask ? ' ••' + a.mask : ''}`;
  }
  const list = db.bankTransactions
    .filter(t => !status || t.status === status)
    .map(t => {
      const rule = t.status === 'new' ? ruleFor(db, t) : null;
      return {
        ...t,
        accountName: t.source === 'csv' ? (t.accountLabel || 'Imported') : (accountNames[t.accountId] || 'Bank'),
        ruleMatch: rule ? { id: rule.id, category: rule.category } : null
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  sendJSON(res, 200, list);
});

route('POST', '/api/bank/transactions/:id/expense', async (req, res, db, params) => {
  const t = db.bankTransactions.find(x => x.id === params.id);
  if (!t) return notFound(res);
  if (t.status !== 'new') return badRequest(res, 'Transaction was already reviewed');
  if (t.amount >= 0) return badRequest(res, 'This is money in — match it to an invoice instead');
  const b = await readBody(req);
  const exp = {
    id: uid(),
    date: b.date || t.date,
    vendor: String(b.vendor || t.name).trim(),
    category: b.category || 'Other',
    amount: round2(Math.abs(t.amount)),
    paymentMethod: b.paymentMethod || 'Bank transfer',
    notes: b.notes || `From bank feed: ${t.name}`,
    createdAt: todayISO()
  };
  db.expenses.push(exp);
  t.status = 'added';
  t.linkedExpenseId = exp.id;
  save(db);
  sendJSON(res, 200, { transaction: t, expense: exp });
});

route('POST', '/api/bank/transactions/:id/match', async (req, res, db, params) => {
  const t = db.bankTransactions.find(x => x.id === params.id);
  if (!t) return notFound(res);
  if (t.status !== 'new') return badRequest(res, 'Transaction was already reviewed');
  if (t.amount <= 0) return badRequest(res, 'This is money out — add it as an expense instead');
  const b = await readBody(req);
  const inv = db.invoices.find(x => x.id === b.invoiceId);
  if (!inv) return badRequest(res, 'A valid invoice is required');
  const dMatch = decorateInvoice(inv);
  const balance = dMatch.balance;
  if (t.amount > balance + 0.005) {
    return badRequest(res, `Deposit (${t.amount.toFixed(2)}) exceeds the invoice balance (${balance.toFixed(2)})`);
  }
  inv.payments.push({
    id: uid(), date: t.date, amount: round2(t.amount), method: 'Bank transfer',
    taxSnapshot: salestax.taxSplitSnapshot(dMatch)
  });
  inv.draft = false;
  t.status = 'matched';
  t.linkedInvoiceId = inv.id;
  save(db);
  sendJSON(res, 200, { transaction: t, invoice: decorateInvoice(inv) });
});

route('POST', '/api/bank/transactions/:id/exclude', (req, res, db, params) => {
  const t = db.bankTransactions.find(x => x.id === params.id);
  if (!t) return notFound(res);
  if (t.status !== 'new') return badRequest(res, 'Transaction was already reviewed');
  t.status = 'excluded';
  save(db);
  sendJSON(res, 200, t);
});

route('POST', '/api/bank/transactions/:id/restore', (req, res, db, params) => {
  const t = db.bankTransactions.find(x => x.id === params.id);
  if (!t) return notFound(res);
  if (t.status !== 'excluded') return badRequest(res, 'Only excluded transactions can be restored');
  t.status = 'new';
  save(db);
  sendJSON(res, 200, t);
});

// -- payroll --
// Extracted into lib/routes/payroll.js as the seventh slice of the incremental
// server split (Phase 6 / #25). Registered here, in place, so route order is
// unchanged; the 19 handlers close over the deps passed below instead of this
// file's module scope. Mixed persistence preserved exactly: the read-only GETs
// and NACHA downloads neither save nor commit; the config/draft mutations call
// save(db); the money paths (run create, finalize, liability deposit) commit
// through the transactional outbox. All payroll domain logic already lives in
// the shared lib/payroll/* modules, so nothing moved in — the modules
// (payroll/deposits/nacha/filings/timecards) are threaded through deps.
require('./lib/routes/payroll')(route, {
  sendJSON, notFound, badRequest, readBody,
  uid, round2, todayISO, save, commit, commitMany,
  audit, payroll, deposits, nacha, filings, timecards, money
});

// -- household taxes (1040/NJ-1040 planning + Schedule Elias) --
// Extracted into lib/routes/household.js as the sixth slice of the incremental
// server split (Phase 6 / #25). Registered here, in place, so route order is
// unchanged; the handlers (and the household-only helpers companyYtd/
// householdInput/njEstimateFor/householdLender) close over the deps passed
// below instead of this file's module scope. All non-money (global.json).
require('./lib/routes/household')(route, {
  sendJSON, notFound, badRequest, readBody,
  uid, load, companies, inRange, decorateInvoice,
  loadGlobal, saveGlobal, taxProfileForYear,
  tax1040, nj1040, elias, eliasP2, salestax, money
});

// -- sales tax (NJ ST-50 / ST-51) --
// -- sales tax + reporting views (dashboard, P&L, A/R aging) --
// Extracted into lib/routes/reports.js as the first slice of the incremental
// server split (Phase 6 / #25). Registered here, in place, so route order is
// unchanged; the handlers close over the deps passed below instead of this
// file's module scope.
require('./lib/routes/reports')(route, {
  sendJSON, readBody, badRequest, inRange,
  round2, uid, todayISO, decorateInvoice, commit,
  audit, salestax, money
});

// -- audit log --
// Surfaces the TAMPER-EVIDENT chain (the hash-chained file outside the mutable
// company-<id>.json), not db.auditLog — the forgeable copy that lives inside
// the very file it audits. Entries carry seq/hash and ship with the chain's
// verification result so the UI shows the record that actually resists forgery.
route('GET', '/api/audit', async (req, res, db, params, query) => {
  const limit = Math.min(Number(query.get('limit')) || 100, 500);
  let verified;
  try {
    verified = await audit.verify(req.companyId);
  } catch (e) {
    verified = { ok: false, entries: 0, error: e.message, atSeq: e.atSeq ?? null };
  }
  const entries = await audit.entries(req.companyId, limit);
  sendJSON(res, 200, { verified, entries });
});
// Integrity status of the tamper-evident chain: full re-verification on
// every call. { ok: true, entries } — or ok:false naming the first bad seq.
route('GET', '/api/audit/chain', async (req, res) => {
  try {
    sendJSON(res, 200, await audit.verify(req.companyId));
  } catch (e) {
    sendJSON(res, 200, { ok: false, entries: 0, error: e.message, atSeq: e.atSeq ?? null });
  }
});

// -- backup: the whole data directory as a plain tarball --
// This exports everything (Plaid access tokens, bank details, receipts), so
// it always requires a session whenever a password exists — even when auth is
// disabled via QUICKBUCKS_DISABLE_AUTH for a trusted network.
route('GET', '/api/backup', (req, res) => {
  if (loadGlobal().passwordHash && !auth.isAuthenticated(req)) {
    return sendJSON(res, 401, { error: 'Authentication required' });
  }
  const buf = backup.tarball();
  res.writeHead(200, {
    'Content-Type': 'application/x-tar',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="quickbucks-backup-${todayISO()}.tar"`
  });
  res.end(buf);
});

// Routes reachable without a session (login flow itself).
const PUBLIC_ROUTES = new Set(['/api/auth-status', '/api/login']);

// ---------- static files + dispatch ----------

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return notFound(res);
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for unknown non-API paths.
      if (!pathname.startsWith('/api/')) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
          if (e2) return notFound(res);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(idx);
        });
      }
      return notFound(res);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Serialize mutating requests per company (M7). The datastore is one shared
// in-memory object per company persisted with a whole-file save(); two write
// requests that interleave across their awaits (readBody, audit.append) can
// clobber each other's save or race the audit append. A per-company promise
// chain makes each non-GET request's read-modify-save-append run to completion
// before the next starts — the money mutation and its audit append land as one
// uninterrupted unit.
const companyLocks = new Map();
function withCompanyLock(companyId, fn) {
  const prev = companyLocks.get(companyId) || Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of the prior result
  // Keep the chain alive but never let a rejection wedge the queue. fn handles
  // its own errors, so this is belt-and-suspenders.
  companyLocks.set(companyId, next.then(() => {}, () => {}));
  return next;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const cookies = auth.parseCookies(req);
    const list = companies();
    const active = list.find(c => c.id === cookies.qb_company) || list[0];
    req.companyId = active.id;
    const db = load(active.id);
    const g = loadGlobal();
    const isPublic = PUBLIC_ROUTES.has(pathname);
    // First run (no password yet, auth not explicitly disabled): the API is
    // locked until the owner creates a password through the setup screen —
    // nothing is reachable anonymously out of the box. /api/password stays
    // reachable or setup could never complete.
    if (!g.passwordHash && !auth.authDisabled() && !isPublic && pathname !== '/api/password') {
      return sendJSON(res, 401, { error: 'Set a password to finish setup', setupRequired: true });
    }
    if (g.passwordHash && !auth.authDisabled() && !isPublic && !auth.isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Authentication required' });
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.rx);
      if (!m) continue;
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        // Malformed %-encoding in a route param — reject, don't crash.
        return badRequest(res, 'Malformed URL encoding');
      }
      const runHandler = async () => {
        try {
          await r.handler(req, res, db, params, url.searchParams);
        } catch (e) {
          badRequest(res, e.message || 'Bad request');
        }
        // Audit trail: who-did-what for every write — including login attempts,
        // so brute-force bursts are visible. Paths only — request bodies are
        // never logged (they can carry passwords and bank keys).
        if (req.method !== 'GET' && pathname !== '/api/auth-status') {
          db.auditLog.push({
            ts: new Date().toISOString(),
            method: req.method,
            path: pathname,
            status: res.statusCode
          });
          if (db.auditLog.length > 500) db.auditLog.splice(0, db.auditLog.length - 500);
          save(db);
          // Layer A: the same write, chained and tamper-evident. A chain
          // failure is loud (stderr), not a rollback — semantic money events
          // are awaited pre-response in the handlers themselves.
          try {
            await audit.append(req.companyId, 'http.write', {
              method: req.method, path: pathname, status: res.statusCode, actor: audit.actor(req)
            });
          } catch (e) {
            console.error('audit chain append failed:', e.message);
          }
        }
      };
      // GETs are read-only (M8) and need no lock; mutations serialize per
      // company so their read-modify-save-append cannot interleave (M7).
      if (req.method === 'GET') await runHandler();
      else await withCompanyLock(req.companyId, runHandler);
      return;
    }
    return notFound(res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  // Last-resort guard: an unexpected bug in any route must answer 500, not
  // kill the process (unhandled rejections crash modern Node).
  handleRequest(req, res).catch(err => {
    console.error('Unhandled request error:', err);
    try { sendJSON(res, 500, { error: 'Internal server error' }); } catch { /* socket already gone */ }
  });
});

if (require.main === module) {
  seedIfEmpty();
  // Redeliver any audit events a crash left owed in a company's outbox before
  // serving — a persisted mutation must never stay off the tamper-evident chain
  // (#24). Best-effort + logged: never fatal to boot.
  outbox.recoverAll(companies, load, save).catch(e => console.error('outbox recovery error:', e.message));
  backup.scheduleSnapshots();   // tar the data dir now and daily, keep 7
  scheduleRecurring();          // materialize due recurring invoices now and daily (never on a GET)
  if (auth.authDisabled()) {
    console.log('Warning: QUICKBUCKS_DISABLE_AUTH=1 — the API is unauthenticated (trusted-network mode)');
  }
  server.listen(PORT, HOST, () => {
    console.log(`QuickBucks running at http://${HOST}:${PORT}`);
  });
}

module.exports = { server, HOST };
