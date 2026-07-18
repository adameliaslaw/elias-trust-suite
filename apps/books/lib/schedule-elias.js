// Schedule Elias — depreciation-to-DTI analyzer (Phase 1).
// The same return drives two numbers: what you owe the IRS and what an
// underwriter says you can borrow. This module computes the lender side
// (agency worksheet + 75% shortcut, SEB cash flow from the books, DTI and
// max-purchase) and hands the tax side (Schedule E net, §469 toggle, QBI
// safe-harbor eligibility, NIIT base) to lib/tax1040.js.
// Spec: SCHEDULEELIAS spec §§4-9. Phase 2 fields exist in the data model
// (nullable) so per-property MACRS/§469/recapture slot in without migration.

const { cents, num } = require('./payroll/engine');
const phase2 = require('./elias-phase2');

// Guideline & statutory constants — these change with guidelines/tax years.
const CONSTANTS = {
  GROSS_RENT_FACTOR_PCT: 75,        // Fannie B3-3.1-08 quick screen
  RESIDENTIAL_RECOVERY_YEARS: 27.5, // IRC §168(c), residential rental
  DTI_BANDS: [                      // original design's color thresholds
    { max: 36, label: 'Excellent' },
    { max: 43, label: 'Acceptable' },
    { max: 50, label: 'Stretched' },
    { max: Infinity, label: 'Over limit' }
  ],
  NIIT_RATE: 0.038,                 // IRC §1411 (statutory, not indexed)
  NIIT_THRESHOLD: { single: 200000, married_jointly: 250000, head_of_household: 200000 },
  MILEAGE_DEPRECIATION_RATE: 0.30,  // per-mile depreciation component of the
                                    // IRS standard mileage rate — confirm annually
  DECLINING_INCOME_WARN_PCT: 20     // Form 1084 practice: >20% decline is a red flag
};

const STRATEGIES = ['conservative', 'balanced', 'aggressive'];

function defaultScheduleElias() {
  return {
    settings: {
      depreciationStrategy: 'balanced',
      sec469Handling: 'suspend',      // suspend | allow | phase2 (Form 8582-lite)
      activeParticipation: true,      // phase2: $25K special allowance
      reProfessional: false,          // phase2: losses allowed in full
      suspendedCarryforward: 0,       // phase2: prior-year Form 8582 balance
      qbiSafeHarbor: false,           // Rev. Proc. 2019-38
      dtiTargetPct: 45,
      grossRentFactorPct: CONSTANTS.GROSS_RENT_FACTOR_PCT
    },
    borrower: {
      monthlyW2Income: 0,
      monthlyNonHousingDebts: 0,
      primaryResidencePITIA: 0,
      purchaseType: 'additional',     // primary_replacement | additional
      countProjectedRent: false,
      proposedPurchase: {
        targetPrice: 0, downPaymentPct: 20, ratePct: 0, termMonths: 360,
        monthlyTaxes: 0, monthlyInsurance: 0, monthlyHOA: 0,
        projectedMonthlyRent: 0
      }
    },
    seb: {},          // companyId -> manual supplements (see sanitizeSeb)
    properties: []
  };
}

function sanitizeSeb(b = {}) {
  const f = k => Math.max(num(b[k]), 0);
  return {
    depreciation: f('depreciation'),
    amortization: f('amortization'),
    depletion: f('depletion'),
    businessUseOfHome: f('businessUseOfHome'),
    businessMiles: f('businessMiles'),
    nonrecurringOtherIncome: f('nonrecurringOtherIncome'),
    nonrecurringLoss: f('nonrecurringLoss'),
    priorYearNet: num(b.priorYearNet)
  };
}

const EXPENSE_FIELDS = [
  'advertising', 'autoTravel', 'cleaningMaintenance', 'commissions', 'insurance',
  'legalProfessional', 'managementFees', 'mortgageInterest', 'otherInterest',
  'repairs', 'supplies', 'taxes', 'utilities', 'other'
];

function sanitizeProperty(b, existing) {
  const e = existing || {};
  const acq = { ...(e.acquisition || {}), ...(b.acquisition || {}) };
  const fin = { ...(e.financing || {}), ...(b.financing || {}) };
  const ops = { ...(e.operations || {}), ...(b.operations || {}) };
  const dep = { ...(e.depreciation || {}), ...(b.depreciation || {}) };
  const expenses = {};
  const rawExp = { ...((e.operations || {}).annualExpenses || {}), ...(ops.annualExpenses || {}) };
  for (const k of EXPENSE_FIELDS) expenses[k] = Math.max(num(rawExp[k]), 0);
  const byStrategy = { ...(dep.annualByStrategy || {}) };
  for (const s of STRATEGIES) byStrategy[s] = Math.max(num(byStrategy[s]), 0);
  return {
    id: e.id || b.id,
    nickname: String(b.nickname ?? e.nickname ?? '').trim(),
    address: String(b.address ?? e.address ?? '').trim(),
    type: 'residential_rental',
    monthsInService: Math.min(Math.max(Math.round(num(b.monthsInService ?? e.monthsInService ?? 12)) || 12, 1), 12),
    acquisition: {
      purchasePrice: Math.max(num(acq.purchasePrice), 0),
      landAllocationPct: Math.min(Math.max(num(acq.landAllocationPct ?? 20), 0), 90),
      placedInServiceDate: /^\d{4}-\d{2}-\d{2}$/.test(acq.placedInServiceDate || '') ? acq.placedInServiceDate : '',
      improvements: num(b.capitalImprovements) > 0
        ? [{ label: 'Capital improvements', amount: num(b.capitalImprovements) }]
        : (Array.isArray(acq.improvements) ? acq.improvements : [])
    },
    financing: {
      monthlyPI: Math.max(num(fin.monthlyPI), 0),
      monthlyTaxes: Math.max(num(fin.monthlyTaxes), 0),
      monthlyInsurance: Math.max(num(fin.monthlyInsurance), 0),
      monthlyHOA: Math.max(num(fin.monthlyHOA), 0),
      loanBalance: Math.max(num(fin.loanBalance), 0),
      ratePct: Math.max(num(fin.ratePct), 0)
    },
    operations: {
      annualGrossRent: Math.max(num(ops.annualGrossRent), 0),
      annualExpenses: expenses,
      oneTimeExpenses: Math.max(num(ops.oneTimeExpenses), 0)
    },
    depreciation: {
      annualByStrategy: byStrategy,
      useComputedDefault: dep.useComputedDefault !== false
    },
    phase2: {
      macrsSchedule: null,
      costSegComponents: (b.phase2 && b.phase2.costSegComponents) || (e.phase2 && e.phase2.costSegComponents)
        ? {
            five: Math.max(num((b.phase2 && b.phase2.costSegComponents && b.phase2.costSegComponents.five) ?? (e.phase2 && e.phase2.costSegComponents && e.phase2.costSegComponents.five)), 0),
            seven: Math.max(num((b.phase2 && b.phase2.costSegComponents && b.phase2.costSegComponents.seven) ?? (e.phase2 && e.phase2.costSegComponents && e.phase2.costSegComponents.seven)), 0),
            fifteen: Math.max(num((b.phase2 && b.phase2.costSegComponents && b.phase2.costSegComponents.fifteen) ?? (e.phase2 && e.phase2.costSegComponents && e.phase2.costSegComponents.fifteen)), 0)
          }
        : null,
      suspendedLossCarryforward: null,   // household-level in settings for now
      accumulatedDepreciation: Math.max(num((b.phase2 && b.phase2.accumulatedDepreciation) ?? (e.phase2 && e.phase2.accumulatedDepreciation)), 0) || null
    }
  };
}

// Straight-line default: building basis over 27.5 years (full-year figure;
// year-one mid-month proration is Phase 2).
function computedDefaultDepreciation(property) {
  const a = property.acquisition;
  return cents(a.purchasePrice * (1 - a.landAllocationPct / 100) / CONSTANTS.RESIDENTIAL_RECOVERY_YEARS);
}

// Depreciation for a strategy. "Conservative" = plain straight-line (you
// can't legally under-depreciate — it means no cost-seg acceleration);
// "balanced" defaults to the same; "aggressive" is user-entered until
// Phase 2 computes cost-seg/bonus outcomes.
function annualDepreciation(property, strategy, taxYear) {
  // Phase 2: a placed-in-service date switches this property to the real
  // MACRS engine (mid-month 27.5-yr SL; cost-seg/bonus under 'aggressive').
  if (phase2.hasPhase2(property)) {
    return phase2.macrsForYear(property, strategy, taxYear || new Date().getFullYear());
  }
  const dep = property.depreciation;
  if (dep.useComputedDefault && (strategy === 'balanced' || strategy === 'conservative')) {
    return computedDefaultDepreciation(property);
  }
  return cents(dep.annualByStrategy[strategy] || 0);
}

function sumExpenses(property) {
  return cents(EXPENSE_FIELDS.reduce((s, k) => s + property.operations.annualExpenses[k], 0));
}

// §5.1 agency worksheet method (Fannie Form 1038 / B3-3.1-08 style) +
// §5.2 the 75% quick screen, for one property under one strategy.
function propertyAnalysis(property, strategy, grossRentFactorPct, taxYear) {
  const ops = property.operations;
  const fin = property.financing;
  const depreciation = annualDepreciation(property, strategy, taxYear);
  const expenses = sumExpenses(property);
  const scheduleENet = cents(ops.annualGrossRent - expenses - ops.oneTimeExpenses - depreciation);
  const adjustedIncome = cents(scheduleENet + depreciation +
    ops.annualExpenses.mortgageInterest + ops.annualExpenses.taxes +
    ops.annualExpenses.insurance + ops.oneTimeExpenses);
  const monthlyAdjusted = cents(adjustedIncome / property.monthsInService);
  const monthlyPITIA = cents(fin.monthlyPI + fin.monthlyTaxes + fin.monthlyInsurance + fin.monthlyHOA);
  const netRental = cents(monthlyAdjusted - monthlyPITIA);
  const netRental75 = cents((ops.annualGrossRent / 12) * (grossRentFactorPct / 100) - monthlyPITIA);
  return { id: property.id, nickname: property.nickname, depreciation, expenses, scheduleENet, adjustedIncome, monthlyAdjusted, monthlyPITIA, netRental, netRental75 };
}

// §5.3 portfolio aggregation: positive income and negative liability stay in
// separate buckets — they land on different sides of the DTI ratio.
function portfolioAnalysis(properties, settings, strategyOverride, taxYear) {
  const strategy = STRATEGIES.includes(strategyOverride) ? strategyOverride : settings.depreciationStrategy;
  const perProperty = properties.map(p => propertyAnalysis(p, strategy, settings.grossRentFactorPct, taxYear));
  return {
    strategy,
    perProperty,
    scheduleENetTotal: cents(perProperty.reduce((s, p) => s + p.scheduleENet, 0)),
    positiveNetRental: cents(perProperty.filter(p => p.netRental > 0).reduce((s, p) => s + p.netRental, 0)),
    negativeNetRentalLiability: cents(perProperty.filter(p => p.netRental < 0).reduce((s, p) => s - p.netRental, 0)),
    net75Total: cents(perProperty.reduce((s, p) => s + p.netRental75, 0))
  };
}

// §6 SEB (Form 1084-style cash flow) from a company's actual books.
// books = {netProfit, mealsExpense} pulled from the company's categorized
// expenses; supplements = sanitizeSeb() manual figures for lines QuickBucks
// has no category for (flagged in the UI, never silently zeroed).
function sebAnalysis(books, supplements) {
  const s = supplements;
  // Meals: the 50% NOT deducted is cash actually spent — SUBTRACT it.
  const mealsNonDeductible = cents((books.mealsExpense || 0) * 0.5);
  const adjustedAnnual = cents(
    books.netProfit
    - s.nonrecurringOtherIncome
    + s.nonrecurringLoss
    + s.depletion
    + s.depreciation
    + s.amortization
    + s.businessUseOfHome
    - mealsNonDeductible
    + s.businessMiles * CONSTANTS.MILEAGE_DEPRECIATION_RATE
  );
  // Two-year trend: average when stable/rising, current-only when declining.
  let usableAnnual = adjustedAnnual;
  let trend = 'single_year';
  let declinePct = 0;
  if (s.priorYearNet > 0) {
    if (adjustedAnnual >= s.priorYearNet) {
      usableAnnual = cents((adjustedAnnual + s.priorYearNet) / 2);
      trend = 'averaged';
    } else {
      trend = 'declining';
      declinePct = Math.round(((s.priorYearNet - adjustedAnnual) / s.priorYearNet) * 100);
    }
  }
  return {
    netProfit: cents(books.netProfit),
    mealsNonDeductible,
    adjustedAnnual,
    usableAnnual,
    monthlyIncome: cents(usableAnnual / 12),
    trend,
    declinePct,
    warnDeclining: trend === 'declining' && declinePct > CONSTANTS.DECLINING_INCOME_WARN_PCT
  };
}

// Standard amortization payment.
function monthlyPI(price, downPaymentPct, ratePct, termMonths) {
  const loan = price * (1 - downPaymentPct / 100);
  const r = ratePct / 1200;
  if (loan <= 0 || termMonths <= 0) return 0;
  if (r === 0) return cents(loan / termMonths);
  return cents(loan * r / (1 - Math.pow(1 + r, -termMonths)));
}

// §7 DTI for a given purchase price (taxes/insurance scale with price).
function dtiAt(price, borrower, income) {
  const pp = borrower.proposedPurchase;
  const scale = pp.targetPrice > 0 ? price / pp.targetPrice : 1;
  let proposedPITIA = monthlyPI(price, pp.downPaymentPct, pp.ratePct, pp.termMonths) +
    pp.monthlyTaxes * scale + pp.monthlyInsurance * scale + pp.monthlyHOA;
  if (borrower.purchaseType === 'additional' && borrower.countProjectedRent) {
    proposedPITIA -= (pp.projectedMonthlyRent || 0) * (CONSTANTS.GROSS_RENT_FACTOR_PCT / 100);
  }
  proposedPITIA = Math.max(cents(proposedPITIA), 0);
  const housing = proposedPITIA + (borrower.purchaseType === 'additional' ? borrower.primaryResidencePITIA : 0);
  const liabilities = borrower.monthlyNonHousingDebts + income.negativeNetRentalLiability;
  const gross = income.grossMonthlyQualifying;
  return {
    proposedPITIA,
    frontEndDTI: gross > 0 ? cents((proposedPITIA / gross) * 100) : null,
    backEndDTI: gross > 0 ? cents(((housing + liabilities) / gross) * 100) : null
  };
}

function dtiBand(pct) {
  if (pct === null) return null;
  return CONSTANTS.DTI_BANDS.find(b => pct <= b.max).label;
}

// Binary-search the price where back-end DTI hits the target (±$500).
function maxPurchaseSolver(borrower, income, dtiTargetPct) {
  if (income.grossMonthlyQualifying <= 0) return { maxPrice: 0, maxLoan: 0 };
  const fits = price => {
    const d = dtiAt(price, borrower, income);
    return d.backEndDTI !== null && d.backEndDTI <= dtiTargetPct;
  };
  if (!fits(0)) return { maxPrice: 0, maxLoan: 0 };   // over target before any purchase
  let lo = 0, hi = 1000000;
  while (fits(hi) && hi < 100000000) hi *= 2;
  while (hi - lo > 500) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const maxPrice = Math.floor(lo / 500) * 500;
  return {
    maxPrice,
    maxLoan: cents(maxPrice * (1 - borrower.proposedPurchase.downPaymentPct / 100))
  };
}

// Full lender-side picture for the household.
// sebByCompany = [{id, name, seb}], portfolio = portfolioAnalysis() result.
function borrowingAnalysis(borrower, sebByCompany, portfolio, dtiTargetPct) {
  const income = {
    monthlyW2Income: cents(borrower.monthlyW2Income),
    sebMonthlyTotal: cents(sebByCompany.reduce((s, c) => s + Math.max(c.seb.monthlyIncome, 0), 0)),
    positiveNetRental: portfolio.positiveNetRental,
    negativeNetRentalLiability: portfolio.negativeNetRentalLiability,
    grossMonthlyQualifying: 0
  };
  income.grossMonthlyQualifying = cents(income.monthlyW2Income + income.sebMonthlyTotal + income.positiveNetRental);
  const atTarget = dtiAt(borrower.proposedPurchase.targetPrice, borrower, income);
  return {
    income,
    proposed: {
      ...atTarget,
      frontEndBand: dtiBand(atTarget.frontEndDTI),
      backEndBand: dtiBand(atTarget.backEndDTI)
    },
    maxPurchase: maxPurchaseSolver(borrower, income, dtiTargetPct)
  };
}

module.exports = {
  CONSTANTS, STRATEGIES, EXPENSE_FIELDS,
  defaultScheduleElias, sanitizeSeb, sanitizeProperty,
  computedDefaultDepreciation, annualDepreciation,
  propertyAnalysis, portfolioAnalysis, sebAnalysis,
  monthlyPI, dtiAt, dtiBand, maxPurchaseSolver, borrowingAnalysis
};
