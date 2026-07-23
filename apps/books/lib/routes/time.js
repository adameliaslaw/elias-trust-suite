// Route group: billable time tracking (entries CRUD + WIP + roll-to-invoice).
//
// Extracted verbatim from server.js as the fourth slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js, lib/routes/expenses.js and lib/routes/customers.js.
// Behavior-preserving: the handlers are the same closures, registered through
// the same `route(method, pattern, handler)` helper in the same order they had
// inline. Deps that were module-level free variables in server.js are passed in
// explicitly so nothing here reaches back into the monolith.
//
// Persistence note (preserved exactly): a time entry carries hours + rate, so
// creating/updating/deleting one is a MONEY mutation — each calls
// `commit(db, ...)` so its audit event is crash-atomic. `POST /api/time/invoice`
// rolls unbilled time into a draft invoice, also a money mutation, and commits
// the `invoice.created` event. The two GETs only read. Do NOT convert these
// commit paths to a bare save(db).
//
// All time logic lives in the shared `lib/timetracking` module (sanitize /
// decorate / billable-entry selection), so there is no time-only validator to
// move — it is threaded in through deps like the other collaborators.
// `createInvoice` and `decorateInvoice` are shared with the invoices/sales-import
// route groups (and the recurring scheduler), so they stay defined in server.js
// and are threaded in through deps, NOT moved.
//
// Wiring (server.js): require('./lib/routes/time')(route, deps).
module.exports = function registerTimeRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    todayISO, commit,
    createInvoice, decorateInvoice,
    timetracking, recurring, audit
  } = deps;

  // -- billable time --
  route('GET', '/api/time', (req, res, db, params, query) => {
    const status = query.get('status') || 'all';
    const customerId = query.get('customerId');
    let list = db.timeEntries.map(t => {
      const c = db.customers.find(x => x.id === t.customerId);
      return { ...timetracking.decorateEntry(t), customerName: c ? (c.company || c.name) : '(deleted)' };
    });
    if (status !== 'all') list = list.filter(t => t.status === status);
    if (customerId) list = list.filter(t => t.customerId === customerId);
    list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    sendJSON(res, 200, list);
  });
  route('GET', '/api/time/wip', (req, res, db) => sendJSON(res, 200, timetracking.wipByCustomer(db)));
  route('POST', '/api/time', async (req, res, db) => {
    const b = await readBody(req);
    const { error, entry } = timetracking.sanitizeEntry(b, db);
    if (error) return badRequest(res, error);
    db.timeEntries.push(entry);
    await commit(db, req.companyId, 'time_entry.created', {
      entryId: entry.id, customerId: entry.customerId,
      hours: String(entry.hours), rateCents: audit.centsStr(entry.rate), actor: audit.actor(req)
    });
    sendJSON(res, 201, timetracking.decorateEntry(entry));
  });
  route('PUT', '/api/time/:id', async (req, res, db, params) => {
    const idx = db.timeEntries.findIndex(t => t.id === params.id);
    if (idx === -1) return notFound(res);
    if (db.timeEntries[idx].invoiceId) return badRequest(res, 'This entry is on an invoice. Delete the invoice to release it.');
    const b = await readBody(req);
    const { error, entry } = timetracking.sanitizeEntry(b, db, db.timeEntries[idx]);
    if (error) return badRequest(res, error);
    db.timeEntries[idx] = entry;
    await commit(db, req.companyId, 'time_entry.updated', {
      entryId: entry.id, customerId: entry.customerId,
      hours: String(entry.hours), rateCents: audit.centsStr(entry.rate), actor: audit.actor(req)
    });
    sendJSON(res, 200, timetracking.decorateEntry(entry));
  });
  route('DELETE', '/api/time/:id', async (req, res, db, params) => {
    const idx = db.timeEntries.findIndex(t => t.id === params.id);
    if (idx === -1) return notFound(res);
    if (db.timeEntries[idx].invoiceId) return badRequest(res, 'This entry is on an invoice. Delete the invoice to release it.');
    const removed = db.timeEntries[idx];
    db.timeEntries.splice(idx, 1);
    await commit(db, req.companyId, 'time_entry.deleted', {
      entryId: removed.id, customerId: removed.customerId,
      hours: String(removed.hours), rateCents: audit.centsStr(removed.rate), actor: audit.actor(req)
    });
    sendJSON(res, 200, { ok: true });
  });
  // Roll a customer's unbilled time (optionally a subset by entryIds) into a
  // draft invoice, one line per entry.
  route('POST', '/api/time/invoice', async (req, res, db) => {
    const b = await readBody(req);
    const entries = timetracking.billableEntries(db, b.customerId, b.entryIds);
    if (!entries.length) return badRequest(res, 'No unbilled time for that customer');
    let inv;
    try {
      inv = createInvoice(db, {
        customerId: b.customerId,
        date: b.date || todayISO(),
        dueDate: b.dueDate || recurring.addDaysIso(b.date || todayISO(), db.settings.defaultTermsDays || 30),
        items: timetracking.invoiceItems(entries),
        draft: true,
        notes: b.notes || ''
      });
    } catch (e) {
      return badRequest(res, e.message);
    }
    for (const t of entries) t.invoiceId = inv.id;
    await commit(db, req.companyId, 'invoice.created', {
      invoiceId: inv.id, clientId: inv.customerId,
      totalCents: audit.centsStr(decorateInvoice(inv).total),
      source: 'time', actor: audit.actor(req)
    });
    sendJSON(res, 201, { ...decorateInvoice(inv), entriesBilled: entries.length });
  });
};
