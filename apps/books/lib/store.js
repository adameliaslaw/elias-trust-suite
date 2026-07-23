// JSON-file datastore, one file per company. No external dependencies.
// Company registry + household data live in lib/global.js (data/global.json);
// each company's books live in data/company-<id>.json.
const fs = require('fs');
const path = require('path');
const { loadGlobal, saveGlobal, DATA_DIR } = require('./global');
const { round2, mul, percentOf, sum, add, sub } = require('./money');
const secrets = require('./secrets');
const outbox = require('./outbox');

const FILE_KEY = Symbol('dbFile');
const dbs = new Map();   // companyId -> db object

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultData(companyName) {
  return {
    settings: {
      companyName: companyName || 'My Company',
      currency: 'USD',
      nextInvoiceNumber: 1001,
      invoicePrefix: 'INV-',
      defaultTermsDays: 30
    },
    expenseCategories: [
      'Advertising', 'Bank Charges', 'Insurance', 'Legal & Professional Fees',
      'Meals & Entertainment', 'Office Supplies', 'Rent', 'Software & Subscriptions',
      'Travel', 'Utilities', 'Payroll', 'Payroll Taxes', 'Other'
    ],
    customers: [],
    invoices: [],
    expenses: [],
    bankConnections: [],
    bankTransactions: [],
    employees: [],
    payRuns: [],
    payrollDeposits: [],
    salesTaxRemittances: [],
    recurringInvoices: [],
    bankRules: [],
    timeEntries: [],
    vendors1099: [],
    auditLog: [],
    // Transactional outbox (#24): audit events owed by a persisted mutation but
    // not yet delivered to the tamper-evident chain. Rides in this file so it
    // commits atomically with the mutation; drained by lib/outbox.js.
    outbox: []
  };
}

function companyFile(companyId) {
  return path.join(DATA_DIR, `company-${companyId}.json`);
}

function migrate(db) {
  // Data files created before later features existed.
  db.bankConnections = db.bankConnections || [];
  db.bankTransactions = db.bankTransactions || [];
  db.employees = db.employees || [];
  db.payRuns = db.payRuns || [];
  db.payrollDeposits = db.payrollDeposits || [];
  db.salesTaxRemittances = db.salesTaxRemittances || [];
  db.recurringInvoices = db.recurringInvoices || [];
  db.bankRules = db.bankRules || [];
  db.timeEntries = db.timeEntries || [];
  db.vendors1099 = db.vendors1099 || [];
  db.auditLog = db.auditLog || [];
  db.outbox = db.outbox || [];
  if (!db.expenseCategories.includes('Payroll Taxes')) {
    db.expenseCategories.splice(db.expenseCategories.indexOf('Payroll') + 1, 0, 'Payroll Taxes');
  }
  return db;
}

// One-time migration from the single-company era: data/db.json becomes the
// first registered company, and the app password moves to global.json.
function migrateLegacy() {
  const g = loadGlobal();
  const legacy = path.join(DATA_DIR, 'db.json');
  if (g.companies.length || !fs.existsSync(legacy)) return;
  const db = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  const id = uid();
  if (db.settings && db.settings.passwordHash) {
    g.passwordHash = db.settings.passwordHash;
    delete db.settings.passwordHash;
  }
  g.companies.push({ id, name: (db.settings && db.settings.companyName) || 'My Company', createdAt: todayISO() });
  fs.writeFileSync(companyFile(id), JSON.stringify(secrets.sealForStorage(db), null, 2), { mode: 0o600 });
  fs.renameSync(legacy, legacy + '.migrated');
  saveGlobal();
}

function companies() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacy();
  const g = loadGlobal();
  if (!g.companies.length) {
    // Fresh install: create the first company.
    const id = uid();
    g.companies.push({ id, name: 'My Company', createdAt: todayISO() });
    saveGlobal();
  }
  return g.companies;
}

function createCompany(name) {
  const g = loadGlobal();
  const id = uid();
  g.companies.push({ id, name: String(name).trim(), createdAt: todayISO() });
  saveGlobal();
  const db = defaultData(name);
  Object.defineProperty(db, FILE_KEY, { value: companyFile(id) });
  dbs.set(id, db);
  save(db);
  return g.companies[g.companies.length - 1];
}

function load(companyId) {
  const list = companies();
  const company = list.find(c => c.id === companyId) || list[0];
  if (dbs.has(company.id)) return dbs.get(company.id);
  const file = companyFile(company.id);
  let db;
  if (fs.existsSync(file)) {
    db = migrate(secrets.openFromStorage(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } else {
    db = defaultData(company.name);
  }
  Object.defineProperty(db, FILE_KEY, { value: file });
  dbs.set(company.id, db);
  if (!fs.existsSync(file)) save(db);
  return db;
}

function save(db) {
  const file = db[FILE_KEY];
  if (!file) throw new Error('save() needs a db object from load()');
  const tmp = file + '.tmp';
  // Secrets are encrypted on the way to disk; the in-memory db stays plaintext.
  // 0600 so the file (and thus the encrypted-but-still-private books) is not
  // world-readable on a shared host.
  fs.writeFileSync(tmp, JSON.stringify(secrets.sealForStorage(db), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* platform without POSIX modes */ }
}

// Transactional commit (#24): persist the caller's already-applied db mutation
// and deliver its audit event(s) as ONE crash-atomic unit. Replaces the
// non-atomic `save(db); await audit.append(...)` pattern — the owed event rides
// in the same atomic save as the mutation, then a relay delivers it. Use
// `commit` for a single event, `commitMany` for a handler that records several.
function commit(db, companyId, type, payload) {
  return outbox.commit(db, companyId, save, [{ type, payload }]);
}

function commitMany(db, companyId, events) {
  return outbox.commit(db, companyId, save, events);
}

// Test hook: forget cached db objects so the next load() re-reads from disk
// (simulates a process restart after a crash).
function _evict(companyId) {
  if (companyId) dbs.delete(companyId);
  else dbs.clear();
}

// ---- Derived invoice fields ----

// Per-line amounts: qty x rate rounded half-up per LINE (the number the
// client sees on the invoice), then summed in exact integer cents.
function lineAmount(it) {
  return mul(Number(it.rate) || 0, Number(it.qty) || 0);
}

function invoiceSubtotal(inv) {
  return sum(...(inv.items || []).map(lineAmount));
}

// Sales tax on the invoice's taxable lines at the invoice's snapshot rate.
function invoiceTax(inv) {
  const rate = Number(inv.taxRate) || 0;
  if (!(rate > 0)) return 0;
  const taxableBase = sum(...(inv.items || []).filter(it => it.taxable).map(lineAmount));
  return percentOf(taxableBase, rate);
}

function invoiceTotal(inv) {
  return add(invoiceSubtotal(inv), invoiceTax(inv));
}

function invoicePaid(inv) {
  return sum(...(inv.payments || []).map(p => Number(p.amount) || 0));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Status is derived, except "draft" which is explicit until the invoice is sent.
function invoiceStatus(inv) {
  const total = invoiceTotal(inv);
  const paid = invoicePaid(inv);
  if (paid >= total && total > 0) return 'paid';
  if (inv.draft) return 'draft';
  if (paid > 0) return 'partial';
  if (inv.dueDate && inv.dueDate < todayISO()) return 'overdue';
  return 'open';
}

function decorateInvoice(inv) {
  const subtotal = invoiceSubtotal(inv);
  const tax = invoiceTax(inv);
  const total = add(subtotal, tax);
  const paid = invoicePaid(inv);
  return {
    ...inv,
    subtotal,
    tax,
    total,
    amountPaid: paid,
    balance: sub(total, paid),
    status: invoiceStatus(inv)
  };
}

module.exports = {
  load, save, commit, commitMany, companies, createCompany, uid,
  decorateInvoice, invoiceSubtotal, invoiceTax, invoiceTotal, invoicePaid, round2, todayISO,
  _evict
};
