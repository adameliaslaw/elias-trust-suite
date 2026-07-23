// Route group: recurring-invoice templates (CRUD + immediate first bill).
//
// Extracted verbatim from server.js as the fifth slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js, expenses.js, customers.js and time.js.
// Behavior-preserving: the handlers are the same closures, registered through
// the same `route(method, pattern, handler)` helper in the same order they had
// inline. Deps that were module-level free variables in server.js are passed in
// explicitly so nothing here reaches back into the monolith.
//
// Persistence note (preserved exactly): the template CRUD is non-money — GET
// only reads; PUT/DELETE call `save(db)` directly. POST /api/recurring is mixed:
// it calls `generateRecurring` (which `commitMany`s any invoices due today or
// earlier as `source: 'recurring'` — a money path) and then `save(db)` for the
// template itself. Do NOT convert this to a single pattern.
//
// Two shared collaborators stay defined in server.js and are threaded in through
// deps, NOT moved:
//   - `validInvoice` is shared with the invoices route group (same shape check).
//   - `generateRecurring` is shared with the boot scheduler (materializeAll /
//     scheduleRecurring runs the same daily+startup sweep) and closes over
//     createInvoice/commitMany/decorateInvoice/audit/todayISO, so it must live in
//     server.js. POST here calls it to bill an immediate first invoice.
//
// Wiring (server.js): require('./lib/routes/recurring')(route, deps).
module.exports = function registerRecurringRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    save, recurring, validInvoice, generateRecurring, audit
  } = deps;

  // -- recurring invoices --
  route('GET', '/api/recurring', (req, res, db) => {
    const list = db.recurringInvoices.map(tpl => {
      const c = db.customers.find(x => x.id === tpl.customerId);
      return { ...tpl, customerName: c ? (c.company || c.name) : '(deleted)' };
    });
    sendJSON(res, 200, list);
  });
  route('POST', '/api/recurring', async (req, res, db) => {
    const b = await readBody(req);
    const tpl = recurring.sanitizeTemplate(b);
    const err = validInvoice({ customerId: tpl.customerId, date: tpl.nextDate, items: tpl.items }, db);
    if (err) return badRequest(res, err);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tpl.nextDate)) return badRequest(res, 'A first bill date is required');
    db.recurringInvoices.push(tpl);
    await generateRecurring(db, req.companyId, audit.actor(req));   // a first date of today (or earlier) bills immediately
    save(db);
    sendJSON(res, 201, tpl);
  });
  route('PUT', '/api/recurring/:id', async (req, res, db, params) => {
    const idx = db.recurringInvoices.findIndex(t => t.id === params.id);
    if (idx === -1) return notFound(res);
    const b = await readBody(req);
    const tpl = recurring.sanitizeTemplate(b, db.recurringInvoices[idx]);
    db.recurringInvoices[idx] = tpl;
    save(db);
    sendJSON(res, 200, tpl);
  });
  route('DELETE', '/api/recurring/:id', (req, res, db, params) => {
    const idx = db.recurringInvoices.findIndex(t => t.id === params.id);
    if (idx === -1) return notFound(res);
    db.recurringInvoices.splice(idx, 1);
    save(db);
    sendJSON(res, 200, { ok: true });
  });
};
