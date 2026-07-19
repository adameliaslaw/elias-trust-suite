'use strict';
// Clio Manage sync: push attorney-reviewed entries into Clio as time
// entries (Activities), so Matterproof feeds the billing system of record
// instead of replacing it.
//
// Setup: create an app at https://app.clio.com/settings/developer_applications
// with redirect URI http://127.0.0.1:53682/callback, then:
//   billable config clioClientId <id>
//   billable config clioClientSecret <secret>
//   billable clio connect
//   billable clio matters                 # list Clio matters + ids
//   billable clio map "Acme Corp" "ACME-001" 12345
//   billable clio push --from 2026-07-01 --dry-run
//
// Push rules: only entries that are attorney-reviewed, not written off, not
// already pushed, and whose client/matter is mapped to a Clio matter id.

const store = require('./store');
const { keyOf } = require('./economics');

const CLIO_BASE = process.env.CLIO_BASE_URL || 'https://app.clio.com';
const REDIRECT_URI = 'http://127.0.0.1:53682/callback';

function authUrl(config) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: config.clioClientId,
    redirect_uri: REDIRECT_URI,
  });
  return `${CLIO_BASE}/oauth/authorize?${p}`;
}

async function exchangeToken(config, params, fetchImpl = fetch) {
  const res = await fetchImpl(`${CLIO_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clioClientId,
      client_secret: config.clioClientSecret,
      redirect_uri: REDIRECT_URI,
      ...params,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Clio token exchange failed (${res.status}): ${await res.text()}`);
  const tok = await res.json();
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in || 0) * 1000,
  };
}

// Loopback OAuth: open the printed URL, Clio redirects the browser back to
// 127.0.0.1:53682 with the authorization code.
function waitForCode(port = 53682) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/callback') return res.end();
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>Matterproof is connected to Clio. You can close this tab.</p>');
      server.close();
      code ? resolve(code) : reject(new Error(url.searchParams.get('error') || 'no code returned'));
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

async function connect(config, fetchImpl = fetch) {
  if (!config.clioClientId || !config.clioClientSecret) {
    throw new Error('Set clioClientId and clioClientSecret first (billable config clioClientId ...)');
  }
  console.log('Open this URL in your browser and authorize Matterproof:\n');
  console.log('  ' + authUrl(config) + '\n');
  const code = await waitForCode();
  const clio = await exchangeToken(config, { grant_type: 'authorization_code', code }, fetchImpl);
  store.writeConfig({ ...config, clio });
  return clio;
}

async function accessToken(config, fetchImpl = fetch) {
  let clio = config.clio;
  if (!clio || !clio.accessToken) throw new Error('Not connected to Clio — run: billable clio connect');
  if (clio.expiresAt && Date.now() > clio.expiresAt - 60_000 && clio.refreshToken) {
    clio = await exchangeToken(config, { grant_type: 'refresh_token', refresh_token: clio.refreshToken }, fetchImpl);
    store.writeConfig({ ...config, clio });
  }
  return clio.accessToken;
}

async function api(config, method, path, body, fetchImpl = fetch) {
  const token = await accessToken(config, fetchImpl);
  const res = await fetchImpl(`${CLIO_BASE}/api/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Clio API ${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function listMatters(config, fetchImpl = fetch) {
  const data = await api(
    config, 'GET',
    '/matters.json?fields=id,display_number,description,client{name}&limit=200&status=open,pending',
    undefined, fetchImpl
  );
  return (data.data || []).map((m) => ({
    id: m.id,
    number: m.display_number,
    description: m.description,
    client: m.client && m.client.name,
  }));
}

// Returns {pushed, skipped:{unreviewed, unmapped, writeOff, alreadyPushed}}.
function classifyForPush(entries, config, overrides) {
  const ready = [];
  const skipped = { unreviewed: 0, unmapped: 0, writeOff: 0, alreadyPushed: 0 };
  for (const e of entries) {
    const clioMatterId = (config.clioMatters || {})[keyOf(e.client, e.matter)];
    if (overrides[e.id] && overrides[e.id].clioId) skipped.alreadyPushed++;
    else if (e.writeOff) skipped.writeOff++;
    else if (!e.reviewed) skipped.unreviewed++;
    else if (!clioMatterId) skipped.unmapped++;
    else ready.push({ entry: e, clioMatterId });
  }
  return { ready, skipped };
}

function activityBody(entry, clioMatterId, config) {
  return {
    data: {
      type: 'TimeEntry',
      date: entry.date,
      quantity: Math.round(entry.hours * 3600), // Clio v4 takes time in seconds
      price: config.rate || 0,
      note: entry.description,
      non_billable: false,
      matter: { id: clioMatterId },
    },
  };
}

async function pushEntries(entries, config, overrides, { dryRun = false, fetchImpl = fetch } = {}) {
  const { ready, skipped } = classifyForPush(entries, config, overrides);
  const results = [];
  for (const { entry, clioMatterId } of ready) {
    if (dryRun) {
      results.push({ id: entry.id, dryRun: true, clioMatterId });
      continue;
    }
    const res = await api(config, 'POST', '/activities.json', activityBody(entry, clioMatterId, config), fetchImpl);
    const clioId = res.data && res.data.id;
    store.writeOverride(entry.id, { clioId });
    results.push({ id: entry.id, clioId });
  }
  return { results, skipped };
}

module.exports = { authUrl, connect, listMatters, pushEntries, classifyForPush, activityBody, exchangeToken };
