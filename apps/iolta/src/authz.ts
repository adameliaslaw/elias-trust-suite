/**
 * Canonical authorization for iolta (Phase 7 · #26).
 *
 * iolta authenticates users through Firebase (server.ts verifies the ID token;
 * Firebase stays the identity provider). What had FORKED from the rest of the
 * suite was the AUTHORIZATION vocabulary: iolta modelled firm membership as
 * `owner | admin | member` (model.ts) while books and `@elias/auth` speak the
 * canonical `owner | bookkeeper | read-only`. This module reconciles the two so
 * iolta authorizes against the SAME definition every other app does:
 *
 *   - membership role → canonical role via `@elias/entities` (admin→bookkeeper,
 *     member→read-only, owner→owner), and
 *   - allow/deny via `@elias/auth`'s transport-agnostic `roleAllows` with an
 *     iolta-supplied policy (which actions are owner-only, what a read-only
 *     principal may still do).
 *
 * BROWSER-SAFE: it imports only the crypto-free subpaths `@elias/auth/roles` and
 * `@elias/entities/membership` — never the package barrels, which pull in
 * `node:crypto` (password/sessions/review, id derivation) that a Vite bundle
 * can't load. So App.tsx can gate UI on it directly.
 *
 * Enforcement today is single-principal: the authenticated user owns their trust
 * account, so their role is `owner` and every action is allowed — no behavior
 * change. The decision now ROUTES through the shared policy, so when firm
 * memberships go live (Phase 8) a bookkeeper/read-only member is constrained
 * automatically, with no second authorization model to keep in sync.
 */
import { roleAllows, isRole, ROLES } from '@elias/auth/roles';
import type { Role, RolePolicy } from '@elias/auth/roles';
import type { MembershipRole } from './model';

export type { Role } from '@elias/auth/roles';
export { ROLES, isRole } from '@elias/auth/roles';

/** The authorization-relevant things a principal can attempt in iolta. */
export type IoltaAction =
  | 'read' // view ledgers, reconciliations, packets
  | 'mutateLedger' // add / edit / delete a trust transaction
  | 'finalize' // attest + finalize (seal) a reconciliation month
  | 'reopen' // reopen a finalized, locked record for amendment
  | 'manageMembers'; // firm membership administration

/**
 * Each action mapped to the transport-agnostic (method, path) pair the shared
 * `roleAllows` decides on. Reads are GETs; every mutation is a non-GET. The two
 * sensitive administrative actions live under owner-only paths.
 */
const ACTION_ROUTES: Record<IoltaAction, { method: string; path: string }> = {
  read: { method: 'GET', path: '/reconciliation' },
  mutateLedger: { method: 'POST', path: '/trust/transactions' },
  finalize: { method: 'POST', path: '/reconciliation/finalize' },
  reopen: { method: 'POST', path: '/reconciliation/reopen' },
  manageMembers: { method: 'POST', path: '/firm/members' },
};

/** Reopening a sealed record and managing members are owner-only (like books' sensitive routes). */
const OWNER_ONLY_PATHS = new Set<string>([
  ACTION_ROUTES.reopen.path,
  ACTION_ROUTES.manageMembers.path,
]);

/**
 * iolta's app policy for the shared decision: reopen/manage-members are
 * owner-only, and a read-only principal makes NO writes (no whitelist — unlike
 * books' logout, iolta has no read-only-safe mutation).
 */
export const IOLTA_ROLE_POLICY: RolePolicy = {
  isOwnerOnly: (pathname: string): boolean => OWNER_ONLY_PATHS.has(pathname),
};

/**
 * Mirrors `@elias/entities.normalizeMembershipRole` (admin→bookkeeper,
 * member→read-only, owner→owner). Reimplemented here rather than imported
 * because `@elias/entities`' membership module transitively pulls in
 * `node:crypto` (id derivation), which a Vite browser bundle can't load.
 * `test/authz.test.ts` PINS this map to the real
 * `@elias/entities.normalizeMembershipRole`, so the two can never drift — the
 * decoupled-package pattern the suite uses (signoff.ts ↔ @elias/auth).
 */
const MEMBERSHIP_TO_CANONICAL: Record<MembershipRole, Role> = {
  owner: 'owner',
  admin: 'bookkeeper',
  member: 'read-only',
};

/** The canonical role for an iolta firm-membership role. */
export function roleForMembership(role: MembershipRole): Role {
  return MEMBERSHIP_TO_CANONICAL[role];
}

/** Whether a canonical role may perform an iolta action (the shared decision). */
export function can(role: Role, action: IoltaAction): boolean {
  const route = ACTION_ROUTES[action];
  return roleAllows(role, route.method, route.path, IOLTA_ROLE_POLICY);
}

/** Whether a firm-membership role may perform an action (bridges then decides). */
export function memberCan(role: MembershipRole, action: IoltaAction): boolean {
  return can(roleForMembership(role), action);
}

/** Thrown when a principal attempts an action their role forbids. */
export class ForbiddenError extends Error {
  readonly role: Role;
  readonly action: IoltaAction;
  constructor(role: Role, action: IoltaAction) {
    super(`Your role (${role}) is not permitted to ${action} in this trust account.`);
    this.name = 'ForbiddenError';
    this.role = role;
    this.action = action;
  }
}

/** Enforce {@link can}; throws {@link ForbiddenError} when denied. */
export function assertCan(role: Role, action: IoltaAction): void {
  if (!can(role, action)) throw new ForbiddenError(role, action);
}

/**
 * The current principal's canonical role. THE SINGLE SEAM for making firm
 * memberships live: until they are loaded (Phase 8), the authenticated user
 * owns their own trust account, so they are the `owner` and every action is
 * allowed. When memberships go live, resolve this uid's membership role and
 * return `roleForMembership(membership.role)` here — every `can`/`assertCan`
 * call site then enforces the real role with no further changes.
 */
export function currentRoleFor(_uid: string | null | undefined): Role {
  return 'owner';
}
