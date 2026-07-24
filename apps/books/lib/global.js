// Household-level data shared across companies: the companies registry, the app
// password, the principals, and the household tax profile. Persisted as the
// single `global` row in data/books.db (Phase 6 / #25 — was data/global.json).
const path = require('path');

// DATA_DIR is still the anchor for the audit chain, receipts, the secrets
// keyfile and backups, so it stays exported here. Computed identically to
// lib/sqlite.js's copy (kept independent to avoid a require cycle).
const DATA_DIR = process.env.QUICKBUCKS_DATA_DIR || path.join(__dirname, '..', 'data');
const { defaultScheduleElias } = require('./schedule-elias');
const migrations = require('./migrations');
const sqlite = require('./sqlite');

let cache = null;

function defaultTaxProfile() {
  return {
    filingStatus: 'married_jointly',   // single | married_jointly | head_of_household
    wages: 0,                // household W-2 wages from outside these companies
    fedWithholding: 0,       // federal income tax withheld on those wages
    otherIncome: 0,          // interest, dividends, other taxable income
    adjustments: 0,          // SEP/solo-401k, HSA, other above-the-line
    itemizedDeductions: 0,   // 0 = use the standard deduction
    credits: 0,              // child tax credit and other credits (annual)
    estimatedPayments: 0,    // 1040-ES payments + (for past years) amounts already paid in
    priorYearTax: 0,         // prior-year total tax, for the ES safe harbor
    njWithholding: 0,        // NJ income tax withheld (household W-2s)
    njEstimatedPayments: 0,  // NJ-1040-ES payments made
    priorYearNjTax: 0,       // prior-year NJ tax, for the NJ-2210 safe harbor
    njDependents: 0,         // dependents for NJ exemptions ($1,500 each)
    propertyTaxPaid: 0,      // principal-residence property tax (NJ deduction/credit)
    companySstb: {}          // companyId -> true when the business is an SSTB (e.g. law)
  };
}

function defaultGlobal() {
  return {
    // Current household schema version — a fresh install starts already-migrated.
    schemaVersion: migrations.GLOBAL_SCHEMA_VERSION,
    companies: [],          // [{id, name, createdAt}]
    passwordHash: null,     // the household-shared password = the implicit OWNER
    principals: [],         // named principals: [{id, username, name, role, passwordHash, createdAt}]
    taxProfiles: {},        // year -> profile (see defaultTaxProfile)
    scheduleElias: defaultScheduleElias()
  };
}

// Profile for a tax year, created on first access. New years start from the
// latest existing year's filing status and SSTB flags (the per-year dollar
// figures — wages, withholding, payments — start at zero).
function taxProfileForYear(g, year) {
  const key = String(year);
  if (!g.taxProfiles[key]) {
    const years = Object.keys(g.taxProfiles).sort();
    const latest = years.length ? g.taxProfiles[years[years.length - 1]] : null;
    g.taxProfiles[key] = {
      ...defaultTaxProfile(),
      ...(latest ? { filingStatus: latest.filingStatus, companySstb: { ...latest.companySstb } } : {})
    };
  }
  return g.taxProfiles[key];
}

function loadGlobal() {
  if (cache) return cache;
  const db = sqlite.connect(); // ensures schema + one-time legacy JSON import
  const row = db.prepare('SELECT doc FROM global WHERE id = 0').get();
  if (row) {
    const defaults = defaultGlobal();
    const parsed = JSON.parse(row.doc);
    cache = { ...defaults, ...parsed };
    // Trust the FILE's stored schema version, not the default — otherwise the
    // default's current version masks a legacy file's missing one and the
    // migration runner never fires (and never writes the upgrade back).
    cache.schemaVersion = parsed.schemaVersion;
    cache.taxProfiles = cache.taxProfiles || {};
    // Migrate the single-profile era: the old taxProfile becomes 2026's.
    if (cache.taxProfile) {
      cache.taxProfiles['2026'] = { ...defaultTaxProfile(), ...cache.taxProfile };
      delete cache.taxProfile;
    }
    for (const [year, p] of Object.entries(cache.taxProfiles)) {
      cache.taxProfiles[year] = { ...defaultTaxProfile(), ...p };
    }
    const se = cache.scheduleElias || {};
    cache.scheduleElias = {
      settings: { ...defaults.scheduleElias.settings, ...(se.settings || {}) },
      borrower: {
        ...defaults.scheduleElias.borrower, ...(se.borrower || {}),
        proposedPurchase: { ...defaults.scheduleElias.borrower.proposedPurchase, ...((se.borrower || {}).proposedPurchase || {}) }
      },
      seb: se.seb || {},
      properties: se.properties || []
    };
    cache.principals = cache.principals || [];
  } else {
    cache = defaultGlobal();
  }
  // Run ordered forward migrations (schemaVersion stamp + roles seeding). If the
  // household file was upgraded, write it back atomically so the upgrade is
  // durable. Runs once — subsequent loadGlobal() calls return the cache.
  if (migrations.migrateGlobal(cache)) saveGlobal();
  return cache;
}

function saveGlobal() {
  // The household doc holds the app password hash + principals; it lives in the
  // 0600 books.db (whose file mode is set on connect). A single UPSERT of the
  // one global row.
  sqlite.connect()
    .prepare('INSERT OR REPLACE INTO global(id, doc) VALUES(0, ?)')
    .run(JSON.stringify(cache));
}

// Test hook: drop the in-memory household cache so the next loadGlobal()
// re-reads the durable row (simulates a process restart).
function _reset() {
  cache = null;
}

module.exports = { loadGlobal, saveGlobal, taxProfileForYear, DATA_DIR, _reset };
