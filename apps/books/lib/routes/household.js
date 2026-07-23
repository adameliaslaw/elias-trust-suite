// Route group: household taxes (1040/NJ-1040 planning + Schedule Elias).
//
// Extracted verbatim from server.js as the sixth slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js, expenses.js, customers.js, time.js and recurring.js.
// Behavior-preserving: the handlers are the same closures, registered through
// the same `route(method, pattern, handler)` helper in the same order they had
// inline. Deps that were module-level free variables in server.js are passed in
// explicitly so nothing here reaches back into the monolith.
//
// Household-only helpers moved in with the group (like expenses' `validExpense`
// and customers' `validCustomer`): `companyYtd`, `householdInput`,
// `njEstimateFor`, `householdLender` were used ONLY by these handlers, so they
// travel with them. The shared collaborators they close over (`load`,
// `companies`, `decorateInvoice`, `inRange`, `salestax`, `money`, `tax1040`,
// `nj1040`, `elias`, `eliasP2`, `loadGlobal`/`saveGlobal`/`taxProfileForYear`)
// stay defined in server.js and are threaded in through deps, NOT moved —
// `decorateInvoice` in particular is shared across many groups.
//
// Persistence note (preserved exactly): the whole group is NON-money. It reads
// and writes the household-level global.json via `loadGlobal()`/`saveGlobal()`
// (Schedule Elias settings, properties, per-year tax profiles) — there is no
// money mutation and no audit-chain event here, so nothing calls
// `commit`/`commitMany`. Do NOT introduce one.
//
// Wiring (server.js): require('./lib/routes/household')(route, deps).
module.exports = function registerHouseholdRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    uid, load, companies, inRange, decorateInvoice,
    loadGlobal, saveGlobal, taxProfileForYear,
    tax1040, nj1040, elias, eliasP2, salestax, money
  } = deps;

  // Cash-basis Schedule C figures for one company for a calendar year.
  function companyYtd(companyId, year) {
    const cdb = load(companyId);
    const from = `${year}-01-01`, to = `${year}-12-31`;
    let income = 0;
    for (const inv of cdb.invoices) {
      if (inv.draft) continue;
      const dInv = decorateInvoice(inv);
      for (const p of inv.payments || []) {
        if (inRange(p.date, from, to)) income = money.add(income, salestax.paymentIncomeParts(dInv, p).income);
      }
    }
    let expenses = 0;
    for (const e of cdb.expenses) {
      if (inRange(e.date, from, to)) expenses = money.add(expenses, e.amount);
    }
    let meals = 0;     // for the SEB non-deducted-50% subtraction
    for (const e of cdb.expenses) {
      if (e.category === 'Meals & Entertainment' && inRange(e.date, from, to)) meals = money.add(meals, e.amount);
    }
    let w2Wages = 0;   // gross payroll wages paid, for the QBI wage limit
    for (const run of cdb.payRuns) {
      if (run.status !== 'finalized' || Number(run.payDate.slice(0, 4)) !== year) continue;
      w2Wages = money.add(w2Wages, run.totals ? run.totals.gross : 0);
    }
    return {
      income,
      expenses,
      netProfit: money.sub(income, expenses),
      mealsExpense: meals,
      w2Wages
    };
  }

  function householdInput(g, year, adjustments = {}) {
    const p = taxProfileForYear(g, year);
    const perCompany = adjustments.companies || {};
    const businesses = companies().map(c => {
      const ytd = companyYtd(c.id, year);
      const adj = perCompany[c.id] || {};
      return {
        id: c.id,
        name: c.name,
        ytd,
        netProfit: money.sum(ytd.netProfit, Number(adj.incomeDelta) || 0, -(Number(adj.expenseDelta) || 0)),
        w2Wages: ytd.w2Wages,
        sstb: !!p.companySstb[c.id]
      };
    });
    const se = g.scheduleElias;
    const portfolio = elias.portfolioAnalysis(se.properties, se.settings, adjustments.depreciationStrategy, year);
    const mode = adjustments.sec469Handling || se.settings.sec469Handling;
    let schENet = portfolio.scheduleENetTotal;
    let handling = mode;
    let sec469 = null;
    if (mode === 'phase2') {
      // Form 8582 measures the phase-out against MAGI computed WITHOUT the
      // rental loss — probe the estimate once with Schedule E zeroed.
      const probe = tax1040.estimate1040({
        year, filingStatus: p.filingStatus, businesses,
        scheduleE: { net: 0, sec469Handling: 'allow', qbiSafeHarbor: false },
        wages: (Number(p.wages) || 0) + (Number(adjustments.wagesDelta) || 0),
        otherIncome: (Number(p.otherIncome) || 0) + (Number(adjustments.otherIncomeDelta) || 0),
        adjustments: (Number(p.adjustments) || 0) + (Number(adjustments.adjustmentsDelta) || 0),
        itemizedDeductions: (Number(p.itemizedDeductions) || 0) + (Number(adjustments.itemizedDelta) || 0)
      });
      sec469 = eliasP2.resolve469(schENet, {
        carryforward: se.settings.suspendedCarryforward,
        activeParticipation: se.settings.activeParticipation !== false,
        reProfessional: !!se.settings.reProfessional,
        magiBeforeRental: probe.agi
      });
      schENet = sec469.line5;
      handling = 'allow';   // already resolved — pass through unmodified
    }
    return {
      year,
      filingStatus: p.filingStatus,
      businesses,
      scheduleE: {
        net: schENet,
        sec469Handling: handling,
        qbiSafeHarbor: se.settings.qbiSafeHarbor
      },
      sec469,
      portfolio,
      wages: (Number(p.wages) || 0) + (Number(adjustments.wagesDelta) || 0),
      fedWithholding: Number(p.fedWithholding) || 0,
      otherIncome: (Number(p.otherIncome) || 0) + (Number(adjustments.otherIncomeDelta) || 0),
      adjustments: (Number(p.adjustments) || 0) + (Number(adjustments.adjustmentsDelta) || 0),
      itemizedDeductions: (Number(p.itemizedDeductions) || 0) + (Number(adjustments.itemizedDelta) || 0),
      credits: Number(p.credits) || 0,
      estimatedPayments: Number(p.estimatedPayments) || 0
    };
  }

  // NJ-1040 estimate from the same inputs: business category floored (losses
  // never offset wages under NJ law), rentals floored, no federal deductions.
  function njEstimateFor(input, profile) {
    return nj1040.estimateNJ1040({
      filingStatus: input.filingStatus,
      wages: input.wages,
      businesses: undefined,
      businessNet: money.sum(...input.businesses.map(b => b.netProfit)),
      rentalNet: input.portfolio ? input.portfolio.scheduleENetTotal : 0,
      otherIncome: input.otherIncome,
      njDependents: profile.njDependents,
      propertyTaxPaid: profile.propertyTaxPaid,
      njWithholding: profile.njWithholding,
      njEstimatedPayments: profile.njEstimatedPayments
    });
  }

  // Lender-side computation for the household (Schedule Elias §§5-7).
  // Company income/expense scenario deltas flow into SEB so the comparison can
  // show what an expense change does to qualifying income, not just tax.
  function householdLender(g, input) {
    const se = g.scheduleElias;
    const sebByCompany = input.businesses.map(b => ({
      id: b.id,
      name: b.name,
      seb: elias.sebAnalysis(
        { netProfit: b.netProfit, mealsExpense: b.ytd.mealsExpense },
        elias.sanitizeSeb(se.seb[b.id]))
    }));
    return {
      sebByCompany,
      portfolio: input.portfolio,
      borrowing: elias.borrowingAnalysis(se.borrower, sebByCompany, input.portfolio, se.settings.dtiTargetPct)
    };
  }

  route('GET', '/api/household/tax', (req, res, db, params, query) => {
    const year = Number(query.get('year')) || tax1040.YEAR;
    if (!tax1040.YEARS[year]) {
      return badRequest(res, `Supported tax years: ${tax1040.SUPPORTED_YEARS.join(', ')}`);
    }
    const g = loadGlobal();
    const input = householdInput(g, year);
    const lender = householdLender(g, input);
    const baseline = tax1040.estimate1040(input);
    const profile = taxProfileForYear(g, year);
    saveGlobal();   // persist a newly created year profile
    sendJSON(res, 200, {
      year,
      supportedYears: tax1040.SUPPORTED_YEARS,
      profile,
      companies: input.businesses,
      baseline,
      nj: njEstimateFor(input, profile),
      esPlan: tax1040.quarterlyEsPlan(baseline, profile.priorYearTax),
      njEsPlan: nj1040.quarterlyEsPlan(njEstimateFor(input, profile), profile.priorYearNjTax, tax1040.ES_DUE_DATES[year]),
      scheduleElias: {
        settings: g.scheduleElias.settings,
        borrower: g.scheduleElias.borrower,
        seb: g.scheduleElias.seb,
        properties: g.scheduleElias.properties,
        analysis: { ...lender, sec469: input.sec469 }
      }
    });
  });

  // -- Schedule Elias inputs --
  route('PUT', '/api/household/schedule-elias', async (req, res) => {
    const b = await readBody(req);
    const g = loadGlobal();
    const se = g.scheduleElias;
    if (b.settings) {
      const s = b.settings;
      if ('depreciationStrategy' in s) {
        if (!elias.STRATEGIES.includes(s.depreciationStrategy)) return badRequest(res, 'Unknown depreciation strategy');
        se.settings.depreciationStrategy = s.depreciationStrategy;
      }
      if ('sec469Handling' in s) {
        if (!['suspend', 'allow', 'phase2'].includes(s.sec469Handling)) return badRequest(res, 'sec469Handling must be suspend, allow, or phase2');
        se.settings.sec469Handling = s.sec469Handling;
      }
      if ('activeParticipation' in s) se.settings.activeParticipation = !!s.activeParticipation;
      if ('reProfessional' in s) se.settings.reProfessional = !!s.reProfessional;
      if ('suspendedCarryforward' in s) {
        const v = Number(s.suspendedCarryforward);
        if (isNaN(v) || v < 0) return badRequest(res, 'Suspended carryforward must be a non-negative number');
        se.settings.suspendedCarryforward = v;
      }
      if ('qbiSafeHarbor' in s) se.settings.qbiSafeHarbor = !!s.qbiSafeHarbor;
      if ('dtiTargetPct' in s) {
        const v = Number(s.dtiTargetPct);
        if (isNaN(v) || v < 10 || v > 80) return badRequest(res, 'DTI target must be between 10 and 80');
        se.settings.dtiTargetPct = v;
      }
    }
    if (b.borrower) {
      const br = b.borrower;
      for (const k of ['monthlyW2Income', 'monthlyNonHousingDebts', 'primaryResidencePITIA']) {
        if (k in br) {
          const v = Number(br[k]);
          if (isNaN(v) || v < 0) return badRequest(res, `${k} must be a non-negative number`);
          se.borrower[k] = v;
        }
      }
      if ('purchaseType' in br) {
        if (!['primary_replacement', 'additional'].includes(br.purchaseType)) return badRequest(res, 'Unknown purchase type');
        se.borrower.purchaseType = br.purchaseType;
      }
      if ('countProjectedRent' in br) se.borrower.countProjectedRent = !!br.countProjectedRent;
      if (br.proposedPurchase) {
        for (const k of ['targetPrice', 'downPaymentPct', 'ratePct', 'termMonths', 'monthlyTaxes', 'monthlyInsurance', 'monthlyHOA', 'projectedMonthlyRent']) {
          if (k in br.proposedPurchase) {
            const v = Number(br.proposedPurchase[k]);
            if (isNaN(v) || v < 0) return badRequest(res, `${k} must be a non-negative number`);
            se.borrower.proposedPurchase[k] = v;
          }
        }
      }
    }
    if (b.seb && typeof b.seb === 'object') {
      for (const [companyId, supplements] of Object.entries(b.seb)) {
        se.seb[companyId] = elias.sanitizeSeb(supplements);
      }
    }
    saveGlobal();
    sendJSON(res, 200, { settings: se.settings, borrower: se.borrower, seb: se.seb });
  });

  route('POST', '/api/household/properties', async (req, res) => {
    const b = await readBody(req);
    const g = loadGlobal();
    const prop = elias.sanitizeProperty({ ...b, id: uid() });
    if (!prop.nickname) return badRequest(res, 'Give the property a nickname');
    g.scheduleElias.properties.push(prop);
    saveGlobal();
    sendJSON(res, 201, prop);
  });
  route('PUT', '/api/household/properties/:id', async (req, res, db, params) => {
    const g = loadGlobal();
    const idx = g.scheduleElias.properties.findIndex(p => p.id === params.id);
    if (idx === -1) return notFound(res);
    const b = await readBody(req);
    const prop = elias.sanitizeProperty(b, g.scheduleElias.properties[idx]);
    if (!prop.nickname) return badRequest(res, 'Give the property a nickname');
    g.scheduleElias.properties[idx] = prop;
    saveGlobal();
    sendJSON(res, 200, prop);
  });
  // Sell-vs-hold: recapture preview for one property against the baseline.
  route('POST', '/api/household/properties/:id/sell-preview', async (req, res, db, params) => {
    const g = loadGlobal();
    const property = g.scheduleElias.properties.find(p => p.id === params.id);
    if (!property) return notFound(res);
    const b = await readBody(req);
    const salePrice = Number(b.salePrice);
    if (!(salePrice > 0)) return badRequest(res, 'A sale price is required');
    const year = tax1040.YEAR;
    const input = householdInput(g, year);
    const baseline = tax1040.estimate1040(input);
    const suspended = input.sec469 ? input.sec469.suspendedEnd
      : (baseline.suspendedRentalLoss + (Number(g.scheduleElias.settings.suspendedCarryforward) || 0));
    const preview = eliasP2.sellPreview(property, {
      salePrice,
      sellingCostsPct: Number(b.sellingCostsPct) || 7,
      taxYear: year,
      strategy: g.scheduleElias.settings.depreciationStrategy,
      filingStatus: baseline.filingStatus,
      baselineTaxableIncome: baseline.taxableIncome,
      baselineAgi: baseline.agi,
      marginalRate: baseline.marginalRate,
      niitThreshold: tax1040.NIIT_THRESHOLD[baseline.filingStatus],
      suspendedLosses: suspended
    });
    sendJSON(res, 200, { property: { id: property.id, nickname: property.nickname }, salePrice, ...preview });
  });

  route('DELETE', '/api/household/properties/:id', (req, res, db, params) => {
    const g = loadGlobal();
    const idx = g.scheduleElias.properties.findIndex(p => p.id === params.id);
    if (idx === -1) return notFound(res);
    g.scheduleElias.properties.splice(idx, 1);
    saveGlobal();
    sendJSON(res, 200, { ok: true });
  });

  route('PUT', '/api/household/tax-profile', async (req, res) => {
    const b = await readBody(req);
    const year = Number(b.year) || tax1040.YEAR;
    if (!tax1040.YEARS[year]) {
      return badRequest(res, `Supported tax years: ${tax1040.SUPPORTED_YEARS.join(', ')}`);
    }
    const g = loadGlobal();
    const p = taxProfileForYear(g, year);
    if ('filingStatus' in b) {
      if (!tax1040.BRACKETS[b.filingStatus]) return badRequest(res, 'Filing status must be single, married filing jointly, or head of household');
      p.filingStatus = b.filingStatus;
    }
    for (const k of ['wages', 'fedWithholding', 'otherIncome', 'adjustments', 'itemizedDeductions', 'credits', 'estimatedPayments', 'priorYearTax', 'njWithholding', 'njEstimatedPayments', 'priorYearNjTax', 'njDependents', 'propertyTaxPaid']) {
      if (k in b) {
        const v = Number(b[k]);
        if (isNaN(v) || v < 0) return badRequest(res, `${k} must be a non-negative number`);
        p[k] = v;
      }
    }
    if (b.companySstb && typeof b.companySstb === 'object') {
      for (const [id, val] of Object.entries(b.companySstb)) p.companySstb[id] = !!val;
    }
    saveGlobal();
    sendJSON(res, 200, p);
  });

  route('POST', '/api/household/scenario', async (req, res) => {
    const b = await readBody(req);
    const g = loadGlobal();
    const year = Number(b.year) || tax1040.YEAR;
    if (!tax1040.YEARS[year]) {
      return badRequest(res, `Supported tax years: ${tax1040.SUPPORTED_YEARS.join(', ')}`);
    }
    const adj = b.adjustments || {};
    if (adj.depreciationStrategy && !elias.STRATEGIES.includes(adj.depreciationStrategy)) {
      return badRequest(res, 'Unknown depreciation strategy');
    }
    if (adj.sec469Handling && !['suspend', 'allow', 'phase2'].includes(adj.sec469Handling)) {
      return badRequest(res, 'sec469Handling must be suspend, allow, or phase2');
    }
    const baseInput = householdInput(g, year);
    const scInput = householdInput(g, year, adj);
    const baseline = tax1040.estimate1040(baseInput);
    const scenario = tax1040.estimate1040(scInput);
    // Borrowing outcomes for both sides (Schedule Elias §8): the comparison
    // shows tax AND qualifying-income/DTI/max-purchase effects together.
    const baseLender = householdLender(g, baseInput);
    const scLender = householdLender(g, scInput);
    const lenderSummary = l => ({
      grossMonthlyQualifying: l.borrowing.income.grossMonthlyQualifying,
      backEndDTI: l.borrowing.proposed.backEndDTI,
      backEndBand: l.borrowing.proposed.backEndBand,
      maxPurchase: l.borrowing.maxPurchase.maxPrice
    });
    const profileForNj = taxProfileForYear(g, year);
    const njBaseline = njEstimateFor(baseInput, profileForNj);
    const njScenario = njEstimateFor(scInput, profileForNj);
    sendJSON(res, 200, {
      baseline, scenario,
      nj: { baseline: njBaseline, scenario: njScenario },
      borrowing: { baseline: lenderSummary(baseLender), scenario: lenderSummary(scLender) },
      delta: {
        njTax: money.sub(njScenario.tax, njBaseline.tax),
        totalTax: money.sub(scenario.totalTax, baseline.totalTax),
        taxableIncome: money.sub(scenario.taxableIncome, baseline.taxableIncome),
        balanceDue: money.sub(scenario.balanceDue, baseline.balanceDue),
        grossMonthlyQualifying: money.sub(scLender.borrowing.income.grossMonthlyQualifying, baseLender.borrowing.income.grossMonthlyQualifying),
        maxPurchase: money.sub(scLender.borrowing.maxPurchase.maxPrice, baseLender.borrowing.maxPurchase.maxPrice)
      }
    });
  });
};
