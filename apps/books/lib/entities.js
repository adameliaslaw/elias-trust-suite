// Thin adapter: books' local ids → canonical @elias/entities ids.
//
// books identifies a company / customer / principal by an opaque `uid()`
// (base36 timestamp+random) or a login username. Those names are books-local —
// iolta and billable can't reference them. This adapter lifts each into the
// suite's canonical, prefixed id (Phase 7 / #26) so the same firm/client/user
// can be named identically across apps. It is a pure, read-only mapping: it
// does NOT change how books stores or keys anything; it only projects an
// additional canonical id onto what already exists.
//
// @elias/entities is ESM; books is CommonJS. require() works because Node ≥ 22.5
// supports require(esm) (same as books already does for @elias/auth / @elias/rules).
const entities = require('@elias/entities');

// A books company IS the suite's firm (the top-level tenant identity).
function firmIdFor(company) {
  return entities.firmId(company.id);
}

// A books customer IS a suite client.
function clientIdFor(customer) {
  return entities.clientId(customer.id);
}

// A named principal maps to a suite user by its principal id. The default owner
// (the shared household password, which has no principal record) gets the stable
// local id 'owner' so it too has one canonical user id.
function userIdFor(principal) {
  const local = principal && principal.id ? principal.id : 'owner';
  return entities.userId(local);
}

module.exports = { firmIdFor, clientIdFor, userIdFor, entities };
