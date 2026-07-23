'use strict';
// LEDES 1998B export — the pipe-delimited e-billing format accepted by
// legal billing systems, e-billing vendors, and insurance carriers.
// Fee lines carry the UTBMS activity code; AI usage pass-through costs go
// out as expense lines (E124 "Other") so they are disclosed, not buried.

const crypto = require('crypto');
const { sumCents } = require('./money');
const { isClientBillable } = require('./client-billing');

const FIELDS = [
  'INVOICE_DATE',
  'INVOICE_NUMBER',
  'CLIENT_ID',
  'LAW_FIRM_MATTER_ID',
  'INVOICE_TOTAL',
  'BILLING_START_DATE',
  'BILLING_END_DATE',
  'INVOICE_DESCRIPTION',
  'LINE_ITEM_NUMBER',
  'EXP/FEE/INV_ADJ_TYPE',
  'LINE_ITEM_NUMBER_OF_UNITS',
  'LINE_ITEM_ADJUSTMENT_AMOUNT',
  'LINE_ITEM_TOTAL',
  'LINE_ITEM_DATE',
  'LINE_ITEM_TASK_CODE',
  'LINE_ITEM_EXPENSE_CODE',
  'LINE_ITEM_ACTIVITY_CODE',
  'TIMEKEEPER_ID',
  'LINE_ITEM_DESCRIPTION',
  'LAW_FIRM_ID',
  'LINE_ITEM_UNIT_COST',
  'TIMEKEEPER_NAME',
  'TIMEKEEPER_CLASSIFICATION',
  'CLIENT_MATTER_ID',
];

function ledesDate(iso) {
  return String(iso || '').slice(0, 10).replace(/-/g, '');
}

function clean(s) {
  // LEDES is pipe-delimited with no escaping; strip delimiters and newlines.
  return String(s ?? '').replace(/[|\r\n[\]]+/g, ' ').trim();
}

// Exact decimal of the billed hours as LEDES units. NEVER hardcoded to tenths:
// at any increment (0.1, 0.25, ...) `units × unit-cost` must round to the line
// total, or e-billing validators reject the invoice (M5). String() is the
// shortest exact round-trip (0.25 -> "0.25", 1.5 -> "1.5"); we keep at least
// one decimal place so the column always reads as a quantity.
function formatUnits(hours) {
  const s = String(Number(hours));
  return s.includes('.') ? s : s + '.0';
}

// Per-matter invoice number: stable for a given client/matter/date so the same
// billable set re-exports to the same invoice (idempotency), and unique across
// matters so multi-matter files never collide.
function matterInvoiceNumber(prefix, client, matter, invDate) {
  const tag = crypto.createHash('sha1').update(`${client}|${matter}`).digest('hex').slice(0, 6);
  return `${prefix}-${tag}-${ledesDate(invDate) || 'DRAFT'}`;
}

function ledesExport(entries, config, { invoiceNumber, invoiceDate, from, to, description } = {}) {
  // Reviewed-only, confirmed-minutes, unbilled work only — a LEDES file is a
  // CLIENT invoice, so the structural gate (#17/#18) is enforced here too, not
  // just at the route. Anything not client-billable simply never appears.
  const billable = entries.filter(isClientBillable);

  // A LEDES 1998B invoice is single-matter: group by client+matter so each
  // matter becomes its own invoice with its own INVOICE_NUMBER / INVOICE_TOTAL,
  // its own line numbering, and its own timekeeper attribution (M5).
  const groups = new Map();
  for (const e of billable) {
    const key = `${e.client}|${e.matter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const lines = ['LEDES1998B[]', FIELDS.join('|') + '[]'];
  for (const list of groups.values()) {
    const dates = list.map((e) => e.date).sort();
    const start = from || dates[0] || '';
    const end = to || dates[dates.length - 1] || '';
    const invDate = invoiceDate || end || start;
    const { client, matter } = list[0];
    // A single-group export honors a caller-supplied invoice number; multi-matter
    // exports derive a distinct, stable number per matter.
    const invNumber =
      groups.size === 1 && invoiceNumber
        ? invoiceNumber
        : matterInvoiceNumber(invoiceNumber || 'MP', client, matter, invDate);

    // INVOICE_TOTAL must equal the sum of this invoice's LINE_ITEM_TOTALs to the
    // cent; accumulate in integer cents, never floats (validators check this).
    let totalCents = 0;
    for (const e of list) totalCents += sumCents(e.amount, e.aiCost || 0);
    const total = (totalCents / 100).toFixed(2);

    let n = 0;
    const row = (e, type, units, unitCost, lineTotal, expenseCode, activity, desc) => {
      n += 1;
      const values = [
        ledesDate(invDate),
        invNumber,
        clean(e.client),
        clean(e.matter),
        total,
        ledesDate(start),
        ledesDate(end),
        clean(description || 'AI-assisted legal services'),
        String(n),
        type,
        units,
        '0.00',
        lineTotal,
        ledesDate(e.date),
        '', // UTBMS task code (matter-phase coding) not tracked
        expenseCode,
        activity,
        clean(config.timekeeperId),
        clean(desc),
        clean(config.firmId),
        unitCost,
        clean(config.timekeeper),
        clean(config.timekeeperClass),
        clean(e.matter),
      ];
      lines.push(values.join('|') + '[]');
    };

    for (const e of list) {
      // Fee line: units = exact billed hours, unit cost = the rate FROZEN onto
      // the entry at review time (never the live config rate), line total = the
      // exact-cents fee. units × unit-cost === line total holds by construction.
      row(e, 'F', formatUnits(e.hours), (e.rate || 0).toFixed(2), e.amount.toFixed(2), '', e.code, e.description);
      if ((e.aiCost || 0) > 0) {
        row(e, 'E', '1.0', e.aiCost.toFixed(2), e.aiCost.toFixed(2), 'E124', '',
          `AI usage cost (disclosed pass-through): ${e.description}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { ledesExport, FIELDS, formatUnits };
