// The canonical household role model for the whole suite.
//
// The three roles began life in books' request dispatcher (Phase 6 / #25) and
// are lifted here unchanged so every app authorizes against ONE definition:
//
//   owner      — everything, including identity/role administration and any
//                route that dumps every principal's data (e.g. a full backup).
//   bookkeeper — all day-to-day work, including money writes, but NOT the
//                owner-only routes.
//   read-only  — reads only; every state-changing request is denied except the
//                few an app explicitly whitelists (e.g. logging out).
//
// The policy is deliberately transport-agnostic: it decides allow/deny from a
// (role, method, pathname) triple plus two app-supplied predicates. Which
// concrete paths are owner-only, and which writes a read-only principal may
// still make, are APP policy — books names `/api/principals*`, `/api/backup`,
// `/api/password` — so those stay with the app and are injected here. What is
// shared, and must never fork between apps, is the role SET and the shape of
// the decision.

export const ROLES = ['owner', 'bookkeeper', 'read-only'] as const;
export type Role = (typeof ROLES)[number];

/** True when `value` is exactly one of the three canonical roles. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export interface RolePolicy {
  /** App policy: is this path reachable ONLY by an owner? */
  isOwnerOnly(pathname: string): boolean;
  /**
   * App policy: may a read-only principal make this non-GET request? Defaults
   * to "no". books whitelists only `POST /api/logout` so a viewer can end
   * their own session.
   */
  isWriteAllowedForReadOnly?(method: string, pathname: string): boolean;
}

/**
 * The single authorization decision, reproducing books' original dispatcher
 * gate exactly:
 *   - an owner-only path is reachable by the owner alone;
 *   - a read-only principal may GET anything not owner-only, plus any write the
 *     app has whitelisted;
 *   - owner and bookkeeper may do everything that is not owner-only.
 * Method comparison is case-insensitive so `get`/`GET` behave identically.
 */
export function roleAllows(
  role: Role,
  method: string,
  pathname: string,
  policy: RolePolicy
): boolean {
  if (policy.isOwnerOnly(pathname)) return role === 'owner';
  if (role === 'read-only') {
    return (
      method.toUpperCase() === 'GET' ||
      (policy.isWriteAllowedForReadOnly?.(method, pathname) ?? false)
    );
  }
  return true; // owner + bookkeeper: everything that is not owner-only
}
