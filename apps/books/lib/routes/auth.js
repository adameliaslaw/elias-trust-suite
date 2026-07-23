// Route group: auth + companies + settings (session lifecycle, household
// password, company registry CRUD/switch, per-company settings, categories).
//
// Extracted verbatim from server.js as the tenth slice of the incremental
// server split (Phase 6 / #25), following the pattern established by the nine
// domain groups before it (reports/expenses/customers/time/recurring/household/
// payroll/bank/invoices). Behavior-preserving: the handlers are the same
// closures, registered through the same `route(method, pattern, handler)` helper
// in the same order they had inline. Deps that were module-level free variables
// in server.js are passed in explicitly so nothing here reaches back into the
// monolith.
//
// The `secureAttr` helper moves IN with this group — it has no other callers
// (grep-confirmed): only the cookie-setting handlers below (login/logout/
// password/company-select) use it. Contrast PUBLIC_ROUTES and the session/auth
// middleware, which the request DISPATCHER itself consults — those stay in
// server.js and are not part of this module.
//
// Persistence note (preserved exactly): this cluster is mostly NON-money.
// Password + company-registry mutations write the household-level global.json
// via `saveGlobal()`; the login/logout/company-select handlers only set cookies
// and (for login/password) append an `auth.*` audit event directly. The one
// exception is `PUT /api/settings`, which — as it did inline — commits a
// `settings.changed` event through the transactional outbox (settings can carry
// sales-tax config that later money math reads), so `commit` is threaded in. Do
// NOT convert any path's persistence direction.
//
// Wiring (server.js): require('./lib/routes/auth')(route, deps).
module.exports = function registerAuthRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    loadGlobal, saveGlobal,
    companies, createCompany,
    commit, audit, auth, salestax
  } = deps;

  // Append "; Secure" whenever the request actually arrived over TLS (directly
  // or via a terminating proxy). A session/company cookie sent in cleartext —
  // e.g. the server bound to 0.0.0.0 and reached over a LAN — is interceptable;
  // Secure pins it to HTTPS. Omitted on plain-http localhost dev so login still
  // works.
  function secureAttr(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const isTls = proto === 'https' || req.socket?.encrypted === true;
    return isTls ? '; Secure' : '';
  }

  // -- auth (public routes; see PUBLIC_ROUTES in server.js) --
  // The password is household-level (global.json), shared by all companies.
  route('GET', '/api/auth-status', (req, res) => {
    const g = loadGlobal();
    const setupRequired = !g.passwordHash && !auth.authDisabled();
    const authenticated = !setupRequired && (auth.authDisabled() || !g.passwordHash || auth.isAuthenticated(req));
    // Surface the caller's role so the UI can hide owner-only controls. Trusted
    // mode / default owner = owner; a named principal resolves from global.json.
    let role = null, username = null;
    if (authenticated) {
      if (auth.authDisabled() || !g.passwordHash) {
        role = 'owner';
      } else {
        const sp = auth.sessionPrincipal(auth.parseCookies(req).qb_session);
        if (sp && sp.username == null) {
          role = 'owner';
        } else if (sp) {
          const p = (g.principals || []).find(x => x.username === sp.username);
          if (p) { role = p.role; username = p.username; }
        }
      }
    }
    sendJSON(res, 200, { protected: !!g.passwordHash, setupRequired, authenticated, role, username });
  });
  route('POST', '/api/login', async (req, res) => {
    // Throttle brute-force attempts per client IP before doing any scrypt work.
    const lockedMs = auth.loginLockedMs(req);
    if (lockedMs) {
      res.setHeader('Retry-After', Math.ceil(lockedMs / 1000));
      return sendJSON(res, 429, { error: 'Too many failed attempts — try again later' });
    }
    const b = await readBody(req);
    const g = loadGlobal();
    const username = b.username != null ? String(b.username).trim() : '';
    const setCookie = (token) =>
      res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secureAttr(req)}`);
    // login_failed shares one recorder so the throttle, the fail-loud audit
    // entry, and the response stay in lockstep for both credential kinds.
    const fail = async (principal) => {
      auth.recordLoginFail(req);
      // login is a public route, so req.principal is unset and actor() yields
      // `local@<ip>`; slice past the `local@` prefix to record just the ip.
      await audit.append(req.companyId, 'auth.login_failed', {
        principal, reason: 'bad_password', ip: audit.actor(req).slice(6)
      });
    };

    // A named principal (bookkeeper / read-only) logs in with username+password.
    if (username) {
      const p = (g.principals || []).find(x => x.username === username);
      if (!p || !auth.verifyPassword(String(b.password || ''), p.passwordHash)) {
        await fail(username);
        return sendJSON(res, 401, { error: 'Incorrect username or password' });
      }
      auth.resetLoginFails(req);
      setCookie(auth.createSession(p.username));
      return sendJSON(res, 200, { ok: true, role: p.role, username: p.username });
    }

    // The default owner (household-shared password, no username) — the original
    // pre-roles path, unchanged.
    if (!g.passwordHash) return badRequest(res, 'No password is set');
    if (!auth.verifyPassword(String(b.password || ''), g.passwordHash)) {
      await fail('local');
      return sendJSON(res, 401, { error: 'Incorrect password' });
    }
    auth.resetLoginFails(req);
    setCookie(auth.createSession());
    sendJSON(res, 200, { ok: true, role: 'owner' });
  });
  route('POST', '/api/logout', (req, res) => {
    auth.destroySession(auth.parseCookies(req).qb_session);
    res.setHeader('Set-Cookie', `qb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureAttr(req)}`);
    sendJSON(res, 200, { ok: true });
  });
  route('POST', '/api/password', async (req, res) => {
    const b = await readBody(req);
    const g = loadGlobal();
    if (g.passwordHash && !auth.verifyPassword(String(b.current || ''), g.passwordHash)) {
      return sendJSON(res, 401, { error: 'Current password is incorrect' });
    }
    const next = String(b.next || '');
    if (next === '') {
      g.passwordHash = null; // turn protection off
    } else {
      if (next.length < 6) return badRequest(res, 'Password must be at least 6 characters');
      g.passwordHash = auth.hashPassword(next);
    }
    saveGlobal();
    // Invalidate every existing session — a stolen cookie must not outlive the
    // password it was minted under. The caller gets a fresh one below so they
    // aren't locked out of their own session.
    auth.clearSessions();
    const token = auth.createSession();
    res.setHeader('Set-Cookie', `qb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secureAttr(req)}`);
    await audit.append(req.companyId, 'auth.password_changed', { principal: 'local' });
    sendJSON(res, 200, { ok: true, protected: !!g.passwordHash });
  });

  // -- companies (household level) --
  route('GET', '/api/companies', (req, res) => {
    sendJSON(res, 200, companies().map(c => ({ id: c.id, name: c.name, active: c.id === req.companyId })));
  });
  route('POST', '/api/companies', async (req, res) => {
    const b = await readBody(req);
    if (!b.name || !String(b.name).trim()) return badRequest(res, 'A name is required');
    const company = createCompany(b.name);
    sendJSON(res, 201, company);
  });
  route('POST', '/api/companies/:id/select', (req, res, db, params) => {
    const company = companies().find(c => c.id === params.id);
    if (!company) return notFound(res);
    res.setHeader('Set-Cookie', `qb_company=${company.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secureAttr(req)}`);
    sendJSON(res, 200, { ok: true, id: company.id, name: company.name });
  });

  // -- settings --
  route('GET', '/api/settings', (req, res, db) => {
    // Never expose Plaid credentials; the password hash lives in global.json.
    const { passwordHash, plaid: plaidCfg, ...pub } = db.settings;
    sendJSON(res, 200, { ...pub, protected: !!loadGlobal().passwordHash });
  });
  route('PUT', '/api/settings', async (req, res, db) => {
    const b = await readBody(req);
    const allowed = ['companyName', 'currency', 'invoicePrefix', 'defaultTermsDays', 'defaultHourlyRate'];
    for (const k of allowed) if (k in b) db.settings[k] = b[k];
    if (b.salesTax && typeof b.salesTax === 'object') {
      const rate = Number(b.salesTax.ratePct);
      if ('ratePct' in b.salesTax && (isNaN(rate) || rate < 0 || rate > 30)) {
        return badRequest(res, 'Sales tax rate must be a percentage between 0 and 30');
      }
      db.settings.salesTax = {
        enabled: !!b.salesTax.enabled,
        ratePct: rate > 0 ? rate : salestax.NJ_SALES_TAX_RATE,
        monthlyRemitter: !!b.salesTax.monthlyRemitter
      };
    }
    // Keys only — values can carry secrets; which knob turned cannot. Atomic
    // with the save (#24): the mutation and its audit event commit as one unit.
    await commit(db, req.companyId, 'settings.changed', {
      keys: Object.keys(b), actor: audit.actor(req)
    });
    // Keep the household company registry in sync with the display name.
    if ('companyName' in b) {
      const reg = companies().find(c => c.id === req.companyId);
      if (reg) { reg.name = db.settings.companyName; saveGlobal(); }
    }
    sendJSON(res, 200, db.settings);
  });
  route('GET', '/api/categories', (req, res, db) => sendJSON(res, 200, db.expenseCategories));
};
