import { describe, it, expect } from 'vitest';
import { ROLES, isRole, roleAllows } from '../src/roles.js';
import type { RolePolicy } from '../src/roles.js';

// Books' concrete policy, reproduced here to prove the shared decision matches
// the dispatcher gate it was lifted from.
const policy: RolePolicy = {
  isOwnerOnly: (p) =>
    p === '/api/backup' ||
    p === '/api/password' ||
    p === '/api/principals' ||
    p.startsWith('/api/principals/'),
  isWriteAllowedForReadOnly: (_m, p) => p === '/api/logout',
};

describe('roles', () => {
  it('exposes exactly the three canonical roles', () => {
    expect(ROLES).toEqual(['owner', 'bookkeeper', 'read-only']);
  });

  it('isRole guards the role set', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('bookkeeper')).toBe(true);
    expect(isRole('read-only')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole(null)).toBe(false);
  });

  it('owner may do everything, including owner-only routes', () => {
    expect(roleAllows('owner', 'GET', '/api/customers', policy)).toBe(true);
    expect(roleAllows('owner', 'POST', '/api/principals', policy)).toBe(true);
    expect(roleAllows('owner', 'GET', '/api/backup', policy)).toBe(true);
  });

  it('bookkeeper may do day-to-day writes but not owner-only routes', () => {
    expect(roleAllows('bookkeeper', 'POST', '/api/customers', policy)).toBe(true);
    expect(roleAllows('bookkeeper', 'GET', '/api/principals', policy)).toBe(false);
    expect(roleAllows('bookkeeper', 'POST', '/api/principals', policy)).toBe(false);
    expect(roleAllows('bookkeeper', 'GET', '/api/backup', policy)).toBe(false);
  });

  it('read-only may GET non-owner routes and log out, nothing else', () => {
    expect(roleAllows('read-only', 'GET', '/api/customers', policy)).toBe(true);
    expect(roleAllows('read-only', 'get', '/api/customers', policy)).toBe(true); // case-insensitive
    expect(roleAllows('read-only', 'POST', '/api/logout', policy)).toBe(true);
    expect(roleAllows('read-only', 'POST', '/api/customers', policy)).toBe(false);
    expect(roleAllows('read-only', 'PUT', '/api/settings', policy)).toBe(false);
    expect(roleAllows('read-only', 'GET', '/api/principals', policy)).toBe(false); // owner-only GET
  });

  it('read-only writes are denied when no whitelist is supplied', () => {
    const bare: RolePolicy = { isOwnerOnly: () => false };
    expect(roleAllows('read-only', 'POST', '/api/logout', bare)).toBe(false);
    expect(roleAllows('read-only', 'GET', '/api/logout', bare)).toBe(true);
  });
});
