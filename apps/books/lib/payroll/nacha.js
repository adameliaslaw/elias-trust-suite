// NACHA (ACH) file generation: payroll direct deposit and tax payments.
// Ported from the firm payroll app (payroll/nacha.py); that repo's test
// expectations are ported alongside in test/nacha.test.js.
//
// - buildPpdFile: unbalanced PPD credit file paying employees.
// - buildTaxPaymentFile: single CCD+ credit with a TXP addenda record — the
//   format EFTPS and the NJ Division of Revenue require for ACH credit tax
//   payments (EFTPS Financial Institution Handbook CCD+TXP layout; NJ's
//   Addendum Record specification).
//
// Your bank must enable ACH origination on the firm's account and will give
// you the immediate destination (their routing number) and your company or
// origin IDs — enter those in Payroll settings.

// Where EFTPS ACH credit federal tax payments are sent (EFTPS Financial
// Institution Handbook: "ACH Credit Routing and Account Numbers for
// Federal Tax Payments").
const TREASURY_ROUTING = '061036000';
const TREASURY_ACCOUNT = '23401009';
const TREASURY_NAME = 'IRS';

// EFTPS tax type codes (IRS Tax Form Numbers & Codes — Businesses).
const FED_941_DEPOSIT = '94105';   // Form 941 federal tax deposit
const FED_940_DEPOSIT = '09405';   // Form 940 federal tax deposit
// 941 subcategory codes for the TXP breakdown
const SUB_SOCIAL_SECURITY = '1';
const SUB_MEDICARE = '2';
const SUB_WITHHOLDING = '3';

// NJ Division of Revenue payment type codes (verified against DORES ACH
// Exhibit K (2026) and the current NJ-WT booklet).
const NJ_GIT_WEEKLY = '01170';     // Employer GIT withholding, weekly payer
const NJ_GIT_MONTHLY = '01120';    // Employer GIT withholding, monthly (NJ-500)
const NJ_GIT_QUARTERLY = '01130';  // Employer GIT withholding, quarterly (NJ-927)
// UI/DI/WF/HC employer+worker contributions ("Labor Payments", addendum A).
// VERIFY with the NJ EFT unit that ACH credit with this code is accepted for
// routine NJ-927 contributions; paying through the NJ portal is the safe default.
const NJ_LABOR_CONTRIBUTIONS = '13002';

function alpha(value, width) {
  return String(value == null ? '' : value).toUpperCase().slice(0, width).padEnd(width);
}

function num(value, width) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.slice(0, width).padStart(width, '0');
}

// Amount fields are whole cents, right-padded — exact conversion via
// @elias/money, never a float x100.
const money = require('../money');

// ACH Service Class Codes come from the cited @elias/rules rule set (NACHA
// Operating Rules & Guidelines, Appendix Three) — a payroll direct-deposit
// batch is credits-only (220), a CCD+ tax payment is also credits-only (220).
const { ACH_SERVICE_CLASS } = require('@elias/rules');
const SERVICE_CREDITS_ONLY = ACH_SERVICE_CLASS.CREDITS_ONLY.value;   // '220'

function amountCents(amount) {
  return money.centsInt(amount);
}

function routingCheckDigit(routing8) {
  const weights = [3, 7, 1, 3, 7, 1, 3, 7];
  let total = 0;
  for (let i = 0; i < 8; i++) total += Number(routing8[i]) * weights[i];
  return String((10 - (total % 10)) % 10);
}

// ---- date formatting (ISO 'YYYY-MM-DD' strings in, NACHA fields out) ----

function yymmdd(iso) {
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
}

function yymm01(iso) {
  return iso.slice(2, 4) + iso.slice(5, 7) + '01';
}

/**
 * EFTPS TXP addenda payment-related-information string.
 * TXP*EIN*type*YYMM01*subcat*amount[*subcat*amount[*subcat*amount]]\
 * Subcategories, when present, must sum to the total amount. Without them,
 * the tax type code and total amount are repeated (per the EFTPS CCD+TXP
 * addenda record format). periodEnd is an ISO date string.
 */
function eftpsTxp(ein, taxTypeCode, periodEnd, amount, subcategories) {
  const parts = ['TXP', num(ein, 9), taxTypeCode, yymm01(periodEnd)];
  if (subcategories && subcategories.length) {
    const total = subcategories.reduce((s, [, a]) => s + amountCents(a), 0);
    if (total !== amountCents(amount)) {
      throw new Error('TXP subcategories must sum to the payment amount');
    }
    for (const [code, subAmount] of subcategories.slice(0, 3)) {
      parts.push(code, String(amountCents(subAmount)));
    }
  } else {
    parts.push(taxTypeCode, String(amountCents(amount)));
  }
  return parts.join('*') + '\\';
}

/**
 * NJ Division of Revenue TXP addendum (their Addendum A/G layout).
 * TXP*B<12 digits>*<code>*YYMMDD*T*<cents>*****<NAME4>\
 * njTaxpayerId is the 12-digit NJ ID (EIN + 3-digit suffix, usually 000);
 * the mandatory "B" prefix is added here. Name control is the first four
 * characters of the business name, upper-cased.
 */
function njTxp(njTaxpayerId, paymentTypeCode, periodEnd, amount, nameControl) {
  const tid = 'B' + num(njTaxpayerId, 12);
  const name4 = (String(nameControl || '').toUpperCase().replace(/ /g, '') + 'XXXX').slice(0, 4);
  return 'TXP*' + tid + '*' + paymentTypeCode + '*' + yymmdd(periodEnd) +
    '*T*' + amountCents(amount) + '*****' + name4 + '\\';
}

function fileHeaderLine(company, nowDate, nowTime, fileIdModifier) {
  const dest = num(company.immediateDestination, 9);
  const origin = (company.immediateOrigin || '').trim() || ('1' + (company.ein || ''));
  return '101 ' + dest + alpha(origin.replace(/-/g, ''), 10).padStart(10) + nowDate + nowTime +
    fileIdModifier + '094' + '10' + '1' +
    alpha(company.destinationName, 23) +
    alpha(company.originName || company.name, 23) +
    alpha('', 8);
}

/**
 * Build a one-entry CCD+ credit NACHA file for a tax payment.
 *
 * company: {name, ein, bankRouting, immediateDestination, immediateOrigin,
 *           destinationName, originName?}
 * payment: {routing, account, receiverName, amount, addenda, description,
 *           identification}
 * fileDate: ISO datetime-ish {date: 'YYYY-MM-DD', time: 'HHMM'} or ISO date
 * effectiveDate: ISO date string
 */
function buildTaxPaymentFile(company, payment, fileDate, effectiveDate, fileIdModifier = 'A') {
  const lines = [];
  const nowDate = yymmdd(fileDate.date || fileDate);
  const nowTime = fileDate.time || '0900';
  const eff = yymmdd(effectiveDate);
  const odfi8 = num(company.bankRouting, 9).slice(0, 8);

  lines.push(fileHeaderLine(company, nowDate, nowTime, fileIdModifier));

  const companyId = '1' + num(company.ein, 9);
  lines.push(
    '5' + SERVICE_CREDITS_ONLY + alpha(company.name, 16) + alpha('', 20) + companyId +
    'CCD' + alpha(payment.description || 'TAXPAYMENT', 10) +
    nowDate + eff + '   ' + '1' + odfi8 + num(1, 7));

  const routing = num(payment.routing, 9);
  const amount = amountCents(payment.amount);
  lines.push(
    '6' + '22' + routing + alpha(payment.account, 17) +
    num(amount, 10) + alpha(payment.identification, 15) +
    alpha(payment.receiverName, 22) + '  ' + '1' + odfi8 + num(1, 7));

  lines.push('705' + alpha(payment.addenda, 80) + num(1, 4) + num(1, 7));

  const entryHash = Number(routing.slice(0, 8));
  lines.push(
    '8' + SERVICE_CREDITS_ONLY + num(2, 6) + num(entryHash % 1e10, 10) +
    num(0, 12) + num(amount, 12) + companyId +
    alpha('', 19) + alpha('', 6) + odfi8 + num(1, 7));

  const records = lines.length + 1;
  const blockCount = Math.floor((records + 9) / 10);
  lines.push(
    '9' + num(1, 6) + num(blockCount, 6) + num(2, 8) +
    num(entryHash % 1e10, 10) + num(0, 12) + num(amount, 12) +
    alpha('', 39));

  while (lines.length % 10 !== 0) lines.push('9'.repeat(94));
  return lines.join('\n') + '\n';
}

/**
 * Build a PPD credit NACHA file (payroll direct deposit).
 * entries: [{name, routing, account, accountType ('checking'|'savings'),
 *            amount, id}]
 */
function buildPpdFile(company, entries, fileDate, effectiveDate, fileIdModifier = 'A') {
  const lines = [];
  const nowDate = yymmdd(fileDate.date || fileDate);
  const nowTime = fileDate.time || '0900';
  const eff = yymmdd(effectiveDate);
  const odfi8 = num(company.bankRouting, 9).slice(0, 8);

  lines.push(fileHeaderLine(company, nowDate, nowTime, fileIdModifier));

  const companyId = '1' + num(company.ein, 9);
  // Service class 220 = ACH credits only (direct-deposit payroll is entirely
  // credits to employees). Using 200 (mixed debits + credits) misdeclares the
  // batch to the ODFI/ACH operator. NACHA Operating Rules & Guidelines,
  // Appendix Three, Company/Batch Header Record, field 2 (Service Class Code).
  lines.push(
    '5' + SERVICE_CREDITS_ONLY + alpha(company.name, 16) + alpha('', 20) + companyId +
    'PPD' + alpha('PAYROLL', 10) + nowDate + eff + '   ' + '1' + odfi8 + num(1, 7));

  let entryHash = 0;
  let totalCredit = 0;
  entries.forEach((e, i) => {
    const routing = num(e.routing, 9);
    entryHash += Number(routing.slice(0, 8));
    const amount = amountCents(e.amount);
    totalCredit += amount;
    const txCode = e.accountType === 'savings' ? '32' : '22';
    lines.push(
      '6' + txCode + routing + alpha(e.account, 17) +
      num(amount, 10) + alpha(String(e.id || ''), 15) +
      alpha(e.name, 22) + '  ' + '0' + odfi8 + num(i + 1, 7));
  });

  // Batch control service class must match the batch header (220, credits only).
  lines.push(
    '8' + SERVICE_CREDITS_ONLY + num(entries.length, 6) + num(entryHash % 1e10, 10) +
    num(0, 12) + num(totalCredit, 12) + companyId +
    alpha('', 19) + alpha('', 6) + odfi8 + num(1, 7));

  const records = lines.length + 1;
  const blockCount = Math.floor((records + 9) / 10);
  lines.push(
    '9' + num(1, 6) + num(blockCount, 6) + num(entries.length, 8) +
    num(entryHash % 1e10, 10) + num(0, 12) + num(totalCredit, 12) +
    alpha('', 39));

  while (lines.length % 10 !== 0) lines.push('9'.repeat(94));
  return lines.join('\n') + '\n';
}

module.exports = {
  TREASURY_ROUTING, TREASURY_ACCOUNT, TREASURY_NAME,
  FED_941_DEPOSIT, FED_940_DEPOSIT,
  SUB_SOCIAL_SECURITY, SUB_MEDICARE, SUB_WITHHOLDING,
  NJ_GIT_WEEKLY, NJ_GIT_MONTHLY, NJ_GIT_QUARTERLY, NJ_LABOR_CONTRIBUTIONS,
  routingCheckDigit, eftpsTxp, njTxp, buildTaxPaymentFile, buildPpdFile
};
