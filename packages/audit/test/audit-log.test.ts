import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditIntegrityError,
  AuditLog,
  FsJsonlStorage,
  GENESIS_HASH,
  InMemoryStorage,
  stableStringify,
} from '../src/index.js';
import type { PayrollPaymentPayload, ReconciliationCompletedPayload } from '../src/index.js';

const reconPayload: ReconciliationCompletedPayload = {
  reconciliationId: 'recon-2025-01',
  accountId: 'iolta-001',
  periodStart: '2025-01-01',
  periodEnd: '2025-01-31',
  bookBalanceCents: '1250000',
  bankBalanceCents: '1250000',
  differenceCents: '0',
  performedBy: 'adam@eliaslaw.example',
};

const payrollPayload: PayrollPaymentPayload = {
  paymentId: 'pay-0001',
  employeeId: 'emp-42',
  amountCents: '315000',
  payPeriod: '2025-01',
  method: 'ach',
  initiatedBy: 'payroll-service',
  idempotencyKey: 'pay-0001:2025-01',
};

function fixedClock(start = Date.UTC(2025, 0, 31, 12, 0, 0)): () => Date {
  let tick = 0;
  return () => new Date(start + tick++ * 1000);
}

describe('append + chain structure', () => {
  it('seals entries with seq, timestamps, and hash linkage back to GENESIS', async () => {
    const log = await AuditLog.open(new InMemoryStorage(), { clock: fixedClock() });
    const e0 = await log.append('reconciliation.completed', reconPayload);
    const e1 = await log.append('payroll.payment', payrollPayload);
    const e2 = await log.append('invoice.sent', {
      invoiceId: 'inv-9',
      clientId: 'client-7',
      amountCents: '45000',
      sentBy: 'adam@eliaslaw.example',
      sentTo: 'client@example.com',
    });
    await log.append('auth.login_failed', { principal: 'attacker', reason: 'bad_password', ip: '203.0.113.9' });

    expect(e0.seq).toBe(0);
    expect(e0.prevHash).toBe(GENESIS_HASH);
    expect(e1.prevHash).toBe(e0.hash);
    expect(e2.prevHash).toBe(e1.hash);
    expect(new Set([e0.hash, e1.hash, e2.hash]).size).toBe(3);
    expect(e0.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(log.length).toBe(4);
  });

  it('keeps entries in strict append order (ordering)', async () => {
    const log = await AuditLog.open(new InMemoryStorage(), { clock: fixedClock() });
    for (let i = 0; i < 5; i += 1) {
      await log.append('auth.login_failed', { principal: `user-${i}`, reason: 'bad_password' });
    }
    const entries = log.entries();
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // injected clock ticks 1s per append: timestamps are non-decreasing in seq order
    for (let i = 1; i < entries.length; i += 1) {
      const prev = entries[i - 1];
      const cur = entries[i];
      expect(prev && cur && prev.timestamp <= cur.timestamp).toBe(true);
    }
    // payload order matches append order
    expect(entries.map((e) => (e.payload as { principal: string }).principal)).toEqual([
      'user-0',
      'user-1',
      'user-2',
      'user-3',
      'user-4',
    ]);
  });
});

describe('verify()', () => {
  let storage: InMemoryStorage;
  let log: AuditLog;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    log = await AuditLog.open(storage, { clock: fixedClock() });
    await log.append('reconciliation.completed', reconPayload);
    await log.append('payroll.payment', payrollPayload);
    await log.append('auth.login_failed', { principal: 'mallory', reason: 'locked' });
  });

  it('passes on an untouched log', async () => {
    const result = await log.verify();
    expect(result).toEqual({ ok: true, entries: 3 });
  });

  it('detects payload tampering and names the altered entry', async () => {
    const altered = JSON.parse(storage.lineAt(1)) as { payload: { amountCents: string } };
    altered.payload.amountCents = '315001'; // one-cent "adjustment"
    storage.replaceLine(1, stableStringify(altered));

    const result = await log.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.atSeq).toBe(1);
      expect(result.error).toContain('hash mismatch');
    }
  });

  it('detects a 1-cent difference even when only the cents string changes', async () => {
    // Regression shape for the reconciliation-tolerance bug class:
    // flipping differenceCents "0" -> "1" must break the chain, not slip through.
    const altered = JSON.parse(storage.lineAt(0)) as { payload: { differenceCents: string } };
    altered.payload.differenceCents = '1';
    storage.replaceLine(0, stableStringify(altered));
    expect((await log.verify()).ok).toBe(false);
  });

  it('detects deletion of a middle entry', async () => {
    storage.removeLine(1);
    const result = await log.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('seq');
  });

  it('detects reordering of two entries', async () => {
    const a = storage.lineAt(0);
    const b = storage.lineAt(1);
    storage.replaceLine(0, b);
    storage.replaceLine(1, a);
    expect((await log.verify()).ok).toBe(false);
  });

  it('detects a forged trailing entry with a bad prevHash', async () => {
    await storage.append(
      stableStringify({
        seq: 3,
        timestamp: new Date().toISOString(),
        type: 'payroll.payment',
        payload: payrollPayload,
        prevHash: 'forged',
        hash: 'forged',
      }),
    );
    expect((await log.verify()).ok).toBe(false);
  });

  it('detects corrupt JSON lines', async () => {
    storage.replaceLine(2, '{not json');
    const result = await log.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid JSON');
  });

  it('open() refuses a tampered log by default (fail-fast)', async () => {
    const altered = JSON.parse(storage.lineAt(0)) as { payload: { performedBy: string } };
    altered.payload.performedBy = 'mallory';
    storage.replaceLine(0, stableStringify(altered));
    await expect(AuditLog.open(storage)).rejects.toThrow(AuditIntegrityError);
  });
});

describe('FsJsonlStorage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elias-audit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists JSONL and reopens with a passing verify', async () => {
    const file = join(dir, 'nested', 'audit.jsonl');
    const log = await AuditLog.open(new FsJsonlStorage(file), { clock: fixedClock() });
    await log.append('reconciliation.completed', reconPayload);
    await log.append('payroll.payment', payrollPayload);

    const raw = await readFile(file, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
    for (const line of raw.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const reopened = await AuditLog.open(new FsJsonlStorage(file));
    expect(reopened.length).toBe(2);
    expect((await reopened.verify()).ok).toBe(true);
    // chain survives the restart: appending after reopen continues the linkage
    const e = await reopened.append('invoice.sent', {
      invoiceId: 'inv-10',
      clientId: 'client-7',
      amountCents: '100',
      sentBy: 'system',
      sentTo: 'c@example.com',
    });
    expect(e.seq).toBe(2);
    expect((await reopened.verify()).ok).toBe(true);
  });

  it('detects out-of-band file tampering', async () => {
    const file = join(dir, 'audit.jsonl');
    const log = await AuditLog.open(new FsJsonlStorage(file), { clock: fixedClock() });
    await log.append('payroll.payment', payrollPayload);
    await log.append('payroll.payment', { ...payrollPayload, paymentId: 'pay-0002', idempotencyKey: 'k2' });

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    const first = JSON.parse(lines[0] as string) as { payload: { amountCents: string } };
    first.payload.amountCents = '99999999';
    lines[0] = stableStringify(first);
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    await expect(AuditLog.open(new FsJsonlStorage(file))).rejects.toThrow(AuditIntegrityError);
  });
});
