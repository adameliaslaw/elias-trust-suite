'use strict';
// Exact-money bridge: all fee/cost arithmetic goes through @elias/money
// (bigint cents). JS floats are only ever exact decimal *representations*
// at the boundary (config values, quantized hours) — never summed or
// multiplied as floats. Kills the float64 bug class, e.g.:
//   1.5h x $13.35 = $20.025 -> float round2 gave $20.02 (undercharge);
//   exact half-up gives $20.03.
const { Money } = require('@elias/money');

// Exact decimal string for a JS number. String() is shortest round-trip,
// so 13.35 -> '13.35'. Guards against scientific notation leaking into
// @elias/money's factor parser (only reachable for absurd magnitudes).
function dec(n) {
  const s = String(n);
  if (/[eE]/.test(s)) throw new Error(`dec: non-decimal number ${s}`);
  return s;
}

// Dollars (number or numeric string) -> exact Money. Converts via
// $1.00 x factor so 3+ decimal-place inputs round half-up to the cent
// instead of being rejected by fromDollars' strict 2dp literal.
function dollars(n) {
  return Money.fromCents(100).multiply(dec(n));
}

// hours is quantized to 4dp by roundHours; toFixed gives its exact decimal.
function feeCents(hours, rateDollars) {
  if (!(rateDollars > 0) || !(hours > 0)) return 0;
  return Number(dollars(rateDollars).multiply((+hours).toFixed(4)).toCents());
}

// Sum any number of cent-quantized dollar amounts exactly -> integer cents.
function sumCents(...amounts) {
  let total = Money.zero();
  for (const a of amounts) {
    if (a) total = total.add(dollars((+a).toFixed(2)));
  }
  return Number(total.toCents());
}

const centsToDollars = (cents) => cents / 100;

module.exports = { dec, dollars, feeCents, sumCents, centsToDollars };
