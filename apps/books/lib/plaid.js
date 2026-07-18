// Thin Plaid REST client using Node's global fetch — no SDK dependency.
// Credentials come from env vars (PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV)
// or, if unset, from the company's settings.plaid saved via the Banking page.
const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com'
};

function getConfig(db) {
  const s = (db && db.settings.plaid) || {};
  const clientId = process.env.PLAID_CLIENT_ID || s.clientId || '';
  const secret = process.env.PLAID_SECRET || s.secret || '';
  const env = process.env.PLAID_ENV || s.env || 'sandbox';
  return { clientId, secret, env, configured: !!(clientId && secret) };
}

async function plaidPost(db, path, body) {
  const cfg = getConfig(db);
  if (!cfg.configured) {
    const err = new Error('Plaid is not configured — add your API keys on the Banking page');
    err.status = 400;
    throw err;
  }
  const base = process.env.QUICKBUCKS_PLAID_BASE_URL || PLAID_HOSTS[cfg.env] || PLAID_HOSTS.sandbox;
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_message || data.error_code || `Plaid request failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  return data;
}

function createLinkToken(db) {
  return plaidPost(db, '/link/token/create', {
    user: { client_user_id: 'quickbucks-owner' },
    client_name: db.settings.companyName || 'QuickBucks',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en'
  });
}

function exchangePublicToken(db, publicToken) {
  return plaidPost(db, '/item/public_token/exchange', { public_token: publicToken });
}

function getAccounts(db, accessToken) {
  return plaidPost(db, '/accounts/get', { access_token: accessToken });
}

function syncTransactions(db, accessToken, cursor) {
  const body = { access_token: accessToken, count: 250 };
  if (cursor) body.cursor = cursor;
  return plaidPost(db, '/transactions/sync', body);
}

function removeItem(db, accessToken) {
  return plaidPost(db, '/item/remove', { access_token: accessToken });
}

module.exports = { getConfig, createLinkToken, exchangePublicToken, getAccounts, syncTransactions, removeItem };
