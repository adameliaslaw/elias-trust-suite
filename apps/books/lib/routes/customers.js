// Route group: customers (CRUD + per-customer balance rollups).
//
// Extracted verbatim from server.js as the third slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js and lib/routes/expenses.js. Behavior-preserving: the
// handlers are the same closures, registered through the same
// `route(method, pattern, handler)` helper in the same order they had inline.
// Deps that were module-level free variables in server.js are passed in
// explicitly so nothing here reaches back into the monolith.
//
// Persistence note (preserved exactly): every customer mutation here is a
// NON-money path (name/contact metadata only, no ledger amount), so each calls
// `save(db)` directly — no audit event and no `store.commit`. Do NOT convert
// these to commit. The GET handler only reads (it rolls up invoice balances via
// the shared `decorateInvoice` + `money.sum`).
//
// The customer-only validator `validCustomer` moves in with this group — it has
// no other callers. `decorateInvoice` stays shared (it decorates invoices for
// many other route groups) and is threaded in through deps.
//
// Wiring (server.js): require('./lib/routes/customers')(route, deps).
module.exports = function registerCustomerRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    uid, todayISO, save,
    decorateInvoice, money
  } = deps;

  function validCustomer(b) {
    if (!b.name || !String(b.name).trim()) return 'Customer name is required';
    return null;
  }

  // -- customers --
  route('GET', '/api/customers', (req, res, db) => {
    const withBalances = db.customers.map(c => {
      const invs = db.invoices.filter(i => i.customerId === c.id).map(decorateInvoice);
      return {
        ...c,
        openBalance: money.sum(...invs.filter(i => i.status !== 'draft').map(i => i.balance)),
        totalBilled: money.sum(...invs.filter(i => i.status !== 'draft').map(i => i.total)),
        invoiceCount: invs.length
      };
    });
    sendJSON(res, 200, withBalances);
  });
  route('POST', '/api/customers', async (req, res, db) => {
    const b = await readBody(req);
    const err = validCustomer(b);
    if (err) return badRequest(res, err);
    const customer = {
      id: uid(),
      name: String(b.name).trim(),
      company: b.company || '',
      email: b.email || '',
      phone: b.phone || '',
      notes: b.notes || '',
      createdAt: todayISO()
    };
    db.customers.push(customer);
    save(db);
    sendJSON(res, 201, customer);
  });
  route('PUT', '/api/customers/:id', async (req, res, db, params) => {
    const c = db.customers.find(x => x.id === params.id);
    if (!c) return notFound(res);
    const b = await readBody(req);
    const err = validCustomer({ ...c, ...b });
    if (err) return badRequest(res, err);
    for (const k of ['name', 'company', 'email', 'phone', 'notes']) if (k in b) c[k] = b[k];
    save(db);
    sendJSON(res, 200, c);
  });
  route('DELETE', '/api/customers/:id', (req, res, db, params) => {
    const idx = db.customers.findIndex(x => x.id === params.id);
    if (idx === -1) return notFound(res);
    if (db.invoices.some(i => i.customerId === params.id)) {
      return badRequest(res, 'Cannot delete a customer with invoices. Delete their invoices first.');
    }
    db.customers.splice(idx, 1);
    save(db);
    sendJSON(res, 200, { ok: true });
  });
};
