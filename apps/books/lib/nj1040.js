// NJ-1040 resident gross income tax estimate — a PLANNING tool, not a
// filing engine. Sits beside the federal estimate on the Taxes page.
//
// New Jersey differences implemented (N.J.S.A. 54A; NJ-1040 instructions):
// - Category income with NO cross-category netting and no carryforwards:
//   a business loss cannot offset wages, so "net profits from business" and
//   "net rents" are each floored at zero.
// - No standard deduction and no QBI. No deduction for federal SE tax,
//   SEP/IRA contributions, or 401(k) employer-plan matches (employee 401(k)
//   deferrals are already excluded from NJ wages at payroll time).
// - Personal exemptions: $1,000 per taxpayer/spouse; $1,500 per dependent
//   child (other-dependent $1,000 not distinguished here — estimate).
// - Property tax deduction: up to $15,000 of property taxes paid on a
//   principal residence (or the $50 credit if better — the deduction is
//   compared against the credit and the better one is applied).
// - Rate schedules are statutory and not inflation-indexed (unchanged
//   2020-2026): two schedules, single/MFS vs joint/HoH/surviving spouse.
// Not modeled: medical-expense deduction (>2% floor), NJ EITC, the
// healthcare shared-responsibility payment, use tax, credits for taxes
// paid to other states. Review with your accountant.

const { cents: round2 } = require('./payroll/engine');

// [floor, marginalRate] — N.J.S.A. 54A:2-1.
const NJ_BRACKETS = {
  single: [
    [0, 0.014], [20000, 0.0175], [35000, 0.035], [40000, 0.05525],
    [75000, 0.0637], [500000, 0.0897], [1000000, 0.1075]
  ],
  married_jointly: [
    [0, 0.014], [20000, 0.0175], [50000, 0.0245], [70000, 0.035],
    [80000, 0.05525], [150000, 0.0637], [500000, 0.0897], [1000000, 0.1075]
  ],
  head_of_household: [
    [0, 0.014], [20000, 0.0175], [50000, 0.0245], [70000, 0.035],
    [80000, 0.05525], [150000, 0.0637], [500000, 0.0897], [1000000, 0.1075]
  ]
};

const EXEMPTION_TAXPAYER = 1000;
const EXEMPTION_DEPENDENT = 1500;
const PROPERTY_TAX_DEDUCTION_CAP = 15000;
const PROPERTY_TAX_CREDIT = 50;
const FILING_THRESHOLD = { single: 10000, married_jointly: 20000, head_of_household: 20000 };

function bracketTax(rows, taxable) {
  if (taxable <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < rows.length; i++) {
    const [floor, rate] = rows[i];
    const ceil = i + 1 < rows.length ? rows[i + 1][0] : Infinity;
    if (taxable <= floor) break;
    tax += (Math.min(taxable, ceil) - floor) * rate;
  }
  return tax;
}

/**
 * input = {filingStatus, wages, businessNet, rentalNet, otherIncome,
 *          njDependents, propertyTaxPaid, njWithholding, njEstimatedPayments}
 */
function estimateNJ1040(input) {
  const status = NJ_BRACKETS[input.filingStatus] ? input.filingStatus : 'married_jointly';
  const wages = Math.max(Number(input.wages) || 0, 0);
  // Category floors: losses in one category never offset another.
  const businessNet = Math.max(Number(input.businessNet) || 0, 0);
  const rentalNet = Math.max(Number(input.rentalNet) || 0, 0);
  const otherIncome = Math.max(Number(input.otherIncome) || 0, 0);
  const grossIncome = round2(wages + businessNet + rentalNet + otherIncome);

  const taxpayers = status === 'married_jointly' ? 2 : 1;
  const exemptions = taxpayers * EXEMPTION_TAXPAYER +
    Math.max(Math.floor(Number(input.njDependents) || 0), 0) * EXEMPTION_DEPENDENT;

  const propertyTaxPaid = Math.max(Number(input.propertyTaxPaid) || 0, 0);
  const propertyTaxDeduction = Math.min(propertyTaxPaid, PROPERTY_TAX_DEDUCTION_CAP);

  const belowThreshold = grossIncome <= FILING_THRESHOLD[status];

  const computeTax = deduction => {
    const taxable = Math.max(grossIncome - exemptions - deduction, 0);
    return { taxable: round2(taxable), tax: belowThreshold ? 0 : round2(bracketTax(NJ_BRACKETS[status], taxable)) };
  };
  const withDeduction = computeTax(propertyTaxDeduction);
  const withoutDeduction = computeTax(0);
  // Deduction vs the flat $50 credit — take whichever saves more.
  const creditPath = { ...withoutDeduction, tax: round2(Math.max(withoutDeduction.tax - (propertyTaxPaid > 0 ? PROPERTY_TAX_CREDIT : 0), 0)) };
  const useDeduction = propertyTaxPaid > 0 && withDeduction.tax <= creditPath.tax;
  const chosen = useDeduction ? withDeduction : creditPath;

  const payments = round2((Number(input.njWithholding) || 0) + (Number(input.njEstimatedPayments) || 0));
  return {
    filingStatus: status,
    wages: round2(wages),
    businessNet, rentalNet, otherIncome,
    grossIncome,
    belowFilingThreshold: belowThreshold,
    exemptions: round2(exemptions),
    propertyTaxDeduction: useDeduction ? round2(propertyTaxDeduction) : 0,
    propertyTaxCredit: !useDeduction && propertyTaxPaid > 0 ? PROPERTY_TAX_CREDIT : 0,
    taxableIncome: chosen.taxable,
    tax: chosen.tax,
    payments,
    balanceDue: round2(chosen.tax - payments),
    effectiveRate: grossIncome > 0 ? round2((chosen.tax / grossIncome) * 100) : 0
  };
}

// NJ-1040-ES quarterly plan. NJ's rules differ from the federal ones:
// estimated payments are only required when the year's tax after
// withholding exceeds $400 (N.J.S.A. 54A:8-4), and the NJ-2210 safe
// harbor is 80% of the current year's tax or 100% of the prior year's —
// there is no 110% high-income tier. Due dates match the federal
// calendar (Apr/Jun/Sep 15 + Jan 15).
const NJ_ES_THRESHOLD = 400;

function quarterlyEsPlan(nj, priorYearNjTax, esDueDates, todayIso) {
  const dates = esDueDates || [];
  const prior = Math.max(Number(priorYearNjTax) || 0, 0);
  const current80 = round2(0.80 * nj.tax);
  const prior100 = prior > 0 ? round2(prior) : null;
  const required = prior100 !== null ? Math.min(current80, prior100) : current80;
  const basis = prior100 !== null && prior100 < current80
    ? '100% of prior-year NJ tax' : '80% of current-year NJ estimate';
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const upcoming = dates.filter(d => d >= today);
  // No estimated payments required at all when the year's tax after
  // payments already made stays within the $400 threshold.
  const belowThreshold = round2(nj.tax - nj.payments) <= NJ_ES_THRESHOLD;
  const remaining = belowThreshold ? 0 : Math.max(round2(required - nj.payments), 0);
  const perQuarter = upcoming.length ? round2(remaining / upcoming.length) : 0;
  return {
    required, basis,
    threshold: NJ_ES_THRESHOLD,
    belowThreshold,
    paid: nj.payments,
    remaining,
    yearClosed: upcoming.length === 0,
    quarters: dates.map((d, i) => ({
      quarter: `Q${i + 1}`,
      due: d,
      past: d < today,
      suggested: d >= today ? perQuarter : 0
    }))
  };
}

module.exports = { NJ_BRACKETS, EXEMPTION_TAXPAYER, EXEMPTION_DEPENDENT, NJ_ES_THRESHOLD, estimateNJ1040, quarterlyEsPlan, bracketTax };
