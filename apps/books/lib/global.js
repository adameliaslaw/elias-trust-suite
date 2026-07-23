// Household-level data shared across companies: the companies registry,
// the app password, and the household tax profile. Lives in data/global.json.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.QUICKBUCKS_DATA_DIR || path.join(__dirname, '..', 'data');
const GLOBAL_FILE = path.join(DATA_DIR, 'global.json');
const { defaultScheduleElias } = require('./schedule-elias');

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
    companies: [],          // [{id, name, createdAt}]
    passwordHash: null,
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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(GLOBAL_FILE)) {
    const defaults = defaultGlobal();
    cache = { ...defaults, ...JSON.parse(fs.readFileSync(GLOBAL_FILE, 'utf8')) };
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
  } else {
    cache = defaultGlobal();
  }
  return cache;
}

function saveGlobal() {
  const tmp = GLOBAL_FILE + '.tmp';
  // 0600: global.json holds the app password hash and the companies registry.
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, GLOBAL_FILE);
  try { fs.chmodSync(GLOBAL_FILE, 0o600); } catch { /* platform without POSIX modes */ }
}

module.exports = { loadGlobal, saveGlobal, taxProfileForYear, DATA_DIR };
