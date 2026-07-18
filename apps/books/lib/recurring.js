// Recurring invoices: templates that generate real invoices as their next
// date comes due. Generation is lazy — no scheduler needed: any invoice/
// dashboard read first materializes whatever is due (catching up multiple
// periods if the app was closed), so a retainer bills itself.
const { uid, todayISO } = require('./store');

const FREQUENCIES = ['weekly', 'monthly', 'quarterly'];

function daysInMonth(year, month) {   // month 1-12
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Next occurrence after `iso`. Monthly/quarterly keep the template's anchor
// day (a 31st bills on the 28th/30th in short months, back on the 31st after).
function nextOccurrence(iso, frequency, anchorDay) {
  const [y, m, d] = iso.split('-').map(Number);
  if (frequency === 'weekly') {
    const dt = new Date(Date.UTC(y, m - 1, d + 7));
    return dt.toISOString().slice(0, 10);
  }
  const step = frequency === 'quarterly' ? 3 : 1;
  let ny = y, nm = m + step;
  while (nm > 12) { nm -= 12; ny += 1; }
  const day = Math.min(anchorDay || d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sanitizeTemplate(b, existing) {
  const e = existing || {};
  const frequency = FREQUENCIES.includes(b.frequency ?? e.frequency) ? (b.frequency ?? e.frequency) : 'monthly';
  const nextDate = b.nextDate ?? e.nextDate ?? todayISO();
  return {
    id: e.id || uid(),
    customerId: b.customerId ?? e.customerId,
    items: Array.isArray(b.items) ? b.items : (e.items || []),
    notes: b.notes ?? e.notes ?? '',
    termsDays: Math.max(Math.round(Number(b.termsDays ?? e.termsDays ?? 30)) || 30, 0),
    frequency,
    nextDate,
    anchorDay: Number(nextDate.slice(8, 10)),
    draft: b.draft !== undefined ? !!b.draft : !!e.draft,
    active: b.active !== undefined ? !!b.active : (e.active !== undefined ? e.active : true),
    createdAt: e.createdAt || todayISO(),
    lastGenerated: e.lastGenerated || null
  };
}

// Materialize every due occurrence. createInvoice(db, data) is the same
// validated constructor the POST /api/invoices route uses. Returns the
// created invoices; caller saves if any.
function generateDue(db, createInvoice, today) {
  const now = today || todayISO();
  const created = [];
  for (const tpl of db.recurringInvoices || []) {
    if (!tpl.active) continue;
    let guard = 0;
    while (tpl.nextDate <= now && guard++ < 36) {
      const date = tpl.nextDate;
      const dueDate = addDaysIso(date, tpl.termsDays);
      try {
        const inv = createInvoice(db, {
          customerId: tpl.customerId,
          date, dueDate,
          items: tpl.items.map(it => ({ ...it })),
          notes: tpl.notes,
          draft: tpl.draft
        });
        inv.recurringId = tpl.id;
        created.push(inv);
        tpl.lastGenerated = date;
      } catch {
        // Customer deleted or template invalid — pause instead of retrying forever.
        tpl.active = false;
        break;
      }
      tpl.nextDate = nextOccurrence(tpl.nextDate, tpl.frequency, tpl.anchorDay);
    }
  }
  return created;
}

function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

module.exports = { FREQUENCIES, nextOccurrence, sanitizeTemplate, generateDue, addDaysIso };
