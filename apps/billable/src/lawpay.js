'use strict';
// LawPay (AffiniPay) integration: turn a period of attorney-reviewed entries
// into a pre-filled LawPay Payment Page link — and optionally a client-ready
// HTML statement with a "Pay Now" button.
//
// This uses LawPay's Payment Page URL parameters (amount in cents,
// description, reference, readOnlyFields, email), the same pattern as the
// firm's estate-plan-generator integration. No API key or OAuth is needed:
// the page URL is the one you configure in LawPay -> Payment Pages, e.g.
//   billable config lawpayPageUrl https://secure.lawpay.com/pages/<yourfirm>/operating
//
// Billing gate mirrors the Clio sync: only entries that are reviewed, not
// written off, and not already on a previous payment request are included.
// Each generated request stamps its reference onto the included entries
// (overrides.lawpayRef) so work is never double-billed; the reference also
// round-trips through LawPay so payments reconcile to exact entries.

const crypto = require('crypto');
const store = require('./store');
const { totals } = require('./entries');
const { sumCents } = require('./money');

function classifyForBilling(entries, overrides) {
  const ready = [];
  const skipped = { unreviewed: 0, writeOff: 0, alreadyBilled: 0 };
  for (const e of entries) {
    if (overrides[e.id] && overrides[e.id].lawpayRef) skipped.alreadyBilled++;
    else if (e.writeOff) skipped.writeOff++;
    else if (!e.reviewed) skipped.unreviewed++;
    else ready.push(e);
  }
  return { ready, skipped };
}

function referenceFor(entries) {
  const hash = crypto
    .createHash('sha1')
    .update(entries.map((e) => e.id).sort().join(','))
    .digest('hex')
    .slice(0, 12);
  return `MP-${hash}`;
}

function describePeriod(entries, { from, to } = {}) {
  const dates = entries.map((e) => e.date).sort();
  const start = from || dates[0];
  const end = to || dates[dates.length - 1];
  return start === end ? start : `${start} to ${end}`;
}

// Returns { url, reference, amountCents, description, included, skipped }.
// Throws if nothing is billable or the page URL isn't configured.
function buildPaymentRequest(entries, config, { from, to, email, description } = {}) {
  const pageUrl = (config.lawpayPageUrl || '').trim();
  if (!pageUrl) {
    throw new Error(
      'LawPay payment page not configured. Copy your page URL from LawPay -> Payment Pages, then:\n' +
      '  billable config lawpayPageUrl https://secure.lawpay.com/pages/<yourfirm>/operating'
    );
  }
  const { ready, skipped } = classifyForBilling(entries, store.readOverrides());
  if (!ready.length) {
    const reasons = Object.entries(skipped).filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`).join(', ');
    throw new Error(`No billable entries${reasons ? ` (${reasons})` : ''}. Review entries first: billable serve`);
  }

  const t = totals(ready);
  // t.amount / t.aiCost are exact-cent dollars from totals(); sum in cents
  // (never float-add money on the way to a payment link).
  const amountCents = sumCents(t.amount, t.aiCost);
  const period = describePeriod(ready, { from, to });
  const desc =
    description ||
    `${config.firmName ? config.firmName + ' — ' : ''}Legal services, ${period} — ${t.hours.toFixed(1)} hours` +
    (t.aiCost > 0 ? ` (incl. ${config.currency === 'USD' ? '$' : ''}${t.aiCost.toFixed(2)} AI costs)` : '');
  const reference = referenceFor(ready);

  const params = new URLSearchParams({
    amount: String(amountCents),
    description: desc,
    reference,
    readOnlyFields: 'amount,description',
  });
  if (email) params.set('email', email);

  return {
    url: `${pageUrl}?${params}`,
    reference,
    amountCents,
    description: desc,
    email: email || '',
    included: ready,
    skipped,
    totals: t,
  };
}

// Stamp the payment reference onto every included entry so subsequent link
// generations skip them. Also log the request itself to the ledger for an
// audit trail (what was requested, when, for how much).
function markRequested(request) {
  for (const e of request.included) {
    store.writeOverride(e.id, { lawpayRef: request.reference });
  }
  store.appendEvent({
    ts: new Date().toISOString(),
    type: 'payment_request',
    reference: request.reference,
    amountCents: request.amountCents,
    entryIds: request.included.map((e) => e.id),
    description: request.description,
    email: request.email,
  });
}

// Accounts receivable for payment links: every generated request and every
// recorded payment is an append-only ledger event, so the A/R trail is as
// evidence-grade as the time itself.
function listRequests(events) {
  const requests = [];
  const received = new Map();
  for (const ev of events) {
    if (ev.type === 'payment_request') {
      requests.push({
        ts: ev.ts,
        date: (ev.ts || '').slice(0, 10),
        reference: ev.reference,
        amountCents: ev.amountCents,
        description: ev.description,
        entryIds: ev.entryIds || [],
        email: ev.email || '',
      });
    }
    if (ev.type === 'payment_received') received.set(ev.reference, ev);
  }
  for (const r of requests) {
    const p = received.get(r.reference);
    r.paid = !!p;
    r.paidAt = p ? (p.ts || '').slice(0, 10) : null;
  }
  return requests;
}

function outstanding(requests) {
  let cents = 0;
  for (const r of requests) if (!r.paid) cents += r.amountCents;
  return cents;
}

// Record that a request was paid (you saw it land in LawPay). Returns the
// request; throws on unknown reference or double payment.
function markPaid(reference, events) {
  const requests = listRequests(events);
  const req = requests.find((r) => r.reference === reference);
  if (!req) throw new Error(`No payment request ${reference}. List them with: billable lawpay requests`);
  if (req.paid) throw new Error(`${reference} was already marked paid on ${req.paidAt}.`);
  store.appendEvent({
    ts: new Date().toISOString(),
    type: 'payment_received',
    reference,
    amountCents: req.amountCents,
  });
  return req;
}

module.exports = {
  buildPaymentRequest, classifyForBilling, markRequested, referenceFor,
  listRequests, outstanding, markPaid,
};
