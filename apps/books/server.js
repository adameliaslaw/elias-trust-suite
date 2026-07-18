// QuickBucks — self-hosted small-business accounting app.
// Zero dependencies: Node's http module + a JSON file datastore.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, save, companies, createCompany, uid, decorateInvoice, round2, todayISO } = require('./lib/store');
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

function validCustomer(b) {
  if (!b.name || !String(b.name).trim()) return 'Customer name is required';
  return null;
}

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

function validExpense(b) {
  if (!b.vendor || !String(b.vendor).trim()) return 'Vendor is required';
  if (!b.date) return 'Date is required';
  if (!(Number(b.amount) > 0)) return 'Amount must be positive';
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
    return sendJSON(res, 401, { error: 'Incorrect password' });
  }
  auth.resetLoginFails(req);
  const token = auth.createSession();
  res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/logout', (req, res) => {
  auth.destroySession(auth.parseCookies(req).qb_session);
  res.setHeader('Set-Cookie', 'qb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
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
  res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
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
  res.setHeader('Set-Cookie', `qb_company=${company.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
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
  save(db);
  // Keep the household company registry in sync with the display name.
  if ('companyName' in b) {
    const reg = companies().find(c => c.id === req.companyId);
    if (reg) { reg.name = db.settings.companyName; saveGlobal(); }
  }
  sendJSON(res, 200, db.settings);
});
route('GET', '/api/categories', (req, res, db) => sendJSON(res, 200, db.expenseCategories));

// -- customers --
route('GET', '/api/customers', (req, res, db) => {
  const withBalances = db.customers.map(c => {
    const invs = db.invoices.filter(i => i.customerId === c.id).map(decorateInvoice);
    return {
      ...c,
      openBalance: round2(invs.filter(i => i.status !== 'draft').reduce((s, i) => s + i.balance, 0)),
      totalBilled: round2(invs.filter(i => i.status !== 'draft').reduce((s, i) => s + i.total, 0)),
      invoiceCount: invs.length
    };
  });
  sendJSON(res, 200, withBalances);
});
route('POST', '/api/customers', async (req, res, db) => {
  const b = await readBody(req);
  const err = validCustomer(b);
  if (err) return badRequest(res, err);
  const customer = {
    id: uid(),
    name: String(b.name).trim(),
    company: b.company || '',
    email: b.email || '',
    phone: b.phone || '',
    notes: b.notes || '',
    createdAt: todayISO()
  };
  db.customers.push(customer);
  save(db);
  sendJSON(res, 201, customer);
});
route('PUT', '/api/customers/:id', async (req, res, db, params) => {
  const c = db.customers.find(x => x.id === params.id);
  if (!c) return notFound(res);
  const b = await readBody(req);
  const err = validCustomer({ ...c, ...b });
  if (err) return badRequest(res, err);
  for (const k of ['name', 'company', 'email', 'phone', 'notes']) if (k in b) c[k] = b[k];
  save(db);
  sendJSON(res, 200, c);
});
route('DELETE', '/api/customers/:id', (req, res, db, params) => {
  const idx = db.customers.findIndex(x => x.id === params.id);
  if (idx === -1) return notFound(res);
  if (db.invoices.some(i => i.customerId === params.id)) {
    return badRequest(res, 'Cannot delete a customer with invoices. Delete their invoices first.');
  }
  db.customers.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { ok: true });
});

// -- invoices --
route('GET', '/api/invoices', (req, res, db) => {
  generateRecurring(db);
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

// Materialize any due recurring invoices before reads that show them.
function generateRecurring(db) {
  const created = recurring.generateDue(db, createInvoice, todayISO());
  if (created.length) save(db);
  return created;
}

route('POST', '/api/invoices', async (req, res, db) => {
  const b = await readBody(req);
  let inv;
  try {
    inv = createInvoice(db, b);
  } catch (e) {
    return badRequest(res, e.message);
  }
  save(db);
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
  save(db);
  sendJSON(res, 200, decorateInvoice(inv));
});
route('DELETE', '/api/invoices/:id', (req, res, db, params) => {
  const idx = db.invoices.findIndex(x => x.id === params.id);
  if (idx === -1) return notFound(res);
  db.invoices.splice(idx, 1);
  // Release any time entries billed on this invoice back to unbilled WIP.
  for (const t of db.timeEntries) if (t.invoiceId === params.id) t.invoiceId = null;
  save(db);
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/invoices/:id/payments', async (req, res, db, params) => {
  const inv = db.invoices.find(x => x.id === params.id);
  if (!inv) return notFound(res);
  const b = await readBody(req);
  const amount = Number(b.amount);
  if (!(amount > 0)) return badRequest(res, 'Payment amount must be positive');
  const balance = decorateInvoice(inv).balance;
  if (amount > balance + 0.005) return badRequest(res, `Payment exceeds remaining balance ($${balance.toFixed(2)})`);
  inv.payments.push({ id: uid(), date: b.date || todayISO(), amount: round2(amount), method: b.method || 'Other' });
  inv.draft = false;
  save(db);
  sendJSON(res, 200, decorateInvoice(inv));
});
route('POST', '/api/invoices/:id/send', (req, res, db, params) => {
  const inv = db.invoices.find(x => x.id === params.id);
  if (!inv) return notFound(res);
  inv.draft = false;
  save(db);
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
  let imported = 0, duplicates = 0;
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
    const total = decorateInvoice(inv).total;
    inv.payments.push({ id: uid(), date: day.date, amount: total, method: 'Card' });
    inv.draft = false;
    existing.add(key);
    imported++;
    const computedTax = round2(total - day.netSales);
    if (day.tax && Math.abs(computedTax - day.tax) > 0.02) {
      warnings.push(`${day.date}: POS reported ${day.tax.toFixed(2)} tax but the books computed ${computedTax.toFixed(2)} — check the rate in Settings`);
    }
  }
  if (!taxOn && parsed.days.some(d => d.tax > 0)) {
    warnings.unshift('The POS collected sales tax but this company has sales tax turned off in Settings — imported sales were booked without tax');
  }
  save(db);
  sendJSON(res, 200, { imported, duplicates, tipsTotal: parsed.tipsTotal, skipped: parsed.info.skipped, warnings });
});

// -- recurring invoices --
route('GET', '/api/recurring', (req, res, db) => {
  const list = db.recurringInvoices.map(tpl => {
    const c = db.customers.find(x => x.id === tpl.customerId);
    return { ...tpl, customerName: c ? (c.company || c.name) : '(deleted)' };
  });
  sendJSON(res, 200, list);
});
route('POST', '/api/recurring', async (req, res, db) => {
  const b = await readBody(req);
  const tpl = recurring.sanitizeTemplate(b);
  const err = validInvoice({ customerId: tpl.customerId, date: tpl.nextDate, items: tpl.items }, db);
  if (err) return badRequest(res, err);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tpl.nextDate)) return badRequest(res, 'A first bill date is required');
  db.recurringInvoices.push(tpl);
  generateRecurring(db);   // a first date of today (or earlier) bills immediately
  save(db);
  sendJSON(res, 201, tpl);
});
route('PUT', '/api/recurring/:id', async (req, res, db, params) => {
  const idx = db.recurringInvoices.findIndex(t => t.id === params.id);
  if (idx === -1) return notFound(res);
  const b = await readBody(req);
  const tpl = recurring.sanitizeTemplate(b, db.recurringInvoices[idx]);
  db.recurringInvoices[idx] = tpl;
  save(db);
  sendJSON(res, 200, tpl);
});
route('DELETE', '/api/recurring/:id', (req, res, db, params) => {
  const idx = db.recurringInvoices.findIndex(t => t.id === params.id);
  if (idx === -1) return notFound(res);
  db.recurringInvoices.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { ok: true });
});

// -- billable time --
route('GET', '/api/time', (req, res, db, params, query) => {
  const status = query.get('status') || 'all';
  const customerId = query.get('customerId');
  let list = db.timeEntries.map(t => {
    const c = db.customers.find(x => x.id === t.customerId);
    return { ...timetracking.decorateEntry(t), customerName: c ? (c.company || c.name) : '(deleted)' };
  });
  if (status !== 'all') list = list.filter(t => t.status === status);
  if (customerId) list = list.filter(t => t.customerId === customerId);
  list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  sendJSON(res, 200, list);
});
route('GET', '/api/time/wip', (req, res, db) => sendJSON(res, 200, timetracking.wipByCustomer(db)));
route('POST', '/api/time', async (req, res, db) => {
  const b = await readBody(req);
  const { error, entry } = timetracking.sanitizeEntry(b, db);
  if (error) return badRequest(res, error);
  db.timeEntries.push(entry);
  save(db);
  sendJSON(res, 201, timetracking.decorateEntry(entry));
});
route('PUT', '/api/time/:id', async (req, res, db, params) => {
  const idx = db.timeEntries.findIndex(t => t.id === params.id);
  if (idx === -1) return notFound(res);
  if (db.timeEntries[idx].invoiceId) return badRequest(res, 'This entry is on an invoice. Delete the invoice to release it.');
  const b = await readBody(req);
  const { error, entry } = timetracking.sanitizeEntry(b, db, db.timeEntries[idx]);
  if (error) return badRequest(res, error);
  db.timeEntries[idx] = entry;
  save(db);
  sendJSON(res, 200, timetracking.decorateEntry(entry));
});
route('DELETE', '/api/time/:id', (req, res, db, params) => {
  const idx = db.timeEntries.findIndex(t => t.id === params.id);
  if (idx === -1) return notFound(res);
  if (db.timeEntries[idx].invoiceId) return badRequest(res, 'This entry is on an invoice. Delete the invoice to release it.');
  db.timeEntries.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { ok: true });
});
// Roll a customer's unbilled time (optionally a subset by entryIds) into a
// draft invoice, one line per entry.
route('POST', '/api/time/invoice', async (req, res, db) => {
  const b = await readBody(req);
  const entries = timetracking.billableEntries(db, b.customerId, b.entryIds);
  if (!entries.length) return badRequest(res, 'No unbilled time for that customer');
  let inv;
  try {
    inv = createInvoice(db, {
      customerId: b.customerId,
      date: b.date || todayISO(),
      dueDate: b.dueDate || recurring.addDaysIso(b.date || todayISO(), db.settings.defaultTermsDays || 30),
      items: timetracking.invoiceItems(entries),
      draft: true,
      notes: b.notes || ''
    });
  } catch (e) {
    return badRequest(res, e.message);
  }
  for (const t of entries) t.invoiceId = inv.id;
  save(db);
  sendJSON(res, 201, { ...decorateInvoice(inv), entriesBilled: entries.length });
});

// -- expenses --
route('GET', '/api/expenses', (req, res, db) => {
  const list = [...db.expenses].sort((a, b) => b.date.localeCompare(a.date));
  sendJSON(res, 200, list);
});
route('POST', '/api/expenses', async (req, res, db) => {
  const b = await readBody(req);
  const err = validExpense(b);
  if (err) return badRequest(res, err);
  const exp = {
    id: uid(),
    date: b.date,
    vendor: String(b.vendor).trim(),
    category: b.category || 'Other',
    amount: round2(Number(b.amount)),
    paymentMethod: b.paymentMethod || 'Other',
    notes: b.notes || '',
    createdAt: todayISO()
  };
  db.expenses.push(exp);
  save(db);
  sendJSON(res, 201, exp);
});
route('PUT', '/api/expenses/:id', async (req, res, db, params) => {
  const exp = db.expenses.find(x => x.id === params.id);
  if (!exp) return notFound(res);
  const b = await readBody(req);
  const err = validExpense({ ...exp, ...b });
  if (err) return badRequest(res, err);
  for (const k of ['date', 'vendor', 'category', 'paymentMethod', 'notes']) if (k in b) exp[k] = b[k];
  if ('amount' in b) exp.amount = round2(Number(b.amount));
  save(db);
  sendJSON(res, 200, exp);
});
route('DELETE', '/api/expenses/:id', (req, res, db, params) => {
  const idx = db.expenses.findIndex(x => x.id === params.id);
  if (idx === -1) return notFound(res);
  receipts.deleteReceipt(db.expenses[idx].receipt);
  db.expenses.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { ok: true });
});

// -- 1099-NEC vendor tracking --
// Totals paid per vendor for a year, from the expense ledger. Card
// payments are excluded from the reportable total (the card issuer
// reports those on 1099-K); payroll categories are excluded entirely
// (employees get W-2s). Mark the vendors that are 1099-eligible
// (unincorporated service providers); TINs/W-9s stay on paper — this app
// deliberately does not store them.
route('GET', '/api/vendors/1099', (req, res, db, params, query) => {
  const year = String(Number(query.get('year')) || new Date().getFullYear());
  const tracked = new Set(db.vendors1099.map(v => v.toLowerCase()));
  const byVendor = new Map();
  for (const e of db.expenses) {
    if (!e.date.startsWith(year)) continue;
    if (e.category === 'Payroll' || e.category === 'Payroll Taxes') continue;
    const name = (e.vendor || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byVendor.has(key)) byVendor.set(key, { name, reportable: 0, cardTotal: 0, total: 0 });
    const v = byVendor.get(key);
    v.total = round2(v.total + e.amount);
    if (e.paymentMethod === 'Credit card') v.cardTotal = round2(v.cardTotal + e.amount);
    else v.reportable = round2(v.reportable + e.amount);
  }
  // Tracked vendors with no expenses this year still show, at zero.
  for (const name of db.vendors1099) {
    const key = name.toLowerCase();
    if (!byVendor.has(key)) byVendor.set(key, { name, reportable: 0, cardTotal: 0, total: 0 });
  }
  const vendors = [...byVendor.values()].map(v => ({
    ...v,
    tracked: tracked.has(v.name.toLowerCase()),
    needs1099: tracked.has(v.name.toLowerCase()) && v.reportable >= 600
  })).sort((a, b) => b.reportable - a.reportable || a.name.localeCompare(b.name));
  sendJSON(res, 200, { year: Number(year), threshold: 600, vendors });
});
route('POST', '/api/vendors/1099', async (req, res, db) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) return badRequest(res, 'A vendor name is required');
  const idx = db.vendors1099.findIndex(v => v.toLowerCase() === name.toLowerCase());
  if (b.tracked && idx === -1) db.vendors1099.push(name);
  if (!b.tracked && idx !== -1) db.vendors1099.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { name, tracked: !!b.tracked });
});

// -- receipt attachments (photo or PDF, base64 in; streamed bytes out) --
route('POST', '/api/expenses/:id/receipt', async (req, res, db, params) => {
  const exp = db.expenses.find(x => x.id === params.id);
  if (!exp) return notFound(res);
  let b;
  try {
    b = await readBody(req, 15e6);   // ~10 MB file once base64 overhead comes off
  } catch (e) {
    return badRequest(res, e.message);
  }
  const { error, receipt } = receipts.saveReceipt(req.companyId, exp.id, b);
  if (error) return badRequest(res, error);
  if (exp.receipt && exp.receipt.filename !== receipt.filename) receipts.deleteReceipt(exp.receipt);
  exp.receipt = receipt;
  save(db);
  sendJSON(res, 200, exp);
});
route('GET', '/api/expenses/:id/receipt', (req, res, db, params) => {
  const exp = db.expenses.find(x => x.id === params.id);
  if (!exp || !exp.receipt) return notFound(res);
  const file = receipts.readReceipt(exp.receipt);
  if (!file) return notFound(res);
  res.writeHead(200, {
    'Content-Type': file.mime,
    'Content-Length': file.buffer.length,
    'Content-Disposition': `inline; filename="${exp.receipt.filename}"`
  });
  res.end(file.buffer);
});
route('DELETE', '/api/expenses/:id/receipt', (req, res, db, params) => {
  const exp = db.expenses.find(x => x.id === params.id);
  if (!exp || !exp.receipt) return notFound(res);
  receipts.deleteReceipt(exp.receipt);
  delete exp.receipt;
  save(db);
  sendJSON(res, 200, exp);
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
  let added = 0;
  const errors = [];
  for (const conn of db.bankConnections) {
    try {
      added += await syncConnection(db, conn);
    } catch (e) {
      errors.push(`${conn.institution}: ${e.message}`);
    }
  }
  save(db);
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
  let added = 0, duplicates = 0;
  for (const t of transactions) {
    if (existing.has(txnKey(t))) { duplicates++; continue; }
    existing.add(txnKey(t));
    db.bankTransactions.push({
      id: uid(),
      source: 'csv',
      accountLabel: b.accountLabel || 'Imported',
      date: t.date,
      name: t.name,
      amount: round2(t.amount),
      status: 'new'
    });
    added++;
  }
  save(db);
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
  const balance = decorateInvoice(inv).balance;
  if (t.amount > balance + 0.005) {
    return badRequest(res, `Deposit (${t.amount.toFixed(2)}) exceeds the invoice balance (${balance.toFixed(2)})`);
  }
  inv.payments.push({ id: uid(), date: t.date, amount: round2(t.amount), method: 'Bank transfer' });
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

route('GET', '/api/payroll/settings', (req, res, db) => {
  sendJSON(res, 200, payroll.payrollSettings(db));
});
route('PUT', '/api/payroll/settings', async (req, res, db) => {
  const b = await readBody(req);
  const current = payroll.payrollSettings(db);
  const next = { ...current };
  if ('njEmployerUiRate' in b || 'njEmployerTdiRate' in b) {
    const ui = Number(b.njEmployerUiRate ?? current.njEmployerUiRate);
    const tdi = Number(b.njEmployerTdiRate ?? current.njEmployerTdiRate);
    if (isNaN(ui) || ui < 0 || ui > 0.2 || isNaN(tdi) || tdi < 0 || tdi > 0.2) {
      return badRequest(res, 'Rates must be decimals between 0 and 0.2 (e.g. 0.031 for 3.1%)');
    }
    next.njEmployerUiRate = ui;
    next.njEmployerTdiRate = tdi;
  }
  if ('depositSchedule' in b) {
    if (!['monthly', 'semiweekly'].includes(b.depositSchedule)) return badRequest(res, 'Deposit schedule must be monthly or semiweekly');
    next.depositSchedule = b.depositSchedule;
  }
  if ('njPayerType' in b) {
    if (!['weekly', 'monthly', 'quarterly'].includes(b.njPayerType)) return badRequest(res, 'NJ payer type must be weekly, monthly, or quarterly');
    next.njPayerType = b.njPayerType;
  }
  if ('ein' in b) next.ein = String(b.ein).trim();
  if ('njTaxpayerId' in b) {
    const digits = String(b.njTaxpayerId).replace(/\D/g, '');
    if (digits && digits.length !== 12) return badRequest(res, 'NJ taxpayer ID is 12 digits (EIN + suffix, usually 000)');
    next.njTaxpayerId = digits;
  }
  if (b.ach) {
    for (const k of ['bankRouting', 'bankAccount', 'immediateDestination', 'immediateOrigin', 'destinationName']) {
      if (k in b.ach) next.ach[k] = String(b.ach[k]).trim();
    }
  }
  if (b.njAch) {
    for (const k of ['routing', 'account']) {
      if (k in b.njAch) next.njAch[k] = String(b.njAch[k]).trim();
    }
  }
  db.settings.payroll = next;
  save(db);
  sendJSON(res, 200, next);
});

route('GET', '/api/payroll/employees', (req, res, db) => {
  sendJSON(res, 200, db.employees);
});
route('POST', '/api/payroll/employees', async (req, res, db) => {
  const b = await readBody(req);
  const emp = payroll.sanitizeEmployee(b);
  const err = payroll.validateEmployee(emp);
  if (err) return badRequest(res, err);
  db.employees.push(emp);
  save(db);
  sendJSON(res, 201, emp);
});
route('PUT', '/api/payroll/employees/:id', async (req, res, db, params) => {
  const idx = db.employees.findIndex(e => e.id === params.id);
  if (idx === -1) return notFound(res);
  const b = await readBody(req);
  const emp = payroll.sanitizeEmployee(b, db.employees[idx]);
  const err = payroll.validateEmployee(emp);
  if (err) return badRequest(res, err);
  db.employees[idx] = emp;
  // Draft runs hold a snapshot of inputs only; recompute them so previews
  // reflect the edited employee.
  for (const run of db.payRuns) {
    if (run.status === 'draft') payroll.computeRun(db, run);
  }
  save(db);
  sendJSON(res, 200, emp);
});
route('DELETE', '/api/payroll/employees/:id', (req, res, db, params) => {
  const idx = db.employees.findIndex(e => e.id === params.id);
  if (idx === -1) return notFound(res);
  if (db.payRuns.some(r => r.checks.some(c => c.employeeId === params.id))) {
    return badRequest(res, 'This employee has paychecks on record — mark them inactive instead of deleting');
  }
  db.employees.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { ok: true });
});

route('GET', '/api/payroll/runs', (req, res, db) => {
  const list = db.payRuns.map(r => ({
    id: r.id, payDate: r.payDate, periodStart: r.periodStart, periodEnd: r.periodEnd,
    status: r.status, totals: r.totals, employees: r.checks.length
  })).sort((a, b) => b.payDate.localeCompare(a.payDate));
  sendJSON(res, 200, list);
});
route('POST', '/api/payroll/runs', async (req, res, db) => {
  const b = await readBody(req);
  if (!b.payDate || !b.periodStart || !b.periodEnd) {
    return badRequest(res, 'Pay date and period start/end are required');
  }
  if (!db.employees.some(e => e.active)) return badRequest(res, 'Add at least one active employee first');
  const s = payroll.payrollSettings(db);
  if (!(s.njEmployerUiRate > 0)) {
    return badRequest(res, 'Enter your NJ employer UI (and TDI) rates in Payroll settings first — they are on your NJ rate notice');
  }
  try {
    const run = payroll.newRun(db, b);
    db.payRuns.push(run);
    save(db);
    sendJSON(res, 201, run);
  } catch (e) {
    badRequest(res, e.message);
  }
});
route('GET', '/api/payroll/runs/:id', (req, res, db, params) => {
  const run = db.payRuns.find(r => r.id === params.id);
  if (!run) return notFound(res);
  sendJSON(res, 200, { ...run, company: db.settings.companyName });
});
route('PUT', '/api/payroll/runs/:id', async (req, res, db, params) => {
  const run = db.payRuns.find(r => r.id === params.id);
  if (!run) return notFound(res);
  if (run.status !== 'draft') return badRequest(res, 'This run is finalized and can no longer be edited');
  const b = await readBody(req);
  if (Array.isArray(b.checks)) {
    for (const incoming of b.checks) {
      const chk = run.checks.find(c => c.employeeId === incoming.employeeId);
      if (!chk || !incoming.inputs) continue;
      for (const k of ['hours', 'otHours', 'bonus', 'tips', 'reimbursement']) {
        if (k in incoming.inputs) {
          const v = Number(incoming.inputs[k]);
          if (isNaN(v) || v < 0) return badRequest(res, 'Inputs must be non-negative numbers');
          chk.inputs[k] = v;
        }
      }
    }
  }
  for (const k of ['payDate', 'periodStart', 'periodEnd']) if (b[k]) run[k] = b[k];
  try {
    payroll.computeRun(db, run);
  } catch (e) {
    return badRequest(res, e.message);
  }
  save(db);
  sendJSON(res, 200, run);
});
// Import a Dripos (or similar) timecard CSV into a draft run: hours,
// weekly overtime, and card tips per matched employee.
route('POST', '/api/payroll/runs/:id/import-timecards', async (req, res, db, params) => {
  const run = db.payRuns.find(r => r.id === params.id);
  if (!run) return notFound(res);
  if (run.status !== 'draft') return badRequest(res, 'Timecards can only be imported into a draft run');
  const b = await readBody(req);
  if (!b.csv || !String(b.csv).trim()) return badRequest(res, 'CSV content is required');
  let parsed;
  try {
    parsed = timecards.parseTimecards(String(b.csv));
  } catch (e) {
    return badRequest(res, e.message);
  }
  let updated = 0;
  const unmatched = [], notInRun = [];
  for (const person of parsed.rows) {
    const emp = timecards.matchEmployee(person, db.employees);
    if (!emp) { unmatched.push(person.name || person.email); continue; }
    const chk = run.checks.find(c => c.employeeId === emp.id);
    if (!chk) { notInRun.push(`${emp.firstName} ${emp.lastName}`); continue; }
    chk.inputs.hours = person.hours;
    chk.inputs.otHours = person.otHours;
    chk.inputs.tips = person.tips;
    updated++;
  }
  try {
    payroll.computeRun(db, run);
  } catch (e) {
    return badRequest(res, e.message);
  }
  save(db);
  sendJSON(res, 200, { updated, unmatched, notInRun, otSource: parsed.info.otSource, run });
});

route('DELETE', '/api/payroll/runs/:id', (req, res, db, params) => {
  const idx = db.payRuns.findIndex(r => r.id === params.id);
  if (idx === -1) return notFound(res);
  if (db.payRuns[idx].status !== 'draft') {
    return badRequest(res, 'Finalized runs cannot be deleted — they are part of your payroll record');
  }
  db.payRuns.splice(idx, 1);
  save(db);
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/payroll/runs/:id/finalize', (req, res, db, params) => {
  const run = db.payRuns.find(r => r.id === params.id);
  if (!run) return notFound(res);
  if (run.status !== 'draft') return badRequest(res, 'This run is already finalized');
  try {
    payroll.computeRun(db, run);   // recompute against latest YTD, then freeze
  } catch (e) {
    return badRequest(res, e.message);
  }
  if (run.checks.some(c => !c.computed)) {
    return badRequest(res, 'A paycheck on this run could not be computed — review the run first');
  }
  run.status = 'finalized';
  run.finalizedAt = todayISO();
  // Post the cash that actually leaves on payday (net pay) to the books.
  // Withheld and employer taxes accrue as liabilities and hit the books
  // when each deposit is recorded.
  const exp = {
    id: uid(),
    date: run.payDate,
    vendor: 'Payroll (net pay)',
    category: 'Payroll',
    amount: run.totals.net,
    paymentMethod: 'Bank transfer',
    notes: `Pay run ${run.periodStart} – ${run.periodEnd}, ${run.checks.length} employee(s)`,
    createdAt: todayISO()
  };
  db.expenses.push(exp);
  run.postedExpenseId = exp.id;
  save(db);
  sendJSON(res, 200, run);
});

// Deposit calendar: obligations grouped by deposit rule, with due dates and
// what has been recorded against each (spec: IRS Pub 15 / NJ-WT schedules).
route('GET', '/api/payroll/deposits', (req, res, db, params, query) => {
  const year = Number(query.get('year')) || new Date().getFullYear();
  const s = payroll.payrollSettings(db);
  const withPaid = (list, bucket) => list.map(g => ({
    ...g,
    bucket,
    paid: deposits.paidFor(db, bucket, g.key),
    outstanding: round2(Math.max(g.amount - deposits.paidFor(db, bucket, g.key), 0))
  }));
  const quarters = [1, 2, 3, 4].filter(q => deposits.quarterEnd(year, q) <= todayISO() ||
    db.payRuns.some(r => r.status === 'finalized' && Number(r.payDate.slice(0, 4)) === year && deposits.quarterOf(r.payDate) === q));
  sendJSON(res, 200, {
    year,
    settings: { depositSchedule: s.depositSchedule, njPayerType: s.njPayerType },
    achConfigured: payroll.achConfigured(s),
    njAchConfigured: !!(s.njAch.routing && s.njAch.account && s.njTaxpayerId),
    federal: withPaid(deposits.federalLiabilities(db, year, s.depositSchedule), 'federal_941'),
    njGit: withPaid(deposits.njGitLiabilities(db, year, s.njPayerType), 'nj_git'),
    nj927: withPaid(quarters.map(q => deposits.nj927Contributions(db, year, q)).filter(g => g.amount > 0), 'nj_dol'),
    futa: withPaid(deposits.futaLiabilities(db, year), 'futa')
  });
});

// Bank-ready NACHA CCD+/TXP file for one tax obligation. Downloading is the
// action — upload it to your bank's ACH origination portal, then record the
// deposit so the ledger and books agree.
route('GET', '/api/payroll/nacha/tax', (req, res, db, params, query) => {
  const s = payroll.payrollSettings(db);
  if (!payroll.achConfigured(s)) {
    return badRequest(res, 'Enter your EIN and ACH origination details in Payroll settings first');
  }
  const bucket = query.get('bucket');
  const key = query.get('key');
  const year = Number(query.get('year')) || new Date().getFullYear();
  const groups = {
    federal_941: () => deposits.federalLiabilities(db, year, s.depositSchedule),
    futa: () => deposits.futaLiabilities(db, year),
    nj_git: () => deposits.njGitLiabilities(db, year, s.njPayerType),
    nj_dol: () => [1, 2, 3, 4].map(q => deposits.nj927Contributions(db, year, q))
  }[bucket];
  if (!groups) return badRequest(res, 'Unknown deposit bucket');
  const g = groups().find(x => x.key === key);
  if (!g) return notFound(res);
  const amount = round2(Math.max(g.amount - deposits.paidFor(db, bucket, g.key), 0));
  if (!(amount > 0)) return badRequest(res, 'Nothing outstanding for this obligation');

  const company = {
    name: db.settings.companyName, ein: s.ein,
    bankRouting: s.ach.bankRouting,
    immediateDestination: s.ach.immediateDestination,
    immediateOrigin: s.ach.immediateOrigin,
    destinationName: s.ach.destinationName
  };
  let payment;
  const qEnd = deposits.quarterEnd(year, deposits.quarterOf(g.periodEnd));
  if (bucket === 'federal_941') {
    const addenda = nacha.eftpsTxp(s.ein, nacha.FED_941_DEPOSIT, g.periodEnd, amount, [
      [nacha.SUB_SOCIAL_SECURITY, g.ss],
      [nacha.SUB_MEDICARE, g.medicare],
      [nacha.SUB_WITHHOLDING, round2(amount - g.ss - g.medicare)]
    ]);
    payment = { routing: nacha.TREASURY_ROUTING, account: nacha.TREASURY_ACCOUNT, receiverName: nacha.TREASURY_NAME, amount, addenda, description: 'TAXPAYMENT', identification: s.ein };
  } else if (bucket === 'futa') {
    const addenda = nacha.eftpsTxp(s.ein, nacha.FED_940_DEPOSIT, g.periodEnd, amount);
    payment = { routing: nacha.TREASURY_ROUTING, account: nacha.TREASURY_ACCOUNT, receiverName: nacha.TREASURY_NAME, amount, addenda, description: 'TAXPAYMENT', identification: s.ein };
  } else {
    if (!s.njAch.routing || !s.njAch.account || !s.njTaxpayerId) {
      return badRequest(res, 'Enter your NJ taxpayer ID and the State bank details from your EFT1-C reply in Payroll settings');
    }
    // NJ TXP period is always the QUARTER end; code depends on payer type/bucket.
    const code = bucket === 'nj_dol' ? nacha.NJ_LABOR_CONTRIBUTIONS
      : s.njPayerType === 'weekly' ? nacha.NJ_GIT_WEEKLY
      : (g.key.includes('-Q') ? nacha.NJ_GIT_QUARTERLY : nacha.NJ_GIT_MONTHLY);
    const addenda = nacha.njTxp(s.njTaxpayerId, code, qEnd, amount, db.settings.companyName);
    payment = { routing: s.njAch.routing, account: s.njAch.account, receiverName: 'STATE OF NEW JERSEY', amount, addenda, description: 'TAXPAYMENT', identification: s.ein };
  }
  const today = todayISO();
  const content = nacha.buildTaxPaymentFile(company, payment, { date: today, time: '0900' }, g.due >= today ? g.due : today);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="ach-${bucket}-${key}.ach"`
  });
  res.end(content);
});

// PPD direct-deposit file for a finalized pay run.
route('GET', '/api/payroll/runs/:id/nacha', (req, res, db, params) => {
  const run = db.payRuns.find(r => r.id === params.id);
  if (!run) return notFound(res);
  if (run.status !== 'finalized') return badRequest(res, 'Finalize the run before generating a direct-deposit file');
  const s = payroll.payrollSettings(db);
  if (!payroll.achConfigured(s)) {
    return badRequest(res, 'Enter your EIN and ACH origination details in Payroll settings first');
  }
  const entries = [];
  for (const chk of run.checks) {
    const emp = db.employees.find(e => e.id === chk.employeeId);
    if (!emp || emp.paymentMethod !== 'direct_deposit' || !chk.computed || !(chk.computed.net > 0)) continue;
    entries.push({
      name: `${emp.firstName} ${emp.lastName}`,
      routing: emp.bankRouting, account: emp.bankAccount,
      accountType: emp.bankAccountType, amount: chk.computed.net, id: emp.id
    });
  }
  if (!entries.length) {
    return badRequest(res, 'No employees on this run are set to direct deposit with bank details');
  }
  const company = {
    name: db.settings.companyName, ein: s.ein,
    bankRouting: s.ach.bankRouting,
    immediateDestination: s.ach.immediateDestination,
    immediateOrigin: s.ach.immediateOrigin,
    destinationName: s.ach.destinationName
  };
  const today = todayISO();
  const content = nacha.buildPpdFile(company, entries, { date: today, time: '0900' },
    run.payDate >= today ? run.payDate : today);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="payroll-${run.payDate}.ach"`
  });
  res.end(content);
});

// Quarterly/annual filings figures (941, NJ-927/WR-30, 940).
route('GET', '/api/payroll/filings', (req, res, db, params, query) => {
  const year = Number(query.get('year')) || new Date().getFullYear();
  const quarter = Math.min(Math.max(Number(query.get('quarter')) || deposits.quarterOf(todayISO()), 1), 4);
  try {
    sendJSON(res, 200, {
      year, quarter,
      depositSchedule: payroll.payrollSettings(db).depositSchedule,
      f941: filings.compute941(db, year, quarter),
      nj927: filings.computeNj927(db, year, quarter),
      wr30: filings.computeWr30(db, year, quarter),
      f940: filings.compute940(db, year)
    });
  } catch (e) {
    badRequest(res, e.message);
  }
});

route('GET', '/api/payroll/liabilities', (req, res, db) => {
  sendJSON(res, 200, {
    buckets: payroll.liabilities(db),
    deposits: [...db.payrollDeposits].sort((a, b) => b.date.localeCompare(a.date))
  });
});
route('POST', '/api/payroll/liabilities/deposit', async (req, res, db) => {
  const b = await readBody(req);
  const bucket = payroll.LIABILITY_BUCKETS[b.bucket];
  if (!bucket) return badRequest(res, 'Unknown liability bucket');
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) return badRequest(res, 'Deposit amount must be positive');
  const balance = payroll.liabilities(db).find(l => l.bucket === b.bucket).balance;
  if (amount > balance + 0.005) {
    return badRequest(res, `Deposit exceeds the outstanding balance ($${balance.toFixed(2)})`);
  }
  const exp = {
    id: uid(),
    date: b.date || todayISO(),
    vendor: bucket.payee,
    category: 'Payroll Taxes',
    amount,
    paymentMethod: b.paymentMethod || 'Bank transfer',
    notes: b.note || bucket.label,
    createdAt: todayISO()
  };
  db.expenses.push(exp);
  const dep = { id: uid(), bucket: b.bucket, periodKey: b.periodKey || '', amount, date: exp.date, note: b.note || '', expenseId: exp.id };
  db.payrollDeposits.push(dep);
  save(db);
  sendJSON(res, 200, { deposit: dep, expense: exp, buckets: payroll.liabilities(db) });
});

// -- household taxes (1040 planning across all companies) --

// Cash-basis Schedule C figures for one company for a calendar year.
function companyYtd(companyId, year) {
  const cdb = load(companyId);
  const from = `${year}-01-01`, to = `${year}-12-31`;
  let income = 0;
  for (const inv of cdb.invoices) {
    if (inv.draft) continue;
    const dInv = decorateInvoice(inv);
    for (const p of inv.payments || []) {
      if (inRange(p.date, from, to)) income += salestax.paymentIncomeParts(dInv, p).income;
    }
  }
  let expenses = 0;
  for (const e of cdb.expenses) {
    if (inRange(e.date, from, to)) expenses += e.amount;
  }
  let meals = 0;     // for the SEB non-deducted-50% subtraction
  for (const e of cdb.expenses) {
    if (e.category === 'Meals & Entertainment' && inRange(e.date, from, to)) meals += e.amount;
  }
  let w2Wages = 0;   // gross payroll wages paid, for the QBI wage limit
  for (const run of cdb.payRuns) {
    if (run.status !== 'finalized' || Number(run.payDate.slice(0, 4)) !== year) continue;
    w2Wages += run.totals ? run.totals.gross : 0;
  }
  return {
    income: round2(income),
    expenses: round2(expenses),
    netProfit: round2(income - expenses),
    mealsExpense: round2(meals),
    w2Wages: round2(w2Wages)
  };
}

function householdInput(g, year, adjustments = {}) {
  const p = taxProfileForYear(g, year);
  const perCompany = adjustments.companies || {};
  const businesses = companies().map(c => {
    const ytd = companyYtd(c.id, year);
    const adj = perCompany[c.id] || {};
    return {
      id: c.id,
      name: c.name,
      ytd,
      netProfit: round2(ytd.netProfit + (Number(adj.incomeDelta) || 0) - (Number(adj.expenseDelta) || 0)),
      w2Wages: ytd.w2Wages,
      sstb: !!p.companySstb[c.id]
    };
  });
  const se = g.scheduleElias;
  const portfolio = elias.portfolioAnalysis(se.properties, se.settings, adjustments.depreciationStrategy, year);
  const mode = adjustments.sec469Handling || se.settings.sec469Handling;
  let schENet = portfolio.scheduleENetTotal;
  let handling = mode;
  let sec469 = null;
  if (mode === 'phase2') {
    // Form 8582 measures the phase-out against MAGI computed WITHOUT the
    // rental loss — probe the estimate once with Schedule E zeroed.
    const probe = tax1040.estimate1040({
      year, filingStatus: p.filingStatus, businesses,
      scheduleE: { net: 0, sec469Handling: 'allow', qbiSafeHarbor: false },
      wages: (Number(p.wages) || 0) + (Number(adjustments.wagesDelta) || 0),
      otherIncome: (Number(p.otherIncome) || 0) + (Number(adjustments.otherIncomeDelta) || 0),
      adjustments: (Number(p.adjustments) || 0) + (Number(adjustments.adjustmentsDelta) || 0),
      itemizedDeductions: (Number(p.itemizedDeductions) || 0) + (Number(adjustments.itemizedDelta) || 0)
    });
    sec469 = eliasP2.resolve469(schENet, {
      carryforward: se.settings.suspendedCarryforward,
      activeParticipation: se.settings.activeParticipation !== false,
      reProfessional: !!se.settings.reProfessional,
      magiBeforeRental: probe.agi
    });
    schENet = sec469.line5;
    handling = 'allow';   // already resolved — pass through unmodified
  }
  return {
    year,
    filingStatus: p.filingStatus,
    businesses,
    scheduleE: {
      net: schENet,
      sec469Handling: handling,
      qbiSafeHarbor: se.settings.qbiSafeHarbor
    },
    sec469,
    portfolio,
    wages: (Number(p.wages) || 0) + (Number(adjustments.wagesDelta) || 0),
    fedWithholding: Number(p.fedWithholding) || 0,
    otherIncome: (Number(p.otherIncome) || 0) + (Number(adjustments.otherIncomeDelta) || 0),
    adjustments: (Number(p.adjustments) || 0) + (Number(adjustments.adjustmentsDelta) || 0),
    itemizedDeductions: (Number(p.itemizedDeductions) || 0) + (Number(adjustments.itemizedDelta) || 0),
    credits: Number(p.credits) || 0,
    estimatedPayments: Number(p.estimatedPayments) || 0
  };
}

// NJ-1040 estimate from the same inputs: business category floored (losses
// never offset wages under NJ law), rentals floored, no federal deductions.
function njEstimateFor(input, profile) {
  return nj1040.estimateNJ1040({
    filingStatus: input.filingStatus,
    wages: input.wages,
    businesses: undefined,
    businessNet: input.businesses.reduce((s, b) => s + b.netProfit, 0),
    rentalNet: input.portfolio ? input.portfolio.scheduleENetTotal : 0,
    otherIncome: input.otherIncome,
    njDependents: profile.njDependents,
    propertyTaxPaid: profile.propertyTaxPaid,
    njWithholding: profile.njWithholding,
    njEstimatedPayments: profile.njEstimatedPayments
  });
}

// Lender-side computation for the household (Schedule Elias §§5-7).
// Company income/expense scenario deltas flow into SEB so the comparison can
// show what an expense change does to qualifying income, not just tax.
function householdLender(g, input) {
  const se = g.scheduleElias;
  const sebByCompany = input.businesses.map(b => ({
    id: b.id,
    name: b.name,
    seb: elias.sebAnalysis(
      { netProfit: b.netProfit, mealsExpense: b.ytd.mealsExpense },
      elias.sanitizeSeb(se.seb[b.id]))
  }));
  return {
    sebByCompany,
    portfolio: input.portfolio,
    borrowing: elias.borrowingAnalysis(se.borrower, sebByCompany, input.portfolio, se.settings.dtiTargetPct)
  };
}

route('GET', '/api/household/tax', (req, res, db, params, query) => {
  const year = Number(query.get('year')) || tax1040.YEAR;
  if (!tax1040.YEARS[year]) {
    return badRequest(res, `Supported tax years: ${tax1040.SUPPORTED_YEARS.join(', ')}`);
  }
  const g = loadGlobal();
  const input = householdInput(g, year);
  const lender = householdLender(g, input);
  const baseline = tax1040.estimate1040(input);
  const profile = taxProfileForYear(g, year);
  saveGlobal();   // persist a newly created year profile
  sendJSON(res, 200, {
    year,
    supportedYears: tax1040.SUPPORTED_YEARS,
    profile,
    companies: input.businesses,
    baseline,
    nj: njEstimateFor(input, profile),
    esPlan: tax1040.quarterlyEsPlan(baseline, profile.priorYearTax),
    njEsPlan: nj1040.quarterlyEsPlan(njEstimateFor(input, profile), profile.priorYearNjTax, tax1040.ES_DUE_DATES[year]),
    scheduleElias: {
      settings: g.scheduleElias.settings,
      borrower: g.scheduleElias.borrower,
      seb: g.scheduleElias.seb,
      properties: g.scheduleElias.properties,
      analysis: { ...lender, sec469: input.sec469 }
    }
  });
});

// -- Schedule Elias inputs --
route('PUT', '/api/household/schedule-elias', async (req, res) => {
  const b = await readBody(req);
  const g = loadGlobal();
  const se = g.scheduleElias;
  if (b.settings) {
    const s = b.settings;
    if ('depreciationStrategy' in s) {
      if (!elias.STRATEGIES.includes(s.depreciationStrategy)) return badRequest(res, 'Unknown depreciation strategy');
      se.settings.depreciationStrategy = s.depreciationStrategy;
    }
    if ('sec469Handling' in s) {
      if (!['suspend', 'allow', 'phase2'].includes(s.sec469Handling)) return badRequest(res, 'sec469Handling must be suspend, allow, or phase2');
      se.settings.sec469Handling = s.sec469Handling;
    }
    if ('activeParticipation' in s) se.settings.activeParticipation = !!s.activeParticipation;
    if ('reProfessional' in s) se.settings.reProfessional = !!s.reProfessional;
    if ('suspendedCarryforward' in s) {
      const v = Number(s.suspendedCarryforward);
      if (isNaN(v) || v < 0) return badRequest(res, 'Suspended carryforward must be a non-negative number');
      se.settings.suspendedCarryforward = v;
    }
    if ('qbiSafeHarbor' in s) se.settings.qbiSafeHarbor = !!s.qbiSafeHarbor;
    if ('dtiTargetPct' in s) {
      const v = Number(s.dtiTargetPct);
      if (isNaN(v) || v < 10 || v > 80) return badRequest(res, 'DTI target must be between 10 and 80');
      se.settings.dtiTargetPct = v;
    }
  }
  if (b.borrower) {
    const br = b.borrower;
    for (const k of ['monthlyW2Income', 'monthlyNonHousingDebts', 'primaryResidencePITIA']) {
      if (k in br) {
        const v = Number(br[k]);
        if (isNaN(v) || v < 0) return badRequest(res, `${k} must be a non-negative number`);
        se.borrower[k] = v;
      }
    }
    if ('purchaseType' in br) {
      if (!['primary_replacement', 'additional'].includes(br.purchaseType)) return badRequest(res, 'Unknown purchase type');
      se.borrower.purchaseType = br.purchaseType;
    }
    if ('countProjectedRent' in br) se.borrower.countProjectedRent = !!br.countProjectedRent;
    if (br.proposedPurchase) {
      for (const k of ['targetPrice', 'downPaymentPct', 'ratePct', 'termMonths', 'monthlyTaxes', 'monthlyInsurance', 'monthlyHOA', 'projectedMonthlyRent']) {
        if (k in br.proposedPurchase) {
          const v = Number(br.proposedPurchase[k]);
          if (isNaN(v) || v < 0) return badRequest(res, `${k} must be a non-negative number`);
          se.borrower.proposedPurchase[k] = v;
        }
      }
    }
  }
  if (b.seb && typeof b.seb === 'object') {
    for (const [companyId, supplements] of Object.entries(b.seb)) {
      se.seb[companyId] = elias.sanitizeSeb(supplements);
    }
  }
  saveGlobal();
  sendJSON(res, 200, { settings: se.settings, borrower: se.borrower, seb: se.seb });
});

route('POST', '/api/household/properties', async (req, res) => {
  const b = await readBody(req);
  const g = loadGlobal();
  const prop = elias.sanitizeProperty({ ...b, id: uid() });
  if (!prop.nickname) return badRequest(res, 'Give the property a nickname');
  g.scheduleElias.properties.push(prop);
  saveGlobal();
  sendJSON(res, 201, prop);
});
route('PUT', '/api/household/properties/:id', async (req, res, db, params) => {
  const g = loadGlobal();
  const idx = g.scheduleElias.properties.findIndex(p => p.id === params.id);
  if (idx === -1) return notFound(res);
  const b = await readBody(req);
  const prop = elias.sanitizeProperty(b, g.scheduleElias.properties[idx]);
  if (!prop.nickname) return badRequest(res, 'Give the property a nickname');
  g.scheduleElias.properties[idx] = prop;
  saveGlobal();
  sendJSON(res, 200, prop);
});
// Sell-vs-hold: recapture preview for one property against the baseline.
route('POST', '/api/household/properties/:id/sell-preview', async (req, res, db, params) => {
  const g = loadGlobal();
  const property = g.scheduleElias.properties.find(p => p.id === params.id);
  if (!property) return notFound(res);
  const b = await readBody(req);
  const salePrice = Number(b.salePrice);
  if (!(salePrice > 0)) return badRequest(res, 'A sale price is required');
  const year = tax1040.YEAR;
  const input = householdInput(g, year);
  const baseline = tax1040.estimate1040(input);
  const suspended = input.sec469 ? input.sec469.suspendedEnd
    : (baseline.suspendedRentalLoss + (Number(g.scheduleElias.settings.suspendedCarryforward) || 0));
  const preview = eliasP2.sellPreview(property, {
    salePrice,
    sellingCostsPct: Number(b.sellingCostsPct) || 7,
    taxYear: year,
    strategy: g.scheduleElias.settings.depreciationStrategy,
    filingStatus: baseline.filingStatus,
    baselineTaxableIncome: baseline.taxableIncome,
    baselineAgi: baseline.agi,
    marginalRate: baseline.marginalRate,
    niitThreshold: tax1040.NIIT_THRESHOLD[baseline.filingStatus],
    suspendedLosses: suspended
  });
  sendJSON(res, 200, { property: { id: property.id, nickname: property.nickname }, salePrice, ...preview });
});

route('DELETE', '/api/household/properties/:id', (req, res, db, params) => {
  const g = loadGlobal();
  const idx = g.scheduleElias.properties.findIndex(p => p.id === params.id);
  if (idx === -1) return notFound(res);
  g.scheduleElias.properties.splice(idx, 1);
  saveGlobal();
  sendJSON(res, 200, { ok: true });
});

route('PUT', '/api/household/tax-profile', async (req, res) => {
  const b = await readBody(req);
  const year = Number(b.year) || tax1040.YEAR;
  if (!tax1040.YEARS[year]) {
    return badRequest(res, `Supported tax years: ${tax1040.SUPPORTED_YEARS.join(', ')}`);
  }
  const g = loadGlobal();
  const p = taxProfileForYear(g, year);
  if ('filingStatus' in b) {
    if (!tax1040.BRACKETS[b.filingStatus]) return badRequest(res, 'Filing status must be single, married filing jointly, or head of household');
    p.filingStatus = b.filingStatus;
  }
  for (const k of ['wages', 'fedWithholding', 'otherIncome', 'adjustments', 'itemizedDeductions', 'credits', 'estimatedPayments', 'priorYearTax', 'njWithholding', 'njEstimatedPayments', 'priorYearNjTax', 'njDependents', 'propertyTaxPaid']) {
    if (k in b) {
      const v = Number(b[k]);
      if (isNaN(v) || v < 0) return badRequest(res, `${k} must be a non-negative number`);
      p[k] = v;
    }
  }
  if (b.companySstb && typeof b.companySstb === 'object') {
    for (const [id, val] of Object.entries(b.companySstb)) p.companySstb[id] = !!val;
  }
  saveGlobal();
  sendJSON(res, 200, p);
});

route('POST', '/api/household/scenario', async (req, res) => {
  const b = await readBody(req);
  const g = loadGlobal();
  const year = Number(b.year) || tax1040.YEAR;
  if (!tax1040.YEARS[year]) {
    return badRequest(res, `Supported tax years: ${tax1040.SUPPORTED_YEARS.join(', ')}`);
  }
  const adj = b.adjustments || {};
  if (adj.depreciationStrategy && !elias.STRATEGIES.includes(adj.depreciationStrategy)) {
    return badRequest(res, 'Unknown depreciation strategy');
  }
  if (adj.sec469Handling && !['suspend', 'allow', 'phase2'].includes(adj.sec469Handling)) {
    return badRequest(res, 'sec469Handling must be suspend, allow, or phase2');
  }
  const baseInput = householdInput(g, year);
  const scInput = householdInput(g, year, adj);
  const baseline = tax1040.estimate1040(baseInput);
  const scenario = tax1040.estimate1040(scInput);
  // Borrowing outcomes for both sides (Schedule Elias §8): the comparison
  // shows tax AND qualifying-income/DTI/max-purchase effects together.
  const baseLender = householdLender(g, baseInput);
  const scLender = householdLender(g, scInput);
  const lenderSummary = l => ({
    grossMonthlyQualifying: l.borrowing.income.grossMonthlyQualifying,
    backEndDTI: l.borrowing.proposed.backEndDTI,
    backEndBand: l.borrowing.proposed.backEndBand,
    maxPurchase: l.borrowing.maxPurchase.maxPrice
  });
  const profileForNj = taxProfileForYear(g, year);
  const njBaseline = njEstimateFor(baseInput, profileForNj);
  const njScenario = njEstimateFor(scInput, profileForNj);
  sendJSON(res, 200, {
    baseline, scenario,
    nj: { baseline: njBaseline, scenario: njScenario },
    borrowing: { baseline: lenderSummary(baseLender), scenario: lenderSummary(scLender) },
    delta: {
      njTax: round2(njScenario.tax - njBaseline.tax),
      totalTax: round2(scenario.totalTax - baseline.totalTax),
      taxableIncome: round2(scenario.taxableIncome - baseline.taxableIncome),
      balanceDue: round2(scenario.balanceDue - baseline.balanceDue),
      grossMonthlyQualifying: round2(scLender.borrowing.income.grossMonthlyQualifying - baseLender.borrowing.income.grossMonthlyQualifying),
      maxPurchase: round2(scLender.borrowing.maxPurchase.maxPrice - baseLender.borrowing.maxPurchase.maxPrice)
    }
  });
});

// -- sales tax (NJ ST-50 / ST-51) --
route('GET', '/api/salestax', (req, res, db, params, query) => {
  const year = Number(query.get('year')) || new Date().getFullYear();
  const cfg = salestax.salesTaxSettings(db);
  sendJSON(res, 200, salestax.summary(db, year, cfg));
});
route('POST', '/api/salestax/remit', async (req, res, db) => {
  const b = await readBody(req);
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) return badRequest(res, 'Remittance amount must be positive');
  if (!b.periodKey) return badRequest(res, 'A period (month or quarter) is required');
  // A remittance is NOT an expense: the collected tax was never income —
  // it only reduces the trust-fund balance.
  const rec = {
    id: uid(),
    periodKey: String(b.periodKey),
    amount,
    date: b.date || todayISO(),
    note: b.note || ''
  };
  db.salesTaxRemittances.push(rec);
  save(db);
  const cfg = salestax.salesTaxSettings(db);
  sendJSON(res, 200, { remittance: rec, summary: salestax.summary(db, Number(rec.date.slice(0, 4)), cfg) });
});

// -- dashboard --
route('GET', '/api/dashboard', (req, res, db) => {
  generateRecurring(db);
  const invoices = db.invoices.map(decorateInvoice).filter(i => i.status !== 'draft');
  const today = todayISO();

  // Income is recognized on payment date (cash basis); expenses on expense date.
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const monthly = months.map(m => ({ month: m, income: 0, expenses: 0 }));
  const byMonth = Object.fromEntries(monthly.map(x => [x.month, x]));

  let totalIncome = 0;
  for (const inv of invoices) {
    for (const p of inv.payments || []) {
      // Collected sales tax is held in trust for the State — not income.
      const { income } = salestax.paymentIncomeParts(inv, p);
      totalIncome += income;
      const m = (p.date || '').slice(0, 7);
      if (byMonth[m]) byMonth[m].income = round2(byMonth[m].income + income);
    }
  }
  let totalExpenses = 0;
  for (const e of db.expenses) {
    totalExpenses += e.amount;
    const m = e.date.slice(0, 7);
    if (byMonth[m]) byMonth[m].expenses = round2(byMonth[m].expenses + e.amount);
  }

  const open = invoices.filter(i => i.balance > 0);
  const overdue = open.filter(i => i.dueDate < today);

  sendJSON(res, 200, {
    totalIncome: round2(totalIncome),
    totalExpenses: round2(totalExpenses),
    netProfit: round2(totalIncome - totalExpenses),
    outstanding: round2(open.reduce((s, i) => s + i.balance, 0)),
    outstandingCount: open.length,
    overdueAmount: round2(overdue.reduce((s, i) => s + i.balance, 0)),
    overdueCount: overdue.length,
    monthly,
    recentInvoices: db.invoices.map(inv => {
      const c = db.customers.find(x => x.id === inv.customerId);
      return { ...decorateInvoice(inv), customerName: c ? (c.company || c.name) : '(deleted)' };
    }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
    recentExpenses: [...db.expenses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)
  });
});

// -- reports --
route('GET', '/api/reports/pnl', (req, res, db, params, query) => {
  const from = query.get('from') || '0000-01-01';
  const to = query.get('to') || '9999-12-31';

  // Cash-basis P&L: income by payment date, expenses by expense date.
  const incomeByCustomer = {};
  let totalIncome = 0;
  for (const inv of db.invoices) {
    if (inv.draft) continue;
    const c = db.customers.find(x => x.id === inv.customerId);
    const name = c ? (c.company || c.name) : '(deleted)';
    const dInv = decorateInvoice(inv);
    for (const p of inv.payments || []) {
      if (!inRange(p.date, from, to)) continue;
      const { income } = salestax.paymentIncomeParts(dInv, p);
      incomeByCustomer[name] = round2((incomeByCustomer[name] || 0) + income);
      totalIncome += income;
    }
  }

  const expensesByCategory = {};
  let totalExpenses = 0;
  for (const e of db.expenses) {
    if (!inRange(e.date, from, to)) continue;
    expensesByCategory[e.category] = round2((expensesByCategory[e.category] || 0) + e.amount);
    totalExpenses += e.amount;
  }

  sendJSON(res, 200, {
    from, to,
    income: Object.entries(incomeByCustomer).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    totalIncome: round2(totalIncome),
    expenses: Object.entries(expensesByCategory).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    totalExpenses: round2(totalExpenses),
    netProfit: round2(totalExpenses)
  });
});

route('GET', '/api/reports/aging', (req, res, db) => {
  const today = todayISO();
  const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };
  for (const raw of db.invoices) {
    const inv = decorateInvoice(raw);
    if (inv.status === 'draft' || inv.balance <= 0) continue;
    const c = db.customers.find(x => x.id === inv.customerId);
    const entry = { number: inv.number, customerName: c ? (c.company || c.name) : '(deleted)', dueDate: inv.dueDate, balance: inv.balance };
    const daysLate = Math.floor((new Date(today) - new Date(inv.dueDate)) / 86400000);
    if (daysLate <= 0) buckets.current.push(entry);
    else if (daysLate <= 30) buckets['1-30'].push(entry);
    else if (daysLate <= 60) buckets['31-60'].push(entry);
    else if (daysLate <= 90) buckets['61-90'].push(entry);
    else buckets['90+'].push(entry);
  }
  const summary = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, round2(v.reduce((s, e) => s + e.balance, 0))]));
  sendJSON(res, 200, { buckets, summary, total: round2(Object.values(summary).reduce((s, v) => s + v, 0)) });
});

// -- audit log (written centrally in the dispatcher for every mutation) --
route('GET', '/api/audit', (req, res, db, params, query) => {
  const limit = Math.min(Number(query.get('limit')) || 100, 500);
  sendJSON(res, 200, [...db.auditLog].reverse().slice(0, limit));
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
      }
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
  backup.scheduleSnapshots();   // tar the data dir now and daily, keep 7
  if (auth.authDisabled()) {
    console.log('Warning: QUICKBUCKS_DISABLE_AUTH=1 — the API is unauthenticated (trusted-network mode)');
  }
  server.listen(PORT, HOST, () => {
    console.log(`QuickBucks running at http://${HOST}:${PORT}`);
  });
}

module.exports = { server, HOST };
