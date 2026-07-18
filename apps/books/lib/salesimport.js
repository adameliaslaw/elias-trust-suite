// Daily sales CSV import (built for Dripos sales exports, tolerant of
// others). Dripos has no public developer API; its sales reports export
// per-day (or per-order) rows with net sales, sales tax collected, and
// card tips. This module parses such a CSV with flexible header matching
// and aggregates by day; the server turns each day into a paid, taxable
// invoice so the P&L and the sales-tax trust ledger stay correct.
//
// Tips are NOT income — they belong to the staff and flow through payroll
// (the timecards import carries per-employee tips). The parser totals them
// so the import summary can say what to expect in the next pay run.
const { round2 } = require('./store');
const { parseDateCell } = require('./payroll/timecards');

const HEADER_ALIASES = {
  date: ['date', 'day', 'businessdate', 'orderdate', 'created', 'createdat'],
  net: ['netsales', 'net', 'netamount', 'sales', 'subtotal', 'netsale'],
  gross: ['grosssales', 'gross', 'total', 'totalsales', 'totalcollected', 'amount'],
  tax: ['tax', 'salestax', 'taxcollected', 'taxamount', 'taxes'],
  tips: ['tips', 'tip', 'tipamount', 'cardtips', 'totaltips', 'gratuity']
};

function norm(h) {
  return String(h || '').toLowerCase().replace(/[^a-z]/g, '');
}

function num(value) {
  const cleaned = String(value || '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

function splitCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Parse a sales CSV. Returns { days, tipsTotal, info }: days is a list of
// { date, netSales, tax, tips } sorted by date, aggregated across rows.
function parseSalesCSV(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
  if (!lines.length) throw new Error('The file is empty');
  const fieldnames = splitCSVLine(lines[0]).map(h => h.trim());
  const mapping = {};
  for (const field of fieldnames) {
    const n = norm(field);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (!(key in mapping) && aliases.includes(n)) mapping[key] = fieldnames.indexOf(field);
    }
  }
  if (!('date' in mapping)) throw new Error('Could not find a date column. Headers seen: ' + fieldnames.join(', '));
  if (!('net' in mapping) && !('gross' in mapping)) {
    throw new Error('Could not find a net or gross sales column. Headers seen: ' + fieldnames.join(', '));
  }

  const byDay = new Map();
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCSVLine(line);
    const cell = key => (key in mapping ? (cells[mapping[key]] || '') : '');
    const date = parseDateCell(cell('date'));
    if (!date) { skipped++; continue; }
    if (!byDay.has(date)) byDay.set(date, { date, netSales: 0, tax: 0, tips: 0 });
    const day = byDay.get(date);
    const tax = num(cell('tax'));
    const tips = num(cell('tips'));
    // Prefer an explicit net column; otherwise back into it from gross.
    const net = 'net' in mapping ? num(cell('net')) : num(cell('gross')) - tax - tips;
    day.netSales += net;
    day.tax += tax;
    day.tips += tips;
  }

  const days = [...byDay.values()]
    .map(d => ({ date: d.date, netSales: round2(d.netSales), tax: round2(d.tax), tips: round2(d.tips) }))
    .filter(d => d.netSales > 0 || d.tax > 0 || d.tips > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    days,
    tipsTotal: round2(days.reduce((s, d) => s + d.tips, 0)),
    info: { detected: Object.keys(mapping).sort(), skipped, netDerived: !('net' in mapping) }
  };
}

module.exports = { parseSalesCSV };
