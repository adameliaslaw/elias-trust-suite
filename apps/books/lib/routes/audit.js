// Route group: audit + backup tail (tamper-evident chain views + full-tarball
// export). Three handlers, all GET / read-only — there is no restore route.
//
// Extracted verbatim from server.js as the eleventh slice of the incremental
// server split (Phase 6 / #25), following the same pattern as the ten groups
// before it. Behavior-preserving: the handlers are the same closures, registered
// through the same `route(method, pattern, handler)` helper in the same order
// they had inline. Deps that were module-level free variables in server.js are
// passed in explicitly so nothing here reaches back into the monolith.
//
// Persistence note (preserved exactly): every handler here is READ-ONLY. The two
// audit views re-verify and read the tamper-evident chain (via `audit.verify` /
// `audit.entries`); `GET /api/audit` returns `{ verified, entries }` from the
// hash-chained file — NOT the vestigial `db.auditLog` (H1). The backup handler
// streams a tarball of the data directory. Nothing here saves or commits.
//
// Wiring (server.js): require('./lib/routes/audit')(route, deps).
module.exports = function registerAuditRoutes(route, deps) {
  const {
    sendJSON, todayISO,
    audit, backup, auth, loadGlobal
  } = deps;

  // -- audit log --
  // Surfaces the TAMPER-EVIDENT chain (the hash-chained file outside the mutable
  // company-<id>.json), not db.auditLog — the forgeable copy that lives inside
  // the very file it audits. Entries carry seq/hash and ship with the chain's
  // verification result so the UI shows the record that actually resists forgery.
  route('GET', '/api/audit', async (req, res, db, params, query) => {
    const limit = Math.min(Number(query.get('limit')) || 100, 500);
    let verified;
    try {
      verified = await audit.verify(req.companyId);
    } catch (e) {
      verified = { ok: false, entries: 0, error: e.message, atSeq: e.atSeq ?? null };
    }
    const entries = await audit.entries(req.companyId, limit);
    sendJSON(res, 200, { verified, entries });
  });
  // Integrity status of the tamper-evident chain: full re-verification on
  // every call. { ok: true, entries } — or ok:false naming the first bad seq.
  route('GET', '/api/audit/chain', async (req, res) => {
    try {
      sendJSON(res, 200, await audit.verify(req.companyId));
    } catch (e) {
      sendJSON(res, 200, { ok: false, entries: 0, error: e.message, atSeq: e.atSeq ?? null });
    }
  });

  // -- backup: the whole data directory as a plain tarball --
  // This exports everything (Plaid access tokens, bank details, receipts), so
  // it always requires a session whenever a password exists — even when auth is
  // disabled via QUICKBUCKS_DISABLE_AUTH for a trusted network.
  route('GET', '/api/backup', (req, res) => {
    if (loadGlobal().passwordHash && !auth.isAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Authentication required' });
    }
    const buf = backup.tarball();
    res.writeHead(200, {
      'Content-Type': 'application/x-tar',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="quickbucks-backup-${todayISO()}.tar"`
    });
    res.end(buf);
  });
};
