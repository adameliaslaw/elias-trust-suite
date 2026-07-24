// Password hashing — scrypt with a per-password random salt, verified in
// constant time. Lifted verbatim from books' auth so every app in the suite
// hashes and checks passwords one way.
//
// Stored form is `${saltHex}:${hashHex}`. scrypt is memory-hard, so a stolen
// hash is expensive to attack offline; the salt makes two identical passwords
// hash differently and defeats rainbow tables. Verification always runs the KDF
// and compares with `timingSafeEqual`, so a wrong password takes the same time
// as a right one and leaks nothing through timing.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Hash `password` into a salted, self-describing `salt:hash` string. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(password, salt, KEY_BYTES).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Constant-time check of `password` against a `salt:hash` string produced by
 * {@link hashPassword}. Returns false for any missing or malformed stored value
 * rather than throwing, so a corrupt record fails closed.
 */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, KEY_BYTES);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
