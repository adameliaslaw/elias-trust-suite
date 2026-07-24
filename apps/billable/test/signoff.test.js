'use strict';
// Phase 7 (epic #26) reproducing tests — the attorney sign-off gate on the
// billable CLIENT INVOICE, registered into test/run.js's runner.
//
// The structural gate (#17/#18) already keeps unreviewed / unconfirmed /
// already-billed work off a client invoice. This layer adds the uniform,
// AUDITED attorney sign-off the epic calls for: an attorney signs off on the
// EXACT assembled invoice for one (client, matter) via @elias/auth's
// content-addressed reviewSignoff, the sign-off is keyed on the suite's
// canonical @elias/entities matter id, and `report --format ledes --bill`
// refuses to issue the invoice unless a matching, APPROVED sign-off is on
// record. A sign-off is content-addressed, so editing the invoice after
// sign-off (adding an entry, repricing) invalidates it — a stale approval can
// never cover mutated numbers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = (test) => {
  const store = require('../src/store');
  const { buildEntries } = require('../src/entries');
  const signoff = require('../src/signoff');
  const { deriveEntityId } = require('@elias/entities');
  const { verifySignoff } = require('@elias/auth');

  function freshHome() {
    process.env.BILLABLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'billable-signoff-'));
    return process.env.BILLABLE_HOME;
  }

  // Seed one reviewed + confirmed (client-billable) manual entry and return the
  // rebuilt entry list plus the reviewed entry's id.
  function seedReviewedEntry(config, { client, matter, minutes = 60, date = '2026-07-15' }) {
    store.appendEvent({
      ts: `${date}T12:00:00.000Z`,
      type: 'manual',
      minutes,
      description: 'drafted the engagement letter',
      client,
      matter,
    });
    const built = buildEntries(store.readEvents(), config, store.readOverrides());
    // Match the just-added entry precisely (client+matter+date) so a second
    // seed for the same matter reviews the NEW entry, not the earlier one.
    const target = built.find((e) => e.client === client && e.matter === matter && e.date === date);
    store.writeOverride(target.id, { reviewed: true });
    const entries = buildEntries(store.readEvents(), config, store.readOverrides());
    return { entries, id: target.id };
  }

  const CONFIG = () => ({ ...store.DEFAULT_CONFIG, rate: 400 });

  // -------------------------------------------------------------------------
  // The signed output is keyed on the CANONICAL @elias/entities matter id.
  // -------------------------------------------------------------------------
  test('#26 signoff: the invoice output is keyed on the canonical matter id', () => {
    freshHome();
    const config = CONFIG();
    const { entries } = seedReviewedEntry(config, { client: 'Acme', matter: 'Merger' });
    const output = signoff.invoiceOutput(entries, 'Acme', 'Merger');
    assert.strictEqual(output.kind, 'invoice');
    // The id is exactly what any other app derives from the same natural key —
    // no coordination, no shared table (that's the point of @elias/entities).
    assert.strictEqual(output.id, deriveEntityId('matter', 'Acme', 'Merger'));
    assert.match(output.id, /^mtr_/);
    assert.strictEqual(output.content.entryCount, 1);
    assert.strictEqual(output.content.totalCents, 400 * 100); // 1.0h @ $400
  });

  // -------------------------------------------------------------------------
  // A sign-off is content-addressed: it verifies against the signed content and
  // FAILS once the invoice changes.
  // -------------------------------------------------------------------------
  test('#26 signoff: an approved sign-off verifies, and stops verifying once the invoice changes', () => {
    freshHome();
    const config = CONFIG();
    const seeded = seedReviewedEntry(config, { client: 'Acme', matter: 'Merger' });
    const { signoff: rec, output } = signoff.signInvoice(seeded.entries, 'Acme', 'Merger', {
      attorney: 'Jane Roe, Esq.',
      signedAt: '2026-07-20T00:00:00.000Z',
    });
    assert.strictEqual(rec.decision, 'approved');
    assert.strictEqual(rec.outputKind, 'invoice');
    assert.strictEqual(rec.outputId, output.id);
    assert.ok(signoff.invoiceSignoffValid(rec, output), 'valid against the signed invoice');
    assert.ok(verifySignoff(rec, output));

    // Add a second reviewed entry to the SAME matter — the invoice content
    // (and its hash) change, so the earlier sign-off no longer covers it.
    const grown = seedReviewedEntry(config, { client: 'Acme', matter: 'Merger', minutes: 30, date: '2026-07-16' });
    const newOutput = signoff.invoiceOutput(grown.entries, 'Acme', 'Merger');
    assert.strictEqual(newOutput.content.entryCount, 2);
    assert.ok(!signoff.invoiceSignoffValid(rec, newOutput), 'stale sign-off no longer covers the grown invoice');
    assert.throws(
      () => signoff.assertInvoiceSignedOff(grown.entries, 'Acme', 'Merger', rec),
      /does not match the current invoice/,
    );
  });

  // -------------------------------------------------------------------------
  // The gate fails closed: missing and rejected sign-offs both block billing.
  // -------------------------------------------------------------------------
  test('#26 signoff: assertInvoiceSignedOff throws with no sign-off on record', () => {
    freshHome();
    const config = CONFIG();
    const { entries } = seedReviewedEntry(config, { client: 'Acme', matter: 'Merger' });
    assert.throws(
      () => signoff.assertInvoiceSignedOff(entries, 'Acme', 'Merger', null),
      /No attorney sign-off on record/,
    );
  });

  test('#26 signoff: a REJECTED sign-off blocks billing (and requires a note)', () => {
    freshHome();
    const config = CONFIG();
    const { entries } = seedReviewedEntry(config, { client: 'Acme', matter: 'Merger' });
    // A rejection with no note is not reviewable — reviewSignoff refuses it.
    assert.throws(
      () => signoff.signInvoice(entries, 'Acme', 'Merger', { attorney: 'Jane Roe, Esq.', decision: 'rejected' }),
      /must include a note/,
    );
    const { signoff: rec, output } = signoff.signInvoice(entries, 'Acme', 'Merger', {
      attorney: 'Jane Roe, Esq.',
      decision: 'rejected',
      note: 'hours look inflated; revisit',
    });
    assert.ok(!signoff.invoiceSignoffValid(rec, output), 'a rejection is not a valid cover');
    assert.throws(
      () => signoff.assertInvoiceSignedOff(entries, 'Acme', 'Merger', rec),
      /signed off as rejected/,
    );
  });

  // -------------------------------------------------------------------------
  // Persistence + audit: recordSignoff stores the record keyed by canonical id
  // and chains a compliance.signoff event into the tamper-evident trail.
  // -------------------------------------------------------------------------
  test('#26 signoff: recordSignoff persists by canonical id and appends a chained audit event', () => {
    freshHome();
    const config = CONFIG();
    const { entries } = seedReviewedEntry(config, { client: 'Acme', matter: 'Merger' });
    const { signoff: rec, output, event } = signoff.signInvoice(entries, 'Acme', 'Merger', {
      attorney: 'Jane Roe, Esq.',
      signedAt: '2026-07-20T00:00:00.000Z',
    });
    store.recordSignoff(output.id, rec, event);

    // Persisted, keyed by the canonical matter id, and retrievable.
    assert.deepStrictEqual(store.readSignoff(output.id), rec);
    assert.strictEqual(store.readSignoff(deriveEntityId('matter', 'Nope', 'Nope')), null);

    // Chained into the audit trail as a compliance.signoff, and the chain still verifies.
    const audit = require('../src/audit');
    const v = audit.verifyLedger(store.ledgerPath(), store.auditPath());
    assert.ok(v.ok, `audit chain verifies: ${v.error || ''}`);
    const lines = fs.readFileSync(store.auditPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ev = lines.find((l) => l.type === 'compliance.signoff');
    assert.ok(ev, 'a compliance.signoff event was chained');
    assert.strictEqual(ev.payload.outputKind, 'invoice');
    assert.strictEqual(ev.payload.outputId, output.id);
    assert.strictEqual(ev.payload.decision, 'approved');
    assert.strictEqual(ev.payload.actor, 'Jane Roe, Esq.');
    assert.strictEqual(ev.payload.contentHash, rec.contentHash);
  });

  // -------------------------------------------------------------------------
  // End to end through the CLI: `--bill` is refused without a sign-off, then
  // succeeds after one, and never double-bills.
  // -------------------------------------------------------------------------
  test('#26 signoff: CLI report --bill is gated on a recorded sign-off', () => {
    const home = freshHome();
    const config = CONFIG();
    // Snapshot config so the CLI uses the same rate.
    store.writeConfig(config);
    const { id } = seedReviewedEntry(config, { client: 'Acme', matter: 'Merger' });

    const bin = path.resolve(__dirname, '..', 'bin', 'billable.js');
    const env = { ...process.env, BILLABLE_HOME: home };
    const run = (args) => execFileSync('node', [bin, ...args], { env, encoding: 'utf8' });

    // 1. Billing WITHOUT a sign-off is refused, and nothing is stamped billed.
    let threw = false;
    try {
      run(['report', '--format', 'ledes', '--bill']);
    } catch (err) {
      threw = true;
      assert.match(String(err.stderr || err.message), /sign-off/i);
    }
    assert.ok(threw, 'report --bill must fail with no sign-off on record');
    assert.strictEqual(store.readOverrides()[id].billed, undefined, 'no entry was billed');

    // 2. Record an approving sign-off through the CLI.
    const signed = run(['signoff', 'Acme', 'Merger', '--attorney', 'Jane Roe, Esq.']);
    assert.match(signed, /approved/i);
    const matterId = deriveEntityId('matter', 'Acme', 'Merger');
    assert.ok(store.readSignoff(matterId), 'CLI signoff persisted a record');

    // 3. Now --bill succeeds and stamps the mutually-exclusive billed marker.
    const billed = run(['report', '--format', 'ledes', '--bill', '--reference', 'MP-TEST-1']);
    assert.match(billed, /Marked 1 entr/);
    assert.strictEqual(store.readOverrides()[id].billed.reference, 'MP-TEST-1');

    // 4. A re-bill is a no-op (already billed) — still safe, nothing new stamped.
    const rebill = run(['report', '--format', 'ledes', '--bill', '--reference', 'MP-TEST-2']);
    assert.match(rebill, /Marked 0 entr/);
    assert.strictEqual(store.readOverrides()[id].billed.reference, 'MP-TEST-1', 'billed marker is unchanged');
  });
};
