// Password auth: scrypt-hashed password stored in settings, in-memory session
// tokens delivered via an HttpOnly cookie. Sessions reset on server restart,
// expire server-side (idle + absolute caps), and are all invalidated when the
// password changes. Failed logins are throttled per client IP.
const crypto = require('crypto');

const sessions = new Map();       // token -> { createdAt, lastSeen }
const loginAttempts = new Map();  // client ip -> { fails, lockedUntil }

const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;      // sliding inactivity window
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // hard cap, matches the cookie Max-Age
const LOGIN_MAX_FAILS = 5;                            // failures before a lockout
const LOGIN_LOCK_MS = 15 * 60 * 1000;                 // lockout duration

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// A session binds a token to a principal. `username` names a principal in
// global.json (bookkeeper / read-only); null means the DEFAULT OWNER — the
// household-shared password, which is the implicit owner and keeps the
// pre-roles login working unchanged.
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { createdAt: now, lastSeen: now, username: username == null ? null : String(username) });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

// Drop every session — called when the password changes so a stolen cookie
// dies with the password it was minted under.
function clearSessions() {
  sessions.clear();
}

function sessionValid(token) {
  const s = token && sessions.get(token);
  if (!s) return false;
  const now = Date.now();
  if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_ABSOLUTE_MS) {
    sessions.delete(token);
    return false;
  }
  s.lastSeen = now; // slide the idle window on activity
  return true;
}

function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    // A malformed %-escape must not take the request down (same bug class as
    // the route-param decode): fall back to the raw value, which simply
    // won't match any session.
    try { out[key] = decodeURIComponent(pair.slice(idx + 1).trim()); }
    catch { out[key] = pair.slice(idx + 1).trim(); }
  }
  return out;
}

function isAuthenticated(req) {
  return sessionValid(parseCookies(req).qb_session);
}

// The principal descriptor for a valid session token, or undefined if the token
// is missing/expired. `{ username: null }` is the default owner (household
// password); `{ username: 'jane' }` is a named principal. The dispatcher pairs
// this with global.json to resolve the caller's role.
function sessionPrincipal(token) {
  if (!sessionValid(token)) return undefined;
  const s = sessions.get(token);
  return { username: s.username == null ? null : s.username };
}

// Explicit opt-out for private/trusted deployments. Read per-request so the
// setting takes effect without a restart.
function authDisabled() {
  return process.env.QUICKBUCKS_DISABLE_AUTH === '1';
}

function clientIp(req) {
  // The socket address, not X-Forwarded-For — a client can spoof that header
  // to dodge the throttle. Behind a reverse proxy all clients share the
  // proxy's address, so the lockout then applies to the proxy as a whole;
  // that still caps brute-force attempts, which is the point.
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Milliseconds remaining on the caller's lockout, or 0 if they may try.
function loginLockedMs(req) {
  const rec = loginAttempts.get(clientIp(req));
  if (rec && rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
  return 0;
}

function recordLoginFail(req) {
  const ip = clientIp(req);
  const rec = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.fails = 0;
  }
  loginAttempts.set(ip, rec);
}

function resetLoginFails(req) {
  loginAttempts.delete(clientIp(req));
}

// Test hook: wipe all session and rate-limit state.
function _reset() {
  sessions.clear();
  loginAttempts.clear();
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, clearSessions,
  parseCookies, isAuthenticated, sessionPrincipal, authDisabled,
  loginLockedMs, recordLoginFail, resetLoginFails,
  SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, LOGIN_MAX_FAILS, LOGIN_LOCK_MS,
  _reset, _sessions: sessions
};
