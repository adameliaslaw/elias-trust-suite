import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sha256.js';

describe('sha256Hex (pure TS)', () => {
  it('matches published known-answer vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // 448-bit (56-byte) message: exercises the two-block padding boundary.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('handles block-boundary lengths and UTF-8', () => {
    expect(sha256Hex('a'.repeat(55))).toBe(createHash('sha256').update('a'.repeat(55)).digest('hex'));
    expect(sha256Hex('a'.repeat(56))).toBe(createHash('sha256').update('a'.repeat(56)).digest('hex'));
    expect(sha256Hex('a'.repeat(64))).toBe(createHash('sha256').update('a'.repeat(64)).digest('hex'));
    expect(sha256Hex('a'.repeat(1000))).toBe(createHash('sha256').update('a'.repeat(1000)).digest('hex'));
    expect(sha256Hex('cents:123456 "üñï" ✓')).toBe(
      createHash('sha256').update('cents:123456 "üñï" ✓').digest('hex'),
    );
  });

  it('cross-checks pseudo-random inputs against node:crypto', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let i = 0; i < 50; i += 1) {
      const len = rand() % 300;
      const s = Array.from({ length: len }, () => String.fromCharCode(32 + (rand() % 95))).join('');
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
});
