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

const crypto = require('crypto');
const store = require('./store');
const { keyOf } = require('./economics');
const { isBilled } = require('./client-billing');

const CLIO_BASE = process.env.CLIO_BASE_URL || 'https://app.clio.com';
const CALLBACK_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // don't leave the loopback server open forever

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build a hardened authorization request: a random `state` (CSRF defense) and a
// PKCE verifier/challenge pair (S256) so an intercepted authorization code is
// useless without the verifier this process holds. Returns everything the
// caller must retain to validate the callback and complete the exchange.
function buildAuthRequest(config) {
  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(48)); // 43-128 chars per RFC 7636
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: config.clioClientId,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url: `${CLIO_BASE}/oauth/authorize?${p}`, state, codeVerifier, codeChallenge };
}

// Back-compat shim: the bare authorize URL (no PKCE/state). Prefer
// buildAuthRequest for the real connect flow.
function authUrl(config) {
  return buildAuthRequest(config).url;
}

async function exchangeToken(config, params, fetchImpl = fetch) {
  // Map the caller's camelCase codeVerifier to the OAuth `code_verifier` field
  // and never leak the camelCase key into the request body.
  const { codeVerifier, ...rest } = params;
  const form = {
    client_id: config.clioClientId,
    client_secret: config.clioClientSecret,
    redirect_uri: REDIRECT_URI,
    ...rest,
  };
  if (codeVerifier) form.code_verifier = codeVerifier;
  const res = await fetchImpl(`${CLIO_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
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
// 127.0.0.1 with the authorization code. Hardened: the returned `state` MUST
// match what we sent (CSRF), and the wait is bounded by a timeout so a browser
// that never returns doesn't leave the callback server (and the CLI) hanging.
function waitForCode({ port = CALLBACK_PORT, expectedState, timeoutMs = CALLBACK_TIMEOUT_MS, onListening } = {}) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* already closing */ }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`Clio authorization timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/callback') return res.end();
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      // Validate state BEFORE trusting the code — a mismatch means the callback
      // was not initiated by this process (CSRF / forged redirect).
      if (expectedState != null && state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end('<p>Authorization state did not match. Please retry from the CLI.</p>');
        return finish(reject, new Error('Clio authorization state mismatch — request rejected'));
      }
      res.writeHead(code ? 200 : 400, { 'content-type': 'text/html' });
      res.end(code
        ? '<p>Matterproof is connected to Clio. You can close this tab.</p>'
        : '<p>No authorization code returned.</p>');
      code
        ? finish(resolve, code)
        : finish(reject, new Error(url.searchParams.get('error') || 'no code returned'));
    });
    server.once('error', (err) => finish(reject, err));
    server.listen(port, '127.0.0.1', () => {
      if (onListening) onListening(server.address().port);
    });
  });
}

async function connect(config, fetchImpl = fetch) {
  if (!config.clioClientId || !config.clioClientSecret) {
    throw new Error('Set clioClientId and clioClientSecret first (billable config clioClientId ...)');
  }
  const authReq = buildAuthRequest(config);
  console.log('Open this URL in your browser and authorize Matterproof:\n');
  console.log('  ' + authReq.url + '\n');
  const code = await waitForCode({ expectedState: authReq.state });
  const clio = await exchangeToken(
    config,
    { grant_type: 'authorization_code', code, codeVerifier: authReq.codeVerifier },
    fetchImpl
  );
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

// Returns {pushed, skipped:{unreviewed, unconfirmed, unmapped, writeOff, alreadyPushed}}.
// An entry is pushable only when reviewed, built on attorney-confirmed minutes
// (#17), not written off, mapped to a Clio matter, and not already billed to
// ANY destination (#18 — mutual exclusivity, so a LawPay- or LEDES-billed entry
// is skipped here too).
function classifyForPush(entries, config, overrides) {
  const ready = [];
  const skipped = { unreviewed: 0, unconfirmed: 0, unmapped: 0, writeOff: 0, alreadyPushed: 0 };
  for (const e of entries) {
    const clioMatterId = (config.clioMatters || {})[keyOf(e.client, e.matter)];
    if (isBilled(overrides[e.id]) || e.billed) skipped.alreadyPushed++;
    else if (e.writeOff) skipped.writeOff++;
    else if (!e.reviewed) skipped.unreviewed++;
    else if (!e.confirmed || !(e.hours > 0)) skipped.unconfirmed++;
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

// Deterministic idempotency key for one entry's push. Stable across retries
// (so a resumed push recognizes its own earlier intent) and sensitive to the
// pushed content (a genuinely different activity yields a different key). This
// is the Clio analogue of LawPay's deterministic `reference`.
function pushKey(entry, clioMatterId, config) {
  const { data } = activityBody(entry, clioMatterId, config);
  return 'CLIO-' + crypto
    .createHash('sha1')
    .update(JSON.stringify([entry.id, String(clioMatterId), data.date, data.quantity, data.note]))
    .digest('hex')
    .slice(0, 16);
}

// The set of push keys that already have a durable pre-POST intent recorded.
function recordedIntentKeys(events) {
  const keys = new Set();
  for (const ev of events) if (ev.type === 'clio.push_intent' && ev.key) keys.add(ev.key);
  return keys;
}

// Recover a DANGLING intent: the intent was recorded (and the POST may or may
// not have reached Clio) but the process died before the clioId override
// committed. Re-POSTing would risk a duplicate Clio activity, so instead query
// Clio for the activity this intent intended to create.
//   - exactly one unclaimed match  -> adopt its id (no re-POST)
//   - no match                     -> the POST never landed; caller may POST
//   - more than one match          -> ambiguous; fail closed for a human
// A match is the intended (matter, date, quantity, note) not already recorded
// as some other entry's clioId.
async function reconcilePush(entry, clioMatterId, config, fetchImpl) {
  const { data: intended } = activityBody(entry, clioMatterId, config);
  const res = await api(
    config, 'GET',
    `/activities.json?fields=id,date,quantity,note,matter{id}&matter_id=${encodeURIComponent(clioMatterId)}&limit=200`,
    undefined, fetchImpl
  );
  const claimed = new Set(
    Object.values(store.readOverrides())
      .map((o) => o && o.clioId)
      .filter((id) => id != null && id !== '')
      .map(String)
  );
  const matches = (res.data || []).filter((a) =>
    a.date === intended.date &&
    Number(a.quantity) === intended.quantity &&
    (a.note || '') === (intended.note || '') &&
    a.matter && String(a.matter.id) === String(clioMatterId) &&
    !claimed.has(String(a.id))
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) return null;
  throw new Error(
    `Clio reconcile ambiguous for entry ${entry.id}: ${matches.length} matching activities in matter ` +
    `${clioMatterId} — resolve the duplicate in Clio, then retry (billable clio push).`
  );
}

async function pushEntries(entries, config, overrides, { dryRun = false, fetchImpl = fetch } = {}) {
  const { ready, skipped } = classifyForPush(entries, config, overrides);
  const results = [];
  // Read the durable intents once so a batch retry recognizes prior attempts.
  const intents = dryRun ? new Set() : recordedIntentKeys(store.readEvents());
  for (const { entry, clioMatterId } of ready) {
    if (dryRun) {
      results.push({ id: entry.id, dryRun: true, clioMatterId });
      continue;
    }
    const key = pushKey(entry, clioMatterId, config);
    let clioId;
    let reconciled = false;
    if (intents.has(key)) {
      // A prior attempt already recorded this intent and may have POSTed.
      // Reconcile before doing anything irreversible.
      const existing = await reconcilePush(entry, clioMatterId, config, fetchImpl);
      if (existing != null) {
        clioId = existing;
        reconciled = true;
      }
    } else {
      // Fresh push: record the intent BEFORE the POST so a crash between the
      // POST and the clioId commit is recoverable (reconcile, don't re-POST).
      store.appendClioIntent(key, entry.id, clioMatterId);
    }
    if (clioId == null) {
      const res = await api(config, 'POST', '/activities.json', activityBody(entry, clioMatterId, config), fetchImpl);
      clioId = res.data && res.data.id;
    }
    store.writeOverride(entry.id, { clioId });
    results.push(reconciled ? { id: entry.id, clioId, reconciled } : { id: entry.id, clioId });
  }
  return { results, skipped };
}

module.exports = {
  authUrl, buildAuthRequest, connect, listMatters, pushEntries,
  classifyForPush, activityBody, exchangeToken, waitForCode,
  pushKey, reconcilePush,
};
