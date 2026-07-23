'use strict';
// Render time entries as a terminal timesheet, CSV, or HTML invoice.

const { totals } = require('./entries');
const { truncate } = require('./billing');
const { isClientBillable } = require('./client-billing');

function money(amount, currency) {
  const sym = currency === 'USD' ? '$' : currency + ' ';
  return sym + amount.toFixed(2);
}

function textReport(entries, config, title) {
  const t = totals(entries);
  const showAmount = (config.rate || 0) > 0;
  const lines = [];
  lines.push(title);
  lines.push('='.repeat(title.length));
  if (!entries.length) {
    lines.push('(no time entries)');
    return lines.join('\n');
  }
  const header = ['Date', 'Client', 'Matter', 'Code', 'Description', 'Steps', 'Hours', 'Rev'];
  if (showAmount) header.push('Amount');
  const rows = entries.map((e) => {
    const row = [
      e.date,
      truncate(e.client, 14),
      truncate(e.matter, 18),
      e.code,
      truncate(e.description, 58),
      String(e.steps || ''),
      e.hours.toFixed(1),
      e.reviewed ? '✓' : '·',
    ];
    if (showAmount) row.push(e.writeOff ? 'N/C' : money(e.amount, config.currency));
    return row;
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  lines.push(fmt(header));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) lines.push(fmt(row));
  lines.push('');
  let summary = `Total: ${t.count} entries, ${t.steps} steps, ${t.hours.toFixed(1)} hours`;
  if (showAmount) summary += `, ${money(t.amount, config.currency)} in fees`;
  if (t.aiCost > 0) summary += ` + ${money(t.aiCost, config.currency)} AI costs`;
  if (t.unreviewed) summary += ` (${t.unreviewed} awaiting attorney review)`;
  lines.push(summary);
  return lines.join('\n');
}

function csvReport(entries, config) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [
    ['date', 'client', 'matter', 'activity_code', 'timekeeper', 'description', 'steps', 'hours', 'rate', 'amount', 'ai_cost', 'reviewed', 'no_charge', 'source', 'entry_id'],
  ];
  for (const e of entries) {
    rows.push([
      e.date,
      e.client,
      e.matter,
      e.code,
      config.timekeeper,
      e.description,
      e.steps,
      e.hours.toFixed(1),
      (config.rate || 0).toFixed(2),
      e.amount.toFixed(2),
      (e.aiCost || 0).toFixed(2),
      e.reviewed ? 'yes' : 'no',
      e.writeOff ? 'yes' : 'no',
      e.source || '',
      e.id,
    ]);
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function htmlInvoice(allEntries, config, { title, from, to, payUrl } = {}) {
  // An HTML statement is a CLIENT-facing document: only reviewed, attorney-
  // confirmed, unbilled work may appear on it (#17/#18). Non-billable captured
  // time never reaches the client, even by mistake.
  const entries = allEntries.filter(isClientBillable);
  const t = totals(entries);
  const showAmount = (config.rate || 0) > 0;
  const period = from || to ? `${from || 'start'} — ${to || 'present'}` : 'All time';
  const byMatter = new Map();
  for (const e of entries) {
    const key = `${e.client} / ${e.matter}`;
    if (!byMatter.has(key)) byMatter.set(key, []);
    byMatter.get(key).push(e);
  }

  const sections = [...byMatter.entries()]
    .map(([key, list]) => {
      const st = totals(list);
      const rows = list
        .map(
          (e) => `<tr${e.writeOff ? ' class="nc"' : ''}>
  <td class="date">${escapeHtml(e.date)}</td>
  <td class="code">${escapeHtml(e.code)}</td>
  <td>${escapeHtml(e.description)}${e.writeOff ? ' <em>(no charge)</em>' : ''}</td>
  <td class="num">${e.steps || ''}</td>
  <td class="num">${e.hours.toFixed(1)}</td>
  ${showAmount ? `<td class="num">${e.writeOff ? 'N/C' : money(e.amount, config.currency)}</td>` : ''}
</tr>`
        )
        .join('\n');
      return `<h2>${escapeHtml(key)}</h2>
<table>
<thead><tr><th>Date</th><th>Code</th><th>Description of services</th><th class="num">Steps</th><th class="num">Hours</th>${showAmount ? '<th class="num">Amount</th>' : ''}</tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="3">Subtotal</td><td class="num">${st.steps}</td><td class="num">${st.hours.toFixed(1)}</td>${showAmount ? `<td class="num">${money(st.amount, config.currency)}</td>` : ''}</tr></tfoot>
</table>`;
    })
    .join('\n');

  return `<title>${escapeHtml(title || 'Billable.ai Statement')}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  header { border-bottom: 3px double #1a1a1a; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.6rem; letter-spacing: .02em; }
  .meta { color: #555; font-size: .95rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; border-bottom: 1px solid #999; padding-bottom: .25rem; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; font-family: system-ui, sans-serif; }
  th, td { text-align: left; padding: .4rem .5rem; vertical-align: top; }
  thead th { border-bottom: 2px solid #1a1a1a; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  tbody tr:nth-child(even) { background: rgba(0,0,0,.035); }
  tfoot td { border-top: 2px solid #1a1a1a; font-weight: 700; }
  .num { text-align: right; white-space: nowrap; }
  .date, .code { white-space: nowrap; }
  tr.nc td { opacity: .55; }
  .grand { margin-top: 2rem; border-top: 3px double #1a1a1a; padding-top: .75rem; text-align: right; font-size: 1.05rem; }
  .paybtn { display: inline-block; margin-top: .8rem; padding: .7rem 2rem; background: #1a365d; color: #fff !important;
            text-decoration: none; border-radius: 6px; font: 600 1rem system-ui, sans-serif; }
  .paybtn:hover { background: #234878; }
  .disclaimer { margin-top: 2rem; color: #777; font-size: .8rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #191919; }
    header, tfoot td { border-color: #e8e8e8; }
    .meta { color: #aaa; }
    thead th { border-color: #e8e8e8; }
    tbody tr:nth-child(even) { background: rgba(255,255,255,.06); }
    .grand { border-color: #e8e8e8; }
  }
</style>
<header>
  <h1>${escapeHtml(title || 'Statement of AI-Assisted Services')}</h1>
  <div class="meta">${config.firmName ? escapeHtml(config.firmName) + ' · ' : ''}Timekeeper: ${escapeHtml(config.timekeeper)}${showAmount ? ` · Rate: ${money(config.rate, config.currency)}/hr` : ''} · Period: ${escapeHtml(period)}</div>
</header>
${sections || '<p>No time entries for this period.</p>'}
<div class="grand">
  <strong>Fees: ${t.hours.toFixed(1)} hours${showAmount ? ` · ${money(t.amount, config.currency)}` : ''}</strong>
  ${t.aiCost > 0 ? `<div>AI usage costs (disclosed pass-through): ${money(t.aiCost, config.currency)}</div>
  <div><strong>Total: ${money(t.amount + t.aiCost, config.currency)}</strong></div>` : ''}
  <div class="meta">${t.count} entries · ${t.steps} recorded steps${t.unreviewed ? ` · ${t.unreviewed} awaiting attorney review` : ' · all entries attorney-reviewed'}</div>
  ${payUrl ? `<a class="paybtn" href="${escapeHtml(payUrl)}" target="_blank">Pay Now — ${money(t.amount + t.aiCost, config.currency)}</a>
  <div class="meta">Secure payment via LawPay</div>` : ''}
</div>
<p class="disclaimer">Generated by Matterproof from contemporaneously recorded AI activity. Hours reflect actual recorded work — never time "saved" — rounded to ${config.incrementHours.toFixed(1)}-hour increments (minimum ${config.minimumHours.toFixed(1)}) with idle gaps capped at ${config.idleCapMinutes} minutes. See ABA Formal Op. 512 on billing for AI-assisted work.</p>
`;
}

module.exports = { textReport, csvReport, htmlInvoice, money };
