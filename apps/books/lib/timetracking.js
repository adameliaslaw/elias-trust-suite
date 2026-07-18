// Billable time tracking: log hours against customers/matters, watch
// unbilled WIP, and roll selected entries straight into a draft invoice.
//
// An entry's lifecycle is carried by two fields, not a status enum:
//   - billable (bool): non-billable time is tracked for records but never
//     invoiced
//   - invoiceId: set when the entry has been rolled into an invoice; billed
//     entries are frozen (no edit/delete) until the invoice is deleted,
//     which releases them back to unbilled
const { round2, todayISO, uid } = require('./store');

function statusOf(t) {
  if (t.invoiceId) return 'billed';
  return t.billable ? 'unbilled' : 'non-billable';
}

function decorateEntry(t) {
  return { ...t, amount: round2(t.hours * t.rate), status: statusOf(t) };
}

// Validate and normalize a create/update body. Returns { error } or { entry }.
function sanitizeEntry(b, db, existing) {
  const merged = { ...(existing || {}), ...b };
  if (!merged.customerId || !db.customers.some(c => c.id === merged.customerId)) {
    return { error: 'A customer is required' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(merged.date || '')) return { error: 'A date is required (YYYY-MM-DD)' };
  const hours = Number(merged.hours);
  if (!(hours > 0) || hours > 24) return { error: 'Hours must be between 0 and 24' };
  const rate = Number(merged.rate);
  if (!(rate >= 0)) return { error: 'Rate must be zero or more' };
  if (!String(merged.description || '').trim()) return { error: 'A description is required' };
  return {
    entry: {
      id: existing ? existing.id : uid(),
      customerId: merged.customerId,
      date: merged.date,
      matter: String(merged.matter || '').trim(),
      description: String(merged.description).trim(),
      hours: round2(hours),
      rate: round2(rate),
      billable: merged.billable === undefined ? true : !!merged.billable,
      invoiceId: existing ? existing.invoiceId || null : null,
      createdAt: existing ? existing.createdAt : todayISO()
    }
  };
}

// Unbilled billable work grouped by customer — the WIP report.
function wipByCustomer(db) {
  const groups = new Map();
  for (const t of db.timeEntries) {
    if (!t.billable || t.invoiceId) continue;
    if (!groups.has(t.customerId)) {
      const c = db.customers.find(x => x.id === t.customerId);
      groups.set(t.customerId, {
        customerId: t.customerId,
        customerName: c ? (c.company || c.name) : '(deleted)',
        entries: 0, hours: 0, amount: 0, oldest: t.date
      });
    }
    const g = groups.get(t.customerId);
    g.entries += 1;
    g.hours = round2(g.hours + t.hours);
    g.amount = round2(g.amount + t.hours * t.rate);
    if (t.date < g.oldest) g.oldest = t.date;
  }
  return [...groups.values()].sort((a, b) => b.amount - a.amount);
}

// One invoice line per entry, chronological, so the client sees exactly
// what they're paying for. Professional services are not subject to NJ
// sales tax, so lines are non-taxable.
function invoiceItems(entries) {
  return [...entries].sort((a, b) => a.date.localeCompare(b.date)).map(t => ({
    description: [t.date, t.matter, t.description].filter(Boolean).join(' — '),
    qty: t.hours,
    rate: t.rate,
    taxable: false
  }));
}

// Entries eligible to bill for a customer, optionally narrowed to ids.
function billableEntries(db, customerId, entryIds) {
  const wanted = entryIds && entryIds.length ? new Set(entryIds) : null;
  return db.timeEntries.filter(t =>
    t.customerId === customerId && t.billable && !t.invoiceId && (!wanted || wanted.has(t.id)));
}

module.exports = { sanitizeEntry, decorateEntry, wipByCustomer, invoiceItems, billableEntries, statusOf };
