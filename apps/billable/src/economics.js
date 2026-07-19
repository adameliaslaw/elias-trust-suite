'use strict';
// Per-matter unit economics: what does each matter actually cost to produce?
//
// For hourly practices this shows realization; for flat-fee practices it
// answers the pricing question the billable hour never had to: fee vs. the
// actual hours and AI cost that went into the work. Actual hours here are
// unrounded recorded time — billing increments are a fee convention, not a
// cost measure.

function keyOf(client, matter) {
  return `${client}|${matter}`;
}

function buildEconomics(entries, config) {
  const matters = new Map();
  for (const e of entries) {
    const key = keyOf(e.client, e.matter);
    if (!matters.has(key)) {
      matters.set(key, {
        client: e.client,
        matter: e.matter,
        entries: 0,
        steps: 0,
        actualHours: 0,
        billedHours: 0,
        fees: 0,
        aiCost: 0,
      });
    }
    const m = matters.get(key);
    m.entries += 1;
    m.steps += e.steps;
    m.actualHours += (e.seconds || 0) / 3600;
    if (!e.writeOff) {
      m.billedHours += e.hours;
      m.fees += e.amount;
    }
    m.aiCost += e.aiCost || 0;
  }

  const rows = [...matters.values()].map((m) => {
    const flatFee = (config.flatFees || {})[keyOf(m.client, m.matter)];
    const revenue = flatFee != null ? flatFee : m.fees;
    return {
      ...m,
      actualHours: round2(m.actualHours),
      billedHours: round2(m.billedHours),
      fees: round2(m.fees),
      aiCost: round2(m.aiCost),
      flatFee: flatFee != null ? round2(flatFee) : null,
      // Effective realized rate per actual hour of recorded work.
      effectiveRate: m.actualHours > 0 ? round2(revenue / m.actualHours) : null,
      margin: flatFee != null ? round2(flatFee - m.aiCost) : null,
    };
  });
  rows.sort((a, b) => b.actualHours - a.actualHours);
  return rows;
}

function economicsReport(rows, config) {
  const cur = config.currency === 'USD' ? '$' : (config.currency || '') + ' ';
  const money = (n) => (n == null ? '—' : cur + n.toFixed(2));
  const lines = [];
  lines.push('Matterproof Unit Economics (per matter)');
  lines.push('=======================================');
  if (!rows.length) {
    lines.push('(no entries)');
    return lines.join('\n');
  }
  const header = ['Client / Matter', 'Entries', 'Actual hrs', 'Billed hrs', 'Fees', 'AI cost', 'Flat fee', 'Eff. rate/hr', 'Margin'];
  const table = rows.map((r) => [
    `${r.client} / ${r.matter}`.slice(0, 36),
    String(r.entries),
    r.actualHours.toFixed(2),
    r.billedHours.toFixed(1),
    money(r.fees),
    money(r.aiCost),
    money(r.flatFee),
    money(r.effectiveRate),
    money(r.margin),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const fmt = (row) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  lines.push(fmt(header));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of table) lines.push(fmt(row));
  lines.push('');
  lines.push('Actual hrs are unrounded recorded time; billed hrs apply your increment/minimum.');
  lines.push('Eff. rate/hr = (flat fee if set, else fees) / actual hrs. Margin = flat fee - AI cost.');
  return lines.join('\n');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildEconomics, economicsReport, keyOf };
