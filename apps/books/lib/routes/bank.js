// Route group: bank feed — Plaid link/sync, CSV import, categorization rules,
// and the transaction review queue (expense / match / exclude / restore).
//
// Extracted verbatim from server.js as the eighth slice of the incremental
// server split (Phase 6 / #25), following the pattern established by
// lib/routes/reports.js and the six groups after it. Behavior-preserving: the
// handlers are the same closures, registered through the same
// `route(method, pattern, handler)` helper in the same order they had inline.
// Deps that were module-level free variables in server.js are passed in
// explicitly so nothing here reaches back into the monolith.
//
// Persistence note (preserved EXACTLY — do NOT convert either direction): the
// two feed-import paths (`POST /api/bank/sync`, `POST /api/bank/import-csv`)
// commit a `bank.transactions_imported` event through `store.commit`
// (transactional outbox). Every other mutation — config PUT/DELETE, exchange,
// connection delete, rule CRUD, apply-rules, and the review-queue
// expense/match/exclude/restore paths — calls `save(db)` directly, exactly as
// it did inline.
//
// Four bank-only helpers move in with this group (grep confirms no other
// callers in server.js): `publicConnection` (strips the access token/cursor off
// a connection), `txnKey` (CSV dedup key), `syncConnection` (Plaid cursor sync),
// and `ruleFor` (matches an outflow to a categorization rule). The `plaid` and
// `parseBankCSV` requires are used only by this group, but — following the
// payroll/expenses precedent — the `require` lines stay at the top of server.js
// and the modules are threaded through `deps` rather than moved. `decorateInvoice`
// and `salestax` are shared across groups, so they thread through too.
//
// Wiring (server.js): require('./lib/routes/bank')(route, deps).
module.exports = function registerBankRoutes(route, deps) {
  const {
    sendJSON, notFound, badRequest, readBody,
    uid, round2, todayISO, save, commit,
    audit, money, plaid, parseBankCSV, decorateInvoice, salestax
  } = deps;

  function publicConnection(conn) {
    const { accessToken, cursor, ...pub } = conn;
    return pub;
  }

  function txnKey(t) {
    return `${t.date}|${t.amount}|${t.name.toLowerCase()}`;
  }

  route('GET', '/api/bank/status', (req, res, db) => {
    const cfg = plaid.getConfig(db);
    sendJSON(res, 200, {
      configured: cfg.configured,
      env: cfg.env,
      configSource: process.env.PLAID_CLIENT_ID ? 'env' : (db.settings.plaid ? 'settings' : null),
      connections: db.bankConnections.map(publicConnection),
      reviewCount: db.bankTransactions.filter(t => t.status === 'new').length
    });
  });

  route('PUT', '/api/bank/config', async (req, res, db) => {
    const b = await readBody(req);
    if (!b.clientId || !b.secret) return badRequest(res, 'Client ID and secret are required');
    const env = ['sandbox', 'production'].includes(b.env) ? b.env : 'sandbox';
    db.settings.plaid = { clientId: String(b.clientId).trim(), secret: String(b.secret).trim(), env };
    save(db);
    sendJSON(res, 200, { ok: true, configured: true, env });
  });

  route('DELETE', '/api/bank/config', (req, res, db) => {
    delete db.settings.plaid;
    save(db);
    sendJSON(res, 200, { ok: true });
  });

  route('POST', '/api/bank/link-token', async (req, res, db) => {
    const data = await plaid.createLinkToken(db);
    sendJSON(res, 200, { link_token: data.link_token });
  });

  route('POST', '/api/bank/exchange', async (req, res, db) => {
    const b = await readBody(req);
    if (!b.public_token) return badRequest(res, 'public_token is required');
    const { access_token, item_id } = await plaid.exchangePublicToken(db, b.public_token);
    const accountsData = await plaid.getAccounts(db, access_token);
    const conn = {
      id: uid(),
      itemId: item_id,
      institution: b.institution || 'Bank',
      accessToken: access_token,
      cursor: null,
      connectedAt: todayISO(),
      lastSync: null,
      accounts: accountsData.accounts.map(a => ({
        accountId: a.account_id,
        name: a.name,
        mask: a.mask || '',
        type: a.subtype || a.type,
        balance: a.balances.current
      }))
    };
    db.bankConnections.push(conn);
    save(db);
    sendJSON(res, 201, publicConnection(conn));
  });

  async function syncConnection(db, conn) {
    let added = 0, cursor = conn.cursor, hasMore = true;
    const existingPlaid = new Set(db.bankTransactions.map(t => t.plaidId).filter(Boolean));
    while (hasMore) {
      const page = await plaid.syncTransactions(db, conn.accessToken, cursor);
      for (const t of page.added) {
        if (existingPlaid.has(t.transaction_id)) continue;
        db.bankTransactions.push({
          id: uid(),
          source: 'plaid',
          plaidId: t.transaction_id,
          connectionId: conn.id,
          accountId: t.account_id,
          date: t.date,
          name: t.merchant_name || t.name,
          // Plaid: positive = money out. We store positive = money in.
          amount: round2(-t.amount),
          pending: !!t.pending,
          suggestedCategory: t.personal_finance_category ? t.personal_finance_category.primary : '',
          status: 'new'
        });
        added++;
      }
      for (const t of page.modified) {
        const existing = db.bankTransactions.find(x => x.plaidId === t.transaction_id);
        if (existing && existing.status === 'new') {
          existing.date = t.date;
          existing.name = t.merchant_name || t.name;
          existing.amount = round2(-t.amount);
          existing.pending = !!t.pending;
        }
      }
      for (const r of page.removed) {
        const idx = db.bankTransactions.findIndex(x => x.plaidId === r.transaction_id && x.status === 'new');
        if (idx !== -1) db.bankTransactions.splice(idx, 1);
      }
      cursor = page.next_cursor;
      hasMore = page.has_more;
    }
    conn.cursor = cursor;
    conn.lastSync = new Date().toISOString();
    try {
      const accountsData = await plaid.getAccounts(db, conn.accessToken);
      for (const a of accountsData.accounts) {
        const acct = conn.accounts.find(x => x.accountId === a.account_id);
        if (acct) acct.balance = a.balances.current;
      }
    } catch { /* balance refresh is best-effort */ }
    return added;
  }

  route('POST', '/api/bank/sync', async (req, res, db) => {
    if (!db.bankConnections.length) return badRequest(res, 'No bank connections to sync');
    const beforeLen = db.bankTransactions.length;
    let added = 0;
    const errors = [];
    for (const conn of db.bankConnections) {
      try {
        added += await syncConnection(db, conn);
      } catch (e) {
        errors.push(`${conn.institution}: ${e.message}`);
      }
    }
    // Exact signed net of the newly imported feed items (they are appended).
    const net = money.sum(...db.bankTransactions.slice(beforeLen).map(t => t.amount));
    await commit(db, req.companyId, 'bank.transactions_imported', {
      count: added, netCents: audit.centsStr(net), source: 'sync', actor: audit.actor(req)
    });
    sendJSON(res, 200, { added, errors, connections: db.bankConnections.map(publicConnection) });
  });

  route('DELETE', '/api/bank/connections/:id', async (req, res, db, params) => {
    const idx = db.bankConnections.findIndex(c => c.id === params.id);
    if (idx === -1) return notFound(res);
    const conn = db.bankConnections[idx];
    try { await plaid.removeItem(db, conn.accessToken); } catch { /* revoke is best-effort */ }
    db.bankConnections.splice(idx, 1);
    // Drop unreviewed feed items from this bank; reviewed ones already became
    // expenses/payments and live on independently.
    db.bankTransactions = db.bankTransactions.filter(t => !(t.connectionId === conn.id && t.status === 'new'));
    save(db);
    sendJSON(res, 200, { ok: true });
  });

  route('POST', '/api/bank/import-csv', async (req, res, db) => {
    const b = await readBody(req);
    if (!b.csv || !String(b.csv).trim()) return badRequest(res, 'CSV content is required');
    const { transactions, skipped } = parseBankCSV(String(b.csv), { flipSigns: !!b.flipSigns });
    const existing = new Set(db.bankTransactions.map(txnKey));
    let added = 0, duplicates = 0, net = 0;
    for (const t of transactions) {
      if (existing.has(txnKey(t))) { duplicates++; continue; }
      existing.add(txnKey(t));
      const amount = round2(t.amount);
      db.bankTransactions.push({
        id: uid(),
        source: 'csv',
        accountLabel: b.accountLabel || 'Imported',
        date: t.date,
        name: t.name,
        amount,
        status: 'new'
      });
      added++;
      net = money.add(net, amount);
    }
    await commit(db, req.companyId, 'bank.transactions_imported', {
      count: added, netCents: audit.centsStr(net), source: 'csv', actor: audit.actor(req)
    });
    sendJSON(res, 200, { added, duplicates, skipped });
  });

  // -- bank feed rules: "always categorize X as Y" --
  function ruleFor(db, txn) {
    if (txn.amount >= 0) return null;   // rules act on money-out only
    const name = txn.name.toLowerCase();
    return db.bankRules.find(r => r.active !== false && name.includes(r.match.toLowerCase())) || null;
  }

  route('GET', '/api/bank/rules', (req, res, db) => sendJSON(res, 200, db.bankRules));
  route('POST', '/api/bank/rules', async (req, res, db) => {
    const b = await readBody(req);
    if (!b.match || !String(b.match).trim()) return badRequest(res, 'A match text is required');
    if (!b.category || !db.expenseCategories.includes(b.category)) return badRequest(res, 'A valid expense category is required');
    const rule = {
      id: uid(),
      match: String(b.match).trim(),
      category: b.category,
      vendor: (b.vendor || '').trim(),
      active: true,
      createdAt: todayISO()
    };
    db.bankRules.push(rule);
    save(db);
    sendJSON(res, 201, rule);
  });
  route('DELETE', '/api/bank/rules/:id', (req, res, db, params) => {
    const idx = db.bankRules.findIndex(r => r.id === params.id);
    if (idx === -1) return notFound(res);
    db.bankRules.splice(idx, 1);
    save(db);
    sendJSON(res, 200, { ok: true });
  });

  // Apply every rule to the review feed: matching outflows become categorized
  // expenses in one shot (same effect as the per-transaction Add Expense).
  route('POST', '/api/bank/apply-rules', (req, res, db) => {
    let applied = 0;
    for (const t of db.bankTransactions) {
      if (t.status !== 'new') continue;
      const rule = ruleFor(db, t);
      if (!rule) continue;
      const exp = {
        id: uid(),
        date: t.date,
        vendor: rule.vendor || t.name,
        category: rule.category,
        amount: round2(Math.abs(t.amount)),
        paymentMethod: 'Bank transfer',
        notes: `From bank feed via rule "${rule.match}"`,
        createdAt: todayISO()
      };
      db.expenses.push(exp);
      t.status = 'added';
      t.linkedExpenseId = exp.id;
      t.appliedRuleId = rule.id;
      applied++;
    }
    if (applied) save(db);
    sendJSON(res, 200, { applied });
  });

  route('GET', '/api/bank/transactions', (req, res, db, params, query) => {
    const status = query.get('status');
    const accountNames = {};
    for (const c of db.bankConnections) {
      for (const a of c.accounts) accountNames[a.accountId] = `${c.institution} ${a.name}${a.mask ? ' ••' + a.mask : ''}`;
    }
    const list = db.bankTransactions
      .filter(t => !status || t.status === status)
      .map(t => {
        const rule = t.status === 'new' ? ruleFor(db, t) : null;
        return {
          ...t,
          accountName: t.source === 'csv' ? (t.accountLabel || 'Imported') : (accountNames[t.accountId] || 'Bank'),
          ruleMatch: rule ? { id: rule.id, category: rule.category } : null
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    sendJSON(res, 200, list);
  });

  route('POST', '/api/bank/transactions/:id/expense', async (req, res, db, params) => {
    const t = db.bankTransactions.find(x => x.id === params.id);
    if (!t) return notFound(res);
    if (t.status !== 'new') return badRequest(res, 'Transaction was already reviewed');
    if (t.amount >= 0) return badRequest(res, 'This is money in — match it to an invoice instead');
    const b = await readBody(req);
    const exp = {
      id: uid(),
      date: b.date || t.date,
      vendor: String(b.vendor || t.name).trim(),
      category: b.category || 'Other',
      amount: round2(Math.abs(t.amount)),
      paymentMethod: b.paymentMethod || 'Bank transfer',
      notes: b.notes || `From bank feed: ${t.name}`,
      createdAt: todayISO()
    };
    db.expenses.push(exp);
    t.status = 'added';
    t.linkedExpenseId = exp.id;
    save(db);
    sendJSON(res, 200, { transaction: t, expense: exp });
  });

  route('POST', '/api/bank/transactions/:id/match', async (req, res, db, params) => {
    const t = db.bankTransactions.find(x => x.id === params.id);
    if (!t) return notFound(res);
    if (t.status !== 'new') return badRequest(res, 'Transaction was already reviewed');
    if (t.amount <= 0) return badRequest(res, 'This is money out — add it as an expense instead');
    const b = await readBody(req);
    const inv = db.invoices.find(x => x.id === b.invoiceId);
    if (!inv) return badRequest(res, 'A valid invoice is required');
    const dMatch = decorateInvoice(inv);
    const balance = dMatch.balance;
    if (t.amount > balance + 0.005) {
      return badRequest(res, `Deposit (${t.amount.toFixed(2)}) exceeds the invoice balance (${balance.toFixed(2)})`);
    }
    inv.payments.push({
      id: uid(), date: t.date, amount: round2(t.amount), method: 'Bank transfer',
      taxSnapshot: salestax.taxSplitSnapshot(dMatch)
    });
    inv.draft = false;
    t.status = 'matched';
    t.linkedInvoiceId = inv.id;
    save(db);
    sendJSON(res, 200, { transaction: t, invoice: decorateInvoice(inv) });
  });

  route('POST', '/api/bank/transactions/:id/exclude', (req, res, db, params) => {
    const t = db.bankTransactions.find(x => x.id === params.id);
    if (!t) return notFound(res);
    if (t.status !== 'new') return badRequest(res, 'Transaction was already reviewed');
    t.status = 'excluded';
    save(db);
    sendJSON(res, 200, t);
  });

  route('POST', '/api/bank/transactions/:id/restore', (req, res, db, params) => {
    const t = db.bankTransactions.find(x => x.id === params.id);
    if (!t) return notFound(res);
    if (t.status !== 'excluded') return badRequest(res, 'Only excluded transactions can be restored');
    t.status = 'new';
    save(db);
    sendJSON(res, 200, t);
  });
};
