// Route group: sales tax + reporting views (dashboard, P&L, A/R aging).
//
// Extracted verbatim from server.js as the first slice of the incremental
// server split (Phase 6 / #25). Behavior-preserving: the handlers are the same
// closures, registered through the same `route(method, pattern, handler)` helper
// in the same order they had inline. Deps that were module-level free variables
// in server.js are passed in explicitly so nothing here reaches back into the
// monolith.
//
// Wiring (server.js): require('./lib/routes/reports')(route, deps).
module.exports = function registerReportRoutes(route, deps) {
  const {
    sendJSON, readBody, badRequest, inRange,
    round2, uid, todayISO, decorateInvoice, commit,
    audit, salestax, money
  } = deps;

  // -- sales tax --
  route('GET', '/api/salestax', (req, res, db, params, query) => {
    const year = Number(query.get('year')) || new Date().getFullYear();
    const cfg = salestax.salesTaxSettings(db);
    sendJSON(res, 200, salestax.summary(db, year, cfg));
  });
  route('POST', '/api/salestax/remit', async (req, res, db) => {
    const b = await readBody(req);
    const amount = round2(Number(b.amount));
    if (!(amount > 0)) return badRequest(res, 'Remittance amount must be positive');
    if (!b.periodKey) return badRequest(res, 'A period (month or quarter) is required');
    // A remittance is NOT an expense: the collected tax was never income —
    // it only reduces the trust-fund balance.
    const rec = {
      id: uid(),
      periodKey: String(b.periodKey),
      amount,
      date: b.date || todayISO(),
      note: b.note || ''
    };
    db.salesTaxRemittances.push(rec);
    await commit(db, req.companyId, 'salestax.remitted', {
      remittanceId: rec.id, amountCents: audit.centsStr(amount), period: rec.periodKey, actor: audit.actor(req)
    });
    const cfg = salestax.salesTaxSettings(db);
    sendJSON(res, 200, { remittance: rec, summary: salestax.summary(db, Number(rec.date.slice(0, 4)), cfg) });
  });

  // -- dashboard --
  route('GET', '/api/dashboard', (req, res, db) => {
    const invoices = db.invoices.map(decorateInvoice).filter(i => i.status !== 'draft');
    const today = todayISO();

    // Income is recognized on payment date (cash basis); expenses on expense date.
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const monthly = months.map(m => ({ month: m, income: 0, expenses: 0 }));
    const byMonth = Object.fromEntries(monthly.map(x => [x.month, x]));

    let totalIncome = 0;
    for (const inv of invoices) {
      for (const p of inv.payments || []) {
        // Collected sales tax is held in trust for the State — not income.
        const { income } = salestax.paymentIncomeParts(inv, p);
        totalIncome = money.add(totalIncome, income);
        const m = (p.date || '').slice(0, 7);
        if (byMonth[m]) byMonth[m].income = money.add(byMonth[m].income, income);
      }
    }
    let totalExpenses = 0;
    for (const e of db.expenses) {
      totalExpenses = money.add(totalExpenses, e.amount);
      const m = e.date.slice(0, 7);
      if (byMonth[m]) byMonth[m].expenses = money.add(byMonth[m].expenses, e.amount);
    }

    const open = invoices.filter(i => i.balance > 0);
    const overdue = open.filter(i => i.dueDate < today);

    sendJSON(res, 200, {
      totalIncome,
      totalExpenses,
      netProfit: money.sub(totalIncome, totalExpenses),
      outstanding: money.sum(...open.map(i => i.balance)),
      outstandingCount: open.length,
      overdueAmount: money.sum(...overdue.map(i => i.balance)),
      overdueCount: overdue.length,
      monthly,
      recentInvoices: db.invoices.map(inv => {
        const c = db.customers.find(x => x.id === inv.customerId);
        return { ...decorateInvoice(inv), customerName: c ? (c.company || c.name) : '(deleted)' };
      }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
      recentExpenses: [...db.expenses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)
    });
  });

  // -- reports --
  route('GET', '/api/reports/pnl', (req, res, db, params, query) => {
    const from = query.get('from') || '0000-01-01';
    const to = query.get('to') || '9999-12-31';

    // Cash-basis P&L: income by payment date, expenses by expense date.
    const incomeByCustomer = {};
    let totalIncome = 0;
    for (const inv of db.invoices) {
      if (inv.draft) continue;
      const c = db.customers.find(x => x.id === inv.customerId);
      const name = c ? (c.company || c.name) : '(deleted)';
      const dInv = decorateInvoice(inv);
      for (const p of inv.payments || []) {
        if (!inRange(p.date, from, to)) continue;
        const { income } = salestax.paymentIncomeParts(dInv, p);
        incomeByCustomer[name] = money.add(incomeByCustomer[name] || 0, income);
        totalIncome = money.add(totalIncome, income);
      }
    }

    const expensesByCategory = {};
    let totalExpenses = 0;
    for (const e of db.expenses) {
      if (!inRange(e.date, from, to)) continue;
      expensesByCategory[e.category] = money.add(expensesByCategory[e.category] || 0, e.amount);
      totalExpenses = money.add(totalExpenses, e.amount);
    }

    sendJSON(res, 200, {
      from, to,
      income: Object.entries(incomeByCustomer).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      totalIncome,
      expenses: Object.entries(expensesByCategory).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      totalExpenses,
      netProfit: money.sub(totalIncome, totalExpenses)
    });
  });

  route('GET', '/api/reports/aging', (req, res, db) => {
    const today = todayISO();
    const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };
    for (const raw of db.invoices) {
      const inv = decorateInvoice(raw);
      if (inv.status === 'draft' || inv.balance <= 0) continue;
      const c = db.customers.find(x => x.id === inv.customerId);
      const entry = { number: inv.number, customerName: c ? (c.company || c.name) : '(deleted)', dueDate: inv.dueDate, balance: inv.balance };
      const daysLate = Math.floor((new Date(today) - new Date(inv.dueDate)) / 86400000);
      if (daysLate <= 0) buckets.current.push(entry);
      else if (daysLate <= 30) buckets['1-30'].push(entry);
      else if (daysLate <= 60) buckets['31-60'].push(entry);
      else if (daysLate <= 90) buckets['61-90'].push(entry);
      else buckets['90+'].push(entry);
    }
    const summary = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, money.sum(...v.map(e => e.balance))]));
    sendJSON(res, 200, { buckets, summary, total: money.sum(...Object.values(summary)) });
  });
};
