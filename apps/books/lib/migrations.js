'use strict';
// Schema versioning + forward migration runner for the JSON store (Phase 6 / #25).
//
// Books persists one JSON file per company (data/company-<id>.json) plus a
// household file (data/global.json). Before this module those files carried no
// version marker, and shape upgrades were done by an ad-hoc, unversioned
// migrate(db) that ran field-backfills on every load. That is fine for adding a
// missing array, but it does not scale to real shape changes before a
// multi-user deploy: there is no record of which upgrades a file has already
// seen, no ordered sequence, and no guarantee the upgraded file is written back.
//
// This runner fixes that:
//   - Every store file carries a `schemaVersion` integer.
//   - Migrations are an ORDERED list of { version, up(obj) } steps; a step is
//     applied only when its version is greater than the file's current version,
//     so running the runner twice is a no-op (idempotent).
//   - Migrations are NEVER lossy — a step only adds or transforms fields, it
//     never drops data the app still needs.
//   - Each applied step is logged (stderr-friendly console.log), so an upgrade
//     is visible in the boot log.
//   - The caller (store.load / global.loadGlobal) writes the upgraded file back
//     ATOMICALLY (tmp file + rename, 0600), exactly like a normal save — so a
//     crash mid-upgrade never leaves a half-written file.
//
// Seed sets `schemaVersion` to the current version, so a fresh install starts
// already-migrated and the runner is a no-op on it.
//
// To add a migration: append a { version: N, up(obj) } step (N = the next
// integer) and bump the *_SCHEMA_VERSION constant to N. Do NOT edit an existing
// step's behavior — files already at that version will not re-run it.

// Company file (data/company-<id>.json) schema version.
const COMPANY_SCHEMA_VERSION = 1;
// Household file (data/global.json) schema version.
const GLOBAL_SCHEMA_VERSION = 2;

// Ordered forward migrations for a company file. Each `up` takes a company db AT
// version-1 and brings it to `version`.
const COMPANY_MIGRATIONS = [
  {
    version: 1,
    // Baseline: backfill the collections + transactional outbox that post-date
    // the original single-file schema, and the 'Payroll Taxes' expense
    // category. This is exactly the old ad-hoc migrate(db) from store.js — now
    // versioned (runs once, stamped) and written back atomically instead of
    // re-defaulting on every load.
    up(db) {
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
      if (Array.isArray(db.expenseCategories) && !db.expenseCategories.includes('Payroll Taxes')) {
        const at = db.expenseCategories.indexOf('Payroll');
        db.expenseCategories.splice(at >= 0 ? at + 1 : db.expenseCategories.length, 0, 'Payroll Taxes');
      }
    }
  }
];

// Ordered forward migrations for the household file.
const GLOBAL_MIGRATIONS = [
  {
    version: 1,
    // Baseline: ensure the core household collections exist and fold the
    // pre-multi-year single tax profile into the 2026 slot. (loadGlobal still
    // defensively merges these on every load; stamping v1 gives later
    // migrations a known floor to build on.)
    up(g) {
      g.companies = g.companies || [];
      g.taxProfiles = g.taxProfiles || {};
      if (g.taxProfile) {
        g.taxProfiles['2026'] = { ...(g.taxProfiles['2026'] || {}), ...g.taxProfile };
        delete g.taxProfile;
      }
    }
  },
  {
    version: 2,
    // Roles (Phase 6 / #25): per-principal identity. The household-shared
    // password becomes the implicit default OWNER; named principals
    // (bookkeeper / read-only) live in `principals`. Seeding is purely additive
    // — an existing install keeps logging in with the same shared password, now
    // resolved to the owner role.
    up(g) {
      g.principals = g.principals || [];
    }
  }
];

// Apply every migration whose version exceeds the object's current version, in
// order, then stamp the current version. Returns true when anything changed
// (the caller then writes the upgraded file back atomically), false when the
// object was already current (no write needed — keeps loads read-only).
function runMigrations(obj, migrations, currentVersion, label) {
  const from = Number(obj.schemaVersion) || 0;
  let changed = false;
  for (const m of migrations) {
    if (m.version > from) {
      m.up(obj);
      changed = true;
      console.log(`[migrate] ${label}: v${from} -> v${m.version}`);
    }
  }
  if (obj.schemaVersion !== currentVersion) {
    obj.schemaVersion = currentVersion;
    changed = true;
  }
  return changed;
}

// Upgrade a company db in place. `companyId` is used only for the log line.
function migrateCompany(db, companyId) {
  return runMigrations(db, COMPANY_MIGRATIONS, COMPANY_SCHEMA_VERSION, `company ${companyId || ''}`.trim());
}

// Upgrade the household global object in place.
function migrateGlobal(g) {
  return runMigrations(g, GLOBAL_MIGRATIONS, GLOBAL_SCHEMA_VERSION, 'global');
}

module.exports = {
  COMPANY_SCHEMA_VERSION, GLOBAL_SCHEMA_VERSION,
  COMPANY_MIGRATIONS, GLOBAL_MIGRATIONS,
  migrateCompany, migrateGlobal
};
