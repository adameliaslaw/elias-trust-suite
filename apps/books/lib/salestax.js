// NJ sales tax: collection on taxable invoice lines, trust-fund accounting,
// and the ST-50/ST-51 remittance calendar.
//
// Collected sales tax is NEVER income and remitting it is NEVER an expense —
// it is held in trust for the State (N.J.S.A. 54:32B). Every income figure in
// the app (dashboard, P&L, Schedule C feeds) uses paymentIncomeParts() to
// strip the tax portion of each payment on a cash basis.
//
// Filing rules (NJ Division of Taxation, ST-50/51 instructions):
// - Quarterly ST-50 return: due the 20th of the month after quarter end.
// - Monthly ST-51 remittance for months 1-2 of a quarter: due the 20th of
//   the following month, required only when more than $500 was collected in
//   the month AND the prior year's liability exceeded $30,000 (represented
//   here by the "monthly remitter" setting). Month 3 settles with the ST-50.
// Due dates are not shifted for weekends/holidays — when that happens, pay early.

const { decorateInvoice } = require('./store');
const { round2, sum, sub, shareOf } = require('./money');

const NJ_SALES_TAX_RATE = 6.625;        // statewide rate since 2018
const NJ_UEZ_RATE = 3.3125;             // Urban Enterprise Zone half rate
const ST51_MONTHLY_THRESHOLD = 500;     // per-month collected trigger

function salesTaxSettings(db) {
  const s = db.settings.salesTax || {};
  return {
    enabled: !!s.enabled,
    ratePct: Number(s.ratePct) > 0 ? Number(s.ratePct) : NJ_SALES_TAX_RATE,
    monthlyRemitter: !!s.monthlyRemitter   // prior-year liability > $30k
  };
}

// The invoice's tax/total ratio at the moment a payment is received. Storing
// this on the payment freezes the income vs. sales-tax-trust split so a later
// retroactive edit to the invoice's lines or rate cannot restate a prior
// period's income or trust liability (N.J.S.A. 54:32B — collected tax is held
// in trust; the amount held is fixed when the money comes in).
function taxSplitSnapshot(decoratedInv) {
  return { tax: decoratedInv.tax || 0, total: decoratedInv.total || 0 };
}

// Split one payment into (income, tax) on a cash basis, proportional to the
// invoice's subtotal/tax split. A payment carrying a `taxSnapshot` (recorded
// when the money was received) is split against that frozen ratio; only
// legacy payments with no snapshot fall back to the invoice's current ratio.
// Invoices without tax pass through unchanged.
function paymentIncomeParts(decoratedInv, payment) {
  const amount = Number(payment.amount) || 0;
  const snap = payment.taxSnapshot;
  const ratioTax = snap ? (Number(snap.tax) || 0) : decoratedInv.tax;
  const ratioTotal = snap ? (Number(snap.total) || 0) : decoratedInv.total;
  if (!(ratioTax > 0) || !(ratioTotal > 0)) {
    return { income: round2(amount), tax: 0 };
  }
  // Proportional split in exact integer cents — no float ratio.
  const tax = shareOf(amount, ratioTax, ratioTotal);
  return { income: sub(amount, tax), tax };
}

function collectedInRange(db, from, to) {
  const parts = [];
  for (const inv of db.invoices) {
    const d = decorateInvoice(inv);
    if (!(d.tax > 0)) continue;
    for (const p of inv.payments || []) {
      if (p.date >= from && p.date <= to) parts.push(paymentIncomeParts(d, p).tax);
    }
  }
  return sum(...parts);
}

function remittedFor(db, keys) {
  const set = new Set(Array.isArray(keys) ? keys : [keys]);
  return sum(...(db.salesTaxRemittances || [])
    .filter(r => set.has(r.periodKey))
    .map(r => r.amount));
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function monthEnd(year, month) {
  return month === 12 ? iso(year, 12, 31)
    : new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function due20thFollowing(year, month) {
  return month === 12 ? iso(year + 1, 1, 20) : iso(year, month + 1, 20);
}

// The year's remittance calendar: ST-51 monthly entries (when a monthly
// remitter) and ST-50 quarterly settle-ups.
function schedule(db, year, cfg, todayIso) {
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const entries = [];
  for (let q = 1; q <= 4; q++) {
    const qMonths = [q * 3 - 2, q * 3 - 1, q * 3];
    const qStart = iso(year, qMonths[0], 1);
    if (qStart > today) break;
    const monthKeys = [];
    for (const m of qMonths.slice(0, 2)) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      monthKeys.push(key);
      if (!cfg.monthlyRemitter) continue;
      if (iso(year, m, 1) > today) continue;
      const collected = collectedInRange(db, iso(year, m, 1), monthEnd(year, m));
      const remitted = remittedFor(db, key);
      entries.push({
        key, type: 'ST-51', label: `ST-51 ${key}`,
        due: due20thFollowing(year, m),
        collected, remitted,
        required: collected > ST51_MONTHLY_THRESHOLD,
        outstanding: collected > ST51_MONTHLY_THRESHOLD ? Math.max(sub(collected, remitted), 0) : 0
      });
    }
    const qKey = `${year}-Q${q}`;
    const qCollected = collectedInRange(db, qStart, monthEnd(year, qMonths[2]));
    const remittedAll = remittedFor(db, [...monthKeys, qKey]);
    entries.push({
      key: qKey, type: 'ST-50', label: `ST-50 Q${q} ${year}`,
      due: due20thFollowing(year, qMonths[2]),
      collected: qCollected,
      remitted: remittedAll,
      required: qCollected > 0,
      outstanding: Math.max(sub(qCollected, remittedAll), 0)
    });
  }
  return entries;
}

function summary(db, year, cfg, todayIso) {
  const entries = schedule(db, year, cfg, todayIso);
  const collected = collectedInRange(db, `${year}-01-01`, `${year}-12-31`);
  const remitted = sum(...(db.salesTaxRemittances || [])
    .filter(r => r.periodKey.startsWith(String(year)))
    .map(r => r.amount));
  return {
    year,
    settings: cfg,
    collected,
    remitted,
    balance: sub(collected, remitted),
    schedule: entries
  };
}

module.exports = {
  NJ_SALES_TAX_RATE, NJ_UEZ_RATE, ST51_MONTHLY_THRESHOLD,
  salesTaxSettings, paymentIncomeParts, taxSplitSnapshot, collectedInRange, remittedFor,
  schedule, summary
};
