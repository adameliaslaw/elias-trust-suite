// Route group: invoices (CRUD + payments + send) and the POS sales-CSV import.
//
// Extracted verbatim from server.js as the ninth slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js, expenses.js, customers.js, time.js, recurring.js,
// household.js, payroll.js and bank.js. Behavior-preserving: the handlers are
// the same closures, registered through the same `route(method, pattern,
// handler)` helper in the same order they had inline. Deps that were
// module-level free variables in server.js are passed in explicitly so nothing
// here reaches back into the monolith.
//
// This is the domain group that was deferred to a dedicated pass because it is
// NOT self-contained: it drags in the shared `createInvoice` constructor, which
// `generateRecurring` (the boot scheduler), the time route group and this
// sales-import path all thread. So `createInvoice`, `decorateInvoice`,
// `validInvoice` and `generateRecurring` all stay DEFINED in server.js and are
// threaded in through deps, NOT moved:
//   - `createInvoice` is the invoice constructor shared with the recurring
//     scheduler + the time-invoice route; it validates via `validInvoice` and
//     bumps `db.settings.nextInvoiceNumber`.
//   - `validInvoice` is shared with the recurring route group (same shape check).
//   - `decorateInvoice` (from lib/store) computes totals/balance and has ~21
//     call sites across groups.
//
// Persistence note (preserved EXACTLY — do NOT convert commit<->save in either
// direction): invoices is money-heavy. Every invoice mutation goes through the
// transactional outbox via `commit` (crash-atomic audit): create
// (`invoice.created`), update (`invoice.updated`), delete (`invoice.deleted`),
// payment (`invoice.payment_recorded`), send (`invoice.sent`), and the
// sales-CSV import (one batch `sales.imported`). This group carries two of the
// three `salestax.taxSplitSnapshot` sites — the payment push in
// POST /api/invoices/:id/payments and the per-day paid invoice in the sales
// import — so `salestax` is threaded in. (The third snapshot site is the
// bank/match path, now in lib/routes/bank.js.)
//
// Wiring (server.js): require('./lib/routes/invoices')(route, deps).
module.exports = function registerInvoiceRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    uid, todayISO, round2,
    commit, audit,
    createInvoice, decorateInvoice, validInvoice,
    salestax, money, salesimport
  } = deps;

  // -- invoices --
  route('GET', '/api/invoices', (req, res, db) => {
    const list = db.invoices.map(inv => {
      const c = db.customers.find(x => x.id === inv.customerId);
      return { ...decorateInvoice(inv), customerName: c ? (c.company || c.name) : '(deleted)' };
    }).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
    sendJSON(res, 200, list);
  });
  route('GET', '/api/invoices/:id', (req, res, db, params) => {
    const inv = db.invoices.find(x => x.id === params.id);
    if (!inv) return notFound(res);
    const customer = db.customers.find(c => c.id === inv.customerId) || null;
    sendJSON(res, 200, {
      ...decorateInvoice(inv),
      customer,
      company: { name: db.settings.companyName, currency: db.settings.currency }
    });
  });
  route('POST', '/api/invoices', async (req, res, db) => {
    const b = await readBody(req);
    let inv;
    try {
      inv = createInvoice(db, b);
    } catch (e) {
      return badRequest(res, e.message);
    }
    await commit(db, req.companyId, 'invoice.created', {
      invoiceId: inv.id, clientId: inv.customerId,
      totalCents: audit.centsStr(decorateInvoice(inv).total),
      source: 'manual', actor: audit.actor(req)
    });
    sendJSON(res, 201, decorateInvoice(inv));
  });
  route('PUT', '/api/invoices/:id', async (req, res, db, params) => {
    const inv = db.invoices.find(x => x.id === params.id);
    if (!inv) return notFound(res);
    const b = await readBody(req);
    const merged = { ...inv, ...b };
    const err = validInvoice(merged, db);
    if (err) return badRequest(res, err);
    for (const k of ['customerId', 'date', 'dueDate', 'notes']) if (k in b) inv[k] = b[k];
    if ('draft' in b) inv.draft = !!b.draft;
    if ('items' in b) {
      inv.items = b.items.map(it => ({ description: String(it.description).trim(), qty: Number(it.qty), rate: round2(Number(it.rate)), taxable: !!it.taxable }));
      inv.taxRate = inv.items.some(it => it.taxable) ? (inv.taxRate || salestax.salesTaxSettings(db).ratePct) : 0;
    }
    await commit(db, req.companyId, 'invoice.updated', {
      invoiceId: inv.id, totalCents: audit.centsStr(decorateInvoice(inv).total),
      changedFields: Object.keys(b), actor: audit.actor(req)
    });
    sendJSON(res, 200, decorateInvoice(inv));
  });
  route('DELETE', '/api/invoices/:id', async (req, res, db, params) => {
    const idx = db.invoices.findIndex(x => x.id === params.id);
    if (idx === -1) return notFound(res);
    // Snapshot the total BEFORE removal — the chain is the record of what was deleted.
    const deletedTotal = decorateInvoice(db.invoices[idx]).total;
    db.invoices.splice(idx, 1);
    // Release any time entries billed on this invoice back to unbilled WIP.
    for (const t of db.timeEntries) if (t.invoiceId === params.id) t.invoiceId = null;
    await commit(db, req.companyId, 'invoice.deleted', {
      invoiceId: params.id, totalCents: audit.centsStr(deletedTotal), actor: audit.actor(req)
    });
    sendJSON(res, 200, { ok: true });
  });
  route('POST', '/api/invoices/:id/payments', async (req, res, db, params) => {
    const inv = db.invoices.find(x => x.id === params.id);
    if (!inv) return notFound(res);
    const b = await readBody(req);
    const amount = Number(b.amount);
    if (!(amount > 0)) return badRequest(res, 'Payment amount must be positive');
    const dInv = decorateInvoice(inv);
    const balance = dInv.balance;
    if (amount > balance + 0.005) return badRequest(res, `Payment exceeds remaining balance ($${balance.toFixed(2)})`);
    inv.payments.push({
      id: uid(), date: b.date || todayISO(), amount: round2(amount), method: b.method || 'Other',
      // Freeze the income/tax split against the invoice as it stands right now,
      // so a later edit can't restate this period's income or trust liability.
      taxSnapshot: salestax.taxSplitSnapshot(dInv)
    });
    inv.draft = false;
    await commit(db, req.companyId, 'invoice.payment_recorded', {
      invoiceId: inv.id, paymentCents: audit.centsStr(amount), actor: audit.actor(req)
    });
    sendJSON(res, 200, decorateInvoice(inv));
  });
  route('POST', '/api/invoices/:id/send', async (req, res, db, params) => {
    const inv = db.invoices.find(x => x.id === params.id);
    if (!inv) return notFound(res);
    inv.draft = false;
    const customer = db.customers.find(c => c.id === inv.customerId);
    await commit(db, req.companyId, 'invoice.sent', {
      invoiceId: inv.id, clientId: inv.customerId,
      amountCents: audit.centsStr(decorateInvoice(inv).total),
      sentBy: audit.actor(req), sentTo: (customer && customer.email) || ''
    });
    sendJSON(res, 200, decorateInvoice(inv));
  });

  // Import a Dripos (or similar) daily sales CSV: each day becomes a paid,
  // taxable invoice for a walk-in customer, so income and the sales-tax
  // trust ledger flow from the same books as hand-entered sales. Tips are
  // not income (they belong to staff, via payroll) — the response totals
  // them so you know what to expect in the next pay run.
  route('POST', '/api/sales/import-csv', async (req, res, db) => {
    const b = await readBody(req);
    if (!b.csv || !String(b.csv).trim()) return badRequest(res, 'CSV content is required');
    let parsed;
    try {
      parsed = salesimport.parseSalesCSV(String(b.csv));
    } catch (e) {
      return badRequest(res, e.message);
    }
    if (!parsed.days.length) return badRequest(res, 'No sales rows with a parseable date were found');

    const customerName = String(b.customerName || 'Daily sales').trim() || 'Daily sales';
    let customer = db.customers.find(c => c.name === customerName);
    if (!customer) {
      customer = { id: uid(), name: customerName, company: '', email: '', phone: '', notes: 'Auto-created by the sales import', createdAt: todayISO() };
      db.customers.push(customer);
    }

    const existing = new Set(db.invoices.map(i => i.importKey).filter(Boolean));
    const warnings = [];
    let imported = 0, duplicates = 0, importedTotal = 0;
    const taxOn = salestax.salesTaxSettings(db).enabled;
    for (const day of parsed.days) {
      const key = `sales:${customer.id}:${day.date}`;
      if (existing.has(key)) { duplicates++; continue; }
      if (!(day.netSales > 0)) continue;
      let inv;
      try {
        inv = createInvoice(db, {
          customerId: customer.id,
          date: day.date,
          dueDate: day.date,
          items: [{ description: 'Daily sales (imported)', qty: 1, rate: day.netSales, taxable: true }],
          notes: 'Imported from the POS sales export'
        });
      } catch (e) {
        warnings.push(`${day.date}: ${e.message}`);
        continue;
      }
      inv.importKey = key;
      const dImport = decorateInvoice(inv);
      const total = dImport.total;
      inv.payments.push({
        id: uid(), date: day.date, amount: total, method: 'Card',
        taxSnapshot: salestax.taxSplitSnapshot(dImport)
      });
      inv.draft = false;
      existing.add(key);
      imported++;
      importedTotal = money.add(importedTotal, total);
      const computedTax = money.sub(total, day.netSales);
      if (day.tax && Math.abs(computedTax - day.tax) > 0.02) {
        warnings.push(`${day.date}: POS reported ${day.tax.toFixed(2)} tax but the books computed ${computedTax.toFixed(2)} — check the rate in Settings`);
      }
    }
    if (!taxOn && parsed.days.some(d => d.tax > 0)) {
      warnings.unshift('The POS collected sales tax but this company has sales tax turned off in Settings — imported sales were booked without tax');
    }
    // One batch event (not per-invoice): the chain records the import itself,
    // with the exact total of what it booked — atomic with the save (#24).
    await commit(db, req.companyId, 'sales.imported', {
      rowCount: imported, totalCents: audit.centsStr(importedTotal), source: 'csv', actor: audit.actor(req)
    });
    sendJSON(res, 200, { imported, duplicates, tipsTotal: parsed.tipsTotal, skipped: parsed.info.skipped, warnings });
  });
};
