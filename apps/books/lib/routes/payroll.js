// Route group: payroll (settings/employees CRUD, pay runs, finalize, deposit
// calendar, NACHA tax + direct-deposit files, quarterly/annual filings, and
// the tax-liability ledger).
//
// Extracted verbatim from server.js as the seventh slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js, expenses.js, customers.js, time.js, recurring.js and
// household.js. Behavior-preserving: the handlers are the same closures,
// registered through the same `route(method, pattern, handler)` helper in the
// same order they had inline. Deps that were module-level free variables in
// server.js are passed in explicitly so nothing here reaches back into the
// monolith.
//
// Persistence note (preserved exactly — do NOT "fix" the direction of any
// path): this group is money-heavy but mixed.
//   - NON-money paths call `save(db)` directly: settings PUT, employee
//     create/update/delete, run create-draft/edit/import-timecards/delete.
//     These write payroll configuration and DRAFT run inputs — no cash moves,
//     no audit-chain event.
//   - MONEY paths commit through the transactional outbox (`store.commit`/
//     `commitMany`): `POST /api/payroll/runs` records `payroll.run_created`;
//     `POST /api/payroll/runs/:id/finalize` posts net pay to the books and
//     `commitMany`s `payroll.run_finalized` + one `payroll.payment` per
//     employee; `POST /api/payroll/liabilities/deposit` posts a tax deposit and
//     commits `payroll.deposit_recorded`. The read-only GETs (settings,
//     employees, runs, deposits calendar, filings, liabilities) and the two
//     NACHA file downloads (tax + PPD direct deposit) neither save nor commit.
//     Do NOT convert a save(db) path to commit or vice versa.
//
// All payroll domain logic already lives in the shared lib/payroll/* modules
// (service/deposits/nacha/filings/timecards) — there is no payroll-only helper
// defined in server.js module scope to move in with the group; the modules are
// threaded through deps, matching how household.js threaded its collaborators.
//
// Wiring (server.js): require('./lib/routes/payroll')(route, deps).
module.exports = function registerPayrollRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    uid, round2, todayISO, save, commit, commitMany,
    audit, payroll, deposits, nacha, filings, timecards, money
  } = deps;

  route('GET', '/api/payroll/settings', (req, res, db) => {
    sendJSON(res, 200, payroll.payrollSettings(db));
  });
  route('PUT', '/api/payroll/settings', async (req, res, db) => {
    const b = await readBody(req);
    const current = payroll.payrollSettings(db);
    const next = { ...current };
    if ('njEmployerUiRate' in b || 'njEmployerTdiRate' in b) {
      const ui = Number(b.njEmployerUiRate ?? current.njEmployerUiRate);
      const tdi = Number(b.njEmployerTdiRate ?? current.njEmployerTdiRate);
      if (isNaN(ui) || ui < 0 || ui > 0.2 || isNaN(tdi) || tdi < 0 || tdi > 0.2) {
        return badRequest(res, 'Rates must be decimals between 0 and 0.2 (e.g. 0.031 for 3.1%)');
      }
      next.njEmployerUiRate = ui;
      next.njEmployerTdiRate = tdi;
    }
    if ('depositSchedule' in b) {
      if (!['monthly', 'semiweekly'].includes(b.depositSchedule)) return badRequest(res, 'Deposit schedule must be monthly or semiweekly');
      next.depositSchedule = b.depositSchedule;
    }
    if ('njPayerType' in b) {
      if (!['weekly', 'monthly', 'quarterly'].includes(b.njPayerType)) return badRequest(res, 'NJ payer type must be weekly, monthly, or quarterly');
      next.njPayerType = b.njPayerType;
    }
    if ('ein' in b) next.ein = String(b.ein).trim();
    if ('njTaxpayerId' in b) {
      const digits = String(b.njTaxpayerId).replace(/\D/g, '');
      if (digits && digits.length !== 12) return badRequest(res, 'NJ taxpayer ID is 12 digits (EIN + suffix, usually 000)');
      next.njTaxpayerId = digits;
    }
    if (b.ach) {
      for (const k of ['bankRouting', 'bankAccount', 'immediateDestination', 'immediateOrigin', 'destinationName']) {
        if (k in b.ach) next.ach[k] = String(b.ach[k]).trim();
      }
    }
    if (b.njAch) {
      for (const k of ['routing', 'account']) {
        if (k in b.njAch) next.njAch[k] = String(b.njAch[k]).trim();
      }
    }
    db.settings.payroll = next;
    save(db);
    sendJSON(res, 200, next);
  });

  route('GET', '/api/payroll/employees', (req, res, db) => {
    sendJSON(res, 200, db.employees);
  });
  route('POST', '/api/payroll/employees', async (req, res, db) => {
    const b = await readBody(req);
    const emp = payroll.sanitizeEmployee(b);
    const err = payroll.validateEmployee(emp);
    if (err) return badRequest(res, err);
    db.employees.push(emp);
    save(db);
    sendJSON(res, 201, emp);
  });
  route('PUT', '/api/payroll/employees/:id', async (req, res, db, params) => {
    const idx = db.employees.findIndex(e => e.id === params.id);
    if (idx === -1) return notFound(res);
    const b = await readBody(req);
    const emp = payroll.sanitizeEmployee(b, db.employees[idx]);
    const err = payroll.validateEmployee(emp);
    if (err) return badRequest(res, err);
    db.employees[idx] = emp;
    // Draft runs hold a snapshot of inputs only; recompute them so previews
    // reflect the edited employee.
    for (const run of db.payRuns) {
      if (run.status === 'draft') payroll.computeRun(db, run);
    }
    save(db);
    sendJSON(res, 200, emp);
  });
  route('DELETE', '/api/payroll/employees/:id', (req, res, db, params) => {
    const idx = db.employees.findIndex(e => e.id === params.id);
    if (idx === -1) return notFound(res);
    if (db.payRuns.some(r => r.checks.some(c => c.employeeId === params.id))) {
      return badRequest(res, 'This employee has paychecks on record — mark them inactive instead of deleting');
    }
    db.employees.splice(idx, 1);
    save(db);
    sendJSON(res, 200, { ok: true });
  });

  route('GET', '/api/payroll/runs', (req, res, db) => {
    const list = db.payRuns.map(r => ({
      id: r.id, payDate: r.payDate, periodStart: r.periodStart, periodEnd: r.periodEnd,
      status: r.status, totals: r.totals, employees: r.checks.length
    })).sort((a, b) => b.payDate.localeCompare(a.payDate));
    sendJSON(res, 200, list);
  });
  route('POST', '/api/payroll/runs', async (req, res, db) => {
    const b = await readBody(req);
    if (!b.payDate || !b.periodStart || !b.periodEnd) {
      return badRequest(res, 'Pay date and period start/end are required');
    }
    if (!db.employees.some(e => e.active)) return badRequest(res, 'Add at least one active employee first');
    const s = payroll.payrollSettings(db);
    if (!(s.njEmployerUiRate > 0)) {
      return badRequest(res, 'Enter your NJ employer UI (and TDI) rates in Payroll settings first — they are on your NJ rate notice');
    }
    try {
      const run = payroll.newRun(db, b);
      db.payRuns.push(run);
      await commit(db, req.companyId, 'payroll.run_created', {
        runId: run.id, payPeriod: `${run.periodStart}–${run.periodEnd}`, actor: audit.actor(req)
      });
      sendJSON(res, 201, run);
    } catch (e) {
      badRequest(res, e.message);
    }
  });
  route('GET', '/api/payroll/runs/:id', (req, res, db, params) => {
    const run = db.payRuns.find(r => r.id === params.id);
    if (!run) return notFound(res);
    sendJSON(res, 200, { ...run, company: db.settings.companyName });
  });
  route('PUT', '/api/payroll/runs/:id', async (req, res, db, params) => {
    const run = db.payRuns.find(r => r.id === params.id);
    if (!run) return notFound(res);
    if (run.status !== 'draft') return badRequest(res, 'This run is finalized and can no longer be edited');
    const b = await readBody(req);
    if (Array.isArray(b.checks)) {
      for (const incoming of b.checks) {
        const chk = run.checks.find(c => c.employeeId === incoming.employeeId);
        if (!chk || !incoming.inputs) continue;
        for (const k of ['hours', 'otHours', 'bonus', 'tips', 'reimbursement']) {
          if (k in incoming.inputs) {
            const v = Number(incoming.inputs[k]);
            if (isNaN(v) || v < 0) return badRequest(res, 'Inputs must be non-negative numbers');
            chk.inputs[k] = v;
          }
        }
      }
    }
    for (const k of ['payDate', 'periodStart', 'periodEnd']) if (b[k]) run[k] = b[k];
    try {
      payroll.computeRun(db, run);
    } catch (e) {
      return badRequest(res, e.message);
    }
    save(db);
    sendJSON(res, 200, run);
  });
  // Import a Dripos (or similar) timecard CSV into a draft run: hours,
  // weekly overtime, and card tips per matched employee.
  route('POST', '/api/payroll/runs/:id/import-timecards', async (req, res, db, params) => {
    const run = db.payRuns.find(r => r.id === params.id);
    if (!run) return notFound(res);
    if (run.status !== 'draft') return badRequest(res, 'Timecards can only be imported into a draft run');
    const b = await readBody(req);
    if (!b.csv || !String(b.csv).trim()) return badRequest(res, 'CSV content is required');
    let parsed;
    try {
      parsed = timecards.parseTimecards(String(b.csv));
    } catch (e) {
      return badRequest(res, e.message);
    }
    let updated = 0;
    const unmatched = [], notInRun = [];
    for (const person of parsed.rows) {
      const emp = timecards.matchEmployee(person, db.employees);
      if (!emp) { unmatched.push(person.name || person.email); continue; }
      const chk = run.checks.find(c => c.employeeId === emp.id);
      if (!chk) { notInRun.push(`${emp.firstName} ${emp.lastName}`); continue; }
      chk.inputs.hours = person.hours;
      chk.inputs.otHours = person.otHours;
      chk.inputs.tips = person.tips;
      updated++;
    }
    try {
      payroll.computeRun(db, run);
    } catch (e) {
      return badRequest(res, e.message);
    }
    save(db);
    sendJSON(res, 200, { updated, unmatched, notInRun, otSource: parsed.info.otSource, run });
  });

  route('DELETE', '/api/payroll/runs/:id', (req, res, db, params) => {
    const idx = db.payRuns.findIndex(r => r.id === params.id);
    if (idx === -1) return notFound(res);
    if (db.payRuns[idx].status !== 'draft') {
      return badRequest(res, 'Finalized runs cannot be deleted — they are part of your payroll record');
    }
    db.payRuns.splice(idx, 1);
    save(db);
    sendJSON(res, 200, { ok: true });
  });
  route('POST', '/api/payroll/runs/:id/finalize', async (req, res, db, params) => {
    const run = db.payRuns.find(r => r.id === params.id);
    if (!run) return notFound(res);
    if (run.status !== 'draft') return badRequest(res, 'This run is already finalized');
    try {
      payroll.computeRun(db, run);   // recompute against latest YTD, then freeze
    } catch (e) {
      return badRequest(res, e.message);
    }
    if (run.checks.some(c => !c.computed)) {
      return badRequest(res, 'A paycheck on this run could not be computed — review the run first');
    }
    run.status = 'finalized';
    run.finalizedAt = todayISO();
    // Post the cash that actually leaves on payday (net pay) to the books.
    // Withheld and employer taxes accrue as liabilities and hit the books
    // when each deposit is recorded.
    const exp = {
      id: uid(),
      date: run.payDate,
      vendor: 'Payroll (net pay)',
      category: 'Payroll',
      amount: run.totals.net,
      paymentMethod: 'Bank transfer',
      notes: `Pay run ${run.periodStart} – ${run.periodEnd}, ${run.checks.length} employee(s)`,
      createdAt: todayISO()
    };
    db.expenses.push(exp);
    run.postedExpenseId = exp.id;
    // The compliance record of money leaving: one summary event plus one
    // payroll.payment per employee, keyed deterministically so a retried
    // finalize cannot double-record (the run.status guard already prevents
    // a second finalize; the key makes that explicit in the chain). All of it
    // is atomic with the save (#24): the finalized run and every payment event
    // commit as one unit — a crash can't post the run without its payments.
    const payPeriod = `${run.periodStart}–${run.periodEnd}`;
    await commitMany(db, req.companyId, [
      {
        type: 'payroll.run_finalized',
        payload: {
          runId: run.id, payPeriod, employeeCount: run.checks.length,
          totalNetCents: audit.centsStr(run.totals.net), actor: audit.actor(req)
        }
      },
      ...run.checks.map(chk => ({
        type: 'payroll.payment',
        payload: {
          paymentId: `${run.id}:${chk.employeeId}`,
          employeeId: chk.employeeId,
          amountCents: audit.centsStr(chk.computed.net),
          payPeriod,
          method: 'ach',
          initiatedBy: audit.actor(req),
          idempotencyKey: `${run.id}:${chk.employeeId}`
        }
      }))
    ]);
    sendJSON(res, 200, run);
  });

  // Deposit calendar: obligations grouped by deposit rule, with due dates and
  // what has been recorded against each (spec: IRS Pub 15 / NJ-WT schedules).
  route('GET', '/api/payroll/deposits', (req, res, db, params, query) => {
    const year = Number(query.get('year')) || new Date().getFullYear();
    const s = payroll.payrollSettings(db);
    const withPaid = (list, bucket) => list.map(g => ({
      ...g,
      bucket,
      paid: deposits.paidFor(db, bucket, g.key),
      outstanding: Math.max(money.sub(g.amount, deposits.paidFor(db, bucket, g.key)), 0)
    }));
    const quarters = [1, 2, 3, 4].filter(q => deposits.quarterEnd(year, q) <= todayISO() ||
      db.payRuns.some(r => r.status === 'finalized' && Number(r.payDate.slice(0, 4)) === year && deposits.quarterOf(r.payDate) === q));
    sendJSON(res, 200, {
      year,
      settings: { depositSchedule: s.depositSchedule, njPayerType: s.njPayerType },
      achConfigured: payroll.achConfigured(s),
      njAchConfigured: !!(s.njAch.routing && s.njAch.account && s.njTaxpayerId),
      federal: withPaid(deposits.federalLiabilities(db, year, s.depositSchedule), 'federal_941'),
      njGit: withPaid(deposits.njGitLiabilities(db, year, s.njPayerType), 'nj_git'),
      nj927: withPaid(quarters.map(q => deposits.nj927Contributions(db, year, q)).filter(g => g.amount > 0), 'nj_dol'),
      futa: withPaid(deposits.futaLiabilities(db, year), 'futa')
    });
  });

  // Bank-ready NACHA CCD+/TXP file for one tax obligation. Downloading is the
  // action — upload it to your bank's ACH origination portal, then record the
  // deposit so the ledger and books agree.
  route('GET', '/api/payroll/nacha/tax', (req, res, db, params, query) => {
    const s = payroll.payrollSettings(db);
    if (!payroll.achConfigured(s)) {
      return badRequest(res, 'Enter your EIN and ACH origination details in Payroll settings first');
    }
    const bucket = query.get('bucket');
    const key = query.get('key');
    const year = Number(query.get('year')) || new Date().getFullYear();
    const groups = {
      federal_941: () => deposits.federalLiabilities(db, year, s.depositSchedule),
      futa: () => deposits.futaLiabilities(db, year),
      nj_git: () => deposits.njGitLiabilities(db, year, s.njPayerType),
      nj_dol: () => [1, 2, 3, 4].map(q => deposits.nj927Contributions(db, year, q))
    }[bucket];
    if (!groups) return badRequest(res, 'Unknown deposit bucket');
    const g = groups().find(x => x.key === key);
    if (!g) return notFound(res);
    const amount = Math.max(money.sub(g.amount, deposits.paidFor(db, bucket, g.key)), 0);
    if (!(amount > 0)) return badRequest(res, 'Nothing outstanding for this obligation');

    const company = {
      name: db.settings.companyName, ein: s.ein,
      bankRouting: s.ach.bankRouting,
      immediateDestination: s.ach.immediateDestination,
      immediateOrigin: s.ach.immediateOrigin,
      destinationName: s.ach.destinationName
    };
    let payment;
    const qEnd = deposits.quarterEnd(year, deposits.quarterOf(g.periodEnd));
    if (bucket === 'federal_941') {
      const addenda = nacha.eftpsTxp(s.ein, nacha.FED_941_DEPOSIT, g.periodEnd, amount, [
        [nacha.SUB_SOCIAL_SECURITY, g.ss],
        [nacha.SUB_MEDICARE, g.medicare],
        [nacha.SUB_WITHHOLDING, money.sub(amount, g.ss, g.medicare)]
      ]);
      payment = { routing: nacha.TREASURY_ROUTING, account: nacha.TREASURY_ACCOUNT, receiverName: nacha.TREASURY_NAME, amount, addenda, description: 'TAXPAYMENT', identification: s.ein };
    } else if (bucket === 'futa') {
      const addenda = nacha.eftpsTxp(s.ein, nacha.FED_940_DEPOSIT, g.periodEnd, amount);
      payment = { routing: nacha.TREASURY_ROUTING, account: nacha.TREASURY_ACCOUNT, receiverName: nacha.TREASURY_NAME, amount, addenda, description: 'TAXPAYMENT', identification: s.ein };
    } else {
      if (!s.njAch.routing || !s.njAch.account || !s.njTaxpayerId) {
        return badRequest(res, 'Enter your NJ taxpayer ID and the State bank details from your EFT1-C reply in Payroll settings');
      }
      // NJ TXP period is always the QUARTER end; code depends on payer type/bucket.
      const code = bucket === 'nj_dol' ? nacha.NJ_LABOR_CONTRIBUTIONS
        : s.njPayerType === 'weekly' ? nacha.NJ_GIT_WEEKLY
        : (g.key.includes('-Q') ? nacha.NJ_GIT_QUARTERLY : nacha.NJ_GIT_MONTHLY);
      const addenda = nacha.njTxp(s.njTaxpayerId, code, qEnd, amount, db.settings.companyName);
      payment = { routing: s.njAch.routing, account: s.njAch.account, receiverName: 'STATE OF NEW JERSEY', amount, addenda, description: 'TAXPAYMENT', identification: s.ein };
    }
    const today = todayISO();
    const content = nacha.buildTaxPaymentFile(company, payment, { date: today, time: '0900' }, g.due >= today ? g.due : today);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="ach-${bucket}-${key}.ach"`
    });
    res.end(content);
  });

  // PPD direct-deposit file for a finalized pay run.
  route('GET', '/api/payroll/runs/:id/nacha', (req, res, db, params) => {
    const run = db.payRuns.find(r => r.id === params.id);
    if (!run) return notFound(res);
    if (run.status !== 'finalized') return badRequest(res, 'Finalize the run before generating a direct-deposit file');
    const s = payroll.payrollSettings(db);
    if (!payroll.achConfigured(s)) {
      return badRequest(res, 'Enter your EIN and ACH origination details in Payroll settings first');
    }
    const entries = [];
    for (const chk of run.checks) {
      const emp = db.employees.find(e => e.id === chk.employeeId);
      if (!emp || emp.paymentMethod !== 'direct_deposit' || !chk.computed || !(chk.computed.net > 0)) continue;
      entries.push({
        name: `${emp.firstName} ${emp.lastName}`,
        routing: emp.bankRouting, account: emp.bankAccount,
        accountType: emp.bankAccountType, amount: chk.computed.net, id: emp.id
      });
    }
    if (!entries.length) {
      return badRequest(res, 'No employees on this run are set to direct deposit with bank details');
    }
    const company = {
      name: db.settings.companyName, ein: s.ein,
      bankRouting: s.ach.bankRouting,
      immediateDestination: s.ach.immediateDestination,
      immediateOrigin: s.ach.immediateOrigin,
      destinationName: s.ach.destinationName
    };
    const today = todayISO();
    const content = nacha.buildPpdFile(company, entries, { date: today, time: '0900' },
      run.payDate >= today ? run.payDate : today);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="payroll-${run.payDate}.ach"`
    });
    res.end(content);
  });

  // Quarterly/annual filings figures (941, NJ-927/WR-30, 940).
  route('GET', '/api/payroll/filings', (req, res, db, params, query) => {
    const year = Number(query.get('year')) || new Date().getFullYear();
    const quarter = Math.min(Math.max(Number(query.get('quarter')) || deposits.quarterOf(todayISO()), 1), 4);
    try {
      sendJSON(res, 200, {
        year, quarter,
        depositSchedule: payroll.payrollSettings(db).depositSchedule,
        f941: filings.compute941(db, year, quarter),
        nj927: filings.computeNj927(db, year, quarter),
        wr30: filings.computeWr30(db, year, quarter),
        f940: filings.compute940(db, year)
      });
    } catch (e) {
      badRequest(res, e.message);
    }
  });

  route('GET', '/api/payroll/liabilities', (req, res, db) => {
    sendJSON(res, 200, {
      buckets: payroll.liabilities(db),
      deposits: [...db.payrollDeposits].sort((a, b) => b.date.localeCompare(a.date))
    });
  });
  route('POST', '/api/payroll/liabilities/deposit', async (req, res, db) => {
    const b = await readBody(req);
    const bucket = payroll.LIABILITY_BUCKETS[b.bucket];
    if (!bucket) return badRequest(res, 'Unknown liability bucket');
    const amount = round2(Number(b.amount));
    if (!(amount > 0)) return badRequest(res, 'Deposit amount must be positive');
    const balance = payroll.liabilities(db).find(l => l.bucket === b.bucket).balance;
    if (amount > balance + 0.005) {
      return badRequest(res, `Deposit exceeds the outstanding balance ($${balance.toFixed(2)})`);
    }
    const exp = {
      id: uid(),
      date: b.date || todayISO(),
      vendor: bucket.payee,
      category: 'Payroll Taxes',
      amount,
      paymentMethod: b.paymentMethod || 'Bank transfer',
      notes: b.note || bucket.label,
      createdAt: todayISO()
    };
    db.expenses.push(exp);
    const dep = { id: uid(), bucket: b.bucket, periodKey: b.periodKey || '', amount, date: exp.date, note: b.note || '', expenseId: exp.id };
    db.payrollDeposits.push(dep);
    await commit(db, req.companyId, 'payroll.deposit_recorded', {
      depositId: dep.id, amountCents: audit.centsStr(amount), period: dep.periodKey, actor: audit.actor(req)
    });
    sendJSON(res, 200, { deposit: dep, expense: exp, buckets: payroll.liabilities(db) });
  });
};
