import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  outputDigest,
  reviewSignoff,
  verifySignoff,
  signoffAuditEvent,
} from '../src/review.js';
import type { ComplianceOutput } from '../src/review.js';

const invoice: ComplianceOutput = {
  kind: 'invoice',
  id: 'INV-1001',
  content: { total: '1500.00', lines: [{ desc: 'work', amount: '1500.00' }] },
};

describe('review / sign-off', () => {
  it('canonicalize is stable across key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    // array order IS meaningful and preserved
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('records an approval bound to the exact content', () => {
    const s = reviewSignoff(invoice, { attorney: 'adam', decision: 'approved', signedAt: '2026-07-24T00:00:00Z' });
    expect(s.outputKind).toBe('invoice');
    expect(s.outputId).toBe('INV-1001');
    expect(s.decision).toBe('approved');
    expect(s.attorney).toBe('adam');
    expect(s.signedAt).toBe('2026-07-24T00:00:00Z');
    expect(s.contentHash).toBe(outputDigest(invoice));
    expect(s.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies against unchanged content and fails once it changes', () => {
    const s = reviewSignoff(invoice, { attorney: 'adam', decision: 'approved' });
    expect(verifySignoff(s, invoice)).toBe(true);

    const mutated: ComplianceOutput = {
      ...invoice,
      content: { total: '9999.00', lines: [{ desc: 'work', amount: '9999.00' }] },
    };
    expect(verifySignoff(s, mutated)).toBe(false); // stale approval cannot cover edited numbers
  });

  it('fails verification when kind or id no longer match', () => {
    const s = reviewSignoff(invoice, { attorney: 'adam', decision: 'approved' });
    expect(verifySignoff(s, { ...invoice, id: 'INV-2002' })).toBe(false);
    expect(verifySignoff(s, { ...invoice, kind: 'estimate' })).toBe(false);
  });

  it('requires an attorney and requires a note on rejection', () => {
    expect(() => reviewSignoff(invoice, { attorney: '', decision: 'approved' })).toThrow(/attorney/i);
    expect(() => reviewSignoff(invoice, { attorney: 'adam', decision: 'rejected' })).toThrow(/note/i);
    // rejection with a note is fine
    const r = reviewSignoff(invoice, { attorney: 'adam', decision: 'rejected', note: 'math is off' });
    expect(r.decision).toBe('rejected');
    expect(r.note).toBe('math is off');
  });

  it('omits note when none is given (no undefined leak)', () => {
    const s = reviewSignoff(invoice, { attorney: 'adam', decision: 'approved' });
    expect('note' in s).toBe(false);
  });

  it('renders a canonical audit event naming the signer', () => {
    const s = reviewSignoff(invoice, { attorney: 'adam', decision: 'approved', signedAt: '2026-07-24T00:00:00Z' });
    const ev = signoffAuditEvent(s);
    expect(ev.type).toBe('compliance.signoff');
    expect(ev.payload.actor).toBe('adam');
    expect(ev.payload.outputId).toBe('INV-1001');
    expect(ev.payload.contentHash).toBe(s.contentHash);
    expect('note' in ev.payload).toBe(false);
  });
});
