// Tax deposit calendar: what is owed, when it is due, what has been paid.
// Ported from the firm payroll app (payroll/liabilities.py); obligations are
// derived from finalized pay runs, payments from db.payrollDeposits.
//
// Deposit schedule rules (IRS Pub 15 and NJ-WT):
//
// Federal (941 taxes = withheld income tax + both halves of FICA):
//   - monthly depositor: each month's liability due the 15th of the next month
//   - semiweekly depositor: Wed-Fri paydays due the following Wednesday;
//     Sat-Tue paydays due the following Friday
//   - $100,000 next-day rule: flagged whenever one accumulation reaches it
//
// FUTA: quarterly; due the last day of the month after quarter end once the
// cumulative undeposited amount exceeds $500, else it rolls forward.
//
// NJ gross income tax withholding:
//   - weekly payer: due the Wednesday of the week after the payday's week
//   - monthly payer: months 1-2 of a quarter due the 15th following (NJ-500);
//     month 3 rides with the quarterly NJ-927
//   - quarterly payer: due with the NJ-927 by the 30th after quarter end
//
// NJ UI/TDI/FLI contributions (employee + employer): due with the NJ-927.

const money = require('../money');

const FED_NEXT_DAY_THRESHOLD = 100000;
const FUTA_DEPOSIT_THRESHOLD = 500;

// ---- date helpers (ISO strings; local-safe, no Date-timezone traps) ----

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function weekday(isoDate) {  // Mon=0 .. Sun=6, matching Python's weekday()
  const [y, m, d] = isoDate.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function quarterOf(isoDate) {
  return Math.floor((Number(isoDate.slice(5, 7)) - 1) / 3) + 1;
}

function quarterEnd(year, quarter) {
  return { 1: iso(year, 3, 31), 2: iso(year, 6, 30), 3: iso(year, 9, 30), 4: iso(year, 12, 31) }[quarter];
}

function monthEnd(year, month) {
  if (month === 12) return iso(year, 12, 31);
  return addDays(iso(year, month + 1, 1), -1);
}

function fifteenthFollowing(year, month) {
  return month === 12 ? iso(year + 1, 1, 15) : iso(year, month + 1, 15);
}

// 30th of the month following quarter end.
function nj927DueDate(year, quarter) {
  const endMonth = quarter * 3;
  return endMonth === 12 ? iso(year + 1, 1, 30) : iso(year, endMonth + 1, 30);
}

// Wed-Fri paydays -> next Wednesday; Sat-Tue -> next Friday.
function semiweeklyDueDate(payday) {
  const wd = weekday(payday);
  let daysAhead;
  if (wd === 2 || wd === 3 || wd === 4) daysAhead = ((2 - wd) % 7 + 7) % 7 || 7;
  else daysAhead = ((4 - wd) % 7 + 7) % 7 || 7;
  return addDays(payday, daysAhead);
}

// Wednesday of the week (Sun-Sat) following the week of the payday.
function njWeeklyDueDate(payday) {
  const daysToSunday = 7 - ((weekday(payday) + 1) % 7);
  return addDays(payday, daysToSunday + 3);
}

// ---- finalized paychecks for a year (QuickBucks data model) ----

function finalizedChecks(db, year, quarter) {
  const out = [];
  for (const run of db.payRuns) {
    if (run.status !== 'finalized') continue;
    if (Number(run.payDate.slice(0, 4)) !== year) continue;
    if (quarter && quarterOf(run.payDate) !== quarter) continue;
    for (const chk of run.checks) {
      if (chk.computed) out.push({ payDate: run.payDate, employeeId: chk.employeeId, employeeName: chk.employeeName, c: chk.computed });
    }
  }
  out.sort((a, b) => a.payDate.localeCompare(b.payDate));
  return out;
}

// 941 deposit liability for one paycheck: FIT + all four FICA halves.
function federalLiabilityOf(c) {
  return money.sum(c.fit, c.ss, c.erSs, c.medicare, c.erMedicare);
}

function federalLiabilities(db, year, schedule) {
  const groups = new Map();
  for (const { payDate, c } of finalizedChecks(db, year)) {
    const month = Number(payDate.slice(5, 7));
    let key, due, label;
    if (schedule === 'semiweekly') {
      key = payDate;
      due = semiweeklyDueDate(payDate);
      label = `Payday ${payDate}`;
    } else {
      key = payDate.slice(0, 7);
      due = fifteenthFollowing(year, month);
      label = `Month ${payDate.slice(0, 7)}`;
    }
    if (!groups.has(key)) {
      groups.set(key, {
        key, label, due,
        periodEnd: quarterEnd(year, quarterOf(payDate)),
        amount: 0, fit: 0, ss: 0, medicare: 0
      });
    }
    const g = groups.get(key);
    g.amount = money.add(g.amount, federalLiabilityOf(c));
    g.fit = money.add(g.fit, c.fit);
    g.ss = money.add(g.ss, c.ss, c.erSs);
    g.medicare = money.add(g.medicare, c.medicare, c.erMedicare);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map(g => ({
    ...g,
    nextDayRule: g.amount >= FED_NEXT_DAY_THRESHOLD
  }));
}

function njGitLiabilities(db, year, payerType) {
  const groups = new Map();
  for (const { payDate, c } of finalizedChecks(db, year)) {
    const month = Number(payDate.slice(5, 7));
    const q = quarterOf(payDate);
    let key, due, label, periodEnd;
    if (payerType === 'weekly') {
      key = payDate;
      due = njWeeklyDueDate(payDate);
      label = `Payday ${payDate} (weekly payer)`;
      periodEnd = payDate;
    } else if (payerType === 'monthly') {
      const monthInQuarter = (month - 1) % 3;   // 0,1,2
      if (monthInQuarter < 2) {
        key = payDate.slice(0, 7);
        due = fifteenthFollowing(year, month);
        label = `NJ-500 ${payDate.slice(0, 7)}`;
        periodEnd = monthEnd(year, month);
      } else {
        key = `${year}-Q${q}`;
        due = nj927DueDate(year, q);
        label = `With NJ-927 Q${q} ${year}`;
        periodEnd = quarterEnd(year, q);
      }
    } else {   // quarterly
      key = `${year}-Q${q}`;
      due = nj927DueDate(year, q);
      label = `NJ-927 Q${q} ${year}`;
      periodEnd = quarterEnd(year, q);
    }
    if (!groups.has(key)) groups.set(key, { key, label, due, periodEnd, amount: 0 });
    groups.get(key).amount = money.add(groups.get(key).amount, c.njSit);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
    .filter(g => g.amount > 0);
}

// UI/WF + TDI + FLI (employee and employer) owed with the NJ-927.
function nj927Contributions(db, year, quarter) {
  const parts = { eeUiWf: 0, eeTdi: 0, eeFli: 0, erUi: 0, erTdi: 0 };
  for (const { c } of finalizedChecks(db, year, quarter)) {
    parts.eeUiWf = money.add(parts.eeUiWf, c.njUiWf);
    parts.eeTdi = money.add(parts.eeTdi, c.njTdi);
    parts.eeFli = money.add(parts.eeFli, c.njFli);
    parts.erUi = money.add(parts.erUi, c.erNjUi);
    parts.erTdi = money.add(parts.erTdi, c.erNjTdi);
  }
  const amount = money.sum(parts.eeUiWf, parts.eeTdi, parts.eeFli, parts.erUi, parts.erTdi);
  return {
    key: `${year}-Q${quarter}`,
    label: `NJ-927 contributions Q${quarter} ${year}`,
    due: nj927DueDate(year, quarter),
    periodEnd: quarterEnd(year, quarter),
    amount, ...parts
  };
}

// Quarterly FUTA obligations with the $500 roll-forward rule.
function futaLiabilities(db, year, todayIso) {
  const out = [];
  let carried = 0;
  const today = todayIso || new Date().toISOString().slice(0, 10);
  for (const q of [1, 2, 3, 4]) {
    const liability = money.sum(...finalizedChecks(db, year, q).map(({ c }) => c.erFuta));
    const accumulated = money.add(carried, liability);
    const end = quarterEnd(year, q);
    const due = q === 4 ? iso(year + 1, 1, 31) : monthEnd(year, q * 3 + 1);
    const depositRequired = accumulated > FUTA_DEPOSIT_THRESHOLD;
    const entry = {
      key: `${year}-Q${q}-futa`, label: `FUTA Q${q} ${year}`,
      due, periodEnd: end,
      quarterLiability: liability, accumulated,
      depositRequired,
      amount: depositRequired ? accumulated : 0
    };
    carried = depositRequired ? 0 : accumulated;
    if (liability > 0 || depositRequired) out.push(entry);
    if (end > today) break;
  }
  return out;
}

// Payments recorded against a specific obligation (bucket + periodKey).
function paidFor(db, bucket, periodKey) {
  return money.sum(...db.payrollDeposits
    .filter(d => d.bucket === bucket && d.periodKey === periodKey)
    .map(d => d.amount));
}

module.exports = {
  FED_NEXT_DAY_THRESHOLD, FUTA_DEPOSIT_THRESHOLD,
  quarterOf, quarterEnd, monthEnd, fifteenthFollowing, nj927DueDate,
  semiweeklyDueDate, njWeeklyDueDate, finalizedChecks,
  federalLiabilityOf, federalLiabilities, njGitLiabilities,
  nj927Contributions, futaLiabilities, paidFor
};
