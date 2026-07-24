// Books' HTTP auth adapter over the shared @elias/auth identity core.
//
// The reusable primitives — scrypt password hashing, the server-side session
// store (sliding idle + absolute cap, invalidate-all), and the login throttle —
// now live in @elias/auth (Phase 7 / #26), lifted out of this file so every app
// in the suite shares ONE definition. What stays here is the HTTP glue those
// primitives are deliberately free of: pulling the token from the request
// cookie, deriving the throttle key from the socket address, and the
// per-deployment auth-disabled env flag. The exported surface is unchanged, so
// server.js, the route groups, and the tests are untouched.
//
// Sessions bind a token to a principal. `username` names a principal in the
// household record (bookkeeper / read-only); null means the DEFAULT OWNER — the
// household-shared password, the implicit owner that keeps the pre-roles login
// working unchanged.
const { hashPassword, verifyPassword, SessionStore, LoginThrottle, parseCookieHeader } = require('@elias/auth');

const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;      // sliding inactivity window
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // hard cap, matches the cookie Max-Age
const LOGIN_MAX_FAILS = 5;                            // failures before a lockout
const LOGIN_LOCK_MS = 15 * 60 * 1000;                 // lockout duration

const store = new SessionStore({ idleMs: SESSION_IDLE_MS, absoluteMs: SESSION_ABSOLUTE_MS });
const throttle = new LoginThrottle({ maxFails: LOGIN_MAX_FAILS, lockMs: LOGIN_LOCK_MS });

// `username` names a principal (bookkeeper / read-only); null is the default
// owner (household-shared password), preserving the pre-roles login.
function createSession(username) {
  return store.create(username == null ? null : username);
}

function destroySession(token) {
  store.destroy(token);
}

// Drop every session — called when the password changes so a stolen cookie
// dies with the password it was minted under.
function clearSessions() {
  store.clear();
}

function parseCookies(req) {
  return parseCookieHeader(req.headers && req.headers.cookie);
}

function isAuthenticated(req) {
  return store.validate(parseCookies(req).qb_session);
}

// The principal descriptor for a valid session token, or undefined if the token
// is missing/expired. `{ username: null }` is the default owner (household
// password); `{ username: 'jane' }` is a named principal. The dispatcher pairs
// this with the household record to resolve the caller's role.
function sessionPrincipal(token) {
  return store.principal(token);
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
  return throttle.lockedMs(clientIp(req));
}

function recordLoginFail(req) {
  throttle.recordFail(clientIp(req));
}

function resetLoginFails(req) {
  throttle.reset(clientIp(req));
}

// Test hook: wipe all session and rate-limit state.
function _reset() {
  store.clear();
  throttle.clear();
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, clearSessions,
  parseCookies, isAuthenticated, sessionPrincipal, authDisabled,
  loginLockedMs, recordLoginFail, resetLoginFails,
  SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, LOGIN_MAX_FAILS, LOGIN_LOCK_MS,
  _reset, _sessions: store.sessions
};
