// SQLite datastore (Phase 6 / #25): each company's books are one JSON document
// persisted as a row in data/books.db (lib/sqlite.js). The in-memory db object
// keeps the exact same shape as the old JSON-file era, so route handlers are
// unchanged — SQLite buys real transactions (see lib/outbox.js), not a
// relational rewrite. The companies registry + household data live in
// lib/global.js (the `global` table row).
const { loadGlobal, saveGlobal } = require('./global');
const { round2, mul, percentOf, sum, add, sub } = require('./money');
const secrets = require('./secrets');
const outbox = require('./outbox');
const migrations = require('./migrations');
const sqlite = require('./sqlite');

// Non-enumerable tag: which company row a loaded db writes back to.
const COMPANY_ID = Symbol('companyId');
const dbs = new Map();   // companyId -> db object

function uid() {
  return sqlite.uid();
}

function defaultData(companyName) {
  return {
    // Current company schema version — a fresh install starts already-migrated
    // (the migration runner is a no-op on it). See lib/migrations.js.
    schemaVersion: migrations.COMPANY_SCHEMA_VERSION,
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
    // Vestigial from the JSON era: the transactional outbox (#24) is its own
    // SQLite table now (lib/outbox.js), so this array is always empty and is
    // stripped by docText() before the doc is stored. Kept only so the in-memory
    // shape (and the frozen document-migration v1) is unchanged.
    outbox: []
  };
}

// The company doc as STORED: a fresh clone with secret leaves encrypted, and
// the vestigial in-doc `outbox` removed — the outbox is its own table now
// (lib/sqlite.js / lib/outbox.js), never persisted inside the doc. The in-memory
// db stays plaintext (callers unchanged); sealing happens only here on the way
// to the row.
function docText(db) {
  const sealed = secrets.sealForStorage(db); // fresh JSON clone, secrets sealed
  delete sealed.outbox;
  return JSON.stringify(sealed);
}

function companies() {
  sqlite.connect(); // ensures dir + schema + one-time legacy import
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
  Object.defineProperty(db, COMPANY_ID, { value: id });
  dbs.set(id, db);
  save(db);
  return g.companies[g.companies.length - 1];
}

function load(companyId) {
  const list = companies();
  const company = list.find(c => c.id === companyId) || list[0];
  if (dbs.has(company.id)) return dbs.get(company.id);
  const conn = sqlite.connect();
  const row = conn.prepare('SELECT doc FROM company WHERE id = ?').get(company.id);
  let db, needWrite;
  if (row) {
    db = secrets.openFromStorage(JSON.parse(row.doc));
    // Run ordered forward DOCUMENT migrations; if the doc was upgraded, write it
    // back so the row never lingers at an old version (the write is a single
    // atomic UPDATE, and boot triggers it before serving, not on a user GET).
    needWrite = migrations.migrateCompany(db, company.id);
  } else {
    db = defaultData(company.name);
    needWrite = true;
  }
  Object.defineProperty(db, COMPANY_ID, { value: company.id });
  dbs.set(company.id, db);
  if (needWrite) save(db);
  return db;
}

// Persist a non-money mutation: a single UPDATE of the company row. Money
// mutations go through commit()/commitMany() instead (atomic with their audit
// event). The in-memory db stays plaintext — secrets are sealed only in docText.
function save(db) {
  const id = db[COMPANY_ID];
  if (!id) throw new Error('save() needs a db object from load()');
  sqlite.connect()
    .prepare('INSERT OR REPLACE INTO company(id, doc) VALUES(?, ?)')
    .run(id, docText(db));
}

// Transactional commit (#24, on SQLite): persist the caller's already-applied db
// mutation and deliver its audit event(s) as ONE crash-atomic unit. The doc
// UPDATE and the owed-event INSERTs commit in a single SQLite transaction
// (lib/outbox.js), then a relay delivers the events to the tamper-evident chain.
// Use `commit` for a single event, `commitMany` for a handler recording several.
function commit(db, companyId, type, payload) {
  return outbox.commit(sqlite.connect(), companyId, docText(db), [{ type, payload }]);
}

function commitMany(db, companyId, events) {
  return outbox.commit(sqlite.connect(), companyId, docText(db), events);
}

// Test hook: forget cached db objects so the next load() re-reads from the DB
// (simulates a process restart after a crash — the durable store is books.db).
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
  _evict, _docText: docText
};
