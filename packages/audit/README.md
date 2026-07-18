# @elias/audit

Append-only, hash-chained audit log — the compliance backbone of the Elias
Trust Suite. Zero runtime dependencies, strict TypeScript.

## Why this exists (Rule 1:21-6 retention)

NJ Court Rule 1:21-6 requires attorneys to maintain trust-accounting books
and records — receipts and disbursements journals, client ledgers, and the
three-way reconciliations themselves — and to **preserve those records for
seven years**. "We ran a reconciliation" is not a record; a retained,
tamper-evident trail of *what* was reconciled, *when*, *by whom*, and *with
what result* is.

This package provides that trail, and extends the same discipline to the
other regulated money events in the suite (payroll payments, invoice
lifecycle, authentication failures):

- **Append-only.** The log never rewrites or deletes lines. History is
  history.
- **Hash-chained.** Each entry embeds the SHA-256 of its predecessor
  (`hash = sha256(prevHash + "\n" + canonical(entry-body))`). Altering,
  deleting, or reordering any historical entry breaks every subsequent link,
  and `verify()` detects it and names the first bad entry.
- **Durable, portable format.** JSONL on disk (or any injected storage) —
  greppable, archivable to WORM/object-lock retention storage, and readable
  without this library decades from now.

Production deployments should ship JSONL files to retention storage with
immutability controls (e.g. S3 Object Lock, 7-year retention) to fully
satisfy the preservation obligation; the hash chain makes any gap or
substitution in that archive detectable on `verify()`.

## Event vocabulary (closed)

| Type | Payload highlights |
|---|---|
| `reconciliation.completed` | accountId, period, book/bank balance, difference, performedBy |
| `payroll.payment` | employeeId, amountCents, payPeriod, method, **idempotencyKey** |
| `invoice.sent` | invoiceId, clientId, amountCents, sentBy, sentTo |
| `auth.login_failed` | principal, reason, ip? |

**Money fields are integer cents as decimal strings** — the same
representation as `Money.toJSON()` from `@elias/money`. The audit trail can
never carry a float64 amount. The packages are deliberately not import-coupled
(each stays zero-dependency); the cents-string convention is the contract.

## Usage

```ts
import { AuditLog, FsJsonlStorage, InMemoryStorage } from '@elias/audit';

// Production: JSONL file on disk (parent dirs created automatically).
const log = await AuditLog.open(new FsJsonlStorage('var/audit/iolta.jsonl'));
// Tests/dev: const log = await AuditLog.open(new InMemoryStorage());

await log.append('reconciliation.completed', {
  reconciliationId: 'recon-2025-01',
  accountId: 'iolta-001',
  periodStart: '2025-01-01',
  periodEnd: '2025-01-31',
  bookBalanceCents: '1250000',
  bankBalanceCents: '1250000',
  differenceCents: '0',          // exact — a 1-cent difference is recorded, not tolerated
  performedBy: 'adam@eliaslaw.example',
});

const result = await log.verify();
// { ok: true, entries: 1 } — or { ok: false, error, atSeq } naming the first bad entry
```

Behavioral notes:

- `AuditLog.open()` **verifies the whole chain by default** and throws
  `AuditIntegrityError` on any tampering. A compliance log that opens without
  complaint after modification is worse than no log. (`{ verifyOnOpen: false }`
  opts out, e.g. for a hot append path that verifies on a schedule.)
- **Single writer.** One open `AuditLog` owns its storage. Concurrent writers
  would fork the chain; the next `open()` catches the fork.
- Timestamps are ISO 8601 UTC; inject `clock` for deterministic tests.
- `FsJsonlStorage` is the Node adapter; `InMemoryStorage` ships for tests and
  exposes `replaceLine`/`removeLine` purely as tamper-simulation hooks. Any
  other backend (Firestore, Postgres, S3) implements the 2-method
  `AuditStorage` interface.

## Zero dependencies, including the hash

SHA-256 is implemented in pure TypeScript (`src/sha256.ts`) so the package
runs anywhere TS runs with no `node:crypto` coupling; correctness is pinned
by known-answer vectors plus a randomized cross-check against `node:crypto`
in the test suite. The chain provides tamper-**evidence**; if the threat
model grows to attackers who can rewrite the *entire* log undetected, layer
an HMAC/KMS signature over entry hashes (the chain format leaves room for it).

## Development

```sh
npm run build       # tsc -> dist/
npm test            # vitest run (tamper detection, chain verification, ordering)
npm run typecheck   # strict tsc over src + test
```
