// Role model: per-principal identity + owner/bookkeeper/read-only enforcement
// in the dispatcher gate, surfaced through audit.actor (Phase 6 / #25).
//
// Boots the real server WITH auth on and a household password set (the default
// owner), then has the owner create a bookkeeper + a read-only principal and
// proves each role hits/is-denied the right routes, that named-principal login
// works, and that the audit actor names the principal who wrote.
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-roles-'));
process.env.QUICKBUCKS_NO_SEED = '1';
delete process.env.QUICKBUCKS_DISABLE_AUTH; // enforcement on

const { server } = require('../server');
const authLib = require('../lib/auth');

let BASE, passed = 0;
const check = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓', name); };

async function jreq(method, url, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}
const cookieOf = (sc) => (sc ? sc.split(';')[0] : '');

async function main() {
  await new Promise(r => server.listen(0, r));
  BASE = `http://localhost:${server.address().port}`;

  // -- setup: household owner password --
  let r = await jreq('POST', '/api/password', { body: { next: 'ownerpass' } });
  check('setup sets the household owner password', r.status === 200);
  const owner = cookieOf(r.setCookie);
  check('setup returns an owner session cookie', owner.startsWith('qb_session='));
  r = await jreq('GET', '/api/auth-status', { cookie: owner });
  check('auth-status reports the owner role', r.data.role === 'owner');

  // -- owner creates named principals --
  r = await jreq('GET', '/api/principals', { cookie: owner });
  check('owner can list principals (empty)', r.status === 200 && Array.isArray(r.data) && r.data.length === 0);
  r = await jreq('POST', '/api/principals', { cookie: owner, body: { username: 'book', name: 'Book Keeper', role: 'bookkeeper', password: 'bookpass' } });
  check('owner creates a bookkeeper principal', r.status === 201 && r.data.role === 'bookkeeper' && !('passwordHash' in r.data));
  r = await jreq('POST', '/api/principals', { cookie: owner, body: { username: 'view', role: 'read-only', password: 'viewpass' } });
  check('owner creates a read-only principal', r.status === 201 && r.data.role === 'read-only');
  r = await jreq('POST', '/api/principals', { cookie: owner, body: { username: 'bad', role: 'superuser', password: 'nope123' } });
  check('invalid role is rejected', r.status === 400);
  r = await jreq('POST', '/api/principals', { cookie: owner, body: { username: 'book', role: 'read-only', password: 'dup123' } });
  check('duplicate username is rejected', r.status === 400);
  r = await jreq('POST', '/api/principals', { cookie: owner, body: { username: 'shorty', role: 'read-only', password: 'x' } });
  check('short password is rejected', r.status === 400);

  // -- bookkeeper: day-to-day writes yes, owner-only no --
  r = await jreq('POST', '/api/login', { body: { username: 'book', password: 'bookpass' } });
  check('bookkeeper logs in with username+password', r.status === 200 && r.data.role === 'bookkeeper');
  const book = cookieOf(r.setCookie);
  r = await jreq('POST', '/api/customers', { cookie: book, body: { name: 'Client A' } });
  check('bookkeeper can create a customer (day-to-day write)', r.status === 201);
  r = await jreq('GET', '/api/customers', { cookie: book });
  check('bookkeeper can read customers', r.status === 200);
  r = await jreq('GET', '/api/principals', { cookie: book });
  check('bookkeeper cannot list principals (403)', r.status === 403 && r.data.role === 'bookkeeper');
  r = await jreq('POST', '/api/principals', { cookie: book, body: { username: 'z', role: 'read-only', password: 'zzz123' } });
  check('bookkeeper cannot create principals (403)', r.status === 403);
  r = await jreq('GET', '/api/backup', { cookie: book });
  check('bookkeeper cannot download the backup (403)', r.status === 403);

  // -- read-only: GETs only --
  r = await jreq('POST', '/api/login', { body: { username: 'view', password: 'viewpass' } });
  check('read-only logs in', r.status === 200 && r.data.role === 'read-only');
  const view = cookieOf(r.setCookie);
  r = await jreq('GET', '/api/customers', { cookie: view });
  check('read-only can read customers', r.status === 200);
  r = await jreq('GET', '/api/reports/pnl', { cookie: view });
  check('read-only can read reports', r.status === 200);
  r = await jreq('POST', '/api/customers', { cookie: view, body: { name: 'Nope' } });
  check('read-only cannot create a customer (403)', r.status === 403);
  r = await jreq('PUT', '/api/settings', { cookie: view, body: { companyName: 'Nope' } });
  check('read-only cannot change settings (403)', r.status === 403);
  r = await jreq('GET', '/api/principals', { cookie: view });
  check('read-only cannot list principals (owner-only GET, 403)', r.status === 403);
  r = await jreq('POST', '/api/logout', { cookie: view });
  check('read-only can still log out', r.status === 200);

  // -- bad credentials --
  r = await jreq('POST', '/api/login', { body: { username: 'book', password: 'wrong' } });
  check('wrong principal password is rejected', r.status === 401);
  r = await jreq('POST', '/api/login', { body: { username: 'ghost', password: 'whatever' } });
  check('unknown username is rejected', r.status === 401);
  authLib._reset(); // clear the login throttle before the happy path below

  // -- audit actor names the principal who wrote --
  r = await jreq('POST', '/api/login', { body: { username: 'book', password: 'bookpass' } });
  const book2 = cookieOf(r.setCookie);
  await jreq('POST', '/api/customers', { cookie: book2, body: { name: 'Client B' } });
  r = await jreq('POST', '/api/login', { body: { password: 'ownerpass' } }); // default owner
  const owner2 = cookieOf(r.setCookie);
  r = await jreq('GET', '/api/audit?limit=200', { cookie: owner2 });
  const actors = (r.data.entries || []).map(e => e.payload && e.payload.actor).filter(Boolean);
  check('audit actor surfaces the bookkeeper principal (book@...)', actors.some(a => String(a).startsWith('book@')));
  check('audit actor keeps local@ for the default owner', actors.some(a => String(a).startsWith('local@')));

  // -- default owner (household password, no username) keeps full access --
  r = await jreq('GET', '/api/principals', { cookie: owner2 });
  check('default owner (household password) has owner access', r.status === 200);

  // -- deleting a principal denies their live session on the next request --
  const list = (await jreq('GET', '/api/principals', { cookie: owner2 })).data;
  const viewP = list.find(p => p.username === 'view');
  r = await jreq('POST', '/api/login', { body: { username: 'view', password: 'viewpass' } });
  const view2 = cookieOf(r.setCookie);
  check('read-only session works before deletion', (await jreq('GET', '/api/customers', { cookie: view2 })).status === 200);
  r = await jreq('DELETE', '/api/principals/' + viewP.id, { cookie: owner2 });
  check('owner deletes the read-only principal', r.status === 200);
  r = await jreq('GET', '/api/customers', { cookie: view2 });
  check('a deleted principal\'s live session is denied (401)', r.status === 401);

  console.log(`\nAll ${passed} role checks passed.`);
  server.close();
}

main().catch(e => { console.error(e); process.exit(1); });
