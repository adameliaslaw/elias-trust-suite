// Schedule Elias: family real estate coordination, underwriting, and tax
// strategy projections. Currently rented properties are the factual layer
// (lease, rent roll, deposit ledger); strategy projections layer investment
// analysis on top with NJ-specific anchors — all depreciation is a
// planning-grade placeholder (25-yr SL on price × (1 − land%), no basis
// adjustments) until Phase 2 switches on via a placed-in-service date.
//
// NJ anchors (all 2026):
// - Transfer tax: seller's RTT (1%–2.5% graduated, N.J.S.A. 46:15-7);
//   buyer's 1% mansion tax over $1M (46:15-7.2) on our side.
// - Prepaid tuition = ordinary income, taxed at the owner's marginal NJ rate
//   (not the 10.75% composite estimate used in the old one-off script).
// - NJ's $15K property-tax deduction applies to principal residences only.
// - STRs under 90 days are exempt from NJ sales/occupancy taxes only when
//   booked directly (N.J.S.A. 54:32B); Airbnb collects otherwise.
//
// CAUTION: QuickBooks-style personal advice to family members has UPL
// implications; this tool is for planning and coordination only.

const { cents: round2 } = require('./payroll/engine');

const AMORTIZATION_MONTHS = 12;
const TRANSFER_TAX_RATE = 0.01;
const MORTGAGE_POINTS_PCT = 1;
const CAPEX_RESERVE_PCT = 5;
const TURNOVER_COST_PCT = 2;
const DEFAULT_RENT_GROWTH_PCT = 2;
const DEFAULT_EXPENSE_GROWTH_PCT = 2;
const DEFAULT_APPRECIATION_PCT = 3;
const DEFAULT_VACANCY_PCT = 5;
const ANCHORAGE_GROSS_ANCHOR = 20630;   // observed baseline for reference
const PHASE2_ANNUAL_RENT = 19920;       // 12 × $1,660
const TUITION_CREDIT_TOTAL = 4664;
const TUITION_CREDIT_YEARLY = 1166;
const ANCHORAGE_LAND_PCT = 15;
const LTR_DEDUCTION_PCT = 20;
const STR_TAX_PCT = 6.625;
const NJ_MARGINAL_RATE = 0.0637;   // NJ top rate at typical household income

// ---------- money helpers ----------

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function monthlyPmt(principal, annualRatePct, months) {
  if (principal <= 0 || months <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  if (r <= 0) return principal / months;
  return principal * r / (1 - Math.pow(1 + r, -months));
}

// ---------- depreciation (Phase 1 placeholder) ----------

function depreciationForYear(property, strategy, year) {
  if (strategy !== 'aggressive') return 0;
  if (year === undefined) return 0;
  // Pure estimate: 25-yr straight line on price × (1 − land%), starting at
  // acquisition year. Phase 2 (placed-in-service date) replaces this with
  // MACRS 27.5 SL, mid-month, plus cost-seg components — see elias-phase2.js.
  const price = num(property.acquisition && property.acquisition.purchasePrice);
  const landPct = num(property.acquisition && property.acquisition.landAllocationPct) || ANCHORAGE_LAND_PCT;
  const basis = price * (1 - landPct / 100);
  const annual = basis / 25;
  const purchaseYear = Number(String(property.acquisition && property.acquisition.closingDate || '').slice(0, 4));
  if (!purchaseYear || year < purchaseYear) return 0;
  return round2(annual);
}

// ---------- P&L / cash-flow per property ----------

function effectiveGrossIncome(property, year, opts) {
  const vacancy = num(opts.vacancyPct ?? property.vacancyPct ?? DEFAULT_VACANCY_PCT);
  return round2(property.annualRent * (1 - vacancy / 100));
}

function operatingExpenses(property, year, opts) {
  const taxes = num(property.taxesAnnual);
  const ins = num(property.insuranceAnnual);
  const utils = num(property.utilitiesAnnual);
  const maint = num(property.maintenanceAnnual);
  const other = num(property.otherExpensesAnnual);
  const capex = property.annualRent * CAPEX_RESERVE_PCT / 100;
  const turnover = property.annualRent * TURNOVER_COST_PCT / 100;
  return round2(taxes + ins + utils + maint + other + capex + turnover);
}

function netOperatingIncome(property, year, opts) {
  return round2(effectiveGrossIncome(property, year, opts) - operatingExpenses(property, year, opts));
}

function debtServiceAnnual(financing) {
  const monthly = monthlyPmt(num(financing.loanAmount), num(financing.interestRatePct), num(financing.termMonths));
  return round2(monthly * 12);
}

function cashFlowBeforeTax(property, year, opts) {
  return round2(netOperatingIncome(property, year, opts) - debtServiceAnnual(property.financing));
}

// ---------- the three strategies ----------

// For each strategy return the tax-year projection rows the strategy engine
// produces. Rows are pure data; the UI and tax planner consume them.

function strategyLongTermRental(property, year, opts) {
  const egi = effectiveGrossIncome(property, year, opts);
  const opex = operatingExpenses(property, year, opts);
  const depreciation = depreciationForYear(property, 'aggressive', year);
  const netIncome = round2(egi - opex);
  const deduction = round2(netIncome * LTR_DEDUCTION_PCT / 100);
  const taxSavings = round2(deduction * num(opts.marginalRate));
  return {
    id: 'long_term_rental',
    label: 'Long-term rental',
    netIncome,
    depreciation,
    deduction,
    taxSavings,
    cashFlowBeforeTax: cashFlowBeforeTax(property, year, opts),
    notes: '20% estimated deduction × marginal rate; confirm against actual filing.'
  };
}

function strategyShortTermRental(property, year, opts) {
  const occupancy = num(opts.occupancyPct ?? property.strOccupancyPct ?? 55);
  const nightlyRate = num(property.strNightlyRate ?? 150);
  const nights = Math.round(365 * occupancy / 100);
  const gross = round2(nights * nightlyRate);
  const platformFee = round2(gross * num(property.strPlatformFeePct ?? 3) / 100);
  const cleaning = round2(nights * num(property.strCleaningPerTurn ?? 0));
  const taxes = round2(gross * STR_TAX_PCT / 100);   // NJ occupancy taxes via platform
  const opex = operatingExpenses(property, year, opts);
  const netIncome = round2(gross - platformFee - cleaning - taxes - opex);
  const depreciation = depreciationForYear(property, 'aggressive', year);
  const taxSavings = round2((Math.max(netIncome, 0) * LTR_DEDUCTION_PCT / 100) * num(opts.marginalRate));
  return {
    id: 'short_term_rental',
    label: 'Short-term rental (STR)',
    gross, nights, occupancyPct: occupancy,
    platformFee, cleaning, strTaxes: taxes,
    netIncome, depreciation, taxSavings,
    cashFlowBeforeTax: round2(netIncome - debtServiceAnnual(property.financing)),
    notes: 'NJ STR occupancy taxes via platform (6.625% placeholder); confirm Airbnb/direct split.'
  };
}

function strategyPrepaidTuition(property, year, opts) {
  const years = Math.max(Math.floor(num(opts.tuitionYears ?? property.tuitionYears ?? 4)), 1);
  const credit = round2(TUITION_CREDIT_TOTAL / years);
  const annualRent = property.annualRent;
  const grossTuitionValue = round2(annualRent + credit);   // rent + amortized credit
  const taxOnTuition = round2(grossTuitionValue * num(opts.marginalRate));
  const netTuitionValue = round2(grossTuitionValue - taxOnTuition);
  return {
    id: 'prepaid_tuition',
    label: 'Prepaid tuition (Elias anchor)',
    annualRent,
    tuitionCreditPerYear: credit,
    years,
    grossTuitionValue,
    taxOnTuition,
    netTuitionValue,
    cashFlowBeforeTax: round2(netTuitionValue - operatingExpenses(property, year, opts) - debtServiceAnnual(property.financing)),
    notes: 'Prepaid tuition = ordinary income at marginal NJ rate; not the old 10.75% composite.'
  };
}

const STRATEGIES = {
  long_term_rental: strategyLongTermRental,
  short_term_rental: strategyShortTermRental,
  prepaid_tuition: strategyPrepaidTuition
};

function runStrategies(property, year, opts) {
  const out = {};
  for (const [id, fn] of Object.entries(STRATEGIES)) {
    out[id] = fn(property, year, opts);
  }
  return out;
}

// ---------- underwriting a proposed purchase ----------

function closingCosts(p) {
  const price = num(p.purchasePrice);
  const points = num(p.loanAmount) * MORTGAGE_POINTS_PCT / 100;
  const transferTax = price * TRANSFER_TAX_RATE / 100;
  const legal = num(p.legalFees ?? 2500);
  const inspection = num(p.inspectionFees ?? 750);
  const title = num(p.titleFees ?? 1200);
  const misc = num(p.miscClosing ?? 500);
  return round2(points + transferTax + legal + inspection + title + misc);
}

function amortizationSchedule(loanAmount, annualRatePct, termMonths, months) {
  const monthly = monthlyPmt(num(loanAmount), num(annualRatePct), num(termMonths));
  let balance = num(loanAmount);
  const r = num(annualRatePct) / 100 / 12;
  const rows = [];
  for (let i = 0; i < months; i++) {
    const interest = r > 0 ? balance * r : 0;
    const principal = monthly - interest;
    balance = Math.max(balance - principal, 0);
    rows.push({ month: i + 1, payment: round2(monthly), principal: round2(principal), interest: round2(interest), balance: round2(balance) });
  }
  return rows;
}

function dscr(noi, annualDebtService) {
  if (annualDebtService <= 0) return null;
  return round2(noi / annualDebtService);
}

function underwritePurchase(p, opts) {
  const price = num(p.purchasePrice);
  const down = num(p.downPayment);
  const loanAmount = price - down;
  const cc = closingCosts({ ...p, loanAmount });
  const totalCashNeeded = round2(down + cc);
  const monthly = monthlyPmt(loanAmount, num(p.interestRatePct), num(p.termMonths));
  const annualDebt = round2(monthly * 12);
  const vacancy = num(opts.vacancyPct ?? DEFAULT_VACANCY_PCT);
  const egi = round2(num(p.projectedAnnualRent) * (1 - vacancy / 100));
  const opex = round2(num(p.projectedOpexAnnual) + egi * (CAPEX_RESERVE_PCT + TURNOVER_COST_PCT) / 100);
  const noi = round2(egi - opex);
  const cfbt = round2(noi - annualDebt);
  const capRate = price > 0 ? round2(noi / price * 100) : 0;
  const cashOnCash = totalCashNeeded > 0 ? round2(cfbt / totalCashNeeded * 100) : 0;
  return {
    price, downPayment: down, loanAmount,
    closingCosts: cc, totalCashNeeded,
    monthlyPmt: round2(monthly), annualDebtService: annualDebt,
    effectiveGrossIncome: egi, operatingExpenses: opex,
    netOperatingIncome: noi,
    cashFlowBeforeTax: cfbt,
    capRatePct: capRate,
    cashOnCashPct: cashOnCash,
    dscr: dscr(noi, annualDebt),
    year1Amortization: amortizationSchedule(loanAmount, num(p.interestRatePct), num(p.termMonths), AMORTIZATION_MONTHS)
  };
}

// ---------- multi-year projection ----------

function projectYears(property, opts, years) {
  const out = [];
  const rentGrowth = num(opts.rentGrowthPct ?? DEFAULT_RENT_GROWTH_PCT);
  const expenseGrowth = num(opts.expenseGrowthPct ?? DEFAULT_EXPENSE_GROWTH_PCT);
  const appreciation = num(opts.appreciationPct ?? DEFAULT_APPRECIATION_PCT);
  const startYear = opts.startYear;
  for (let i = 0; i < years; i++) {
    const year = startYear + i;
    const rentFactor = Math.pow(1 + rentGrowth / 100, i);
    const expenseFactor = Math.pow(1 + expenseGrowth / 100, i);
    const prop = {
      ...property,
      annualRent: round2(property.annualRent * rentFactor),
      taxesAnnual: round2(num(property.taxesAnnual) * expenseFactor),
      insuranceAnnual: round2(num(property.insuranceAnnual) * expenseFactor),
      maintenanceAnnual: round2(num(property.maintenanceAnnual) * expenseFactor)
    };
    const strategies = runStrategies(prop, year, opts);
    const marketValue = round2(num(property.acquisition.purchasePrice) * Math.pow(1 + appreciation / 100, i + 1));
    out.push({ year, marketValue, strategies });
  }
  return out;
}

// ---------- default fixture (Anchorage anchor) ----------

function defaultProperty() {
  return {
    id: 'anchorage-1',
    name: 'Anchorage (Elias family anchor)',
    address: '',
    annualRent: PHASE2_ANNUAL_RENT,
    vacancyPct: DEFAULT_VACANCY_PCT,
    taxesAnnual: 0,
    insuranceAnnual: 0,
    utilitiesAnnual: 0,
    maintenanceAnnual: 0,
    otherExpensesAnnual: 0,
    strNightlyRate: 150,
    strOccupancyPct: 55,
    strPlatformFeePct: 3,
    strCleaningPerTurn: 0,
    tuitionYears: 4,
    acquisition: {
      purchasePrice: 0,
      closingDate: '',
      landAllocationPct: ANCHORAGE_LAND_PCT,
      placedInServiceDate: ''   // set to activate Phase 2 MACRS
    },
    financing: {
      loanAmount: 0,
      interestRatePct: 0,
      termMonths: 360,
      loanBalance: 0
    },
    phase2: {
      accumulatedDepreciation: 0,
      costSegComponents: { five: 0, seven: 0, fifteen: 0 }
    }
  };
}

function defaultScheduleElias() {
  return {
    settings: {
      marginalRate: NJ_MARGINAL_RATE,
      niitThreshold: 250000,
      activeParticipation: true,
      reProfessional: false
    },
    borrower: {
      name: '',
      creditScore: 0,
      annualIncome: 0,
      liquidAssets: 0,
      proposedPurchase: {
        purchasePrice: 0, downPayment: 0, interestRatePct: 0, termMonths: 360,
        projectedAnnualRent: 0, projectedOpexAnnual: 0
      }
    },
    seb: {},   // small entity borrower state
    properties: [defaultProperty()]
  };
}

module.exports = {
  STRATEGIES,
  num, monthlyPmt,
  depreciationForYear,
  effectiveGrossIncome, operatingExpenses, netOperatingIncome,
  debtServiceAnnual, cashFlowBeforeTax,
  strategyLongTermRental, strategyShortTermRental, strategyPrepaidTuition,
  runStrategies,
  closingCosts, amortizationSchedule, dscr, underwritePurchase, projectYears,
  defaultProperty, defaultScheduleElias
};
