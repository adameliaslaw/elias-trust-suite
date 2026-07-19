'use strict';
// Matterproof local dashboard + capture API. Zero dependencies. Binds to
// 127.0.0.1 by default: the ledger, and any client-confidential text in it,
// never leaves the machine.
//
// Optional LAN mode (billable serve --lan) binds to other interfaces so a
// phone on the same network can use the dashboard. LAN requests must carry
// the serve token (query param on first visit -> HttpOnly cookie after);
// loopback requests stay exempt so Claude Code hooks and the browser
// extension keep working unauthenticated on the machine itself.
//
// Loopback is not the same as trusted, though: any page open in the
// attorney's browser can talk to 127.0.0.1. Three checks below blunt that —
// a Host allowlist stops DNS rebinding, fetch-metadata/Origin checks refuse
// cross-site pages, and POSTs must be JSON, which a web page cannot send
// cross-origin without a CORS preflight this server never answers.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const store = require('./store');
const { buildEntries, filterEntries, totals } = require('./entries');
const { textReport, csvReport, htmlInvoice } = require('./report');
const { ledesExport } = require('./ledes');
const { eventFromHookPayload } = require('./hooks');

// sendgridApiKey is deliberately NOT exposed through the config API —
// it stays CLI/file-only so no local page can read it.
const CONFIG_KEYS = [
  'timekeeper', 'timekeeperId', 'timekeeperClass', 'firmName', 'firmId',
  'firmEmail', 'firmPhone', 'lawpayPageUrl',
  'rate', 'aiCostPerHour', 'currency', 'incrementHours', 'minimumHours',
  'idleCapMinutes', 'capturePrompts', 'defaultClient', 'defaultMatter',
];
const NUMERIC_KEYS = ['rate', 'aiCostPerHour', 'incrementHours', 'minimumHours', 'idleCapMinutes'];

function loadEntries(query) {
  const config = store.readConfig();
  const entries = filterEntries(buildEntries(store.readEvents(), config, store.readOverrides()), {
    from: query.get('from') || undefined,
    to: query.get('to') || undefined,
    client: query.get('client') || undefined,
    matter: query.get('matter') || undefined,
  });
  return { config, entries };
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json', extraHeaders = {}) {
  res.writeHead(status, { 'content-type': type + '; charset=utf-8', ...extraHeaders });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function isLoopback(remoteAddress) {
  const a = String(remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.') || a === '::ffff:127.0.0.1' || a.startsWith('::ffff:127.');
}

// Hosts the server will answer to. Loopback always; in LAN mode also the
// machine's own LAN addresses (the phone follows the printed IP URL). A DNS
// name that rebinds to us matches neither, so rebinding attacks get a 403.
function hostAllowed(host, lanMode) {
  const name = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '::1' || name.startsWith('127.')) return true;
  return !!lanMode && lanAddresses().includes(name);
}

// Refuse requests driven by another site. Modern browsers tag every request
// with Sec-Fetch-Site; anything but same-origin/none means a cross-site page
// is behind it. Older browsers send Origin on POSTs: loopback origins (and
// installed extensions, which are already trusted local code) are fine,
// everything else — including "null" — is refused.
function crossSiteDenied(headers) {
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = headers.origin;
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return false;
    return !['chrome-extension:', 'moz-extension:', 'edge-extension:', 'safari-web-extension:'].includes(u.protocol);
  } catch {
    return true; // unparseable Origin -> not one of ours
  }
}

function tokenEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Decide whether a request may proceed. Loopback is always allowed. LAN
// clients present the token as ?token= (first visit from the printed URL),
// an Authorization bearer, or the cookie set after the first visit.
// Returns { ok, setCookie?, redirect? }.
function authorize({ remoteAddress, url, headers }, token) {
  if (!token || isLoopback(remoteAddress)) return { ok: true };
  const query = url.searchParams.get('token');
  if (query && tokenEqual(query, token)) {
    // Move the token out of the address bar into an HttpOnly cookie.
    url.searchParams.delete('token');
    return {
      ok: true,
      setCookie: `mp_token=${token}; HttpOnly; SameSite=Lax; Path=/`,
      redirect: url.pathname + (url.searchParams.toString() ? '?' + url.searchParams : ''),
    };
  }
  const bearer = (headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer && tokenEqual(bearer, token)) return { ok: true };
  const cookie = /(?:^|;\s*)mp_token=([^;]+)/.exec(headers.cookie || '');
  if (cookie && tokenEqual(cookie[1], token)) return { ok: true };
  return { ok: false };
}

function createServer({ token, lanMode = false } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;

      // Host allowlist + cross-site rejection run for every request,
      // loopback included — the threat here is the attorney's own browser.
      if (!hostAllowed(req.headers.host, lanMode)) {
        return send(res, 403, { error: 'Refused: Host is not an address of this machine.' });
      }
      if (crossSiteDenied(req.headers)) {
        return send(res, 403, { error: 'Refused: cross-site request.' });
      }
      // Every POST must carry a JSON content type. A web page cannot send
      // one cross-origin without a CORS preflight, and this server never
      // answers preflights — so drive-by form/fetch POSTs die here.
      if (req.method === 'POST' &&
          !/^\s*application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
        return send(res, 415, { error: 'POST requires content-type: application/json' });
      }

      const auth = authorize({ remoteAddress: req.socket.remoteAddress, url, headers: req.headers }, token);
      if (!auth.ok) {
        return send(res, 401,
          '<title>Matterproof</title><p>Unauthorized. Open the exact link printed by <code>billable serve --lan</code> (it carries your access token).</p>',
          'text/html');
      }
      if (auth.redirect) {
        res.writeHead(302, { location: auth.redirect, 'set-cookie': auth.setCookie });
        return res.end();
      }

      if (route === 'GET /') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'), 'text/html');
      }

      if (route === 'GET /api/entries') {
        const { config, entries } = loadEntries(url.searchParams);
        return send(res, 200, {
          entries,
          totals: totals(entries),
          clients: [...new Set(entries.map((e) => e.client))].sort(),
          config: {
            rate: config.rate,
            currency: config.currency,
            aiCostPerHour: config.aiCostPerHour,
            firmName: config.firmName,
          },
        });
      }

      if (route === 'POST /api/override') {
        const { id, ...patch } = JSON.parse(await readBody(req));
        if (!id) return send(res, 400, { error: 'id required' });
        // The server enforces its own invariants (the dashboard validates
        // too, but this API is reachable from scripts and extensions):
        // hours bounded, booleans coerced, strings capped — a bad write
        // here silently poisons invoices, LEDES, and payment links.
        const allowed = {};
        if ('reviewed' in patch) allowed.reviewed = !!patch.reviewed;
        if ('writeOff' in patch) allowed.writeOff = !!patch.writeOff;
        if ('hours' in patch) {
          const hours = Number(patch.hours);
          if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
            return send(res, 400, { error: 'hours must be a finite number in [0, 24]' });
          }
          allowed.hours = hours;
        }
        for (const k of ['description', 'client', 'matter', 'code']) {
          if (k in patch) allowed[k] = String(patch[k]).slice(0, 1000);
        }
        return send(res, 200, { id, override: store.writeOverride(id, allowed) });
      }

      if (route === 'POST /api/log') {
        // Generic capture endpoint: accepts a Claude Code hook payload or a
        // pre-shaped manual/ledger event. Future browser extensions and
        // integrations post here.
        const payload = JSON.parse(await readBody(req));
        let event = null;
        if (payload.hook_event_name) {
          event = eventFromHookPayload(payload);
        } else if (payload.type === 'manual') {
          // Cap at 16 hours: nobody works longer in one manual entry, and
          // unbounded minutes would mint absurd invoice lines.
          const minutes = Number(payload.minutes);
          if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 960 || !payload.description) {
            return send(res, 400, { error: 'manual events need a description and minutes in (0, 960]' });
          }
          event = {
            ts: payload.ts || new Date().toISOString(),
            type: 'manual',
            minutes,
            description: String(payload.description).slice(0, 1000),
            client: payload.client ? String(payload.client).slice(0, 200) : undefined,
            matter: payload.matter ? String(payload.matter).slice(0, 200) : undefined,
            code: payload.code ? String(payload.code).slice(0, 20) : undefined,
            source: payload.source ? String(payload.source).slice(0, 40) : 'api',
          };
        }
        if (!event) return send(res, 400, { error: 'unrecognized event' });
        store.appendEvent(event);
        return send(res, 200, { ok: true });
      }

      if (route === 'GET /api/requests') {
        const { listRequests, outstanding } = require('./lawpay');
        const requests = listRequests(store.readEvents());
        return send(res, 200, { requests, outstandingCents: outstanding(requests) });
      }

      if (route === 'POST /api/lawpay/link') {
        const { buildPaymentRequest, markRequested } = require('./lawpay');
        const body = JSON.parse(await readBody(req));
        const config = store.readConfig();
        const q = new URLSearchParams();
        for (const k of ['from', 'to', 'client', 'matter']) if (body[k]) q.set(k, body[k]);
        const { entries } = loadEntries(q);
        let request;
        try {
          request = buildPaymentRequest(entries, config, {
            from: body.from,
            to: body.to,
            email: body.email,
            description: body.desc,
          });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        let emailed = false;
        if (body.send && !body.dryRun) {
          if (!body.email) return send(res, 400, { error: 'send requires an email address' });
          const { sendPaymentEmail } = require('./email');
          try {
            await sendPaymentEmail(config, {
              to: body.email,
              clientName: body.client || '',
              amountCents: request.amountCents,
              description: request.description,
              payUrl: request.url,
            });
            emailed = true;
          } catch (err) {
            return send(res, 502, { error: `Email failed: ${err.message}. Entries were NOT marked.` });
          }
        }
        if (!body.dryRun) markRequested(request);
        return send(res, 200, {
          url: request.url,
          reference: request.reference,
          amountCents: request.amountCents,
          description: request.description,
          included: request.included.length,
          skipped: request.skipped,
          emailed,
          dryRun: !!body.dryRun,
        });
      }

      if (route === 'POST /api/requests/paid') {
        const { markPaid } = require('./lawpay');
        const { reference } = JSON.parse(await readBody(req));
        try {
          const paid = markPaid(reference, store.readEvents());
          return send(res, 200, { ok: true, reference, amountCents: paid.amountCents });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }

      if (route === 'GET /api/config') {
        const config = store.readConfig();
        const out = {};
        for (const k of CONFIG_KEYS) out[k] = config[k];
        return send(res, 200, out);
      }

      if (route === 'POST /api/config') {
        const patch = JSON.parse(await readBody(req));
        const config = store.readConfig();
        for (const k of CONFIG_KEYS) {
          if (!(k in patch)) continue;
          if (NUMERIC_KEYS.includes(k)) {
            const n = Number(patch[k]);
            if (!Number.isFinite(n) || n < 0) {
              return send(res, 400, { error: `${k} must be a finite, non-negative number` });
            }
            config[k] = n;
          } else if (k === 'lawpayPageUrl') {
            // The payment page must stay https: anything weaker exposes the
            // client's card payment to interception (see issue #5).
            const v = String(patch[k]);
            if (v && !v.startsWith('https://')) {
              return send(res, 400, { error: 'lawpayPageUrl must be an https:// URL' });
            }
            config[k] = v;
          } else {
            config[k] = patch[k];
          }
        }
        store.writeConfig(config);
        return send(res, 200, { ok: true });
      }

      if (route === 'GET /export.csv') {
        const { config, entries } = loadEntries(url.searchParams);
        res.setHeader('content-disposition', 'attachment; filename="matterproof.csv"');
        return send(res, 200, csvReport(entries, config), 'text/csv');
      }

      if (route === 'GET /export.ledes') {
        const { config, entries } = loadEntries(url.searchParams);
        res.setHeader('content-disposition', 'attachment; filename="matterproof.ledes.txt"');
        return send(res, 200, ledesExport(entries, config, {
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
        }), 'text/plain');
      }

      if (route === 'GET /export.html') {
        const { config, entries } = loadEntries(url.searchParams);
        return send(res, 200, '<!doctype html><html><head><meta charset="utf-8">' +
          htmlInvoice(entries, config, {
            from: url.searchParams.get('from') || undefined,
            to: url.searchParams.get('to') || undefined,
          }) + '</html>', 'text/html');
      }

      if (route === 'GET /export.txt') {
        const { config, entries } = loadEntries(url.searchParams);
        return send(res, 200, textReport(entries, config, 'Matterproof Timesheet'), 'text/plain');
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
}

function serve({ port = 4321, host = '127.0.0.1', token } = {}) {
  const server = createServer({ token, lanMode: host !== '127.0.0.1' });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// Non-internal IPv4 addresses, for printing reachable LAN URLs.
function lanAddresses() {
  const os = require('os');
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

module.exports = { createServer, serve, authorize, isLoopback, hostAllowed, crossSiteDenied, lanAddresses };
