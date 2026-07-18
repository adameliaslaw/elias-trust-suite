// Schedule Elias Phase 2: real depreciation, real §469, and the sell-vs-hold
// recapture preview (spec §10). Activates per property when a placed-in-
// service date is set; properties without one keep the Phase 1 strategy
// amounts, so nothing migrates.
//
// - MACRS: residential rental real property, 27.5-year straight-line,
//   mid-month convention (IRS Pub 946 Table A-6 as a formula), land excluded
//   via landAllocationPct, capital improvements added to basis.
// - Cost segregation: 5/7/15-year component buckets carved from the building
//   basis. Components acquired after Jan 19, 2025 take 100% bonus (OBBBA,
//   permanent); earlier acquisitions use straight-line over the class life
//   with the half-year convention (documented simplification vs 200% DB).
// - §469 (Form 8582-lite): $25,000 active-participation allowance phased out
//   50¢/$1 of MAGI between $100K and $150K; real-estate-professional toggle
//   allows losses in full; suspended-loss carryforward offsets future rental
//   income first and releases in full on a taxable disposition (§469(g)).
// - Recapture preview: unrecaptured §1250 gain at min(25%, marginal),
//   remaining long-term gain at 0/15/20% by taxable income, NIIT on the
//   gain over the MAGI threshold, and the ordinary-rate benefit of freed
//   suspended losses. A planning estimate — not tax advice.

const { cents, num } = require('./payroll/engine');

const BONUS_CUTOVER = '2025-01-19';       // OBBBA: 100% bonus after this date
const RECOVERY_YEARS = 27.5;
const SEC469_ALLOWANCE = 25000;
const SEC469_PHASEOUT_START = 100000;
const SEC469_PHASEOUT_END = 150000;
const UNRECAP_1250_MAX_RATE = 0.25;
// 0/15/20% long-term capital gains breakpoints (approximate, planning-grade).
const LTCG_BREAKS = {
  single: { zero: 49450, twenty: 533400 },
  married_jointly: { zero: 98900, twenty: 600050 },
  head_of_household: { zero: 66200, twenty: 566700 }
};

function improvementsTotal(property) {
  return (property.acquisition.improvements || [])
    .reduce((s, i) => s + Math.max(num(i.amount), 0), 0);
}

function buildingBasis(property) {
  const a = property.acquisition;
  return a.purchasePrice * (1 - a.landAllocationPct / 100) + improvementsTotal(property);
}

function costSeg(property) {
  const c = (property.phase2 && property.phase2.costSegComponents) || {};
  return {
    five: Math.max(num(c.five), 0),
    seven: Math.max(num(c.seven), 0),
    fifteen: Math.max(num(c.fifteen), 0)
  };
}

function hasPhase2(property) {
  return /^\d{4}-\d{2}-\d{2}$/.test(property.acquisition.placedInServiceDate || '');
}

// 27.5-yr straight-line, mid-month convention. Year 1 gets (12.5 − M)/12 of
// a full year; the tail year absorbs whatever basis remains.
function sl275ForYear(basis, placedIso, year) {
  if (basis <= 0) return 0;
  const placedYear = Number(placedIso.slice(0, 4));
  const placedMonth = Number(placedIso.slice(5, 7));
  if (year < placedYear) return 0;
  const fullAnnual = basis / RECOVERY_YEARS;
  const year1 = fullAnnual * (12.5 - placedMonth) / 12;
  if (year === placedYear) return cents(year1);
  const fullYearsSince = year - placedYear - 1;
  const accumulated = year1 + fullYearsSince * fullAnnual;
  const remaining = basis - accumulated;
  if (remaining <= 0) return 0;
  return cents(Math.min(fullAnnual, remaining));
}

// A 5/7/15-year cost-seg component: 100% bonus when placed in service after
// the OBBBA cutover, else straight-line over the class life, half-year
// convention (half in year 1, half in the year after the life ends).
function componentForYear(amount, life, placedIso, year) {
  if (amount <= 0) return 0;
  const placedYear = Number(placedIso.slice(0, 4));
  if (year < placedYear) return 0;
  if (placedIso > BONUS_CUTOVER) {
    return year === placedYear ? cents(amount) : 0;
  }
  const annual = amount / life;
  if (year === placedYear) return cents(annual / 2);
  if (year > placedYear + life) return 0;
  if (year === placedYear + life) return cents(annual / 2);
  return cents(annual);
}

// Phase 2 depreciation for one property, one tax year, one strategy.
// conservative/balanced = pure 27.5 SL on the whole building basis;
// aggressive = cost-seg components + 27.5 SL on the remainder.
function macrsForYear(property, strategy, year) {
  const placed = property.acquisition.placedInServiceDate;
  const basis = buildingBasis(property);
  if (strategy !== 'aggressive') return sl275ForYear(basis, placed, year);
  const seg = costSeg(property);
  const segTotal = seg.five + seg.seven + seg.fifteen;
  const remainder = Math.max(basis - segTotal, 0);
  return cents(
    sl275ForYear(remainder, placed, year) +
    componentForYear(seg.five, 5, placed, year) +
    componentForYear(seg.seven, 7, placed, year) +
    componentForYear(seg.fifteen, 15, placed, year)
  );
}

// Accumulated depreciation through the end of `year` under a strategy.
// A phase2.accumulatedDepreciation figure (mid-life migration from another
// system) overrides the computed history.
function accumulatedThrough(property, strategy, year) {
  const override = property.phase2 && num(property.phase2.accumulatedDepreciation);
  if (override > 0) return cents(override);
  if (!hasPhase2(property)) return 0;
  const placedYear = Number(property.acquisition.placedInServiceDate.slice(0, 4));
  let total = 0;
  for (let y = placedYear; y <= year; y++) total += macrsForYear(property, strategy, y);
  return cents(total);
}

// ---- §469, Form 8582-lite ----

// net: the year's rental net (all properties). carryforward: suspended losses
// from prior years (Form 8582 Worksheet). magiBeforeRental: MAGI computed
// WITHOUT the rental loss (that's how the phase-out is measured).
function resolve469(net, opts) {
  const cf = Math.max(num(opts.carryforward), 0);
  if (net >= 0) {
    const used = Math.min(cf, net);
    return {
      mode: 'phase2', line5: cents(net - used), usedCarryforward: cents(used),
      allowedLoss: 0, allowance: null, suspendedEnd: cents(cf - used)
    };
  }
  const totalLoss = -net + cf;   // this year's loss plus prior suspended
  if (opts.reProfessional) {
    return { mode: 'phase2', line5: cents(-totalLoss), usedCarryforward: cents(cf), allowedLoss: cents(totalLoss), allowance: null, suspendedEnd: 0 };
  }
  if (!opts.activeParticipation) {
    return { mode: 'phase2', line5: 0, usedCarryforward: 0, allowedLoss: 0, allowance: 0, suspendedEnd: cents(totalLoss) };
  }
  const magi = Math.max(num(opts.magiBeforeRental), 0);
  const allowance = cents(Math.max(SEC469_ALLOWANCE - 0.5 * Math.max(magi - SEC469_PHASEOUT_START, 0), 0));
  const allowed = Math.min(totalLoss, allowance);
  return {
    mode: 'phase2',
    line5: cents(-allowed),
    // The current year's loss absorbs the allowance first; any room left
    // draws down the prior-year carryforward.
    usedCarryforward: cents(Math.min(Math.max(allowed + net, 0), cf)),
    allowedLoss: cents(allowed),
    allowance,
    suspendedEnd: cents(totalLoss - allowed)
  };
}

// ---- sell-vs-hold recapture preview ----

function ltcgRate(filingStatus, taxableIncome) {
  const b = LTCG_BREAKS[filingStatus] || LTCG_BREAKS.married_jointly;
  if (taxableIncome <= b.zero) return 0;
  if (taxableIncome > b.twenty) return 0.20;
  return 0.15;
}

/**
 * opts: {salePrice, sellingCostsPct, taxYear, strategy, filingStatus,
 *        baselineTaxableIncome, baselineAgi, marginalRate, niitThreshold,
 *        suspendedLosses}
 */
function sellPreview(property, opts) {
  const a = property.acquisition;
  const fullBasis = a.purchasePrice + improvementsTotal(property);
  const accumDep = accumulatedThrough(property, opts.strategy, opts.taxYear);
  const adjustedBasis = cents(fullBasis - accumDep);
  const sellingCosts = cents(opts.salePrice * (num(opts.sellingCostsPct) / 100));
  const amountRealized = cents(opts.salePrice - sellingCosts);
  const gain = cents(amountRealized - adjustedBasis);

  if (gain <= 0) {
    return {
      accumDep, adjustedBasis, amountRealized, gain,
      unrecaptured1250: 0, unrecapTax: 0, ltcg: 0, ltcgTax: 0, niit: 0,
      freedLossBenefit: cents(Math.max(num(opts.suspendedLosses), 0) * num(opts.marginalRate)),
      saleTax: 0,
      netAfterTax: cents(amountRealized - (property.financing.loanBalance || 0))
    };
  }

  const unrecaptured1250 = cents(Math.min(gain, accumDep));
  const unrecapRate = Math.min(UNRECAP_1250_MAX_RATE, num(opts.marginalRate) || UNRECAP_1250_MAX_RATE);
  const unrecapTax = cents(unrecaptured1250 * unrecapRate);
  const ltcg = cents(gain - unrecaptured1250);
  const rate = ltcgRate(opts.filingStatus, num(opts.baselineTaxableIncome));
  const ltcgTax = cents(ltcg * rate);
  const overThreshold = Math.max(num(opts.baselineAgi) + gain - num(opts.niitThreshold), 0);
  const niit = cents(0.038 * Math.min(gain, overThreshold));
  // §469(g): a fully taxable disposition releases the suspended losses
  // against ordinary income — an offset at the marginal rate.
  const freedLossBenefit = cents(Math.max(num(opts.suspendedLosses), 0) * num(opts.marginalRate));
  const saleTax = cents(Math.max(unrecapTax + ltcgTax + niit - freedLossBenefit, 0));
  return {
    accumDep, adjustedBasis, sellingCosts, amountRealized, gain,
    unrecaptured1250, unrecapRate, unrecapTax,
    ltcg, ltcgRate: rate, ltcgTax, niit,
    freedLossBenefit, saleTax,
    netAfterTax: cents(amountRealized - (property.financing.loanBalance || 0) - saleTax)
  };
}

module.exports = {
  BONUS_CUTOVER, RECOVERY_YEARS,
  hasPhase2, buildingBasis, improvementsTotal, costSeg,
  sl275ForYear, componentForYear, macrsForYear, accumulatedThrough,
  resolve469, ltcgRate, sellPreview
};
