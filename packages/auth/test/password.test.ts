import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('password', () => {
  it('verifies the correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const stored = hashPassword('s3cret');
    expect(verifyPassword('S3cret', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('salts: the same password hashes differently every time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('fails closed on missing or malformed stored values', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', undefined)).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'nosalt')).toBe(false);
    expect(verifyPassword('x', ':onlyhash')).toBe(false);
  });
});
