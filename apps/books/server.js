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
// Extracted verbatim into lib/routes/invoices.js (Phase 6 / #25, ninth slice of
// the server split — the last big domain route group), wired in place so
// route-registration order is unchanged; the handlers close over the deps passed
// below instead of this file's module scope. Invoices is money-heavy: every
// mutation (create/update/delete/payment/send + the sales-CSV import) commits
// through the transactional outbox — do NOT convert any of them to save(db).
// The shared invoice collaborators stay DEFINED here and are threaded through
// deps, NOT moved: createInvoice (the constructor generateRecurring/time/
// sales-import all thread — defined just below), validInvoice (shared with the
// recurring group), decorateInvoice (shared, from lib/store). This group carries
// two of the three salestax.taxSplitSnapshot sites (the payment push + the
// sales-import paid invoice) — salestax is threaded (the third is bank/match).
require('./lib/routes/invoices')(route, {
  sendJSON, notFound, badRequest, readBody,
  uid, todayISO, round2,
  commit, audit,
  createInvoice, decorateInvoice, validInvoice,
  salestax, money, salesimport
});

// Shared constructor: validates and appends an invoice (threaded into
// lib/routes/invoices.js for its POST/sales-import routes, and used by
// recurring-invoice generation below). Throws on validation errors.
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
// Extracted into lib/routes/bank.js as the eighth slice of the incremental
// server split (Phase 6 / #25). Registered here, in place, so route order is
// unchanged; the 17 handlers close over the deps passed below instead of this
// file's module scope. Four bank-only helpers (publicConnection, txnKey,
// syncConnection, ruleFor) moved in with them (no other callers). The plaid
// and parseBankCSV requires are used only by this group, but — matching how
// expenses' receipts and payroll's lib/payroll/* are threaded — the require
// lines stay at the top of this file and the modules pass through deps.
// decorateInvoice and salestax are shared, so they thread through too. Mixed
// persistence preserved exactly: the two feed-import paths (POST /api/bank/sync,
// POST /api/bank/import-csv) commit bank.transactions_imported through the
// transactional outbox; every other mutation — config, exchange, connection
// delete, rule CRUD, apply-rules, and the review-queue expense/match/exclude/
// restore paths — calls save(db) directly.
require('./lib/routes/bank')(route, {
  sendJSON, notFound, badRequest, readBody,
  uid, round2, todayISO, save, commit,
  audit, money, plaid, parseBankCSV, decorateInvoice, salestax
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
