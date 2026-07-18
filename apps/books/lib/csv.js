// Bank-statement CSV parsing. Handles quoted fields, common date formats,
// currency symbols/parentheses, and either a single amount column or
// separate debit/credit columns.

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

function parseAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().replace(/[$€£,\s]/g, '');
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = Number(s);
  return neg ? -n : n;
}

function parseDate(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);           // ISO
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);          // US MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/);         // MM/DD/YY
  if (m) return `20${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

// Returns { transactions: [{date, name, amount}], skipped } where amount is
// signed: positive = money in, negative = money out.
function parseBankCSV(text, { flipSigns = false } = {}) {
  const rows = parseCSV(text);
  if (!rows.length) return { transactions: [], skipped: 0 };

  const header = rows[0].map(h => h.trim().toLowerCase());
  const findCol = (...patterns) => header.findIndex(h => patterns.some(p => p.test(h)));

  let dateCol = findCol(/date/);
  let descCol = findCol(/desc/, /name/, /payee/, /memo/, /merchant/, /transaction/);
  let amountCol = findCol(/^amount$/, /amount/);
  let debitCol = findCol(/debit|withdraw/);
  let creditCol = findCol(/credit|deposit/);
  let hasHeader = dateCol !== -1;

  // Headerless files: assume date, description, amount order.
  if (!hasHeader) { dateCol = 0; descCol = 1; amountCol = 2; }
  if (descCol === -1) descCol = dateCol === 0 ? 1 : 0;

  const out = [];
  let skipped = 0;
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const date = parseDate(row[dateCol]);
    let amount;
    if (amountCol !== -1 && row[amountCol] !== undefined && String(row[amountCol]).trim() !== '') {
      amount = parseAmount(row[amountCol]);
    } else if (debitCol !== -1 || creditCol !== -1) {
      const debit = parseAmount(row[debitCol]);
      const credit = parseAmount(row[creditCol]);
      amount = !isNaN(credit) && credit !== 0 ? Math.abs(credit) : (!isNaN(debit) ? -Math.abs(debit) : NaN);
    } else {
      amount = NaN;
    }
    const name = String(row[descCol] || '').trim();
    if (!date || isNaN(amount) || amount === 0 || !name) { skipped++; continue; }
    out.push({ date, name, amount: flipSigns ? -amount : amount });
  }
  return { transactions: out, skipped };
}

module.exports = { parseCSV, parseBankCSV, parseAmount, parseDate };
