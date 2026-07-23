// Route group: principal (identity + role) administration (Phase 6 / #25).
//
// The move off the single household-shared password toward per-principal
// identity. These routes let the OWNER manage named principals — a bookkeeper
// who does day-to-day money work, a read-only viewer — each with their own
// username + password + role. The household-shared password remains the
// implicit default owner; these principals live in global.json (`principals`),
// seeded empty by the global v2 schema migration.
//
// Authorization is enforced in the DISPATCHER (server.js roleAllows/isOwnerOnly:
// `/api/principals*` is owner-only), not here — so these handlers assume the
// caller is already an owner, matching how PUBLIC_ROUTES + the auth check gate
// every other route. Password hashes are NEVER returned.
//
// Session lifecycle: a session stores only the principal's username and the
// role is re-resolved from global.json on every request (server.js resolveRole),
// so deleting a principal or changing their role takes effect immediately — a
// deleted principal's live session is denied on its next request.
//
// Wiring (server.js): require('./lib/routes/principals')(route, deps).
module.exports = function registerPrincipalRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    loadGlobal, saveGlobal, auth, audit, uid, todayISO
  } = deps;

  const ROLES = ['owner', 'bookkeeper', 'read-only'];
  const publicView = (p) => ({ id: p.id, username: p.username, name: p.name || '', role: p.role, createdAt: p.createdAt });

  route('GET', '/api/principals', (req, res) => {
    const g = loadGlobal();
    sendJSON(res, 200, (g.principals || []).map(publicView));
  });

  route('POST', '/api/principals', async (req, res) => {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const role = String(b.role || '');
    const password = String(b.password || '');
    if (!username) return badRequest(res, 'A username is required');
    if (!ROLES.includes(role)) return badRequest(res, 'Role must be owner, bookkeeper, or read-only');
    if (password.length < 6) return badRequest(res, 'Password must be at least 6 characters');
    const g = loadGlobal();
    g.principals = g.principals || [];
    if (g.principals.some(p => p.username === username)) return badRequest(res, 'That username already exists');
    const principal = {
      id: uid(), username, name: String(b.name || '').trim(), role,
      passwordHash: auth.hashPassword(password), createdAt: todayISO()
    };
    g.principals.push(principal);
    saveGlobal();
    await audit.append(req.companyId, 'principal.created', { username, role, actor: audit.actor(req) });
    sendJSON(res, 201, publicView(principal));
  });

  route('PUT', '/api/principals/:id', async (req, res, db, params) => {
    const b = await readBody(req);
    const g = loadGlobal();
    const p = (g.principals || []).find(x => x.id === params.id);
    if (!p) return notFound(res);
    if ('role' in b) {
      if (!ROLES.includes(String(b.role))) return badRequest(res, 'Role must be owner, bookkeeper, or read-only');
      p.role = String(b.role);
    }
    if ('name' in b) p.name = String(b.name || '').trim();
    if (b.password != null && String(b.password) !== '') {
      if (String(b.password).length < 6) return badRequest(res, 'Password must be at least 6 characters');
      p.passwordHash = auth.hashPassword(String(b.password));
    }
    saveGlobal();
    await audit.append(req.companyId, 'principal.updated', { username: p.username, role: p.role, actor: audit.actor(req) });
    sendJSON(res, 200, publicView(p));
  });

  route('DELETE', '/api/principals/:id', async (req, res, db, params) => {
    const g = loadGlobal();
    const idx = (g.principals || []).findIndex(x => x.id === params.id);
    if (idx < 0) return notFound(res);
    const [removed] = g.principals.splice(idx, 1);
    saveGlobal();
    await audit.append(req.companyId, 'principal.deleted', { username: removed.username, actor: audit.actor(req) });
    sendJSON(res, 200, { ok: true });
  });
};
