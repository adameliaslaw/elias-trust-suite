// Tamper-evident audit chain regression tests for iolta (@elias/audit wiring).
// Pure logic only (src/audit-chain.ts has no Firebase imports): chain-format
// equivalence with @elias/audit, tamper detection, and CAS serialization of
// concurrent writers (the multi-tab/multi-device case).
import assert from 'node:assert/strict';
import { AuditLog, InMemoryStorage, GENESIS_HASH } from '@elias/audit/core';
import { buildNextEntry, verifyEntryDocs, verifyChainState, casAppend } from '../src/audit-chain';
import type { ChainHead, HeadCas, SealedEntry } from '../src/audit-chain';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const reconPayload = {
  reconciliationId: 'u1:2026-01',
  accountId: 'iolta-trust',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  bookBalanceCents: '1250000',
  bankBalanceCents: '1250000',
  differenceCents: '0',
  performedBy: 'adam@example.com',
};

async function main() {
  await test('buildNextEntry seals the same bytes @elias/audit would', async () => {
    // Seal three events with AuditLog (the reference implementation)...
    const log = await AuditLog.open(new InMemoryStorage());
    const a = await log.append('reconciliation.completed', reconPayload, { timestamp: '2026-02-01T00:00:00.000Z' });
    const b = await log.append('trust.transaction_added', {
      transactionId: 't1', clientId: 'c1', amountCents: '50000', txType: 'receipt',
      month: '2026-01', source: 'manual', actor: 'adam@example.com',
    }, { timestamp: '2026-02-01T00:00:01.000Z' });
    // ...and with the CAS path. Hashes must be identical — one chain format.
    const e0 = buildNextEntry(null, 'reconciliation.completed', reconPayload, '2026-02-01T00:00:00.000Z');
    const e1 = buildNextEntry({ seq: e0.seq, hash: e0.hash }, 'trust.transaction_added', {
      transactionId: 't1', clientId: 'c1', amountCents: '50000', txType: 'receipt',
      month: '2026-01', source: 'manual', actor: 'adam@example.com',
    }, '2026-02-01T00:00:01.000Z');
    assert.equal(e0.hash, a.hash);
    assert.equal(e1.hash, b.hash);
    assert.equal(e0.prevHash, GENESIS_HASH);
    assert.equal(e1.prevHash, e0.hash);
  });

  await test('verifyEntryDocs accepts a valid chain', () => {
    const e0 = buildNextEntry(null, 'reconciliation.completed', reconPayload, '2026-02-01T00:00:00.000Z');
    const e1 = buildNextEntry(e0, 'trust.transaction_deleted', {
      transactionId: 't9', amountCents: '-12500', month: '2026-01', actor: 'adam@example.com',
    }, '2026-02-01T00:00:01.000Z');
    const v = verifyEntryDocs([e0, e1]);
    assert.deepEqual(v, { ok: true, entries: 2 });
  });

  await test('tamper detection: altered amount names the entry', () => {
    const e0 = buildNextEntry(null, 'trust.transaction_deleted', {
      transactionId: 't9', amountCents: '-12500', month: '2026-01', actor: 'adam@example.com',
    }, '2026-02-01T00:00:00.000Z');
    const e1 = buildNextEntry(e0, 'reconciliation.completed', reconPayload, '2026-02-01T00:00:01.000Z');
    const forged = { ...e0, payload: { ...e0.payload, amountCents: '-125' } };
    const v = verifyEntryDocs([forged, e1]);
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.atSeq, 0);
      assert.match(v.error, /hash mismatch/);
    }
  });

  await test('tamper detection: deleted middle entry (gap) and reorder', () => {
    const entries: SealedEntry[] = [];
    let head: ChainHead | null = null;
    for (let i = 0; i < 4; i += 1) {
      const e = buildNextEntry(head, 'trust.transaction_cleared', {
        transactionId: `t${i}`, clearDate: '2026-02-01', actor: 'a',
      }, `2026-02-01T00:00:0${i}.000Z`);
      entries.push(e);
      head = { seq: e.seq, hash: e.hash };
    }
    const gap = verifyEntryDocs([entries[0]!, entries[2]!, entries[3]!]);
    assert.equal(gap.ok, false);
    const reordered = verifyEntryDocs([entries[0]!, entries[2]!, entries[1]!, entries[3]!]);
    assert.equal(reordered.ok, false);
  });

  await test('CAS serialization: racing writers serialize, no fork', async () => {
    // Fake head store that simulates two tabs racing: reads see the head as
    // of the START of the "transaction"; a write fails if the head moved
    // since the read (Firestore transaction semantics).
    function makeStore() {
      let head: ChainHead | null = null;
      const entries: SealedEntry[] = [];
      const store: HeadCas = {
        read: () => Promise.resolve(head),
        compareAndSwap: (expected, entry, newHead) => {
          const current = head;
          const same = (expected === null && current === null) ||
            (expected !== null && current !== null && expected.hash === current.hash);
          if (!same) return Promise.resolve(false);      // conflict → caller retries
          head = newHead;
          entries.push(entry);
          return Promise.resolve(true);
        },
      };
      return { store, entries, getHead: () => head };
    }

    const { store, entries } = makeStore();
    // 10 concurrent appends with interleaved awaits — without CAS retries
    // several would seal the same seq.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => casAppend(store, 'trust.transaction_added', {
        transactionId: `t${i}`, clientId: 'c1', amountCents: String(i * 100), txType: 'receipt',
        month: '2026-01', source: 'import', actor: 'a',
      }, { maxRetries: 20 })),   // 10-way race: a writer can need ~10 rounds
    );
    const seqs = results.map(r => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [...Array(10).keys()]);
    assert.equal(new Set(results.map(r => r.hash)).size, 10);
    const v = verifyEntryDocs(entries.slice().sort((a, b) => a.seq - b.seq));
    assert.deepEqual(v, { ok: true, entries: 10 });
  });

  await test('casAppend gives up after bounded retries under permanent contention', async () => {
    const alwaysConflict: HeadCas = {
      read: () => Promise.resolve(null),
      compareAndSwap: () => Promise.resolve(false),
    };
    await assert.rejects(
      casAppend(alwaysConflict, 'trust.client_created', { clientId: 'c1', name: 'X', actor: 'a' }, { maxRetries: 3 }),
      /contention/,
    );
  });

  // --- #16: fail-closed verify against the recorded head + offline queue ---
  const chain3 = (): SealedEntry[] => {
    const e0 = buildNextEntry(null, 'trust.client_created', { clientId: 'c1', name: 'A', actor: 'a' }, '2026-02-01T00:00:00.000Z');
    const e1 = buildNextEntry(e0, 'trust.transaction_added', {
      transactionId: 't1', clientId: 'c1', amountCents: '5000', txType: 'receipt',
      month: '2026-01', source: 'manual', actor: 'a',
    }, '2026-02-01T00:00:01.000Z');
    const e2 = buildNextEntry(e1, 'trust.transaction_added', {
      transactionId: 't2', clientId: 'c1', amountCents: '2500', txType: 'disbursement',
      month: '2026-01', source: 'manual', actor: 'a',
    }, '2026-02-01T00:00:02.000Z');
    return [e0, e1, e2];
  };

  await test('#16 verifyChainState: head matching the tail with an empty queue is ok', () => {
    const docs = chain3();
    const tail = docs[docs.length - 1];
    const v = verifyChainState(docs, { seq: tail.seq, hash: tail.hash }, 0);
    assert.deepEqual(v, { ok: true, entries: 3, pending: 0 });
  });

  await test('#16 verifyChainState: empty chain, no head, no queue is ok', () => {
    assert.deepEqual(verifyChainState([], null, 0), { ok: true, entries: 0, pending: 0 });
  });

  await test('#16 verifyChainState: head ahead of the entries fails (dropped tail)', () => {
    // The recorded head reached seq 2, but only the first two entries survive:
    // re-hashing the two would say "ok" — the head witnesses the missing one.
    const docs = chain3();
    const realHead = { seq: docs[2].seq, hash: docs[2].hash };
    const truncated = docs.slice(0, 2);
    const v = verifyChainState(truncated, realHead, 0);
    assert.equal(v.ok, false);
    assert.equal((v as { atSeq: number }).atSeq, 1);
    assert.match((v as { error: string }).error, /does not match the last entry/);
  });

  await test('#16 verifyChainState: entries with no recorded head fail (head lost)', () => {
    const v = verifyChainState(chain3(), null, 0);
    assert.equal(v.ok, false);
    assert.match((v as { error: string }).error, /head is missing/);
  });

  await test('#16 verifyChainState: head present but all entries gone fails', () => {
    const v = verifyChainState([], { seq: 4, hash: 'abc' }, 0);
    assert.equal(v.ok, false);
    assert.equal((v as { atSeq: number }).atSeq, 4);
    assert.match((v as { error: string }).error, /no entries exist/);
  });

  await test('#16 verifyChainState: a non-empty offline queue is surfaced as a failure', () => {
    const docs = chain3();
    const tail = docs[docs.length - 1];
    const v = verifyChainState(docs, { seq: tail.seq, hash: tail.hash }, 2);
    assert.equal(v.ok, false);
    assert.equal((v as { pending: number }).pending, 2);
    assert.match((v as { error: string }).error, /unflushed queue/);
  });

  await test('#16 verifyChainState: tampering still beats a matching head + empty queue', () => {
    const docs = chain3();
    // Alter a sealed payload without resealing — hash no longer matches.
    (docs[1] as unknown as { payload: { amountCents: string } }).payload.amountCents = '999999';
    const tail = docs[docs.length - 1];
    const v = verifyChainState(docs, { seq: tail.seq, hash: tail.hash }, 0);
    assert.equal(v.ok, false);
    assert.equal((v as { atSeq: number }).atSeq, 1);
  });

  console.log(`\naudit.test.ts: ${passed} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
