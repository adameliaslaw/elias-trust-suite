// @elias/auth — the suite's shared identity core. One definition of how the
// apps hash passwords, keep sessions, throttle logins, model household roles,
// and record an attorney's audited sign-off on a compliance output. Lifted from
// books (Phase 6 / #25), where the per-principal identity + 3-role model first
// landed, so every app authorizes against ONE source of truth (Phase 7 / #26).

export { hashPassword, verifyPassword } from './password.js';

export { SessionStore } from './sessions.js';
export type {
  SessionRecord,
  PrincipalRef,
  SessionStoreOptions,
} from './sessions.js';

export { LoginThrottle } from './throttle.js';
export type { LoginThrottleOptions } from './throttle.js';

export { parseCookieHeader } from './cookies.js';

export { ROLES, isRole, roleAllows } from './roles.js';
export type { Role, RolePolicy } from './roles.js';

export {
  canonicalize,
  outputDigest,
  reviewSignoff,
  verifySignoff,
  signoffAuditEvent,
} from './review.js';
export type {
  SignoffDecision,
  ComplianceOutput,
  Signoff,
  ReviewInput,
} from './review.js';
