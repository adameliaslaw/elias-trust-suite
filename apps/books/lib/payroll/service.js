// Payroll business logic: employees, pay runs, YTD accumulation, tax
// liabilities, and posting finalized runs into the books.
const { uid, todayISO } = require('../store');
const money = require('../money');
const engine = require('./engine');

// ---------- employees ----------

function sanitizeEmployee(b, existing) {
  const e = existing || {};
  const fed = { ...(e.fed || {}), ...(b.fed || {}) };
  const nj = { ...(e.nj || {}), ...(b.nj || {}) };
  return {
    id: e.id || uid(),
    firstName: String(b.firstName ?? e.firstName ?? '').trim(),
    lastName: String(b.lastName ?? e.lastName ?? '').trim(),
    email: b.email ?? e.email ?? '',
    active: b.active !== undefined ? !!b.active : (e.active !== undefined ? e.active : true),
    payType: b.payType ?? e.payType ?? 'salary',
    annualSalary: engine.num(b.annualSalary ?? e.annualSalary),
    hourlyRate: engine.num(b.hourlyRate ?? e.hourlyRate),
    payFrequency: b.payFrequency ?? e.payFrequency ?? 'biweekly',
    defaultHours: engine.num(b.defaultHours ?? e.defaultHours),
    fed: {
      filingStatus: fed.filingStatus || 'single',
      multipleJobs: !!fed.multipleJobs,
      dependentsCredit: engine.num(fed.dependentsCredit),
      otherIncome: engine.num(fed.otherIncome),
      deductions: engine.num(fed.deductions),
      extraWithholding: engine.num(fed.extraWithholding),
      exempt: !!fed.exempt
    },
    nj: {
      rateTable: /^[A-E]$/.test(nj.rateTable) ? nj.rateTable : 'A',
      allowances: Math.max(0, Math.floor(engine.num(nj.allowances))),
      extraWithholding: engine.num(nj.extraWithholding),
      exempt: !!nj.exempt
    },
    deductions: Array.isArray(b.deductions)
      ? b.deductions
          .filter(d => d.name && ['pretax_health', 'pretax_401k', 'roth_401k', 'aftertax'].includes(d.kind))
          .map(d => ({
            id: d.id || uid(),
            name: String(d.name).trim(),
            kind: d.kind,
            amountType: d.amountType === 'percent' ? 'percent' : 'fixed',
            amount: engine.num(d.amount),
            active: d.active !== false
          }))
      : (e.deductions || []),
    paymentMethod: (b.paymentMethod ?? e.paymentMethod) === 'direct_deposit' ? 'direct_deposit' : 'check',
    bankRouting: String(b.bankRouting ?? e.bankRouting ?? '').replace(/\D/g, ''),
    bankAccount: String(b.bankAccount ?? e.bankAccount ?? '').trim(),
    bankAccountType: (b.bankAccountType ?? e.bankAccountType) === 'savings' ? 'savings' : 'checking',
    ytdOpening: b.ytdOpening !== undefined
      ? (b.ytdOpening && engine.num(b.ytdOpening.year)
          ? {
              year: Math.floor(engine.num(b.ytdOpening.year)),
              ssWages: engine.num(b.ytdOpening.ssWages),
              medicareWages: engine.num(b.ytdOpening.medicareWages),
              futaWages: engine.num(b.ytdOpening.futaWages),
              njUiWages: engine.num(b.ytdOpening.njUiWages),
              njTdiWages: engine.num(b.ytdOpening.njTdiWages)
            }
          : null)
      : (e.ytdOpening || null),
    createdAt: e.createdAt || todayISO()
  };
}

function validateEmployee(emp) {
  if (!emp.firstName || !emp.lastName) return 'First and last name are required';
  if (!['salary', 'hourly'].includes(emp.payType)) return 'Pay type must be salary or hourly';
  if (!engine.PAY_PERIODS[emp.payFrequency]) return 'Invalid pay frequency';
  if (emp.payType === 'salary' && !(emp.annualSalary > 0)) return 'Annual salary must be positive';
  if (emp.payType === 'hourly' && !(emp.hourlyRate > 0)) return 'Hourly rate must be positive';
  if (!['single', 'married_jointly', 'head_of_household'].includes(emp.fed.filingStatus)) {
    return 'Federal filing status must be single, married filing jointly, or head of household';
  }
  if (emp.paymentMethod === 'direct_deposit' && (emp.bankRouting.length !== 9 || !emp.bankAccount)) {
    return 'Direct deposit needs a 9-digit routing number and an account number';
  }
  return null;
}

// ---------- YTD ----------

// Prior-YTD taxable-wage totals for wage-base caps: finalized checks in the
// same calendar year (excluding the run being computed) plus any opening
// balances entered for a mid-year migration.
function ytdTotals(db, employeeId, year, excludeRunId) {
  const t = { ssWages: 0, medicareWages: 0, futaWages: 0, njUiWages: 0, njTdiWages: 0, electiveDeferrals: 0 };
  const emp = db.employees.find(e => e.id === employeeId);
  if (emp && emp.ytdOpening && emp.ytdOpening.year === year) {
    t.ssWages += emp.ytdOpening.ssWages;
    t.medicareWages += emp.ytdOpening.medicareWages;
    t.futaWages += emp.ytdOpening.futaWages;
    t.njUiWages += emp.ytdOpening.njUiWages;
    t.njTdiWages += emp.ytdOpening.njTdiWages;
    t.electiveDeferrals += emp.ytdOpening.electiveDeferrals || 0;
  }
  for (const run of db.payRuns) {
    if (run.status !== 'finalized' || run.id === excludeRunId) continue;
    if (Number(run.payDate.slice(0, 4)) !== year) continue;
    for (const chk of run.checks) {
      if (chk.employeeId !== employeeId || !chk.computed) continue;
      t.ssWages = money.add(t.ssWages, chk.computed.ssTaxable);
      t.medicareWages = money.add(t.medicareWages, chk.computed.medicareTaxable);
      t.futaWages = money.add(t.futaWages, chk.computed.futaTaxable);
      t.njUiWages = money.add(t.njUiWages, chk.computed.njUiTaxable);
      t.njTdiWages = money.add(t.njTdiWages, chk.computed.njTdiTaxable);
      // Sum this year's elective 401(k)/Roth deferrals for the §402(g) cap.
      t.electiveDeferrals = money.add(t.electiveDeferrals,
        chk.computed.dedPretax401k || 0, chk.computed.dedRoth401k || 0);
    }
  }
  return t;
}

// ---------- pay runs ----------

function payrollSettings(db) {
  const s = db.settings.payroll || {};
  return {
    njEmployerUiRate: s.njEmployerUiRate || 0,
    njEmployerTdiRate: s.njEmployerTdiRate || 0,
    depositSchedule: s.depositSchedule === 'semiweekly' ? 'semiweekly' : 'monthly',
    njPayerType: ['weekly', 'monthly', 'quarterly'].includes(s.njPayerType) ? s.njPayerType : 'quarterly',
    ein: s.ein || '',
    njTaxpayerId: s.njTaxpayerId || '',
    // ACH origination details from your bank (for NACHA files).
    ach: {
      bankRouting: (s.ach && s.ach.bankRouting) || '',
      bankAccount: (s.ach && s.ach.bankAccount) || '',
      immediateDestination: (s.ach && s.ach.immediateDestination) || '',
      immediateOrigin: (s.ach && s.ach.immediateOrigin) || '',
      destinationName: (s.ach && s.ach.destinationName) || ''
    },
    // NJ's bank details from the EFT1-C enrollment reply.
    njAch: {
      routing: (s.njAch && s.njAch.routing) || '',
      account: (s.njAch && s.njAch.account) || ''
    }
  };
}

function achConfigured(settings) {
  const a = settings.ach;
  return !!(settings.ein && a.bankRouting && a.immediateDestination);
}

function computeRun(db, run) {
  const year = Number(run.payDate.slice(0, 4));
  const tables = engine.tablesForYear(year);   // throws for unknown years
  const settings = payrollSettings(db);
  const warnings = [];
  for (const chk of run.checks) {
    const emp = db.employees.find(e => e.id === chk.employeeId);
    if (!emp) {
      chk.computed = null;
      warnings.push('An employee on this run no longer exists');
      continue;
    }
    if (emp.payType === 'hourly' && emp.hourlyRate < tables.NJ_MINIMUM_WAGE) {
      warnings.push(`${emp.firstName} ${emp.lastName}: hourly rate $${emp.hourlyRate.toFixed(2)} ` +
        `is below the ${year} NJ minimum wage ($${tables.NJ_MINIMUM_WAGE})`);
    }
    const ytd = ytdTotals(db, emp.id, year, run.id);
    const deductions = (emp.deductions || []).filter(d => d.active);
    chk.employeeName = `${emp.firstName} ${emp.lastName}`;
    chk.computed = engine.computePaycheck(year, emp, chk.inputs, deductions, ytd, settings);
  }
  const done = run.checks.filter(c => c.computed);
  run.totals = {
    gross: money.sum(...done.map(c => c.computed.gross)),
    employeeTaxes: money.sum(...done.map(c => c.computed.employeeTaxes)),
    deductions: money.sum(...done.map(c => c.computed.totalDeductions)),
    reimbursements: money.sum(...done.map(c => c.computed.reimbursement)),
    net: money.sum(...done.map(c => c.computed.net)),
    erTotal: money.sum(...done.map(c => c.computed.erTotal))
  };
  run.warnings = warnings;
  return run;
}

function newRun(db, { payDate, periodStart, periodEnd }) {
  const active = db.employees.filter(e => e.active);
  const run = {
    id: uid(),
    payDate, periodStart, periodEnd,
    status: 'draft',
    createdAt: todayISO(),
    checks: active.map(e => ({
      employeeId: e.id,
      employeeName: `${e.firstName} ${e.lastName}`,
      inputs: {
        hours: e.payType === 'hourly' ? e.defaultHours : 0,
        otHours: 0, bonus: 0, tips: 0, reimbursement: 0
      },
      computed: null
    }))
  };
  return computeRun(db, run);
}

// ---------- liabilities ----------

// Withheld + employer taxes grouped by who actually gets paid.
const LIABILITY_BUCKETS = {
  federal_941: {
    label: 'Federal — Form 941 (income tax + FICA)',
    payee: 'IRS (EFTPS 941 deposit)',
    amount: c => money.sum(c.fit, c.ss, c.medicare, c.erSs, c.erMedicare)
  },
  futa: {
    label: 'Federal — FUTA (Form 940)',
    payee: 'IRS (EFTPS FUTA deposit)',
    amount: c => c.erFuta
  },
  nj_git: {
    label: 'NJ — gross income tax withheld',
    payee: 'NJ Division of Taxation',
    amount: c => c.njSit
  },
  nj_dol: {
    label: 'NJ — UI/WF/SWF, TDI, FLI (employee + employer)',
    payee: 'NJ Department of Labor',
    amount: c => money.sum(c.njUiWf, c.njTdi, c.njFli, c.erNjUi, c.erNjTdi)
  },
  retirement_401k: {
    label: '401(k) deferrals to remit (DOL: within 7 business days)',
    payee: 'Retirement plan recordkeeper',
    amount: c => money.sum(c.dedPretax401k, c.dedRoth401k)
  }
};

function liabilities(db) {
  const accrued = {};
  for (const key of Object.keys(LIABILITY_BUCKETS)) accrued[key] = 0;
  for (const run of db.payRuns) {
    if (run.status !== 'finalized') continue;
    for (const chk of run.checks) {
      if (!chk.computed) continue;
      for (const [key, bucket] of Object.entries(LIABILITY_BUCKETS)) {
        accrued[key] = money.add(accrued[key], bucket.amount(chk.computed));
      }
    }
  }
  const deposited = {};
  for (const d of db.payrollDeposits) {
    deposited[d.bucket] = money.add(deposited[d.bucket] || 0, d.amount);
  }
  return Object.entries(LIABILITY_BUCKETS).map(([key, bucket]) => ({
    bucket: key,
    label: bucket.label,
    payee: bucket.payee,
    accrued: accrued[key],
    deposited: deposited[key] || 0,
    balance: money.sub(accrued[key], deposited[key] || 0)
  }));
}

module.exports = {
  sanitizeEmployee, validateEmployee, ytdTotals, payrollSettings, achConfigured,
  computeRun, newRun, liabilities, LIABILITY_BUCKETS
};
