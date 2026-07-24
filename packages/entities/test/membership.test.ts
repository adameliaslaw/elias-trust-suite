import { describe, it, expect } from 'vitest';
import {
  CANONICAL_ROLES,
  FIRM_MEMBERSHIP_ROLES,
  isCanonicalRole,
  isFirmMembershipRole,
  normalizeMembershipRole,
  toMembershipRole,
  firmMembership,
  firmId,
  userId,
  clientId,
  type ClientId,
} from '../src/index.js';

describe('canonical vs firm-membership role vocabularies', () => {
  it('canonical roles mirror @elias/auth ROLES exactly', () => {
    // Kept in lock-step with packages/auth/src/roles.ts ROLES. If that set
    // ever changes, this literal must change with it (and vice versa).
    expect([...CANONICAL_ROLES]).toEqual(['owner', 'bookkeeper', 'read-only']);
  });

  it('firm-membership roles are iolta’s owner/admin/member vocabulary', () => {
    expect([...FIRM_MEMBERSHIP_ROLES]).toEqual(['owner', 'admin', 'member']);
  });

  it('guards are fail-closed', () => {
    expect(isCanonicalRole('bookkeeper')).toBe(true);
    expect(isCanonicalRole('admin')).toBe(false);
    expect(isCanonicalRole(null)).toBe(false);
    expect(isFirmMembershipRole('admin')).toBe(true);
    expect(isFirmMembershipRole('bookkeeper')).toBe(false);
    expect(isFirmMembershipRole(7)).toBe(false);
  });
});

describe('role reconciliation (the fork the suite must not keep)', () => {
  it('maps iolta membership roles onto the canonical set', () => {
    expect(normalizeMembershipRole('owner')).toBe('owner');
    expect(normalizeMembershipRole('admin')).toBe('bookkeeper');
    expect(normalizeMembershipRole('member')).toBe('read-only');
  });

  it('maps canonical roles back to the firm-membership vocabulary', () => {
    expect(toMembershipRole('owner')).toBe('owner');
    expect(toMembershipRole('bookkeeper')).toBe('admin');
    expect(toMembershipRole('read-only')).toBe('member');
  });

  it('the mapping is a bijection (round-trips both directions)', () => {
    for (const r of FIRM_MEMBERSHIP_ROLES) {
      expect(toMembershipRole(normalizeMembershipRole(r))).toBe(r);
    }
    for (const r of CANONICAL_ROLES) {
      expect(normalizeMembershipRole(toMembershipRole(r))).toBe(r);
    }
  });

  it('fails closed on an unknown role string', () => {
    expect(() => normalizeMembershipRole('superuser')).toThrow();
    expect(() => normalizeMembershipRole('')).toThrow();
    expect(() => toMembershipRole('admin')).toThrow(); // 'admin' is not canonical
  });
});

describe('firmMembership constructor', () => {
  it('binds a canonical firm + user + role', () => {
    const m = firmMembership(firmId('trust__abc'), userId('jane'), 'bookkeeper');
    expect(m).toEqual({
      firmId: 'firm_trust__abc',
      userId: 'usr_jane',
      role: 'bookkeeper',
    });
  });

  it('accepts a firm-membership role and normalizes it', () => {
    const m = firmMembership(firmId('f1'), userId('u1'), 'admin');
    expect(m.role).toBe('bookkeeper');
  });

  it('rejects ids of the wrong kind', () => {
    // @ts-expect-error — a client id is not a firm id
    expect(() => firmMembership(clientIdLike(), userId('u1'), 'owner')).toThrow();
  });

  it('rejects an unknown role', () => {
    expect(() => firmMembership(firmId('f1'), userId('u1'), 'wizard' as never)).toThrow();
  });
});

// A deliberately mis-kinded id: a real ClientId passed where a FirmId is wanted.
function clientIdLike(): ClientId {
  return clientId('x');
}
