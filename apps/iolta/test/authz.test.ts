// Canonical authorization for iolta (Phase 7 · #26).
//
// iolta's firm-membership roles (owner/admin/member) now reconcile to the
// canonical @elias/auth roles (owner/bookkeeper/read-only) and every access
// decision routes through the shared @elias/auth.roleAllows. These tests pin:
//   1. the membership→canonical bridge stays lock-step with @elias/entities
//      (imported here from the barrel — Node, so node:crypto is fine — while
//      authz.ts uses the crypto-free @elias/entities/membership subpath);
//   2. the iolta role policy: read-only reads only; bookkeeper does day-to-day
//      work incl. finalize but NOT reopen/manage-members; owner does everything;
//   3. assertCan enforces + throws ForbiddenError.
//
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import {
  can,
  memberCan,
  roleForMembership,
  assertCan,
  ForbiddenError,
  IOLTA_ROLE_POLICY,
  isRole,
  ROLES,
  type IoltaAction,
} from '../src/authz';
import type { Role } from '../src/authz';
import type { MembershipRole } from '../src/model';
// The REAL shared bridge (barrel import; node:crypto is fine under Node/tsx) —
// the lock-step reference for roleForMembership.
import { normalizeMembershipRole } from '@elias/entities';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const ALL_ACTIONS: IoltaAction[] = ['read', 'mutateLedger', 'finalize', 'reopen', 'manageMembers'];
const MEMBERSHIP_ROLES: MembershipRole[] = ['owner', 'admin', 'member'];

// ===========================================================================
// 1. The membership → canonical bridge (lock-step with @elias/entities).
// ===========================================================================

test('#26 authz: roleForMembership matches @elias/entities.normalizeMembershipRole', () => {
  for (const m of MEMBERSHIP_ROLES) {
    assert.equal(roleForMembership(m), normalizeMembershipRole(m));
    assert.ok(isRole(roleForMembership(m)), `${m} maps to a canonical role`);
  }
  // The documented mapping, pinned explicitly so a drift is loud.
  assert.equal(roleForMembership('owner'), 'owner');
  assert.equal(roleForMembership('admin'), 'bookkeeper');
  assert.equal(roleForMembership('member'), 'read-only');
});

// ===========================================================================
// 2. The iolta role policy (the shared roleAllows decision).
// ===========================================================================

test('#26 authz: owner may do everything', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(can('owner', action), true, `owner can ${action}`);
  }
});

test('#26 authz: bookkeeper does day-to-day work but not owner-only actions', () => {
  assert.equal(can('bookkeeper', 'read'), true);
  assert.equal(can('bookkeeper', 'mutateLedger'), true);
  assert.equal(can('bookkeeper', 'finalize'), true);
  assert.equal(can('bookkeeper', 'reopen'), false, 'reopen (unseal a locked record) is owner-only');
  assert.equal(can('bookkeeper', 'manageMembers'), false, 'membership admin is owner-only');
});

test('#26 authz: read-only reads only — every mutation is denied', () => {
  assert.equal(can('read-only', 'read'), true);
  for (const action of ALL_ACTIONS.filter((a) => a !== 'read')) {
    assert.equal(can('read-only', action), false, `read-only cannot ${action}`);
  }
});

test('#26 authz: memberCan composes the bridge with the decision', () => {
  // member → read-only: read only.
  assert.equal(memberCan('member', 'read'), true);
  assert.equal(memberCan('member', 'mutateLedger'), false);
  // admin → bookkeeper: mutate + finalize, but not reopen.
  assert.equal(memberCan('admin', 'finalize'), true);
  assert.equal(memberCan('admin', 'reopen'), false);
  // owner → owner: everything.
  assert.equal(memberCan('owner', 'reopen'), true);
});

test('#26 authz: the policy marks exactly the two sensitive actions owner-only', () => {
  assert.equal(IOLTA_ROLE_POLICY.isOwnerOnly('/reconciliation/reopen'), true);
  assert.equal(IOLTA_ROLE_POLICY.isOwnerOnly('/firm/members'), true);
  assert.equal(IOLTA_ROLE_POLICY.isOwnerOnly('/reconciliation'), false);
  // Every canonical role is covered by the ROLES set (no stray role can slip in).
  assert.deepEqual([...ROLES].sort(), ['bookkeeper', 'owner', 'read-only']);
});

// ===========================================================================
// 3. assertCan enforcement.
// ===========================================================================

test('#26 authz: assertCan throws ForbiddenError on a denied action', () => {
  assert.doesNotThrow(() => assertCan('owner', 'reopen'));
  assert.throws(() => assertCan('read-only', 'finalize'), (err: unknown) => {
    assert.ok(err instanceof ForbiddenError);
    assert.equal((err as ForbiddenError).role, 'read-only');
    assert.equal((err as ForbiddenError).action, 'finalize');
    return true;
  });
});

console.log(`\n${passed} authz tests passed`);
