// Firm membership + role reconciliation.
//
// The suite's role vocabulary has forked. books and @elias/auth speak the
// canonical household set — owner / bookkeeper / read-only (see
// packages/auth/src/roles.ts) — while iolta's trust-account memberships speak
// owner / admin / member (apps/iolta/src/model.ts, firestore.rules). A single
// firm identity can't span both apps while the words disagree, so this module
// pins the ONE canonical set and provides the bijection to iolta's vocabulary.
//
// The canonical roles are kept as string literals here rather than imported
// from @elias/auth on purpose: like @elias/audit and @elias/review, the shared
// packages stay decoupled (no inter-package build edge). The lock-step is a
// documented invariant, guarded by a test that pins the exact list.

import type { EntityId, FirmId, UserId } from './ids.js';
import { isEntityId } from './ids.js';

/**
 * The canonical household roles — identical to `ROLES` in @elias/auth. Keep in
 * lock-step with packages/auth/src/roles.ts.
 */
export const CANONICAL_ROLES = ['owner', 'bookkeeper', 'read-only'] as const;
export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

/** iolta's trust-account membership vocabulary. */
export const FIRM_MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type FirmMembershipRole = (typeof FIRM_MEMBERSHIP_ROLES)[number];

const FIRM_TO_CANONICAL: Readonly<Record<FirmMembershipRole, CanonicalRole>> = {
  owner: 'owner',
  admin: 'bookkeeper',
  member: 'read-only',
};

const CANONICAL_TO_FIRM: Readonly<Record<CanonicalRole, FirmMembershipRole>> = {
  owner: 'owner',
  bookkeeper: 'admin',
  'read-only': 'member',
};

/** True when `value` is exactly one of the canonical household roles. */
export function isCanonicalRole(value: unknown): value is CanonicalRole {
  return (
    typeof value === 'string' &&
    (CANONICAL_ROLES as readonly string[]).includes(value)
  );
}

/** True when `value` is exactly one of iolta's membership roles. */
export function isFirmMembershipRole(value: unknown): value is FirmMembershipRole {
  return (
    typeof value === 'string' &&
    (FIRM_MEMBERSHIP_ROLES as readonly string[]).includes(value)
  );
}

/** Map an iolta membership role onto the canonical set. Fails closed. */
export function normalizeMembershipRole(raw: unknown): CanonicalRole {
  if (!isFirmMembershipRole(raw)) {
    throw new Error(`Unknown firm-membership role: ${JSON.stringify(raw)}`);
  }
  return FIRM_TO_CANONICAL[raw];
}

/** Map a canonical role back to iolta's membership vocabulary. Fails closed. */
export function toMembershipRole(role: unknown): FirmMembershipRole {
  if (!isCanonicalRole(role)) {
    throw new Error(`Unknown canonical role: ${JSON.stringify(role)}`);
  }
  return CANONICAL_TO_FIRM[role];
}

/** A user's canonical role within a firm. */
export interface FirmMembership {
  firmId: FirmId;
  userId: UserId;
  role: CanonicalRole;
}

/**
 * Build a firm membership from canonical firm + user ids and a role given in
 * EITHER vocabulary (a canonical role passes through; an iolta membership role
 * is normalized). Fails closed on a mis-kinded id or an unknown role.
 */
export function firmMembership(
  firm: FirmId,
  user: UserId,
  role: CanonicalRole | FirmMembershipRole,
): FirmMembership {
  if (!isEntityId(firm, 'firm')) {
    throw new Error(`Not a firm id: ${JSON.stringify(firm as EntityId)}`);
  }
  if (!isEntityId(user, 'user')) {
    throw new Error(`Not a user id: ${JSON.stringify(user as EntityId)}`);
  }
  const canonical = isCanonicalRole(role) ? role : normalizeMembershipRole(role);
  return { firmId: firm, userId: user, role: canonical };
}
