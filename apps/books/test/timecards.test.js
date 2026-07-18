// Timecard + sales CSV import tests. The timecard fixtures are ported from
// the firm payroll app's tests (test_tips_timecards.py) so the two parsers
// provably agree.
const assert = require('assert');
const T = require('../lib/payroll/timecards');
const S = require('../lib/salesimport');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const DRIPOS_LIKE_CSV = `Employee,Email,Date,Total Hours,Tips
Jane Doe,jane@shop.com,07/06/2026,8.5,41.25
Jane Doe,jane@shop.com,07/07/2026,9.0,38.00
Jane Doe,jane@shop.com,07/08/2026,9.0,12.75
Jane Doe,jane@shop.com,07/09/2026,9.0,0
Jane Doe,jane@shop.com,07/10/2026,9.0,22.00
Bob Smith,bob@shop.com,07/06/2026,6.0,18.50
Bob Smith,bob@shop.com,07/13/2026,6.0,9.25
`;

check('parse aggregates shifts and computes weekly OT', () => {
  const { rows, info } = T.parseTimecards(DRIPOS_LIKE_CSV);
  const byEmail = Object.fromEntries(rows.map(r => [r.email, r]));
  const jane = byEmail['jane@shop.com'];
  // One Sun-Sat week: 44.5 hours -> 40 regular + 4.5 OT
  assert.strictEqual(jane.hours, 40);
  assert.strictEqual(jane.otHours, 4.5);
  assert.strictEqual(jane.tips, 114.00);
  const bob = byEmail['bob@shop.com'];
  // Two separate weeks of 6h each: no OT
  assert.strictEqual(bob.hours, 12);
  assert.strictEqual(bob.otHours, 0);
  assert.ok(info.otSource.includes('computed weekly'));
});

check('explicit OT column is trusted', () => {
  const { rows, info } = T.parseTimecards('Name,Regular Hours,Overtime Hours,Card Tips\nJane Doe,80,3,120.50\n');
  assert.strictEqual(rows[0].hours, 80);
  assert.strictEqual(rows[0].otHours, 3);
  assert.strictEqual(rows[0].tips, 120.50);
  assert.strictEqual(info.otSource, 'column');
});

check('currency symbols, quoted commas, and BOM', () => {
  const { rows } = T.parseTimecards('﻿Employee,Total Hours,Tip Payout\nJane Doe,8,"$1,041.25"\n');
  assert.strictEqual(rows[0].tips, 1041.25);
});

check('missing columns raise', () => {
  assert.throws(() => T.parseTimecards('Foo,Bar\n1,2\n'));
  assert.throws(() => T.parseTimecards('Total Hours\n8\n'));   // no employee column
});

check('matchEmployee: email first, then name forward or reversed', () => {
  const employees = [
    { id: 1, email: 'jane@shop.com', firstName: 'Jane', lastName: 'Doe' },
    { id: 2, email: '', firstName: 'Bob', lastName: 'Smith' }
  ];
  assert.strictEqual(T.matchEmployee({ email: 'jane@shop.com', name: '' }, employees).id, 1);
  assert.strictEqual(T.matchEmployee({ email: '', name: 'Smith, Bob' }, employees).id, 2);
  assert.strictEqual(T.matchEmployee({ email: '', name: 'Nobody Here' }, employees), null);
});

check('sales CSV aggregates per-day with net, tax, tips', () => {
  const { days, tipsTotal, info } = S.parseSalesCSV(
    'Date,Net Sales,Tax,Tips\n' +
    '07/14/2026,812.40,53.82,61.00\n' +
    '07/14/2026,100.00,6.63,5.00\n' +
    '07/15/2026,"1,040.25",68.92,74.50\n');
  assert.strictEqual(days.length, 2);
  assert.strictEqual(days[0].date, '2026-07-14');
  assert.strictEqual(days[0].netSales, 912.40);
  assert.strictEqual(days[0].tax, 60.45);
  assert.strictEqual(days[1].netSales, 1040.25);
  assert.strictEqual(tipsTotal, 140.50);
  assert.strictEqual(info.netDerived, false);
});

check('sales CSV derives net from gross when needed', () => {
  const { days, info } = S.parseSalesCSV(
    'Date,Total Collected,Sales Tax,Gratuity\n2026-07-14,1000.00,60.00,40.00\n');
  assert.strictEqual(days[0].netSales, 900);   // 1000 − 60 tax − 40 tips
  assert.strictEqual(info.netDerived, true);
});

check('sales CSV requires date and a sales column', () => {
  assert.throws(() => S.parseSalesCSV('Net Sales,Tax\n100,6.63\n'));
  assert.throws(() => S.parseSalesCSV('Date,Tips\n2026-07-14,5\n'));
});

console.log(`\nAll ${passed} timecard/sales import checks passed.`);
