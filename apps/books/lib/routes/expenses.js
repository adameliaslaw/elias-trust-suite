// Route group: expenses, 1099-NEC vendor tracking, and receipt attachments.
//
// Extracted verbatim from server.js as the second slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js. Behavior-preserving: the handlers are the same
// closures, registered through the same `route(method, pattern, handler)` helper
// in the same order they had inline. Deps that were module-level free variables
// in server.js are passed in explicitly so nothing here reaches back into the
// monolith.
//
// Persistence note (preserved exactly): the money mutations (expense
// create/update/delete) commit through `store.commit` (transactional outbox);
// the NON-money paths (1099 vendor tracking, receipt attach/delete) call
// `save(db)` directly. Do NOT convert the save(db) paths to commit.
//
// The expense-only validator `validExpense` moves in with this group — it has
// no other callers.
//
// Wiring (server.js): require('./lib/routes/expenses')(route, deps).
module.exports = function registerExpenseRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    uid, round2, todayISO, commit, save,
    audit, receipts, money
  } = deps;

  function validExpense(b) {
    if (!b.vendor || !String(b.vendor).trim()) return 'Vendor is required';
    if (!b.date) return 'Date is required';
    if (!(Number(b.amount) > 0)) return 'Amount must be positive';
    return null;
  }

  // -- expenses --
  route('GET', '/api/expenses', (req, res, db) => {
    const list = [...db.expenses].sort((a, b) => b.date.localeCompare(a.date));
    sendJSON(res, 200, list);
  });
  route('POST', '/api/expenses', async (req, res, db) => {
    const b = await readBody(req);
    const err = validExpense(b);
    if (err) return badRequest(res, err);
    const exp = {
      id: uid(),
      date: b.date,
      vendor: String(b.vendor).trim(),
      category: b.category || 'Other',
      amount: round2(Number(b.amount)),
      paymentMethod: b.paymentMethod || 'Other',
      notes: b.notes || '',
      createdAt: todayISO()
    };
    db.expenses.push(exp);
    await commit(db, req.companyId, 'expense.created', {
      expenseId: exp.id, amountCents: audit.centsStr(exp.amount), category: exp.category, actor: audit.actor(req)
    });
    sendJSON(res, 201, exp);
  });
  route('PUT', '/api/expenses/:id', async (req, res, db, params) => {
    const exp = db.expenses.find(x => x.id === params.id);
    if (!exp) return notFound(res);
    const b = await readBody(req);
    const err = validExpense({ ...exp, ...b });
    if (err) return badRequest(res, err);
    for (const k of ['date', 'vendor', 'category', 'paymentMethod', 'notes']) if (k in b) exp[k] = b[k];
    if ('amount' in b) exp.amount = round2(Number(b.amount));
    await commit(db, req.companyId, 'expense.updated', {
      expenseId: exp.id, amountCents: audit.centsStr(exp.amount), category: exp.category, actor: audit.actor(req)
    });
    sendJSON(res, 200, exp);
  });
  route('DELETE', '/api/expenses/:id', async (req, res, db, params) => {
    const idx = db.expenses.findIndex(x => x.id === params.id);
    if (idx === -1) return notFound(res);
    const removed = db.expenses[idx];
    receipts.deleteReceipt(removed.receipt);
    db.expenses.splice(idx, 1);
    await commit(db, req.companyId, 'expense.deleted', {
      expenseId: removed.id, amountCents: audit.centsStr(removed.amount), category: removed.category, actor: audit.actor(req)
    });
    sendJSON(res, 200, { ok: true });
  });

  // -- 1099-NEC vendor tracking --
  // Totals paid per vendor for a year, from the expense ledger. Card
  // payments are excluded from the reportable total (the card issuer
  // reports those on 1099-K); payroll categories are excluded entirely
  // (employees get W-2s). Mark the vendors that are 1099-eligible
  // (unincorporated service providers); TINs/W-9s stay on paper — this app
  // deliberately does not store them.
  route('GET', '/api/vendors/1099', (req, res, db, params, query) => {
    const year = String(Number(query.get('year')) || new Date().getFullYear());
    const tracked = new Set(db.vendors1099.map(v => v.toLowerCase()));
    const byVendor = new Map();
    for (const e of db.expenses) {
      if (!e.date.startsWith(year)) continue;
      if (e.category === 'Payroll' || e.category === 'Payroll Taxes') continue;
      const name = (e.vendor || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, { name, reportable: 0, cardTotal: 0, total: 0 });
      const v = byVendor.get(key);
      v.total = money.add(v.total, e.amount);
      if (e.paymentMethod === 'Credit card') v.cardTotal = money.add(v.cardTotal, e.amount);
      else v.reportable = money.add(v.reportable, e.amount);
    }
    // Tracked vendors with no expenses this year still show, at zero.
    for (const name of db.vendors1099) {
      const key = name.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, { name, reportable: 0, cardTotal: 0, total: 0 });
    }
    const vendors = [...byVendor.values()].map(v => ({
      ...v,
      tracked: tracked.has(v.name.toLowerCase()),
      needs1099: tracked.has(v.name.toLowerCase()) && v.reportable >= 600
    })).sort((a, b) => b.reportable - a.reportable || a.name.localeCompare(b.name));
    sendJSON(res, 200, { year: Number(year), threshold: 600, vendors });
  });
  route('POST', '/api/vendors/1099', async (req, res, db) => {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    if (!name) return badRequest(res, 'A vendor name is required');
    const idx = db.vendors1099.findIndex(v => v.toLowerCase() === name.toLowerCase());
    if (b.tracked && idx === -1) db.vendors1099.push(name);
    if (!b.tracked && idx !== -1) db.vendors1099.splice(idx, 1);
    save(db);
    sendJSON(res, 200, { name, tracked: !!b.tracked });
  });

  // -- receipt attachments (photo or PDF, base64 in; streamed bytes out) --
  route('POST', '/api/expenses/:id/receipt', async (req, res, db, params) => {
    const exp = db.expenses.find(x => x.id === params.id);
    if (!exp) return notFound(res);
    let b;
    try {
      b = await readBody(req, 15e6);   // ~10 MB file once base64 overhead comes off
    } catch (e) {
      return badRequest(res, e.message);
    }
    const { error, receipt } = receipts.saveReceipt(req.companyId, exp.id, b);
    if (error) return badRequest(res, error);
    if (exp.receipt && exp.receipt.filename !== receipt.filename) receipts.deleteReceipt(exp.receipt);
    exp.receipt = receipt;
    save(db);
    sendJSON(res, 200, exp);
  });
  route('GET', '/api/expenses/:id/receipt', (req, res, db, params) => {
    const exp = db.expenses.find(x => x.id === params.id);
    if (!exp || !exp.receipt) return notFound(res);
    const file = receipts.readReceipt(exp.receipt);
    if (!file) return notFound(res);
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': file.buffer.length,
      'Content-Disposition': `inline; filename="${exp.receipt.filename}"`
    });
    res.end(file.buffer);
  });
  route('DELETE', '/api/expenses/:id/receipt', (req, res, db, params) => {
    const exp = db.expenses.find(x => x.id === params.id);
    if (!exp || !exp.receipt) return notFound(res);
    receipts.deleteReceipt(exp.receipt);
    delete exp.receipt;
    save(db);
    sendJSON(res, 200, exp);
  });
};
