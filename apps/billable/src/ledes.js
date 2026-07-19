'use strict';
// LEDES 1998B export — the pipe-delimited e-billing format accepted by
// legal billing systems, e-billing vendors, and insurance carriers.
// Fee lines carry the UTBMS activity code; AI usage pass-through costs go
// out as expense lines (E124 "Other") so they are disclosed, not buried.

const { sumCents } = require('./money');

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

function ledesExport(entries, config, { invoiceNumber, invoiceDate, from, to, description } = {}) {
  const billable = entries.filter((e) => !e.writeOff);
  const dates = billable.map((e) => e.date).sort();
  const start = from || dates[0] || '';
  const end = to || dates[dates.length - 1] || '';
  const invDate = invoiceDate || end || start;
  const invNumber = invoiceNumber || `MP-${ledesDate(invDate) || 'DRAFT'}`;

  // INVOICE_TOTAL must equal the sum of LINE_ITEM_TOTALs to the cent;
  // accumulate in integer cents, never floats (LEDES validators check this).
  let totalCents = 0;
  for (const e of billable) totalCents += sumCents(e.amount, e.aiCost || 0);
  const total = (totalCents / 100).toFixed(2);

  const lines = ['LEDES1998B[]', FIELDS.join('|') + '[]'];
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

  for (const e of billable) {
    row(
      e,
      'F',
      e.hours.toFixed(1),
      (config.rate || 0).toFixed(2),
      e.amount.toFixed(2),
      '',
      e.code,
      e.description
    );
    if ((e.aiCost || 0) > 0) {
      row(
        e,
        'E',
        '1.0',
        e.aiCost.toFixed(2),
        e.aiCost.toFixed(2),
        'E124',
        '',
        `AI usage cost (disclosed pass-through): ${e.description}`
      );
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { ledesExport, FIELDS };
