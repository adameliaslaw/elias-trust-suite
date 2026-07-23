/* QuickBucks SPA — vanilla JS, no dependencies. */
'use strict';

// ---------- utilities ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let SETTINGS = { companyName: 'QuickBucks', currency: 'USD' };

function fmtMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: SETTINGS.currency || 'USD' }).format(n || 0);
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login' && url !== '/api/password') {
    showLogin();
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return toast(d.error || 'Download failed', true);
  }
  const blob = await res.blob();
  const m = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : 'download.ach';
  a.click();
  URL.revokeObjectURL(a.href);
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- modal ----------

function openModal({ title, body, footer, wide = false, onOpen }) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  $('.modal-close', root).onclick = closeModal;
  $('.modal-backdrop', root).addEventListener('mousedown', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  if (onOpen) onOpen(root);
  const firstInput = $('.modal-body input, .modal-body select', root);
  if (firstInput) firstInput.focus();
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ---------- badges ----------

const STATUS_LABEL = { paid: 'Paid', open: 'Open', partial: 'Partial', overdue: 'Overdue', draft: 'Draft', unbilled: 'Unbilled', 'non-billable': 'Non-billable' };
const badge = s => `<span class="badge ${s}">${STATUS_LABEL[s] || s}</span>`;

// ---------- chart (grouped bars, SVG) ----------

function renderBarChart(container, monthly) {
  const W = 520, H = 220, PAD = { t: 10, r: 8, b: 26, l: 52 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const max = Math.max(1, ...monthly.flatMap(m => [m.income, m.expenses]));
  // round the axis max up to a clean step
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const yMax = Math.ceil(max / step) * step;
  const y = v => PAD.t + ih - (v / yMax) * ih;

  const groupW = iw / monthly.length;
  const barW = Math.min(26, (groupW - 18) / 2);

  let bars = '', grid = '', labels = '', hits = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax / ticks) * i;
    const yy = y(v);
    grid += `<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" stroke="var(--hairline)" stroke-width="1"/>`;
    labels += `<text x="${PAD.l - 8}" y="${yy + 4}" text-anchor="end" font-size="10.5" fill="var(--ink-muted)">${v >= 1000 ? (v / 1000) + 'k' : v}</text>`;
  }

  monthly.forEach((m, i) => {
    const cx = PAD.l + groupW * i + groupW / 2;
    const x1 = cx - barW - 1, x2 = cx + 1; // 2px surface gap between the pair
    const bar = (x, v, color) => {
      const top = y(v), h = Math.max(0, PAD.t + ih - top);
      if (h <= 0) return '';
      const r = Math.min(4, h); // rounded data-end, anchored to baseline
      return `<path d="M${x} ${PAD.t + ih} V${top + r} Q${x} ${top} ${x + r} ${top} H${x + barW - r} Q${x + barW} ${top} ${x + barW} ${top + r} V${PAD.t + ih} Z" fill="${color}"/>`;
    };
    bars += bar(x1, m.income, 'var(--series-income)');
    bars += bar(x2, m.expenses, 'var(--series-expense)');
    labels += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--ink-muted)">${fmtMonth(m.month)}</text>`;
    hits += `<rect class="bar-hit" x="${PAD.l + groupW * i}" y="${PAD.t}" width="${groupW}" height="${ih}" data-i="${i}" rx="6"/>`;
  });

  container.innerHTML = `
    <div class="chart-legend" role="list">
      <span class="key" role="listitem"><span class="swatch" style="background:var(--series-income)"></span>Income</span>
      <span class="key" role="listitem"><span class="swatch" style="background:var(--series-expense)"></span>Expenses</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly income and expenses bar chart">
      ${grid}
      <line x1="${PAD.l}" y1="${PAD.t + ih}" x2="${W - PAD.r}" y2="${PAD.t + ih}" stroke="var(--baseline)" stroke-width="1"/>
      ${bars}${labels}${hits}
    </svg>`;

  const tip = $('#tooltip');
  $$('.bar-hit', container).forEach(hit => {
    hit.addEventListener('mousemove', e => {
      const m = monthly[Number(hit.dataset.i)];
      tip.innerHTML = `<div class="t-title">${esc(fmtMonth(m.month))}</div>
        Income: <strong>${fmtMoney(m.income)}</strong><br>Expenses: <strong>${fmtMoney(m.expenses)}</strong>`;
      tip.hidden = false;
      const pad = 14;
      let x = e.clientX + pad, yy = e.clientY + pad;
      if (x + tip.offsetWidth > innerWidth - 8) x = e.clientX - tip.offsetWidth - pad;
      if (yy + tip.offsetHeight > innerHeight - 8) yy = e.clientY - tip.offsetHeight - pad;
      tip.style.left = x + 'px';
      tip.style.top = yy + 'px';
    });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

// ---------- views ----------

const view = $('#view');

async function renderDashboard() {
  const d = await api('GET', '/api/dashboard');
  view.innerHTML = `
    <div class="page-head"><h1>Dashboard</h1></div>
    <div class="tiles">
      <div class="card tile">
        <div class="label">Income (all time)</div>
        <div class="value good">${fmtMoney(d.totalIncome)}</div>
        <div class="sub">payments received</div>
      </div>
      <div class="card tile">
        <div class="label">Expenses (all time)</div>
        <div class="value">${fmtMoney(d.totalExpenses)}</div>
        <div class="sub">${''}money out</div>
      </div>
      <div class="card tile">
        <div class="label">Net profit</div>
        <div class="value ${d.netProfit >= 0 ? 'good' : 'bad'}">${fmtMoney(d.netProfit)}</div>
        <div class="sub">income − expenses</div>
      </div>
      <div class="card tile">
        <div class="label">Outstanding invoices</div>
        <div class="value">${fmtMoney(d.outstanding)}</div>
        <div class="sub">${d.overdueCount ? `<span style="color:var(--status-critical);font-weight:600">${fmtMoney(d.overdueAmount)} overdue</span> · ` : ''}${d.outstandingCount} open</div>
      </div>
    </div>
    <div class="card card-pad mb">
      <h2>Income vs. expenses — last 6 months</h2>
      <div class="chart-wrap" id="chart"></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-pad" style="padding-bottom:0"><h2>Recent invoices</h2></div>
        <div class="table-wrap">
        ${d.recentInvoices.length ? `<table>
          <tbody>
            ${d.recentInvoices.map(i => `<tr>
              <td><span class="strong">${esc(i.number)}</span><br><span class="muted">${esc(i.customerName)}</span></td>
              <td>${badge(i.status)}</td>
              <td class="num">${fmtMoney(i.total)}<br><span class="muted">${fmtDate(i.date)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No invoices yet</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-pad" style="padding-bottom:0"><h2>Recent expenses</h2></div>
        <div class="table-wrap">
        ${d.recentExpenses.length ? `<table>
          <tbody>
            ${d.recentExpenses.map(e => `<tr>
              <td><span class="strong">${esc(e.vendor)}</span><br><span class="muted">${esc(e.category)}</span></td>
              <td class="num">${fmtMoney(e.amount)}<br><span class="muted">${fmtDate(e.date)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No expenses yet</div>'}
        </div>
      </div>
    </div>`;
  renderBarChart($('#chart'), d.monthly);
}

// ----- invoices -----

let invoiceFilter = 'all';

async function renderInvoices() {
  const invoices = await api('GET', '/api/invoices');
  const counts = { all: invoices.length };
  for (const s of ['open', 'overdue', 'partial', 'paid', 'draft']) counts[s] = invoices.filter(i => i.status === s).length;
  const filtered = invoiceFilter === 'all' ? invoices : invoices.filter(i => i.status === invoiceFilter);

  view.innerHTML = `
    <div class="page-head">
      <h1>Invoices</h1>
      <div class="actions">
        <button class="btn" id="import-sales">Import sales</button>
        <button class="btn" id="recurring-list">Recurring</button>
        <button class="btn btn-primary" id="new-invoice">+ New invoice</button>
      </div>
    </div>
    <div class="tabs">
      ${['all', 'open', 'overdue', 'partial', 'paid', 'draft'].map(s =>
        `<button data-f="${s}" class="${invoiceFilter === s ? 'active' : ''}">${s === 'all' ? 'All' : STATUS_LABEL[s]} (${counts[s]})</button>`).join('')}
    </div>
    <div class="card table-wrap">
      ${filtered.length ? `<table>
        <thead><tr>
          <th>No.</th><th>Customer</th><th>Date</th><th>Due date</th><th>Status</th>
          <th class="num">Total</th><th class="num">Balance</th><th></th>
        </tr></thead>
        <tbody>
          ${filtered.map(i => `<tr>
            <td><a class="inv-link strong" href="#/invoices/${i.id}">${esc(i.number)}</a></td>
            <td>${esc(i.customerName)}</td>
            <td>${fmtDate(i.date)}</td>
            <td>${fmtDate(i.dueDate)}</td>
            <td>${badge(i.status)}</td>
            <td class="num">${fmtMoney(i.total)}</td>
            <td class="num">${fmtMoney(i.balance)}</td>
            <td class="actions-cell">
              ${i.status === 'draft' ? `<button class="btn-link" data-act="send" data-id="${i.id}">Mark sent</button>` : ''}
              ${i.balance > 0 && i.status !== 'draft' ? `<button class="btn-link" data-act="pay" data-id="${i.id}">Receive payment</button>` : ''}
              <button class="btn-link" data-act="repeat" data-id="${i.id}">Repeat…</button>
              <button class="btn-link" data-act="edit" data-id="${i.id}">Edit</button>
              <button class="btn-link" data-act="del" data-id="${i.id}" style="color:var(--status-critical)">Delete</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">No ${invoiceFilter === 'all' ? '' : STATUS_LABEL[invoiceFilter].toLowerCase() + ' '}invoices${invoiceFilter === 'all' ? ' yet — create your first one' : ''}.</div>`}
    </div>`;

  $('#new-invoice').onclick = () => invoiceForm();
  $('#recurring-list').onclick = () => recurringListModal();
  $('#import-sales').onclick = () => salesImportModal();
  $$('.tabs button').forEach(b => b.onclick = () => { invoiceFilter = b.dataset.f; renderInvoices(); });
  $$('[data-act]').forEach(b => {
    const inv = invoices.find(i => i.id === b.dataset.id);
    b.onclick = () => {
      if (b.dataset.act === 'edit') invoiceForm(inv);
      else if (b.dataset.act === 'repeat') repeatInvoiceForm(inv);
      else if (b.dataset.act === 'pay') paymentForm(inv);
      else if (b.dataset.act === 'send') api('POST', `/api/invoices/${inv.id}/send`).then(() => { toast(`${inv.number} marked as sent`); renderInvoices(); });
      else if (b.dataset.act === 'del') confirmDelete(`invoice ${inv.number}`, () =>
        api('DELETE', `/api/invoices/${inv.id}`).then(() => { toast('Invoice deleted'); renderInvoices(); }));
    };
  });
}

async function invoiceForm(inv) {
  const customers = await api('GET', '/api/customers');
  if (!customers.length) {
    toast('Add a customer first', true);
    customerForm(null, () => invoiceForm());
    return;
  }
  const items = inv ? inv.items.map(x => ({ ...x })) : [{ description: '', qty: 1, rate: '' }];
  const date = inv ? inv.date : todayISO();
  const due = inv ? inv.dueDate : addDays(todayISO(), 30);

  const taxOn = !!(SETTINGS.salesTax && SETTINGS.salesTax.enabled);
  const taxRate = inv && inv.taxRate ? inv.taxRate : (SETTINGS.salesTax ? SETTINGS.salesTax.ratePct : 0);
  const itemRow = (it, idx) => `<tr data-idx="${idx}">
    <td><input class="it-desc" value="${esc(it.description)}" placeholder="Description of service or product"></td>
    <td class="num-col"><input class="it-qty" type="number" min="0" step="any" value="${esc(it.qty)}"></td>
    <td class="num-col"><input class="it-rate" type="number" min="0" step="0.01" value="${esc(it.rate)}" placeholder="0.00"></td>
    ${taxOn ? `<td class="rm-col" style="text-align:center"><input type="checkbox" class="it-taxable" ${it.taxable ? 'checked' : ''} title="Charge sales tax on this line"></td>` : ''}
    <td class="amt-col it-amt">$0.00</td>
    <td class="rm-col"><button type="button" class="rm-item" title="Remove line">&times;</button></td>
  </tr>`;

  openModal({
    title: inv ? `Edit ${inv.number}` : 'New invoice',
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>Customer</span>
          <select id="f-customer">${customers.map(c =>
            `<option value="${c.id}" ${inv && inv.customerId === c.id ? 'selected' : ''}>${esc(c.company || c.name)}</option>`).join('')}
          </select>
        </label>
        <div></div>
        <label class="field"><span>Invoice date</span><input type="date" id="f-date" value="${date}"></label>
        <label class="field"><span>Due date</span><input type="date" id="f-due" value="${due}"></label>
        <div class="full">
          <table class="items-table">
            <thead><tr><th>Line item</th><th class="num-col">Qty</th><th class="num-col">Rate</th>${taxOn ? '<th class="rm-col">Tax</th>' : ''}<th class="amt-col">Amount</th><th class="rm-col"></th></tr></thead>
            <tbody id="items-body">${items.map(itemRow).join('')}</tbody>
          </table>
          <button type="button" class="btn btn-sm" id="add-item">+ Add line</button>
          <div class="invoice-total" id="f-totals">Total: <span id="f-total">$0.00</span></div>
        </div>
        <label class="field full"><span>Notes (optional)</span><textarea id="f-notes">${esc(inv ? inv.notes : '')}</textarea></label>
      </div>`,
    footer: `
      ${!inv || inv.status === 'draft' ? `<button class="btn" id="save-draft">Save as draft</button>` : ''}
      <button class="btn btn-primary" id="save-invoice">${inv ? 'Save changes' : 'Save & send'}</button>`,
    onOpen(root) {
      const body = $('#items-body', root);
      const recalc = () => {
        let subtotal = 0, taxable = 0;
        $$('tr', body).forEach(tr => {
          const amt = (Number($('.it-qty', tr).value) || 0) * (Number($('.it-rate', tr).value) || 0);
          subtotal += amt;
          const cb = $('.it-taxable', tr);
          if (cb && cb.checked) taxable += amt;
          $('.it-amt', tr).textContent = fmtMoney(amt);
        });
        const tax = Math.round(taxable * taxRate) / 100;
        $('#f-totals', root).innerHTML = tax > 0
          ? `Subtotal: ${fmtMoney(subtotal)} &nbsp;·&nbsp; Sales tax (${taxRate}%): ${fmtMoney(tax)} &nbsp;·&nbsp; Total: <span id="f-total">${fmtMoney(subtotal + tax)}</span>`
          : `Total: <span id="f-total">${fmtMoney(subtotal)}</span>`;
      };
      body.addEventListener('input', recalc);
      body.addEventListener('click', e => {
        if (e.target.classList.contains('rm-item')) {
          if ($$('tr', body).length > 1) { e.target.closest('tr').remove(); recalc(); }
        }
      });
      $('#add-item', root).onclick = () => {
        body.insertAdjacentHTML('beforeend', itemRow({ description: '', qty: 1, rate: '' }, 0));
        recalc();
      };
      recalc();

      const collect = draft => ({
        customerId: $('#f-customer', root).value,
        date: $('#f-date', root).value,
        dueDate: $('#f-due', root).value,
        notes: $('#f-notes', root).value,
        draft,
        items: $$('tr', body).map(tr => ({
          description: $('.it-desc', tr).value,
          qty: Number($('.it-qty', tr).value),
          rate: Number($('.it-rate', tr).value),
          taxable: !!($('.it-taxable', tr) && $('.it-taxable', tr).checked)
        }))
      });
      const submit = async draft => {
        try {
          if (inv) await api('PUT', `/api/invoices/${inv.id}`, collect(draft));
          else await api('POST', '/api/invoices', collect(draft));
          closeModal();
          toast(inv ? 'Invoice updated' : (draft ? 'Draft saved' : 'Invoice created'));
          router();
        } catch (e) { toast(e.message, true); }
      };
      $('#save-invoice').onclick = () => submit(false);
      const draftBtn = $('#save-draft');
      if (draftBtn) draftBtn.onclick = () => submit(true);
    }
  });
}

function paymentForm(inv) {
  openModal({
    title: `Receive payment — ${inv.number}`,
    body: `
      <div class="form-grid">
        <label class="field"><span>Amount (balance ${fmtMoney(inv.balance)})</span>
          <input type="number" id="p-amount" min="0.01" step="0.01" value="${inv.balance}"></label>
        <label class="field"><span>Date</span><input type="date" id="p-date" value="${todayISO()}"></label>
        <label class="field full"><span>Payment method</span>
          <select id="p-method">
            ${['Bank transfer', 'Credit card', 'Check', 'Cash', 'Other'].map(m => `<option>${m}</option>`).join('')}
          </select></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="save-payment">Record payment</button>`,
    onOpen(root) {
      $('#save-payment', root).onclick = async () => {
        try {
          const updated = await api('POST', `/api/invoices/${inv.id}/payments`, {
            amount: Number($('#p-amount', root).value),
            date: $('#p-date', root).value,
            method: $('#p-method', root).value
          });
          closeModal();
          toast(updated.status === 'paid' ? `${inv.number} paid in full 🎉` : 'Payment recorded');
          router();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ----- recurring invoices -----

function repeatInvoiceForm(inv) {
  openModal({
    title: `Repeat ${inv.number}`,
    body: `
      <p class="bank-help">Creates a recurring template from this invoice — the same customer and line items
        bill automatically on the schedule below (great for retainers and monthly card-sales batches).</p>
      <div class="form-grid">
        <label class="field"><span>Frequency</span>
          <select id="rc-freq"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="quarterly">Quarterly</option></select></label>
        <label class="field"><span>First bill date</span><input id="rc-date" type="date" value="${addDays(todayISO(), 1)}"></label>
        <label class="field"><span>Payment terms (days)</span><input id="rc-terms" type="number" min="0" step="1" value="30"></label>
        <label class="field"><span>Create as</span>
          <select id="rc-draft"><option value="0">Open (ready to send)</option><option value="1">Draft (review first)</option></select></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="rc-save">Start recurring</button>`,
    onOpen(root) {
      $('#rc-save', root).onclick = async () => {
        try {
          await api('POST', '/api/recurring', {
            customerId: inv.customerId,
            items: inv.items,
            notes: inv.notes,
            frequency: $('#rc-freq', root).value,
            nextDate: $('#rc-date', root).value,
            termsDays: Number($('#rc-terms', root).value) || 30,
            draft: $('#rc-draft', root).value === '1'
          });
          closeModal();
          toast('Recurring invoice created');
          renderInvoices();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

async function recurringListModal() {
  const templates = await api('GET', '/api/recurring');
  openModal({
    title: 'Recurring invoices',
    wide: true,
    body: templates.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Customer</th><th>Every</th><th>Next bill</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${templates.map(t => `<tr ${t.active ? '' : 'style="opacity:.55"'}>
            <td class="strong">${esc(t.customerName)}</td>
            <td>${esc(t.frequency)}</td>
            <td>${fmtDate(t.nextDate)}</td>
            <td>${fmtMoney(t.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0))}</td>
            <td>${t.active ? '<span class="badge open">Active</span>' : '<span class="badge draft">Paused</span>'}</td>
            <td class="actions-cell">
              <button class="btn-link" data-rctoggle="${t.id}" data-rcactive="${t.active ? 1 : 0}">${t.active ? 'Pause' : 'Resume'}</button>
              <button class="btn-link" data-rcdel="${t.id}" style="color:var(--status-critical)">Delete</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <p class="bank-help" style="margin-top:10px">Due templates bill automatically whenever the app is opened —
        multiple missed periods catch up on their original dates.</p>`
      : `<p class="bank-help">No recurring invoices yet. Use <strong>Repeat…</strong> on any invoice to create one.</p>`,
    onOpen(root) {
      $$('[data-rctoggle]', root).forEach(b => b.onclick = async () => {
        await api('PUT', `/api/recurring/${b.dataset.rctoggle}`, { active: b.dataset.rcactive !== '1' });
        closeModal();
        recurringListModal();
      });
      $$('[data-rcdel]', root).forEach(b => b.onclick = async () => {
        await api('DELETE', `/api/recurring/${b.dataset.rcdel}`);
        closeModal();
        toast('Recurring invoice deleted');
        recurringListModal();
      });
    }
  });
}

// ----- invoice detail / print view -----

async function renderInvoiceDetail(id) {
  const inv = await api('GET', `/api/invoices/${id}`);
  const c = inv.customer;
  view.innerHTML = `
    <div class="page-head no-print">
      <h1><a href="#/invoices" class="back-link">← Invoices</a></h1>
      <div class="actions">
        ${inv.status === 'draft' ? `<button class="btn" id="d-send">Mark sent</button>` : ''}
        ${inv.balance > 0 && inv.status !== 'draft' ? `<button class="btn" id="d-pay">Receive payment</button>` : ''}
        <button class="btn" id="d-edit">Edit</button>
        <button class="btn btn-primary" id="d-print">Print / Save PDF</button>
      </div>
    </div>
    <div class="card invoice-doc" id="invoice-doc">
      <div class="doc-head">
        <div>
          <div class="doc-company">${esc(inv.company.name)}</div>
        </div>
        <div class="doc-title">
          <div class="doc-invoice-label">INVOICE</div>
          <div class="doc-number">${esc(inv.number)}</div>
          <div class="no-print" style="margin-top:6px">${badge(inv.status)}</div>
        </div>
      </div>
      <div class="doc-meta">
        <div>
          <div class="doc-meta-label">Bill to</div>
          <div class="strong">${esc(c ? (c.company || c.name) : '(deleted customer)')}</div>
          ${c && c.company ? `<div>${esc(c.name)}</div>` : ''}
          ${c && c.email ? `<div>${esc(c.email)}</div>` : ''}
          ${c && c.phone ? `<div>${esc(c.phone)}</div>` : ''}
        </div>
        <div class="doc-dates">
          <div><span class="doc-meta-label">Invoice date</span> ${fmtDate(inv.date)}</div>
          <div><span class="doc-meta-label">Due date</span> ${fmtDate(inv.dueDate)}</div>
        </div>
      </div>
      <table class="doc-items">
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${inv.items.map(it => `<tr>
            <td>${esc(it.description)}</td>
            <td class="num">${it.qty}</td>
            <td class="num">${fmtMoney(it.rate)}</td>
            <td class="num">${fmtMoney(it.qty * it.rate)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="doc-totals">
        ${inv.tax > 0 ? `<div class="doc-total-row"><span>Subtotal</span><span>${fmtMoney(inv.subtotal)}</span></div>
        <div class="doc-total-row"><span>NJ sales tax (${inv.taxRate}%)</span><span>${fmtMoney(inv.tax)}</span></div>` : ''}
        <div class="doc-total-row"><span>Total</span><span>${fmtMoney(inv.total)}</span></div>
        ${inv.amountPaid > 0 ? `<div class="doc-total-row muted"><span>Payments received</span><span>−${fmtMoney(inv.amountPaid)}</span></div>` : ''}
        <div class="doc-total-row doc-balance"><span>Balance due</span><span>${fmtMoney(inv.balance)}</span></div>
      </div>
      ${inv.payments.length ? `
        <div class="doc-payments no-print">
          <div class="doc-meta-label">Payment history</div>
          ${inv.payments.map(p => `<div class="muted">${fmtDate(p.date)} — ${fmtMoney(p.amount)} (${esc(p.method)})</div>`).join('')}
        </div>` : ''}
      ${inv.notes ? `<div class="doc-notes"><div class="doc-meta-label">Notes</div>${esc(inv.notes)}</div>` : ''}
      <div class="doc-footer">Thank you for your business.</div>
    </div>`;

  $('#d-print').onclick = () => window.print();
  $('#d-edit').onclick = () => invoiceForm(inv);
  const payBtn = $('#d-pay');
  if (payBtn) payBtn.onclick = () => paymentForm(inv);
  const sendBtn = $('#d-send');
  if (sendBtn) sendBtn.onclick = () =>
    api('POST', `/api/invoices/${inv.id}/send`).then(() => { toast(`${inv.number} marked as sent`); router(); });
}

// POS daily-sales CSV import (Dripos etc.): each day becomes a paid,
// taxable invoice so the P&L and the sales-tax trust ledger stay right.
function salesImportModal() {
  openModal({
    title: 'Import daily sales (POS CSV)',
    body: `
      <p class="bank-help">Upload a sales export with date, net (or gross) sales, tax, and tips columns —
      e.g. the Dripos sales report. Each day becomes a <strong>paid, taxable invoice</strong> for the
      walk-in customer below; re-importing the same days is safe (duplicates are skipped).
      Tips aren't income — they flow to staff through payroll.</p>
      <div class="form-grid">
        <label class="field"><span>Sales file</span><input type="file" id="ds-file" accept=".csv,text/csv"></label>
        <label class="field"><span>Walk-in customer</span><input id="ds-customer" value="Daily sales"></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="ds-go">Import</button>`,
    onOpen(root) {
      $('#ds-go', root).onclick = async () => {
        const file = $('#ds-file', root).files[0];
        if (!file) return toast('Choose a CSV file first', true);
        try {
          const r = await api('POST', '/api/sales/import-csv', {
            csv: await file.text(),
            customerName: $('#ds-customer', root).value
          });
          closeModal();
          toast(`Imported ${r.imported} day${r.imported === 1 ? '' : 's'} of sales` +
            (r.duplicates ? `, ${r.duplicates} already on the books` : '') +
            (r.tipsTotal ? ` — ${fmtMoney(r.tipsTotal)} of tips for the next pay run` : ''));
          r.warnings.forEach(w => toast(w, true));
          renderInvoices();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ----- billable time -----

let timeFilter = 'unbilled';

async function renderTime() {
  const [entries, wip, customers] = await Promise.all([
    api('GET', '/api/time'), api('GET', '/api/time/wip'), api('GET', '/api/customers')
  ]);
  const counts = { all: entries.length };
  for (const s of ['unbilled', 'billed', 'non-billable']) counts[s] = entries.filter(t => t.status === s).length;
  const filtered = timeFilter === 'all' ? entries : entries.filter(t => t.status === timeFilter);
  const wipTotal = wip.reduce((s, g) => s + g.amount, 0);

  view.innerHTML = `
    <div class="page-head">
      <h1>Time</h1>
      <div class="actions"><button class="btn btn-primary" id="new-time">+ Log time</button></div>
    </div>

    <div class="card mb">
      <div class="card-pad">
        <h2>Unbilled work in progress <span class="muted" style="font-weight:400">${fmtMoney(wipTotal)}</span></h2>
      </div>
      ${wip.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Client</th><th class="num">Entries</th><th class="num">Hours</th><th class="num">Amount</th><th>Oldest</th><th></th></tr></thead>
        <tbody>${wip.map(g => `<tr>
          <td class="strong">${esc(g.customerName)}</td>
          <td class="num">${g.entries}</td>
          <td class="num">${g.hours}</td>
          <td class="num">${fmtMoney(g.amount)}</td>
          <td>${fmtDate(g.oldest)}</td>
          <td class="actions-cell"><button class="btn btn-sm" data-bill="${g.customerId}">Create invoice</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty">No unbilled time. Log hours as you work and bill them here.</div>`}
    </div>

    <div class="tabs">
      ${['unbilled', 'billed', 'non-billable', 'all'].map(s =>
        `<button data-f="${s}" class="${timeFilter === s ? 'active' : ''}">${s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} (${counts[s]})</button>`).join('')}
    </div>
    <div class="card table-wrap">
      ${filtered.length ? `<table>
        <thead><tr><th>Date</th><th>Client</th><th>Matter</th><th>Description</th>
          <th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${filtered.map(t => `<tr>
          <td>${fmtDate(t.date)}</td>
          <td>${esc(t.customerName)}</td>
          <td>${esc(t.matter)}</td>
          <td>${esc(t.description)}</td>
          <td class="num">${t.hours}</td>
          <td class="num">${fmtMoney(t.rate)}</td>
          <td class="num">${fmtMoney(t.amount)}</td>
          <td>${t.status === 'billed' && t.invoiceId
            ? `<a href="#/invoices/${t.invoiceId}"><span class="badge paid">Billed</span></a>`
            : badge(t.status)}</td>
          <td class="actions-cell">${t.invoiceId ? '' : `
            <button class="btn-link" data-act="edit" data-id="${t.id}">Edit</button>
            <button class="btn-link" data-act="del" data-id="${t.id}" style="color:var(--status-critical)">Delete</button>`}</td>
        </tr>`).join('')}</tbody>
      </table>` : `<div class="empty">No ${timeFilter === 'all' ? '' : timeFilter + ' '}time entries.</div>`}
    </div>`;

  $('#new-time').onclick = () => timeEntryForm(null, customers);
  $$('.tabs button').forEach(b => b.onclick = () => { timeFilter = b.dataset.f; renderTime(); });
  $$('[data-bill]').forEach(b => b.onclick = async () => {
    try {
      const inv = await api('POST', '/api/time/invoice', { customerId: b.dataset.bill });
      toast(`Draft ${inv.number} created from ${inv.entriesBilled} entr${inv.entriesBilled === 1 ? 'y' : 'ies'}`);
      location.hash = `#/invoices/${inv.id}`;
    } catch (e) { toast(e.message, true); }
  });
  $$('[data-act]').forEach(b => {
    const t = entries.find(x => x.id === b.dataset.id);
    b.onclick = () => {
      if (b.dataset.act === 'edit') timeEntryForm(t, customers);
      else confirmDelete('this time entry', () =>
        api('DELETE', `/api/time/${t.id}`).then(() => { toast('Entry deleted'); renderTime(); }));
    };
  });
}

async function timeEntryForm(entry, customers) {
  customers = customers || await api('GET', '/api/customers');
  if (!customers.length) {
    toast('Add a client first', true);
    customerForm(null, () => timeEntryForm(entry));
    return;
  }
  // Default the rate to the last one used for the chosen client, falling
  // back to the company default.
  const recent = await api('GET', '/api/time');
  const lastRateFor = cid => {
    const last = recent.find(t => t.customerId === cid);
    return last ? last.rate : (SETTINGS.defaultHourlyRate || '');
  };
  openModal({
    title: entry ? 'Edit time entry' : 'Log time',
    body: `
      <div class="form-grid">
        <label class="field"><span>Date</span><input id="t-date" type="date" value="${entry ? entry.date : todayISO()}"></label>
        <label class="field"><span>Client</span><select id="t-customer">
          ${customers.map(c => `<option value="${c.id}" ${entry && entry.customerId === c.id ? 'selected' : ''}>${esc(c.company || c.name)}</option>`).join('')}
        </select></label>
        <label class="field full"><span>Matter (optional)</span><input id="t-matter" value="${entry ? esc(entry.matter) : ''}" placeholder="e.g. Smith v. Jones · closing · retainer"></label>
        <label class="field full"><span>Description</span><input id="t-desc" value="${entry ? esc(entry.description) : ''}" placeholder="What was the work?"></label>
        <label class="field"><span>Hours</span><input id="t-hours" type="number" min="0" max="24" step="0.1" value="${entry ? entry.hours : ''}" placeholder="0.5"></label>
        <label class="field"><span>Rate / hour</span><input id="t-rate" type="number" min="0" step="0.01" value="${entry ? entry.rate : lastRateFor(customers[0].id)}"></label>
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="t-billable" style="width:auto" ${!entry || entry.billable ? 'checked' : ''}>
          <span style="margin:0">Billable</span></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="save-time">${entry ? 'Save' : 'Log it'}</button>`,
    onOpen(root) {
      if (!entry) {
        $('#t-customer', root).onchange = e => { $('#t-rate', root).value = lastRateFor(e.target.value); };
      }
      $('#save-time', root).onclick = async () => {
        const body = {
          date: $('#t-date', root).value,
          customerId: $('#t-customer', root).value,
          matter: $('#t-matter', root).value,
          description: $('#t-desc', root).value,
          hours: Number($('#t-hours', root).value),
          rate: Number($('#t-rate', root).value),
          billable: $('#t-billable', root).checked
        };
        try {
          await api(entry ? 'PUT' : 'POST', entry ? `/api/time/${entry.id}` : '/api/time', body);
          closeModal();
          toast(entry ? 'Entry updated' : 'Time logged');
          renderTime();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ----- expenses -----

async function renderExpenses() {
  const [expenses, categories] = await Promise.all([api('GET', '/api/expenses'), api('GET', '/api/categories')]);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  view.innerHTML = `
    <div class="page-head">
      <h1>Expenses</h1>
      <div class="actions"><button class="btn btn-primary" id="new-expense">+ New expense</button></div>
    </div>
    <div class="card table-wrap">
      ${expenses.length ? `<table>
        <thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Method</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>
          ${expenses.map(e => `<tr>
            <td>${fmtDate(e.date)}</td>
            <td class="strong">${esc(e.vendor)}${e.receipt ? ` <a href="/api/expenses/${e.id}/receipt" target="_blank" title="View receipt (${esc(e.receipt.name)})" style="text-decoration:none">📎</a>` : ''}</td>
            <td>${esc(e.category)}</td>
            <td class="muted">${esc(e.paymentMethod)}</td>
            <td class="num">${fmtMoney(e.amount)}</td>
            <td class="actions-cell">
              <button class="btn-link" data-act="edit" data-id="${e.id}">Edit</button>
              <button class="btn-link" data-act="del" data-id="${e.id}" style="color:var(--status-critical)">Delete</button>
            </td>
          </tr>`).join('')}
          <tr class="total-row"><td colspan="4">Total</td><td class="num">${fmtMoney(total)}</td><td></td></tr>
        </tbody>
      </table>` : '<div class="empty">No expenses recorded yet.</div>'}
    </div>`;
  $('#new-expense').onclick = () => expenseForm(null, categories);
  $$('[data-act]').forEach(b => {
    const exp = expenses.find(e => e.id === b.dataset.id);
    b.onclick = () => {
      if (b.dataset.act === 'edit') expenseForm(exp, categories);
      else confirmDelete(`expense "${exp.vendor}"`, () =>
        api('DELETE', `/api/expenses/${exp.id}`).then(() => { toast('Expense deleted'); renderExpenses(); }));
    };
  });
}

function expenseForm(exp, categories) {
  openModal({
    title: exp ? 'Edit expense' : 'New expense',
    body: `
      <div class="form-grid">
        <label class="field"><span>Vendor / payee</span><input id="e-vendor" value="${esc(exp ? exp.vendor : '')}" placeholder="e.g. Staples"></label>
        <label class="field"><span>Amount</span><input id="e-amount" type="number" min="0.01" step="0.01" value="${exp ? exp.amount : ''}" placeholder="0.00"></label>
        <label class="field"><span>Date</span><input id="e-date" type="date" value="${exp ? exp.date : todayISO()}"></label>
        <label class="field"><span>Category</span>
          <select id="e-category">${categories.map(c => `<option ${exp && exp.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="field"><span>Payment method</span>
          <select id="e-method">${['Credit card', 'Bank transfer', 'Check', 'Cash', 'Other'].map(m =>
            `<option ${exp && exp.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="field full"><span>Notes (optional)</span><textarea id="e-notes">${esc(exp ? exp.notes : '')}</textarea></label>
        <label class="field full"><span>Receipt (snap a photo or attach a PDF)</span>
          <input type="file" id="e-receipt" accept="image/*,application/pdf" capture="environment"></label>
        ${exp && exp.receipt ? `<div class="full muted">Attached:
          <a href="/api/expenses/${exp.id}/receipt" target="_blank">${esc(exp.receipt.name)}</a>
          <button class="btn-link" id="e-receipt-del" style="color:var(--status-critical)">Remove</button></div>` : ''}
      </div>`,
    footer: `<button class="btn btn-primary" id="save-expense">${exp ? 'Save changes' : 'Save expense'}</button>`,
    onOpen(root) {
      const delBtn = $('#e-receipt-del', root);
      if (delBtn) delBtn.onclick = async () => {
        try {
          await api('DELETE', `/api/expenses/${exp.id}/receipt`);
          toast('Receipt removed');
          closeModal();
          renderExpenses();
        } catch (e) { toast(e.message, true); }
      };
      $('#save-expense', root).onclick = async () => {
        const body = {
          vendor: $('#e-vendor', root).value,
          amount: Number($('#e-amount', root).value),
          date: $('#e-date', root).value,
          category: $('#e-category', root).value,
          paymentMethod: $('#e-method', root).value,
          notes: $('#e-notes', root).value
        };
        try {
          const saved = exp ? await api('PUT', `/api/expenses/${exp.id}`, body)
                            : await api('POST', '/api/expenses', body);
          const file = $('#e-receipt', root).files[0];
          if (file) {
            const dataBase64 = await new Promise((resolve, reject) => {
              const rd = new FileReader();
              rd.onload = () => resolve(rd.result);
              rd.onerror = () => reject(new Error('Could not read the file'));
              rd.readAsDataURL(file);
            });
            await api('POST', `/api/expenses/${saved.id}/receipt`, { name: file.name, type: file.type, dataBase64 });
          }
          closeModal();
          toast(exp ? 'Expense updated' : (file ? 'Expense saved with receipt' : 'Expense saved'));
          renderExpenses();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ----- banking -----

let bankTab = 'new';

async function renderBanking() {
  const status = await api('GET', '/api/bank/status');
  const txns = await api('GET', '/api/bank/transactions');
  const rules = await api('GET', '/api/bank/rules');
  const ruleMatches = txns.filter(t => t.status === 'new' && t.ruleMatch).length;
  const counts = { new: 0, added: 0, matched: 0, excluded: 0 };
  for (const t of txns) counts[t.status] = (counts[t.status] || 0) + 1;
  const filtered = txns.filter(t => t.status === bankTab);
  const TAB_LABEL = { new: 'For review', added: 'Added', matched: 'Matched', excluded: 'Excluded' };

  view.innerHTML = `
    <div class="page-head">
      <h1>Banking</h1>
      <div class="actions">
        ${status.configured && status.connections.length ? `<button class="btn" id="bank-sync">↻ Sync now</button>` : ''}
        ${status.configured ? `<button class="btn btn-primary" id="bank-connect">+ Connect a bank</button>` : ''}
      </div>
    </div>

    ${!status.configured ? `
    <div class="card card-pad mb">
      <h2>Connect your bank with Plaid</h2>
      <p class="bank-help">
        QuickBucks uses <strong>Plaid</strong> — the same bank-connection service used by Venmo and
        American Express — to pull transactions from 12,000+ US banks. Get free API keys at
        <strong>dashboard.plaid.com</strong> (Sandbox keys work instantly for testing; request
        Production access to link your real accounts). Your keys and bank tokens are stored only in
        your local data file. Prefer not to link? Use CSV import below — no signup needed.
      </p>
      <div class="form-grid" style="max-width:640px">
        <label class="field"><span>Plaid client ID</span><input id="pl-client" autocomplete="off"></label>
        <label class="field"><span>Plaid secret</span><input id="pl-secret" type="password" autocomplete="off"></label>
        <label class="field"><span>Environment</span>
          <select id="pl-env"><option value="sandbox">Sandbox (testing)</option><option value="production">Production (real banks)</option></select></label>
        <div class="field" style="align-self:end"><button class="btn btn-primary" id="pl-save">Save keys</button></div>
      </div>
    </div>` : `
    <div class="card card-pad mb">
      <h2>Connected banks <span class="muted" style="font-weight:400">(Plaid ${esc(status.env)}${status.configSource === 'env' ? ', keys from environment' : ''})</span></h2>
      ${status.connections.length ? `
        <div class="bank-conns">
          ${status.connections.map(c => `
            <div class="bank-conn">
              <div>
                <div class="strong">${esc(c.institution)}</div>
                <div class="muted">${c.accounts.map(a => `${esc(a.name)}${a.mask ? ' ••' + esc(a.mask) : ''} — ${fmtMoney(a.balance)}`).join(' · ')}</div>
                <div class="muted" style="font-size:12px">${c.lastSync ? 'Last synced ' + new Date(c.lastSync).toLocaleString() : 'Never synced — click Sync now'}</div>
              </div>
              <button class="btn btn-sm btn-danger" data-disconnect="${c.id}">Disconnect</button>
            </div>`).join('')}
        </div>` : `<p class="bank-help">No banks connected yet. Click <strong>+ Connect a bank</strong> to link one securely through Plaid.</p>`}
      <div style="margin-top:10px"><button class="btn-link" id="pl-remove">Remove Plaid keys</button></div>
    </div>`}

    <div class="card card-pad mb">
      <h2>Import a CSV statement</h2>
      <p class="bank-help">Works with exports from any bank — needs date, description, and amount columns. Duplicates are skipped automatically.</p>
      <div class="range-row">
        <label class="field" style="width:auto"><span>Statement file</span><input type="file" id="csv-file" accept=".csv,text/csv"></label>
        <label class="field"><span>Account label</span><input id="csv-label" placeholder="e.g. Chase Checking"></label>
        <label class="field" style="width:auto;display:flex;align-items:center;gap:6px;padding-bottom:8px">
          <input type="checkbox" id="csv-flip" style="width:auto"> <span style="margin:0;font-weight:500">Flip signs (money out is positive in my file)</span></label>
        <button class="btn btn-primary" id="csv-import" style="margin-bottom:2px">Import</button>
      </div>
    </div>

    ${rules.length ? `
    <div class="card card-pad mb">
      <h2 style="display:flex;justify-content:space-between;align-items:center">Rules
        ${ruleMatches ? `<button class="btn btn-sm btn-primary" id="apply-rules">Apply rules (${ruleMatches} match${ruleMatches === 1 ? '' : 'es'})</button>` : '<span class="muted" style="font-weight:400;font-size:13px">no matches in the review feed</span>'}</h2>
      <div class="table-wrap"><table>
        <tbody>${rules.map(r => `<tr>
          <td>“${esc(r.match)}” → <span class="strong">${esc(r.category)}</span>${r.vendor ? ` <span class="muted">as ${esc(r.vendor)}</span>` : ''}</td>
          <td class="actions-cell"><button class="btn-link" data-delrule="${r.id}" style="color:var(--status-critical)">Delete</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}
    <div class="tabs">
      ${Object.entries(TAB_LABEL).map(([k, label]) =>
        `<button data-t="${k}" class="${bankTab === k ? 'active' : ''}">${label} (${counts[k] || 0})</button>`).join('')}
    </div>
    <div class="card table-wrap">
      ${filtered.length ? `<table>
        <thead><tr><th>Date</th><th>Description</th><th>Account</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>
          ${filtered.map(t => `<tr>
            <td>${fmtDate(t.date)}</td>
            <td><span class="strong">${esc(t.name)}</span>${t.pending ? ' <span class="badge draft">Pending</span>' : ''}
              ${t.ruleMatch ? ` <span class="badge open" title="A rule will categorize this">rule: ${esc(t.ruleMatch.category)}</span>` : ''}
              ${t.suggestedCategory ? `<br><span class="muted">${esc(t.suggestedCategory.replace(/_/g, ' ').toLowerCase())}</span>` : ''}</td>
            <td class="muted">${esc(t.accountName)}</td>
            <td class="num ${t.amount >= 0 ? 'amt-in' : ''}">${t.amount >= 0 ? '+' : ''}${fmtMoney(t.amount)}</td>
            <td class="actions-cell">
              ${t.status === 'new' ? `
                ${t.amount < 0 ? `<button class="btn-link" data-act="expense" data-id="${t.id}">Add expense</button>` : ''}
                ${t.amount > 0 ? `<button class="btn-link" data-act="match" data-id="${t.id}">Match to invoice</button>` : ''}
                <button class="btn-link" data-act="exclude" data-id="${t.id}" style="color:var(--ink-muted)">Exclude</button>` : ''}
              ${t.status === 'excluded' ? `<button class="btn-link" data-act="restore" data-id="${t.id}">Restore</button>` : ''}
              ${t.status === 'added' ? `<span class="muted">→ expense</span>` : ''}
              ${t.status === 'matched' ? `<span class="muted">→ invoice payment</span>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">${bankTab === 'new' ? 'Nothing to review — connect a bank or import a CSV to get started.' : 'Nothing here yet.'}</div>`}
    </div>`;

  // -- wire up --
  $$('.tabs button').forEach(b => b.onclick = () => { bankTab = b.dataset.t; renderBanking(); });

  const plSave = $('#pl-save');
  if (plSave) plSave.onclick = async () => {
    try {
      await api('PUT', '/api/bank/config', {
        clientId: $('#pl-client').value, secret: $('#pl-secret').value, env: $('#pl-env').value
      });
      toast('Plaid keys saved');
      renderBanking();
    } catch (e) { toast(e.message, true); }
  };
  const plRemove = $('#pl-remove');
  if (plRemove) plRemove.onclick = () => confirmDelete('your saved Plaid keys', async () => {
    await api('DELETE', '/api/bank/config');
    toast('Plaid keys removed');
    renderBanking();
  });

  const connectBtn = $('#bank-connect');
  if (connectBtn) connectBtn.onclick = () => launchPlaidLink();

  const syncBtn = $('#bank-sync');
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    try {
      const r = await api('POST', '/api/bank/sync');
      toast(`Sync complete — ${r.added} new transaction${r.added === 1 ? '' : 's'}`);
      if (r.errors.length) toast(r.errors.join('; '), true);
      renderBanking();
    } catch (e) { toast(e.message, true); syncBtn.disabled = false; syncBtn.textContent = '↻ Sync now'; }
  };

  $$('[data-disconnect]').forEach(b => b.onclick = () => {
    const c = status.connections.find(x => x.id === b.dataset.disconnect);
    confirmDelete(`the connection to ${c.institution}`, async () => {
      await api('DELETE', `/api/bank/connections/${c.id}`);
      toast('Bank disconnected');
      renderBanking();
    });
  });

  $('#csv-import').onclick = async () => {
    const file = $('#csv-file').files[0];
    if (!file) return toast('Choose a CSV file first', true);
    const csv = await file.text();
    try {
      const r = await api('POST', '/api/bank/import-csv', {
        csv, accountLabel: $('#csv-label').value || file.name.replace(/\.csv$/i, ''), flipSigns: $('#csv-flip').checked
      });
      toast(`Imported ${r.added} transaction${r.added === 1 ? '' : 's'}` +
        (r.duplicates ? `, ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped` : '') +
        (r.skipped ? `, ${r.skipped} unparseable row${r.skipped === 1 ? '' : 's'} skipped` : ''));
      bankTab = 'new';
      renderBanking();
    } catch (e) { toast(e.message, true); }
  };

  const applyBtn = $('#apply-rules');
  if (applyBtn) applyBtn.onclick = async () => {
    try {
      const r = await api('POST', '/api/bank/apply-rules');
      toast(`${r.applied} transaction${r.applied === 1 ? '' : 's'} categorized by rules`);
      renderBanking();
    } catch (e) { toast(e.message, true); }
  };
  $$('[data-delrule]').forEach(b => b.onclick = () =>
    api('DELETE', `/api/bank/rules/${b.dataset.delrule}`).then(() => { toast('Rule deleted'); renderBanking(); }));

  $$('[data-act]').forEach(b => {
    const t = txns.find(x => x.id === b.dataset.id);
    b.onclick = () => {
      if (b.dataset.act === 'expense') bankExpenseForm(t);
      else if (b.dataset.act === 'match') bankMatchForm(t);
      else if (b.dataset.act === 'exclude') api('POST', `/api/bank/transactions/${t.id}/exclude`).then(() => renderBanking()).catch(e => toast(e.message, true));
      else if (b.dataset.act === 'restore') api('POST', `/api/bank/transactions/${t.id}/restore`).then(() => renderBanking()).catch(e => toast(e.message, true));
    };
  });
}

async function bankExpenseForm(t) {
  const categories = await api('GET', '/api/categories');
  openModal({
    title: `Add expense — ${fmtMoney(Math.abs(t.amount))}`,
    body: `
      <div class="form-grid">
        <label class="field"><span>Vendor</span><input id="be-vendor" value="${esc(t.name)}"></label>
        <label class="field"><span>Category</span>
          <select id="be-category">${categories.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label class="field"><span>Date</span><input id="be-date" type="date" value="${t.date}"></label>
        <label class="field"><span>Amount</span><input value="${Math.abs(t.amount).toFixed(2)}" disabled></label>
        <label class="field full" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="be-rule" style="width:auto">
          <span style="margin:0">Always do this — save a rule matching “${esc(t.name)}”</span></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="be-save">Add expense</button>`,
    onOpen(root) {
      $('#be-save', root).onclick = async () => {
        try {
          await api('POST', `/api/bank/transactions/${t.id}/expense`, {
            vendor: $('#be-vendor', root).value,
            category: $('#be-category', root).value,
            date: $('#be-date', root).value
          });
          if ($('#be-rule', root).checked) {
            await api('POST', '/api/bank/rules', {
              match: t.name,
              category: $('#be-category', root).value,
              vendor: $('#be-vendor', root).value !== t.name ? $('#be-vendor', root).value : ''
            });
          }
          closeModal();
          toast('Expense added from bank feed');
          renderBanking();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

async function bankMatchForm(t) {
  const invoices = await api('GET', '/api/invoices');
  const open = invoices.filter(i => i.balance > 0 && i.status !== 'draft');
  if (!open.length) {
    return toast('No open invoices to match — exclude this deposit or create an invoice first', true);
  }
  // Exact-balance matches first, then closest.
  open.sort((a, b) => Math.abs(a.balance - t.amount) - Math.abs(b.balance - t.amount));
  openModal({
    title: `Match deposit — ${fmtMoney(t.amount)}`,
    body: `
      <p class="bank-help">Record this ${fmtDate(t.date)} deposit from “${esc(t.name)}” as a payment on:</p>
      <label class="field"><span>Invoice</span>
        <select id="bm-invoice">
          ${open.map(i => `<option value="${i.id}" ${Math.abs(i.balance - t.amount) < 0.005 ? 'selected' : ''} ${t.amount > i.balance + 0.005 ? 'disabled' : ''}>
            ${esc(i.number)} — ${esc(i.customerName)} (balance ${fmtMoney(i.balance)})${Math.abs(i.balance - t.amount) < 0.005 ? ' — exact match' : ''}
          </option>`).join('')}
        </select></label>`,
    footer: `<button class="btn btn-primary" id="bm-save">Record payment</button>`,
    onOpen(root) {
      $('#bm-save', root).onclick = async () => {
        try {
          const r = await api('POST', `/api/bank/transactions/${t.id}/match`, { invoiceId: $('#bm-invoice', root).value });
          closeModal();
          toast(r.invoice.status === 'paid' ? `${r.invoice.number} paid in full 🎉` : 'Payment recorded from bank feed');
          renderBanking();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// Plaid Link — loads Plaid's script on demand, then opens the link flow.
function launchPlaidLink() {
  const start = async () => {
    try {
      const { link_token } = await api('POST', '/api/bank/link-token');
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (publicToken, metadata) => {
          try {
            await api('POST', '/api/bank/exchange', {
              public_token: publicToken,
              institution: metadata.institution ? metadata.institution.name : 'Bank'
            });
            toast('Bank connected — syncing transactions…');
            await api('POST', '/api/bank/sync').catch(() => {});
            renderBanking();
          } catch (e) { toast(e.message, true); }
        },
        onExit: (err) => { if (err) toast(err.display_message || 'Bank connection cancelled', true); }
      });
      handler.open();
    } catch (e) { toast(e.message, true); }
  };
  if (window.Plaid) return start();
  const s = document.createElement('script');
  s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
  s.onload = start;
  s.onerror = () => toast('Could not load Plaid Link — check your internet connection', true);
  document.head.appendChild(s);
}

// ----- payroll -----

let payrollTab = 'runs';

const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Biweekly', semimonthly: 'Semimonthly', monthly: 'Monthly' };
const FILING_LABEL = { single: 'Single', married_jointly: 'Married filing jointly', head_of_household: 'Head of household' };
const DED_KIND_LABEL = {
  pretax_health: 'Health (§125, pre-tax)', pretax_401k: '401(k) traditional',
  roth_401k: '401(k) Roth', aftertax: 'Other (after-tax)'
};

async function renderPayroll() {
  const [employees, runs, liab, psettings, depcal] = await Promise.all([
    api('GET', '/api/payroll/employees'),
    api('GET', '/api/payroll/runs'),
    api('GET', '/api/payroll/liabilities'),
    api('GET', '/api/payroll/settings'),
    api('GET', '/api/payroll/deposits?year=' + new Date().getFullYear())
  ]);
  const obligations = [
    ...depcal.federal.map(g => ({ ...g, kind: 'Federal 941' })),
    ...depcal.njGit.map(g => ({ ...g, kind: 'NJ GIT' })),
    ...depcal.nj927.map(g => ({ ...g, kind: 'NJ-927 contributions' })),
    ...depcal.futa.map(g => ({ ...g, kind: 'FUTA' }))
  ].sort((a, b) => a.due.localeCompare(b.due));
  const today = todayISO();
  const ratesSet = psettings.njEmployerUiRate > 0;
  const owed = liab.buckets.reduce((s, b) => s + b.balance, 0);

  view.innerHTML = `
    <div class="page-head">
      <h1>Payroll</h1>
      <div class="actions">
        <button class="btn" id="pr-settings">Payroll settings</button>
        <button class="btn" id="pr-new-emp">+ Employee</button>
        <button class="btn btn-primary" id="pr-run">Run payroll</button>
      </div>
    </div>
    ${!ratesSet ? `<div class="card card-pad mb notice-card">
      <strong>Set up:</strong> enter your NJ employer UI and TDI rates (from your NJ rate notice /
      Employer Access) under <em>NJ employer rates</em> before running payroll. Then add each employee
      with the figures from their federal W-4 and NJ-W4.
    </div>` : ''}
    <div class="tabs">
      <button data-pt="runs" class="${payrollTab === 'runs' ? 'active' : ''}">Pay runs (${runs.length})</button>
      <button data-pt="employees" class="${payrollTab === 'employees' ? 'active' : ''}">Employees (${employees.filter(e => e.active).length})</button>
      <button data-pt="liabilities" class="${payrollTab === 'liabilities' ? 'active' : ''}">Tax liabilities (${fmtMoney(owed)})</button>
      <button data-pt="filings" class="${payrollTab === 'filings' ? 'active' : ''}">Filings</button>
    </div>

    ${payrollTab === 'filings' ? `<div id="filings-root"><div class="empty">Loading filings…</div></div>` : ''}

    ${payrollTab === 'runs' ? `
    <div class="card table-wrap">
      ${runs.length ? `<table>
        <thead><tr><th>Pay date</th><th>Period</th><th>Employees</th><th>Status</th>
          <th class="num">Gross</th><th class="num">Net pay</th><th></th></tr></thead>
        <tbody>
          ${runs.map(r => `<tr>
            <td class="strong"><a class="inv-link" href="#/payroll/runs/${r.id}">${fmtDate(r.payDate)}</a></td>
            <td class="muted">${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}</td>
            <td>${r.employees}</td>
            <td>${r.status === 'finalized' ? '<span class="badge paid">Finalized</span>' : '<span class="badge draft">Draft</span>'}</td>
            <td class="num">${fmtMoney(r.totals ? r.totals.gross : 0)}</td>
            <td class="num">${fmtMoney(r.totals ? r.totals.net : 0)}</td>
            <td class="actions-cell">
              <a class="btn-link" href="#/payroll/runs/${r.id}">Open</a>
              ${r.status === 'draft' ? `<button class="btn-link" data-delrun="${r.id}" style="color:var(--status-critical)">Delete</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">No pay runs yet — add employees, set your NJ rates, then click <strong>Run payroll</strong>.</div>`}
    </div>` : ''}

    ${payrollTab === 'employees' ? `
    <div class="card table-wrap">
      ${employees.length ? `<table>
        <thead><tr><th>Employee</th><th>Pay</th><th>Frequency</th><th>W-4 / NJ-W4</th><th>Deductions</th><th></th></tr></thead>
        <tbody>
          ${employees.map(e => `<tr ${e.active ? '' : 'style="opacity:.55"'}>
            <td><span class="strong">${esc(e.firstName)} ${esc(e.lastName)}</span>${e.active ? '' : ' <span class="badge draft">Inactive</span>'}<br><span class="muted">${esc(e.email)}</span></td>
            <td>${e.payType === 'salary' ? fmtMoney(e.annualSalary) + '/yr' : fmtMoney(e.hourlyRate) + '/hr'}</td>
            <td>${FREQ_LABEL[e.payFrequency]}</td>
            <td class="muted">${FILING_LABEL[e.fed.filingStatus]}${e.fed.multipleJobs ? ' · Step 2 ✓' : ''}<br>NJ table ${e.nj.rateTable}, ${e.nj.allowances} allowance${e.nj.allowances === 1 ? '' : 's'}</td>
            <td class="muted">${(e.deductions || []).filter(d => d.active).map(d => esc(d.name)).join(', ') || '—'}</td>
            <td class="actions-cell"><button class="btn-link" data-editemp="${e.id}">Edit</button></td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">No employees yet — click <strong>+ Employee</strong> and copy the figures from their W-4 and NJ-W4.</div>`}
    </div>` : ''}

    ${payrollTab === 'liabilities' ? `
    <div class="card table-wrap mb">
      <div class="card-pad" style="padding-bottom:0"><h2>Deposit calendar — ${depcal.year}
        <span class="muted" style="font-weight:400">(federal ${esc(depcal.settings.depositSchedule)} depositor · NJ ${esc(depcal.settings.njPayerType)} payer)</span></h2></div>
      ${obligations.length ? `<table>
        <thead><tr><th>Deposit</th><th>Period</th><th>Due</th><th class="num">Amount</th><th class="num">Outstanding</th><th></th></tr></thead>
        <tbody>
          ${obligations.map(g => `<tr>
            <td><span class="strong">${esc(g.kind)}</span>${g.nextDayRule ? '<br><span style="color:var(--status-critical);font-size:12px">⚠ $100,000 next-day rule</span>' : ''}
              ${g.depositRequired === false ? '<br><span class="muted" style="font-size:12px">under $500 — rolls forward</span>' : ''}</td>
            <td class="muted">${esc(g.label)}</td>
            <td ${g.outstanding > 0 && g.due < today ? 'style="color:var(--status-critical);font-weight:600"' : ''}>${fmtDate(g.due)}${g.outstanding > 0 && g.due < today ? ' (past due)' : ''}</td>
            <td class="num">${fmtMoney(g.amount)}</td>
            <td class="num ${g.outstanding > 0 ? 'strong' : ''}">${fmtMoney(g.outstanding)}</td>
            <td class="actions-cell">
              ${g.outstanding > 0 ? `
                ${(g.bucket === 'federal_941' || g.bucket === 'futa') ? (depcal.achConfigured ? `<button class="btn-link" data-ach="${g.bucket}|${g.key}">ACH file</button>` : '<span class="muted" title="Enter ACH details in Payroll settings">ACH: set up</span>') : ''}
                ${(g.bucket === 'nj_git' || g.bucket === 'nj_dol') ? (depcal.achConfigured && depcal.njAchConfigured ? `<button class="btn-link" data-ach="${g.bucket}|${g.key}">ACH file</button>` : '<span class="muted" title="Enter NJ EFT details in Payroll settings">NJ portal</span>') : ''}
                <button class="btn-link" data-obldep="${g.bucket}|${g.key}">Record deposit</button>` : (g.depositRequired === false ? '<span class="muted">rolls forward</span>' : '<span class="badge paid">Paid</span>')}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">No deposit obligations yet — finalize a pay run first.</div>'}
      <p class="bank-help" style="padding:0 20px 14px;margin:0">Download the ACH file and upload it to your bank's
        ACH origination portal — that is the payment. Then record the deposit here so the ledger and your books agree.
        Due dates are not shifted for banking holidays; when one lands on a holiday, pay early.</p>
    </div>
    <div class="card table-wrap mb">
      <table>
        <thead><tr><th>Liability</th><th>Paid to</th><th class="num">Accrued</th><th class="num">Deposited</th><th class="num">Owed</th><th></th></tr></thead>
        <tbody>
          ${liab.buckets.map(b => `<tr>
            <td>${esc(b.label)}</td>
            <td class="muted">${esc(b.payee)}</td>
            <td class="num">${fmtMoney(b.accrued)}</td>
            <td class="num">${fmtMoney(b.deposited)}</td>
            <td class="num ${b.balance > 0 ? 'strong' : ''}">${fmtMoney(b.balance)}</td>
            <td class="actions-cell">${b.balance > 0 ? `<button class="btn-link" data-deposit="${b.bucket}">Record deposit</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="bank-help">Liabilities accrue when a pay run is finalized. Recording a deposit books it as a
      “Payroll Taxes” expense on that date — pay through EFTPS / the NJ portal (or your payroll app's
      Tax Center), then record it here so your books and the bank feed agree.</p>
    ${liab.deposits.length ? `
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Deposit</th><th class="num">Amount</th></tr></thead>
        <tbody>${liab.deposits.slice(0, 10).map(d => `<tr>
          <td>${fmtDate(d.date)}</td><td class="muted">${esc(d.bucket)}${d.note ? ' — ' + esc(d.note) : ''}</td>
          <td class="num">${fmtMoney(d.amount)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}` : ''}`;

  $$('.tabs [data-pt]').forEach(b => b.onclick = () => { payrollTab = b.dataset.pt; renderPayroll(); });
  if (payrollTab === 'filings') renderFilings();
  $('#pr-settings').onclick = () => payrollSettingsForm(psettings);
  $('#pr-new-emp').onclick = () => employeeForm();
  $('#pr-run').onclick = () => payRunForm();
  $$('[data-editemp]').forEach(b => b.onclick = () => employeeForm(employees.find(e => e.id === b.dataset.editemp)));
  $$('[data-delrun]').forEach(b => b.onclick = () => confirmDelete('this draft pay run', () =>
    api('DELETE', `/api/payroll/runs/${b.dataset.delrun}`).then(() => { toast('Draft run deleted'); renderPayroll(); })));
  $$('[data-deposit]').forEach(b => {
    const bucket = liab.buckets.find(x => x.bucket === b.dataset.deposit);
    b.onclick = () => depositForm(bucket);
  });
  $$('[data-ach]').forEach(b => {
    const [bucket, key] = b.dataset.ach.split('|');
    b.onclick = () => downloadFile(`/api/payroll/nacha/tax?bucket=${bucket}&key=${encodeURIComponent(key)}&year=${depcal.year}`);
  });
  $$('[data-obldep]').forEach(b => {
    const [bucketKey, key] = b.dataset.obldep.split('|');
    const g = obligations.find(x => x.bucket === bucketKey && x.key === key);
    const bucket = liab.buckets.find(x => x.bucket === bucketKey);
    b.onclick = () => depositForm(bucket, g);
  });
}

let filingsYear = new Date().getFullYear();
let filingsQuarter = Math.floor(new Date().getMonth() / 3) + 1;

async function renderFilings() {
  const root = $('#filings-root');
  if (!root) return;
  const d = await api('GET', `/api/payroll/filings?year=${filingsYear}&quarter=${filingsQuarter}`);
  const f = d.f941, nj = d.nj927, f9 = d.f940;
  const row = (label, v, opts = {}) => `<tr class="${opts.total ? 'total-row' : ''}"><td>${label}</td><td class="num">${opts.raw ?? fmtMoney(v)}</td></tr>`;

  root.innerHTML = `
    <div class="range-row">
      <label class="field" style="width:110px"><span>Year</span>
        <select id="fl-year">${[2024, 2025, 2026].map(y => `<option ${y === filingsYear ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label class="field" style="width:110px"><span>Quarter</span>
        <select id="fl-q">${[1, 2, 3, 4].map(q => `<option value="${q}" ${q === filingsQuarter ? 'selected' : ''}>Q${q}</option>`).join('')}</select></label>
    </div>
    <div class="grid-2 mb">
      <div class="card table-wrap">
        <div class="card-pad" style="padding-bottom:0"><h2>Form 941 — Q${f.quarter} ${f.year} <span class="muted" style="font-weight:400">(${f.checks} paychecks)</span></h2></div>
        <table><tbody>
          ${row('1. Number of employees', f.l1Employees, { raw: String(f.l1Employees) })}
          ${row('2. Wages, tips, compensation', f.l2Wages)}
          ${row('3. Federal income tax withheld', f.l3Fit)}
          ${row('5a. Taxable SS wages × 12.4%', f.l5aSsTax, { raw: fmtMoney(f.l5aSsWages) + ' → ' + fmtMoney(f.l5aSsTax) })}
          ${f.l5bSsTips ? row('5b. Taxable SS tips × 12.4%', f.l5bSsTipsTax, { raw: fmtMoney(f.l5bSsTips) + ' → ' + fmtMoney(f.l5bSsTipsTax) }) : ''}
          ${row('5c. Medicare wages × 2.9%', f.l5cMedTax, { raw: fmtMoney(f.l5cMedWages) + ' → ' + fmtMoney(f.l5cMedTax) })}
          ${f.l5dAddlWages ? row('5d. Additional Medicare × 0.9%', f.l5dAddlTax) : ''}
          ${row('5e. Total FICA', f.l5eTotalFica)}
          ${row('6. Total before adjustments', f.l6BeforeAdjust)}
          ${row('7. Fractions of cents', f.l7Fractions, { raw: (f.l7Fractions >= 0 ? '' : '−') + fmtMoney(Math.abs(f.l7Fractions)) })}
          ${row('10/12. Total taxes', f.l12TotalAfterCredits, { total: true })}
          ${row('13. Deposits for the quarter', f.l13Deposits)}
          ${f.l13Unattributed ? row('(deposits without a period — allocate)', f.l13Unattributed) : ''}
          ${f.l14BalanceDue ? row('14. Balance due', f.l14BalanceDue, { total: true }) : row('15. Overpayment', f.l15Overpayment, { total: true })}
        </tbody></table>
        <div class="card-pad" style="padding-top:8px"><h2>${d.depositSchedule === 'semiweekly' ? 'Schedule B — liability by payday' : 'Line 16 — monthly liability'}</h2></div>
        <table><tbody>
          ${d.depositSchedule === 'semiweekly'
            ? (f.scheduleB.map(b2 => row(fmtDate(b2.payDate), b2.liability)).join('') || row('No paydays this quarter', 0, { raw: '—' }))
            : Object.entries(f.monthlyLiability).map(([m, v]) => row(`Month ${m}`, v)).join('')}
        </tbody></table>
      </div>
      <div>
        <div class="card table-wrap mb">
          <div class="card-pad" style="padding-bottom:0"><h2>NJ-927 — Q${nj.quarter} ${nj.year} <span class="muted" style="font-weight:400">(due ${fmtDate(nj.due)}, file at the NJ portal)</span></h2></div>
          <table><tbody>
            ${row('Gross wages', nj.grossWages)}
            ${row('GIT withheld', nj.gitWithheld)}
            ${Object.entries(nj.gitByMonth).map(([m, v]) => row(`— month ${m}`, v)).join('')}
            ${row('UI taxable wages', nj.uiTaxableWages)}
            ${row('TDI taxable wages', nj.tdiTaxableWages)}
            ${row('UI/WF/SWF + TDI + FLI contributions', nj.contributions.amount)}
            ${row('Total due with return', nj.totalDue, { total: true })}
          </tbody></table>
          <div class="card-pad" style="padding-top:8px"><h2>WR-30 wage detail</h2></div>
          <table>
            <thead><tr><th>Employee</th><th class="num">Gross</th><th class="num">Checks*</th></tr></thead>
            <tbody>${d.wr30.map(w => `<tr><td>${esc(w.name)}</td><td class="num">${fmtMoney(w.gross)}</td><td class="num">${w.checks}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No paychecks this quarter</td></tr>'}
            </tbody>
          </table>
          <p class="bank-help" style="padding:0 20px 14px;margin:0">*Base weeks start from the check count —
            review before filing. SSNs are entered at the portal; QuickBucks doesn't store them.</p>
        </div>
        <div class="card table-wrap">
          <div class="card-pad" style="padding-bottom:0"><h2>Form 940 — ${f9.year} <span class="muted" style="font-weight:400">(annual, due Jan 31)</span></h2></div>
          <table><tbody>
            ${row('3. Total payments to employees', f9.l3TotalPayments)}
            ${row('4. Exempt payments (§125)', f9.l4ExemptPayments)}
            ${row('5. Excess over the $7,000 base', f9.l5ExcessOverBase)}
            ${row('7. Taxable FUTA wages', f9.l7TaxableFutaWages)}
            ${row('8/12. FUTA tax (0.6%)', f9.l12TotalTax, { total: true })}
            ${row('13. Deposits', f9.l13Deposits)}
            ${f9.l14BalanceDue ? row('14. Balance due', f9.l14BalanceDue, { total: true }) : row('15. Overpayment', f9.l15Overpayment, { total: true })}
          </tbody></table>
        </div>
      </div>
    </div>
    <p class="bank-help">Figures computed from finalized pay runs. Transcribe into the IRS/NJ forms or portals
      (or e-file via your provider); pay through the Deposit calendar. Have your accountant review the first
      quarter before transmitting.</p>`;

  $('#fl-year').onchange = () => { filingsYear = Number($('#fl-year').value); renderFilings(); };
  $('#fl-q').onchange = () => { filingsQuarter = Number($('#fl-q').value); renderFilings(); };
}

function payrollSettingsForm(current) {
  openModal({
    title: 'Payroll settings',
    wide: true,
    body: `
      <div class="form-grid">
        <div class="full"><span class="doc-meta-label">NJ employer rates (from your NJ rate notice — enter 3.1 for 3.1%)</span></div>
        <label class="field"><span>Employer UI rate (%)</span>
          <input id="ps-ui" type="number" step="0.0001" min="0" value="${current.njEmployerUiRate ? current.njEmployerUiRate * 100 : ''}"></label>
        <label class="field"><span>Employer TDI rate (%)</span>
          <input id="ps-tdi" type="number" step="0.0001" min="0" value="${current.njEmployerTdiRate ? current.njEmployerTdiRate * 100 : ''}"></label>

        <div class="full section-divider"><span class="doc-meta-label">Deposit schedules</span></div>
        <label class="field"><span>Federal 941 depositor schedule</span>
          <select id="ps-sched">
            <option value="monthly" ${current.depositSchedule !== 'semiweekly' ? 'selected' : ''}>Monthly (liability ≤ $50k lookback)</option>
            <option value="semiweekly" ${current.depositSchedule === 'semiweekly' ? 'selected' : ''}>Semiweekly</option>
          </select></label>
        <label class="field"><span>NJ GIT payer type</span>
          <select id="ps-njtype">
            <option value="quarterly" ${current.njPayerType === 'quarterly' ? 'selected' : ''}>Quarterly (NJ-927)</option>
            <option value="monthly" ${current.njPayerType === 'monthly' ? 'selected' : ''}>Monthly (NJ-500)</option>
            <option value="weekly" ${current.njPayerType === 'weekly' ? 'selected' : ''}>Weekly (withheld ≥ $10k/yr)</option>
          </select></label>

        <div class="full section-divider"><span class="doc-meta-label">ACH origination (for bank-ready NACHA files — ask your bank to enable ACH origination)</span></div>
        <label class="field"><span>Company EIN</span><input id="ps-ein" value="${esc(current.ein)}" placeholder="12-3456789"></label>
        <label class="field"><span>Your bank routing (ODFI)</span><input id="ps-routing" value="${esc(current.ach.bankRouting)}"></label>
        <label class="field"><span>Immediate destination (bank's routing)</span><input id="ps-dest" value="${esc(current.ach.immediateDestination)}"></label>
        <label class="field"><span>Immediate origin (usually 1 + EIN)</span><input id="ps-origin" value="${esc(current.ach.immediateOrigin)}"></label>
        <label class="field"><span>Destination name (your bank)</span><input id="ps-destname" value="${esc(current.ach.destinationName)}"></label>

        <div class="full section-divider"><span class="doc-meta-label">New Jersey ACH credit (from your EFT1-C enrollment reply)</span></div>
        <label class="field"><span>NJ taxpayer ID (12 digits: EIN + 000)</span><input id="ps-njid" value="${esc(current.njTaxpayerId)}"></label>
        <label class="field"><span>NJ bank routing</span><input id="ps-njrouting" value="${esc(current.njAch.routing)}"></label>
        <label class="field"><span>NJ bank account</span><input id="ps-njaccount" value="${esc(current.njAch.account)}"></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="ps-save">Save settings</button>`,
    onOpen(root) {
      $('#ps-save', root).onclick = async () => {
        try {
          await api('PUT', '/api/payroll/settings', {
            njEmployerUiRate: Number($('#ps-ui', root).value) / 100,
            njEmployerTdiRate: Number($('#ps-tdi', root).value) / 100,
            depositSchedule: $('#ps-sched', root).value,
            njPayerType: $('#ps-njtype', root).value,
            ein: $('#ps-ein', root).value,
            njTaxpayerId: $('#ps-njid', root).value,
            ach: {
              bankRouting: $('#ps-routing', root).value,
              immediateDestination: $('#ps-dest', root).value,
              immediateOrigin: $('#ps-origin', root).value,
              destinationName: $('#ps-destname', root).value
            },
            njAch: { routing: $('#ps-njrouting', root).value, account: $('#ps-njaccount', root).value }
          });
          closeModal();
          toast('Payroll settings saved');
          renderPayroll();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

function employeeForm(emp) {
  const e = emp || {};
  const fed = e.fed || {};
  const nj = e.nj || {};
  const opening = e.ytdOpening || {};
  const dedRow = d => `<tr>
    <td><input class="dd-name" value="${esc(d.name || '')}" placeholder="e.g. Health premium"></td>
    <td><select class="dd-kind">${Object.entries(DED_KIND_LABEL).map(([k, l]) =>
      `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td class="num-col"><select class="dd-type">
      <option value="fixed" ${d.amountType !== 'percent' ? 'selected' : ''}>$</option>
      <option value="percent" ${d.amountType === 'percent' ? 'selected' : ''}>%</option></select></td>
    <td class="num-col"><input class="dd-amount" type="number" step="0.01" min="0" value="${d.amount ?? ''}"></td>
    <td class="rm-col"><button type="button" class="rm-item">&times;</button></td>
  </tr>`;

  openModal({
    title: emp ? `Edit ${e.firstName} ${e.lastName}` : 'New employee',
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>First name</span><input id="em-first" value="${esc(e.firstName || '')}"></label>
        <label class="field"><span>Last name</span><input id="em-last" value="${esc(e.lastName || '')}"></label>
        <label class="field"><span>Email</span><input id="em-email" value="${esc(e.email || '')}"></label>
        <label class="field"><span>Status</span>
          <select id="em-active"><option value="1">Active</option><option value="0" ${e.active === false ? 'selected' : ''}>Inactive</option></select></label>

        <div class="full section-divider"><span class="doc-meta-label">Pay</span></div>
        <label class="field"><span>Pay type</span>
          <select id="em-paytype"><option value="salary" ${e.payType !== 'hourly' ? 'selected' : ''}>Salary</option>
          <option value="hourly" ${e.payType === 'hourly' ? 'selected' : ''}>Hourly</option></select></label>
        <label class="field"><span>Pay frequency</span>
          <select id="em-freq">${Object.entries(FREQ_LABEL).map(([k, l]) =>
            `<option value="${k}" ${e.payFrequency === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field" id="f-salary"><span>Annual salary</span><input id="em-salary" type="number" step="0.01" min="0" value="${e.annualSalary || ''}"></label>
        <label class="field" id="f-hourly"><span>Hourly rate</span><input id="em-rate" type="number" step="0.01" min="0" value="${e.hourlyRate || ''}"></label>
        <label class="field" id="f-hours"><span>Default hours per check</span><input id="em-hours" type="number" step="0.01" min="0" value="${e.defaultHours || ''}"></label>

        <div class="full section-divider"><span class="doc-meta-label">Payment</span></div>
        <label class="field"><span>Payment method</span>
          <select id="em-paymethod"><option value="check" ${e.paymentMethod !== 'direct_deposit' ? 'selected' : ''}>Check</option>
          <option value="direct_deposit" ${e.paymentMethod === 'direct_deposit' ? 'selected' : ''}>Direct deposit (ACH)</option></select></label>
        <label class="field"><span>Bank routing (9 digits)</span><input id="em-routing" value="${esc(e.bankRouting || '')}"></label>
        <label class="field"><span>Bank account</span><input id="em-account" value="${esc(e.bankAccount || '')}"></label>
        <label class="field"><span>Account type</span>
          <select id="em-accttype"><option value="checking" ${e.bankAccountType !== 'savings' ? 'selected' : ''}>Checking</option>
          <option value="savings" ${e.bankAccountType === 'savings' ? 'selected' : ''}>Savings</option></select></label>

        <div class="full section-divider"><span class="doc-meta-label">Federal W-4 (2020 or later)</span></div>
        <label class="field"><span>Step 1(c) filing status</span>
          <select id="em-filing">${Object.entries(FILING_LABEL).map(([k, l]) =>
            `<option value="${k}" ${fed.filingStatus === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="em-step2" style="width:auto" ${fed.multipleJobs ? 'checked' : ''}>
          <span style="margin:0">Step 2 checkbox (multiple jobs)</span></label>
        <label class="field"><span>Step 3: dependents credit ($/yr)</span><input id="em-dep" type="number" step="1" min="0" value="${fed.dependentsCredit || ''}"></label>
        <label class="field"><span>Step 4(a): other income ($/yr)</span><input id="em-other" type="number" step="1" min="0" value="${fed.otherIncome || ''}"></label>
        <label class="field"><span>Step 4(b): deductions ($/yr)</span><input id="em-ded4b" type="number" step="1" min="0" value="${fed.deductions || ''}"></label>
        <label class="field"><span>Step 4(c): extra withholding ($/check)</span><input id="em-extra" type="number" step="0.01" min="0" value="${fed.extraWithholding || ''}"></label>
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="em-exempt" style="width:auto" ${fed.exempt ? 'checked' : ''}>
          <span style="margin:0">Exempt from federal withholding</span></label>

        <div class="full section-divider"><span class="doc-meta-label">NJ-W4</span></div>
        <label class="field"><span>Rate table (line 3)</span>
          <select id="em-njtable">${['A', 'B', 'C', 'D', 'E'].map(t =>
            `<option ${nj.rateTable === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field"><span>Allowances (line 4)</span><input id="em-njallow" type="number" step="1" min="0" value="${nj.allowances || 0}"></label>
        <label class="field"><span>Extra withholding (line 5, $/check)</span><input id="em-njextra" type="number" step="0.01" min="0" value="${nj.extraWithholding || ''}"></label>
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="em-njexempt" style="width:auto" ${nj.exempt ? 'checked' : ''}>
          <span style="margin:0">Exempt from NJ withholding</span></label>

        <div class="full section-divider"><span class="doc-meta-label">Recurring deductions</span></div>
        <div class="full">
          <table class="items-table">
            <thead><tr><th>Name</th><th>Type</th><th class="num-col">$/%</th><th class="num-col">Amount</th><th class="rm-col"></th></tr></thead>
            <tbody id="ded-body">${(e.deductions || []).filter(d => d.active !== false).map(dedRow).join('')}</tbody>
          </table>
          <button type="button" class="btn btn-sm" id="add-ded">+ Add deduction</button>
        </div>

        <details class="full">
          <summary class="doc-meta-label" style="cursor:pointer">Opening year-to-date (mid-year switch from another provider)</summary>
          <p class="bank-help" style="margin-top:8px">From the employee's final pay stub with the old provider —
            keeps Social Security, UI/TDI/FLI, and FUTA wage-base caps accurate.</p>
          <div class="form-grid">
            <label class="field"><span>Year</span><input id="yo-year" type="number" step="1" value="${opening.year || new Date().getFullYear()}"></label>
            <label class="field"><span>Social Security wages YTD</span><input id="yo-ss" type="number" step="0.01" min="0" value="${opening.ssWages || ''}"></label>
            <label class="field"><span>Medicare wages YTD</span><input id="yo-med" type="number" step="0.01" min="0" value="${opening.medicareWages || ''}"></label>
            <label class="field"><span>FUTA wages YTD</span><input id="yo-futa" type="number" step="0.01" min="0" value="${opening.futaWages || ''}"></label>
            <label class="field"><span>NJ UI wages YTD</span><input id="yo-ui" type="number" step="0.01" min="0" value="${opening.njUiWages || ''}"></label>
            <label class="field"><span>NJ TDI/FLI wages YTD</span><input id="yo-tdi" type="number" step="0.01" min="0" value="${opening.njTdiWages || ''}"></label>
          </div>
        </details>
      </div>`,
    footer: `<button class="btn btn-primary" id="em-save">${emp ? 'Save changes' : 'Add employee'}</button>`,
    onOpen(root) {
      const syncPayFields = () => {
        const hourly = $('#em-paytype', root).value === 'hourly';
        $('#f-salary', root).style.display = hourly ? 'none' : '';
        $('#f-hourly', root).style.display = hourly ? '' : 'none';
        $('#f-hours', root).style.display = hourly ? '' : 'none';
      };
      $('#em-paytype', root).onchange = syncPayFields;
      syncPayFields();
      $('#add-ded', root).onclick = () => $('#ded-body', root).insertAdjacentHTML('beforeend', dedRow({}));
      $('#ded-body', root).addEventListener('click', ev => {
        if (ev.target.classList.contains('rm-item')) ev.target.closest('tr').remove();
      });
      $('#em-save', root).onclick = async () => {
        const hasOpening = ['#yo-ss', '#yo-med', '#yo-futa', '#yo-ui', '#yo-tdi']
          .some(sel => Number($(sel, root).value) > 0);
        const body = {
          firstName: $('#em-first', root).value,
          lastName: $('#em-last', root).value,
          email: $('#em-email', root).value,
          active: $('#em-active', root).value === '1',
          payType: $('#em-paytype', root).value,
          annualSalary: $('#em-salary', root).value,
          hourlyRate: $('#em-rate', root).value,
          payFrequency: $('#em-freq', root).value,
          defaultHours: $('#em-hours', root).value,
          paymentMethod: $('#em-paymethod', root).value,
          bankRouting: $('#em-routing', root).value,
          bankAccount: $('#em-account', root).value,
          bankAccountType: $('#em-accttype', root).value,
          fed: {
            filingStatus: $('#em-filing', root).value,
            multipleJobs: $('#em-step2', root).checked,
            dependentsCredit: $('#em-dep', root).value,
            otherIncome: $('#em-other', root).value,
            deductions: $('#em-ded4b', root).value,
            extraWithholding: $('#em-extra', root).value,
            exempt: $('#em-exempt', root).checked
          },
          nj: {
            rateTable: $('#em-njtable', root).value,
            allowances: $('#em-njallow', root).value,
            extraWithholding: $('#em-njextra', root).value,
            exempt: $('#em-njexempt', root).checked
          },
          deductions: $$('#ded-body tr', root).map(tr => ({
            name: $('.dd-name', tr).value,
            kind: $('.dd-kind', tr).value,
            amountType: $('.dd-type', tr).value,
            amount: $('.dd-amount', tr).value
          })),
          ytdOpening: hasOpening ? {
            year: $('#yo-year', root).value,
            ssWages: $('#yo-ss', root).value,
            medicareWages: $('#yo-med', root).value,
            futaWages: $('#yo-futa', root).value,
            njUiWages: $('#yo-ui', root).value,
            njTdiWages: $('#yo-tdi', root).value
          } : null
        };
        try {
          if (emp) await api('PUT', `/api/payroll/employees/${emp.id}`, body);
          else await api('POST', '/api/payroll/employees', body);
          closeModal();
          toast(emp ? 'Employee updated' : 'Employee added');
          payrollTab = 'employees';
          renderPayroll();
        } catch (err) { toast(err.message, true); }
      };
    }
  });
}

function payRunForm() {
  const today = todayISO();
  openModal({
    title: 'Run payroll',
    body: `
      <div class="form-grid">
        <label class="field"><span>Period start</span><input id="run-start" type="date" value="${addDays(today, -13)}"></label>
        <label class="field"><span>Period end</span><input id="run-end" type="date" value="${today}"></label>
        <label class="field"><span>Pay date (check date)</span><input id="run-paydate" type="date" value="${today}"></label>
      </div>
      <p class="bank-help" style="margin-top:10px">Every active employee is included. You'll enter hours,
        tips, and bonuses on the next screen before anything is finalized.</p>`,
    footer: `<button class="btn btn-primary" id="run-create">Create draft run</button>`,
    onOpen(root) {
      $('#run-create', root).onclick = async () => {
        try {
          const run = await api('POST', '/api/payroll/runs', {
            periodStart: $('#run-start', root).value,
            periodEnd: $('#run-end', root).value,
            payDate: $('#run-paydate', root).value
          });
          closeModal();
          location.hash = `#/payroll/runs/${run.id}`;
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

function depositForm(bucket, obligation) {
  openModal({
    title: 'Record tax deposit',
    body: `
      <p class="bank-help">${esc(obligation ? `${obligation.label} — due ${fmtDate(obligation.due)}` : bucket.label)}<br>Paid to: <strong>${esc(bucket.payee)}</strong></p>
      <div class="form-grid">
        <label class="field"><span>Amount (owed ${fmtMoney(obligation ? obligation.outstanding : bucket.balance)})</span>
          <input id="dep-amount" type="number" step="0.01" min="0.01" value="${obligation ? obligation.outstanding : bucket.balance}"></label>
        <label class="field"><span>Date paid</span><input id="dep-date" type="date" value="${todayISO()}"></label>
        <label class="field full"><span>Confirmation # / note (optional)</span><input id="dep-note"></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="dep-save">Record deposit</button>`,
    onOpen(root) {
      $('#dep-save', root).onclick = async () => {
        try {
          await api('POST', '/api/payroll/liabilities/deposit', {
            bucket: bucket.bucket,
            periodKey: obligation ? obligation.key : '',
            amount: Number($('#dep-amount', root).value),
            date: $('#dep-date', root).value,
            note: $('#dep-note', root).value
          });
          closeModal();
          toast('Deposit recorded and booked as a Payroll Taxes expense');
          renderPayroll();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

async function renderPayrollRun(id) {
  const run = await api('GET', `/api/payroll/runs/${id}`);
  const draft = run.status === 'draft';
  const num = v => (v ? v : '');

  view.innerHTML = `
    <div class="page-head no-print">
      <h1><a href="#/payroll" class="back-link">← Payroll</a>&nbsp; ${fmtDate(run.payDate)}
        ${draft ? '<span class="badge draft">Draft</span>' : '<span class="badge paid">Finalized</span>'}</h1>
      <div class="actions">
        ${draft ? `<button class="btn" id="run-import">Import timecards</button>
                   <button class="btn" id="run-save">Save &amp; recompute</button>
                   <button class="btn btn-primary" id="run-finalize">Finalize run</button>`
                : `<button class="btn" id="run-nacha">Direct deposit (ACH file)</button>`}
      </div>
    </div>
    <p class="bank-help">Pay period ${fmtDate(run.periodStart)} – ${fmtDate(run.periodEnd)}.</p>
    ${(run.warnings || []).map(w => `<div class="card card-pad mb notice-card">⚠ ${esc(w)}</div>`).join('')}
    <div class="card table-wrap mb">
      <table>
        <thead><tr><th>Employee</th><th class="num">Hours</th><th class="num">OT</th><th class="num">Bonus</th>
          <th class="num">Tips</th><th class="num">Reimb.</th><th class="num">Gross</th>
          <th class="num">Taxes</th><th class="num">Deductions</th><th class="num">Net pay</th>${draft ? '' : '<th></th>'}</tr></thead>
        <tbody>
          ${run.checks.map(c => {
            const k = c.computed || {};
            const cell = (key, step = '0.01') => draft
              ? `<input class="run-input" data-emp="${c.employeeId}" data-k="${key}" type="number" min="0" step="${step}" value="${num(c.inputs[key])}">`
              : (c.inputs[key] ? c.inputs[key] : '—');
            return `<tr>
              <td class="strong">${esc(c.employeeName)}</td>
              <td class="num">${cell('hours', '0.25')}</td>
              <td class="num">${cell('otHours', '0.25')}</td>
              <td class="num">${cell('bonus')}</td>
              <td class="num">${cell('tips')}</td>
              <td class="num">${cell('reimbursement')}</td>
              <td class="num">${fmtMoney(k.gross)}</td>
              <td class="num">${fmtMoney(k.employeeTaxes)}</td>
              <td class="num">${fmtMoney(k.totalDeductions)}</td>
              <td class="num strong">${fmtMoney(k.net)}</td>
              ${draft ? '' : `<td class="actions-cell"><a class="btn-link" href="#/payroll/stubs/${run.id}/${c.employeeId}">Pay stub</a></td>`}
            </tr>`;
          }).join('')}
          <tr class="total-row">
            <td>Totals</td><td colspan="5"></td>
            <td class="num">${fmtMoney(run.totals.gross)}</td>
            <td class="num">${fmtMoney(run.totals.employeeTaxes)}</td>
            <td class="num">${fmtMoney(run.totals.deductions)}</td>
            <td class="num">${fmtMoney(run.totals.net)}</td>${draft ? '' : '<td></td>'}
          </tr>
        </tbody>
      </table>
    </div>
    <div class="card card-pad">
      <h2>Employer cost</h2>
      <p class="bank-help" style="margin:0">Employer taxes this run (Social Security, Medicare, FUTA, NJ UI, NJ TDI):
        <strong>${fmtMoney(run.totals.erTotal)}</strong> — total cost of this payroll:
        <strong>${fmtMoney(run.totals.gross + run.totals.erTotal + run.totals.reimbursements)}</strong>.
        ${draft ? 'Finalizing posts the net pay to your books and accrues withheld + employer taxes as liabilities.' : 'Net pay was posted to your books; taxes are tracked under Tax liabilities.'}</p>
    </div>`;

  const nachaBtn = $('#run-nacha');
  if (nachaBtn) nachaBtn.onclick = () => downloadFile(`/api/payroll/runs/${run.id}/nacha`);

  if (draft) {
    const collect = () => ({
      checks: run.checks.map(c => ({
        employeeId: c.employeeId,
        inputs: Object.fromEntries(['hours', 'otHours', 'bonus', 'tips', 'reimbursement'].map(k => {
          const input = $(`.run-input[data-emp="${c.employeeId}"][data-k="${k}"]`);
          return [k, input ? Number(input.value) || 0 : c.inputs[k]];
        }))
      }))
    });
    const saveRun = async () => {
      await api('PUT', `/api/payroll/runs/${run.id}`, collect());
    };
    $('#run-save').onclick = async () => {
      try { await saveRun(); toast('Run recomputed'); renderPayrollRun(id); }
      catch (e) { toast(e.message, true); }
    };
    $('#run-import').onclick = () => openModal({
      title: 'Import timecards (Dripos CSV)',
      body: `
        <p class="bank-help">Upload the Time Card export — hours, weekly overtime (&gt;40h Sun–Sat),
        and card tips are filled in per employee, matched by email or name.</p>
        <label class="field"><span>Timecard file</span><input type="file" id="tc-file" accept=".csv,text/csv"></label>`,
      footer: `<button class="btn btn-primary" id="tc-go">Import</button>`,
      onOpen(root) {
        $('#tc-go', root).onclick = async () => {
          const file = $('#tc-file', root).files[0];
          if (!file) return toast('Choose a CSV file first', true);
          try {
            const r = await api('POST', `/api/payroll/runs/${run.id}/import-timecards`, { csv: await file.text() });
            closeModal();
            toast(`Filled in ${r.updated} paycheck${r.updated === 1 ? '' : 's'} — overtime: ${r.otSource}`);
            if (r.unmatched.length) toast('No matching employee: ' + r.unmatched.join(', '), true);
            if (r.notInRun.length) toast('Matched but not in this run: ' + r.notInRun.join(', '), true);
            renderPayrollRun(id);
          } catch (e) { toast(e.message, true); }
        };
      }
    });
    $('#run-finalize').onclick = () => openModal({
      title: 'Finalize this pay run?',
      body: `<p>Finalizing freezes every paycheck, posts <strong>${fmtMoney(run.totals.net)}</strong> of net pay
        to your books dated ${fmtDate(run.payDate)}, and accrues the withheld and employer taxes as
        liabilities. Finalized runs cannot be edited or deleted.</p>`,
      footer: `<button class="btn" id="fin-cancel">Cancel</button>
               <button class="btn btn-primary" id="fin-go">Finalize</button>`,
      onOpen(root) {
        $('#fin-cancel', root).onclick = closeModal;
        $('#fin-go', root).onclick = async () => {
          try {
            await saveRun();
            await api('POST', `/api/payroll/runs/${run.id}/finalize`);
            closeModal();
            toast('Pay run finalized and posted to your books');
            renderPayrollRun(id);
          } catch (e) { toast(e.message, true); }
        };
      }
    });
  }
}

async function renderPayStub(runId, employeeId) {
  const run = await api('GET', `/api/payroll/runs/${runId}`);
  const chk = run.checks.find(c => c.employeeId === employeeId);
  if (!chk || !chk.computed) {
    view.innerHTML = '<div class="empty">Pay stub not found.</div>';
    return;
  }
  const k = chk.computed;
  const row = (label, amt) => amt > 0 ? `<tr><td>${label}</td><td class="num">${fmtMoney(amt)}</td></tr>` : '';

  view.innerHTML = `
    <div class="page-head no-print">
      <h1><a href="#/payroll/runs/${run.id}" class="back-link">← Pay run</a></h1>
      <div class="actions"><button class="btn btn-primary" id="stub-print">Print / Save PDF</button></div>
    </div>
    <div class="card invoice-doc">
      <div class="doc-head">
        <div><div class="doc-company">${esc(run.company)}</div></div>
        <div class="doc-title">
          <div class="doc-invoice-label">PAY STUB</div>
          <div class="doc-number">${fmtDate(run.payDate)}</div>
        </div>
      </div>
      <div class="doc-meta">
        <div>
          <div class="doc-meta-label">Employee</div>
          <div class="strong">${esc(chk.employeeName)}</div>
        </div>
        <div class="doc-dates">
          <div><span class="doc-meta-label">Pay period</span> ${fmtDate(run.periodStart)} – ${fmtDate(run.periodEnd)}</div>
          <div><span class="doc-meta-label">Pay date</span> ${fmtDate(run.payDate)}</div>
        </div>
      </div>
      <table class="doc-items">
        <thead><tr><th>Earnings</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${row('Regular', k.regular)}${row('Overtime (1.5×)', k.overtime)}
          ${row('Bonus', k.bonus)}${row('Tips', k.tips)}
          <tr class="total-row"><td>Gross pay</td><td class="num">${fmtMoney(k.gross)}</td></tr>
        </tbody>
      </table>
      <table class="doc-items" style="margin-top:18px">
        <thead><tr><th>Taxes withheld</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${row('Federal income tax', k.fit)}${row('Social Security', k.ss)}
          ${row('Medicare', k.medicare)}${row('NJ income tax', k.njSit)}
          ${row('NJ UI/WF/SWF', k.njUiWf)}${row('NJ TDI', k.njTdi)}${row('NJ FLI', k.njFli)}
          <tr class="total-row"><td>Total taxes</td><td class="num">${fmtMoney(k.employeeTaxes)}</td></tr>
        </tbody>
      </table>
      ${k.deductions.length ? `
      <table class="doc-items" style="margin-top:18px">
        <thead><tr><th>Deductions</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${k.deductions.map(d => `<tr><td>${esc(d.name)} <span class="muted">(${DED_KIND_LABEL[d.kind] || d.kind})</span></td><td class="num">${fmtMoney(d.amount)}</td></tr>`).join('')}
          <tr class="total-row"><td>Total deductions</td><td class="num">${fmtMoney(k.totalDeductions)}</td></tr>
        </tbody>
      </table>` : ''}
      <div class="doc-totals">
        ${k.reimbursement > 0 ? `<div class="doc-total-row muted"><span>Reimbursement (non-taxable)</span><span>+${fmtMoney(k.reimbursement)}</span></div>` : ''}
        <div class="doc-total-row doc-balance"><span>Net pay</span><span>${fmtMoney(k.net)}</span></div>
      </div>
      <div class="doc-footer">${run.status === 'draft' ? 'DRAFT — not yet finalized' : ''}</div>
    </div>`;
  $('#stub-print').onclick = () => window.print();
}

// ----- customers -----

async function renderCustomers() {
  const customers = await api('GET', '/api/customers');
  view.innerHTML = `
    <div class="page-head">
      <h1>Customers</h1>
      <div class="actions"><button class="btn btn-primary" id="new-customer">+ New customer</button></div>
    </div>
    <div class="card table-wrap">
      ${customers.length ? `<table>
        <thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th class="num">Total billed</th><th class="num">Open balance</th><th></th></tr></thead>
        <tbody>
          ${customers.map(c => `<tr>
            <td><span class="strong">${esc(c.company || c.name)}</span>${c.company ? `<br><span class="muted">${esc(c.name)}</span>` : ''}</td>
            <td>${esc(c.email)}</td>
            <td>${esc(c.phone)}</td>
            <td class="num">${fmtMoney(c.totalBilled)}</td>
            <td class="num ${c.openBalance > 0 ? 'strong' : ''}">${fmtMoney(c.openBalance)}</td>
            <td class="actions-cell">
              <button class="btn-link" data-act="edit" data-id="${c.id}">Edit</button>
              <button class="btn-link" data-act="del" data-id="${c.id}" style="color:var(--status-critical)">Delete</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">No customers yet — add your first one.</div>'}
    </div>`;
  $('#new-customer').onclick = () => customerForm();
  $$('[data-act]').forEach(b => {
    const c = customers.find(x => x.id === b.dataset.id);
    b.onclick = () => {
      if (b.dataset.act === 'edit') customerForm(c);
      else confirmDelete(`customer "${c.company || c.name}"`, () =>
        api('DELETE', `/api/customers/${c.id}`).then(() => { toast('Customer deleted'); renderCustomers(); }));
    };
  });
}

function customerForm(c, after) {
  openModal({
    title: c ? 'Edit customer' : 'New customer',
    body: `
      <div class="form-grid">
        <label class="field"><span>Contact name</span><input id="c-name" value="${esc(c ? c.name : '')}" placeholder="Jane Smith"></label>
        <label class="field"><span>Company (optional)</span><input id="c-company" value="${esc(c ? c.company : '')}"></label>
        <label class="field"><span>Email</span><input id="c-email" type="email" value="${esc(c ? c.email : '')}"></label>
        <label class="field"><span>Phone</span><input id="c-phone" value="${esc(c ? c.phone : '')}"></label>
        <label class="field full"><span>Notes (optional)</span><textarea id="c-notes">${esc(c ? c.notes : '')}</textarea></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="save-customer">${c ? 'Save changes' : 'Save customer'}</button>`,
    onOpen(root) {
      $('#save-customer', root).onclick = async () => {
        const body = {
          name: $('#c-name', root).value,
          company: $('#c-company', root).value,
          email: $('#c-email', root).value,
          phone: $('#c-phone', root).value,
          notes: $('#c-notes', root).value
        };
        try {
          if (c) await api('PUT', `/api/customers/${c.id}`, body);
          else await api('POST', '/api/customers', body);
          closeModal();
          toast(c ? 'Customer updated' : 'Customer added');
          if (after) after(); else renderCustomers();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ----- reports -----

function rangePresets() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    'this-month': { label: 'This month', from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    'last-month': { label: 'Last month', from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    'this-quarter': { label: 'This quarter', from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: iso(new Date(y, Math.floor(m / 3) * 3 + 3, 0)) },
    'this-year': { label: 'This year', from: `${y}-01-01`, to: `${y}-12-31` },
    'all': { label: 'All time', from: '', to: '' }
  };
}

let reportRange = 'this-year';

async function renderReports() {
  const presets = rangePresets();
  const preset = presets[reportRange];
  const qs = new URLSearchParams();
  if (preset.from) qs.set('from', preset.from);
  if (preset.to) qs.set('to', preset.to);
  const taxEnabled = !!(SETTINGS.salesTax && SETTINGS.salesTax.enabled);
  const [pnl, aging, stx] = await Promise.all([
    api('GET', '/api/reports/pnl?' + qs),
    api('GET', '/api/reports/aging'),
    taxEnabled ? api('GET', '/api/salestax?year=' + new Date().getFullYear()) : Promise.resolve(null)
  ]);

  const section = (title, rows, total, totalLabel) => `
    <table>
      <thead><tr><th>${title}</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${rows.length ? rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmtMoney(r.amount)}</td></tr>`).join('')
          : `<tr><td colspan="2" class="muted">None in this period</td></tr>`}
        <tr class="total-row"><td>${totalLabel}</td><td class="num">${fmtMoney(total)}</td></tr>
      </tbody>
    </table>`;

  const bucketNames = { current: 'Current', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': '90+ days' };

  view.innerHTML = `
    <div class="page-head"><h1>Reports</h1></div>
    <div class="tabs">
      ${Object.entries(presets).map(([k, p]) =>
        `<button data-r="${k}" class="${reportRange === k ? 'active' : ''}">${p.label}</button>`).join('')}
    </div>
    <div class="grid-2 mb">
      <div class="card">
        <div class="card-pad" style="padding-bottom:6px">
          <h2>Profit &amp; Loss <span class="muted" style="font-weight:400">(cash basis${preset.from ? `, ${fmtDate(pnl.from)} – ${fmtDate(pnl.to)}` : ''})</span></h2>
        </div>
        <div class="table-wrap">
          ${section('Income by customer', pnl.income, pnl.totalIncome, 'Total income')}
          <div style="height:8px"></div>
          ${section('Expenses by category', pnl.expenses, pnl.totalExpenses, 'Total expenses')}
          <table><tbody>
            <tr class="total-row"><td>Net profit</td>
              <td class="num" style="color:${pnl.netProfit >= 0 ? 'var(--status-good-text)' : 'var(--status-critical)'}">${fmtMoney(pnl.netProfit)}</td></tr>
          </tbody></table>
        </div>
      </div>
      <div class="card">
        <div class="card-pad" style="padding-bottom:6px"><h2>Accounts receivable aging <span class="muted" style="font-weight:400">(as of today)</span></h2></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Bucket</th><th>Invoices</th><th class="num">Balance</th></tr></thead>
            <tbody>
              ${Object.entries(aging.buckets).map(([k, list]) => `<tr>
                <td>${bucketNames[k]}</td>
                <td class="muted">${list.map(e => `${esc(e.number)} · ${esc(e.customerName)}`).join('<br>') || '—'}</td>
                <td class="num">${fmtMoney(aging.summary[k])}</td>
              </tr>`).join('')}
              <tr class="total-row"><td>Total receivable</td><td></td><td class="num">${fmtMoney(aging.total)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    ${stx ? `
    <div class="card table-wrap mb">
      <div class="card-pad" style="padding-bottom:0"><h2>NJ sales tax — ${stx.year}
        <span class="muted" style="font-weight:400">(collected ${fmtMoney(stx.collected)} · remitted ${fmtMoney(stx.remitted)} · held in trust ${fmtMoney(stx.balance)})</span></h2></div>
      ${stx.schedule.length ? `<table>
        <thead><tr><th>Filing</th><th>Due</th><th class="num">Collected</th><th class="num">Remitted</th><th class="num">To remit</th><th></th></tr></thead>
        <tbody>
          ${stx.schedule.map(e => `<tr ${!e.required && e.type === 'ST-51' ? 'style="opacity:.6"' : ''}>
            <td><span class="strong">${esc(e.label)}</span>${e.type === 'ST-51' && !e.required ? '<br><span class="muted" style="font-size:12px">under $500 — pays with the ST-50</span>' : ''}</td>
            <td>${fmtDate(e.due)}</td>
            <td class="num">${fmtMoney(e.collected)}</td>
            <td class="num">${fmtMoney(e.remitted)}</td>
            <td class="num ${e.outstanding > 0 ? 'strong' : ''}">${fmtMoney(e.outstanding)}</td>
            <td class="actions-cell">${e.outstanding > 0 ? `<button class="btn-link" data-remit="${e.key}" data-remitamt="${e.outstanding}" data-remitlabel="${esc(e.label)}">Record remittance</button>` : (e.collected > 0 ? '<span class="badge paid">Settled</span>' : '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">No taxable sales yet this year.</div>'}
      <p class="bank-help" style="padding:0 20px 14px;margin:0">Collected sales tax is held in trust for the State —
        it is excluded from income and remitting it is not an expense; your P&amp;L and Schedule C already reflect that.
        File and pay at the NJ portal, then record the remittance here.</p>
    </div>` : ''}
    <div class="card table-wrap mb" id="nec-card"></div>
    <div class="card table-wrap" id="audit-card"></div>`;

  $$('.tabs button').forEach(b => b.onclick = () => { reportRange = b.dataset.r; renderReports(); });
  $$('[data-remit]').forEach(b => b.onclick = () => salesTaxRemitForm(b.dataset.remit, Number(b.dataset.remitamt), b.dataset.remitlabel));
  render1099Card();
  renderAuditCard();
}

let necYear = new Date().getFullYear();

// 1099-NEC tracker: totals per vendor from the expense ledger. Card
// payments are excluded (the processor reports those on 1099-K).
async function render1099Card() {
  const card = $('#nec-card');
  if (!card) return;
  const d = await api('GET', `/api/vendors/1099?year=${necYear}`);
  card.innerHTML = `
    <div class="card-pad" style="padding-bottom:0;display:flex;justify-content:space-between;align-items:center">
      <h2>1099-NEC tracker — ${d.year}</h2>
      <select id="nec-year" style="width:auto">${[2024, 2025, 2026].map(y => `<option ${y === necYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
    </div>
    ${d.vendors.length ? `<table>
      <thead><tr><th>1099?</th><th>Vendor</th><th class="num">Reportable (cash/check/ACH)</th><th class="num">Card (1099-K)</th><th></th></tr></thead>
      <tbody>${d.vendors.map(v => `<tr>
        <td><input type="checkbox" data-nec="${esc(v.name)}" ${v.tracked ? 'checked' : ''} style="width:auto"></td>
        <td class="strong">${esc(v.name)}</td>
        <td class="num">${fmtMoney(v.reportable)}</td>
        <td class="num muted">${v.cardTotal ? fmtMoney(v.cardTotal) : '—'}</td>
        <td>${v.needs1099 ? '<span class="badge overdue">1099-NEC due</span>' : (v.tracked && v.reportable < d.threshold ? '<span class="muted">under $600</span>' : '')}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty">No vendor payments this year.</div>'}
    <p class="bank-help" style="padding:0 20px 14px;margin:0">Check the vendors that are 1099-eligible (unincorporated
      service providers — contractors, cleaners, your bookkeeper). Anyone checked with ${fmtMoney(d.threshold)}+ of
      non-card payments needs a 1099-NEC by January 31. Collect W-9s on paper — QuickBucks doesn't store TINs.
      Card payments don't count: the card processor reports those on 1099-K.</p>`;
  $('#nec-year', card).onchange = e => { necYear = Number(e.target.value); render1099Card(); };
  $$('[data-nec]', card).forEach(cb => cb.onchange = async () => {
    try {
      await api('POST', '/api/vendors/1099', { name: cb.dataset.nec, tracked: cb.checked });
      render1099Card();
    } catch (e) { toast(e.message, true); }
  });
}

function auditActionCell(e) {
  const p = e.payload || {};
  // http.write carries the request line; every other event is a semantic
  // money/compliance mutation — show its type and the fields that matter.
  if (e.type === 'http.write') {
    return `<span class="strong">${esc(p.method || '')}</span> ${esc(p.path || '')}`;
  }
  const detail = Object.entries(p)
    .filter(([k]) => k !== 'actor')
    .map(([k, v]) => `${esc(k)}=${esc(String(v))}`)
    .join(', ');
  return `<span class="strong">${esc(e.type)}</span>${detail ? ` <span class="muted">${detail}</span>` : ''}`;
}

async function renderAuditCard() {
  const card = $('#audit-card');
  if (!card) return;
  const { verified, entries } = await api('GET', '/api/audit?limit=30');
  const badge = verified.ok
    ? `<span class="badge paid">tamper-evident · ${verified.entries} entries verified</span>`
    : `<span class="badge overdue">INTEGRITY FAILURE${verified.atSeq != null ? ` (seq ${verified.atSeq})` : ''}</span>`;
  card.innerHTML = `
    <div class="card-pad" style="padding-bottom:0"><h2>Audit chain ${badge}
      <span class="muted" style="font-weight:400">(hash-chained record, newest first)</span></h2>
      ${verified.ok ? '' : `<p class="bank-help" style="color:var(--danger,#b00)">${esc(verified.error || 'chain verification failed')}</p>`}</div>
    ${entries.length ? `<table>
      <thead><tr><th>#</th><th>When</th><th>Event</th><th>Hash</th></tr></thead>
      <tbody>${entries.map(e => `<tr>
        <td class="muted">${e.seq}</td>
        <td class="muted">${new Date(e.timestamp).toLocaleString()}</td>
        <td>${auditActionCell(e)}</td>
        <td class="muted" title="${esc(e.hash || '')}" style="font-family:monospace">${esc(String(e.hash || '').slice(0, 10))}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty">No changes recorded yet.</div>'}`;
}

function salesTaxRemitForm(periodKey, amount, label) {
  openModal({
    title: 'Record sales tax remittance',
    body: `
      <p class="bank-help">${esc(label)} — paid at the NJ portal (this records it; it does not move money and is not an expense).</p>
      <div class="form-grid">
        <label class="field"><span>Amount (to remit ${fmtMoney(amount)})</span>
          <input id="str-amount" type="number" min="0.01" step="0.01" value="${amount}"></label>
        <label class="field"><span>Date paid</span><input id="str-date" type="date" value="${todayISO()}"></label>
        <label class="field full"><span>Confirmation # (optional)</span><input id="str-note"></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="str-save">Record remittance</button>`,
    onOpen(root) {
      $('#str-save', root).onclick = async () => {
        try {
          await api('POST', '/api/salestax/remit', {
            periodKey,
            amount: Number($('#str-amount', root).value),
            date: $('#str-date', root).value,
            note: $('#str-note', root).value
          });
          closeModal();
          toast('Sales tax remittance recorded');
          renderReports();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ---------- shared: delete confirmation, company settings ----------

function confirmDelete(what, onConfirm) {
  openModal({
    title: 'Confirm delete',
    body: `<p>Delete ${esc(what)}? This cannot be undone.</p>`,
    footer: `<button class="btn" id="cancel-del">Cancel</button><button class="btn btn-danger" id="do-del">Delete</button>`,
    onOpen(root) {
      $('#cancel-del', root).onclick = closeModal;
      $('#do-del', root).onclick = async () => {
        try { await onConfirm(); closeModal(); } catch (e) { toast(e.message, true); }
      };
    }
  });
}

function settingsForm() {
  openModal({
    title: 'Company settings',
    body: `
      <div class="form-grid">
        <label class="field full"><span>Company name</span><input id="s-name" value="${esc(SETTINGS.companyName)}"></label>
        <label class="field"><span>Currency code</span><input id="s-currency" value="${esc(SETTINGS.currency)}" maxlength="3" placeholder="USD"></label>
        <label class="field"><span>Invoice prefix</span><input id="s-prefix" value="${esc(SETTINGS.invoicePrefix || 'INV-')}"></label>
        <label class="field"><span>Default hourly rate (billable time)</span>
          <input id="s-rate" type="number" min="0" step="0.01" value="${SETTINGS.defaultHourlyRate || ''}" placeholder="e.g. 350"></label>
        <div class="full section-divider"><span class="doc-meta-label">NJ sales tax (for taxable sales, e.g. prepared food & drink)</span></div>
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="s-tax-on" style="width:auto" ${SETTINGS.salesTax && SETTINGS.salesTax.enabled ? 'checked' : ''}>
          <span style="margin:0">This company collects sales tax</span></label>
        <label class="field"><span>Rate % (6.625 statewide, 3.3125 UEZ)</span>
          <input id="s-tax-rate" type="number" min="0" max="30" step="0.0001" value="${SETTINGS.salesTax ? SETTINGS.salesTax.ratePct : 6.625}"></label>
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="s-tax-monthly" style="width:auto" ${SETTINGS.salesTax && SETTINGS.salesTax.monthlyRemitter ? 'checked' : ''}>
          <span style="margin:0">Monthly remitter (ST-51 — prior-year liability over $30k)</span></label>
        <div class="full section-divider"><span class="doc-meta-label">Backups</span></div>
        <div class="full" style="display:flex;align-items:center;gap:12px">
          <button class="btn" id="s-backup">Download backup (.tar)</button>
          <span class="muted" style="font-size:13px">Everything — all companies, household data, receipts.
          The server also snapshots daily into <code>data/backups/</code> (keeps 7).</span>
        </div>
        <div class="full section-divider">
          <span class="doc-meta-label">App password ${SETTINGS.protected ? '(currently on)' : '(currently off)'}</span>
        </div>
        ${SETTINGS.protected ? `<label class="field full"><span>Current password</span><input id="s-pw-current" type="password" autocomplete="current-password"></label>` : ''}
        <label class="field"><span>${SETTINGS.protected ? 'New password' : 'Set a password'}</span><input id="s-pw-next" type="password" autocomplete="new-password" placeholder="Leave blank to keep${SETTINGS.protected ? '' : ' off'}"></label>
        <label class="field"><span>Confirm</span><input id="s-pw-confirm" type="password" autocomplete="new-password"></label>
        ${SETTINGS.protected ? `<div class="full"><button class="btn btn-sm btn-danger" id="s-pw-remove">Remove password protection</button></div>` : ''}
      </div>`,
    footer: `<button class="btn btn-primary" id="save-settings">Save</button>`,
    onOpen(root) {
      $('#s-backup', root).onclick = () => downloadFile('/api/backup');
      const savePassword = async next => {
        await api('POST', '/api/password', {
          current: SETTINGS.protected ? $('#s-pw-current', root).value : '',
          next
        });
      };
      const removeBtn = $('#s-pw-remove', root);
      if (removeBtn) removeBtn.onclick = async () => {
        try {
          await savePassword('');
          closeModal();
          toast('Password protection removed');
          refreshSettings();
        } catch (e) { toast(e.message, true); }
      };
      $('#save-settings', root).onclick = async () => {
        const pwNext = $('#s-pw-next', root).value;
        if (pwNext && pwNext !== $('#s-pw-confirm', root).value) {
          return toast('Passwords do not match', true);
        }
        try {
          if (pwNext) await savePassword(pwNext);
          SETTINGS = await api('PUT', '/api/settings', {
            companyName: $('#s-name', root).value || 'My Company',
            currency: ($('#s-currency', root).value || 'USD').toUpperCase(),
            invoicePrefix: $('#s-prefix', root).value || 'INV-',
            defaultHourlyRate: Number($('#s-rate', root).value) || 0,
            salesTax: {
              enabled: $('#s-tax-on', root).checked,
              ratePct: Number($('#s-tax-rate', root).value) || 6.625,
              monthlyRemitter: $('#s-tax-monthly', root).checked
            }
          });
          $('#company-name').textContent = SETTINGS.companyName;
          closeModal();
          toast(pwNext ? 'Settings saved — password is on' : 'Settings saved');
          refreshSettings();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

async function refreshSettings() {
  try {
    SETTINGS = await api('GET', '/api/settings');
    $('#company-name').textContent = SETTINGS.companyName;
    $('#btn-logout').hidden = !SETTINGS.protected;
    await refreshCompanySwitcher();
  } catch { /* login screen will handle it */ }
  router();
}

// ---------- company switcher ----------

async function refreshCompanySwitcher() {
  const list = await api('GET', '/api/companies');
  const sel = $('#company-switch');
  sel.innerHTML = list.map(c =>
    `<option value="${c.id}" ${c.active ? 'selected' : ''}>${esc(c.name)}</option>`).join('') +
    '<option value="__new">+ Add company…</option>';
  sel.onchange = async () => {
    if (sel.value === '__new') {
      sel.value = list.find(c => c.active).id;
      return newCompanyForm();
    }
    await api('POST', `/api/companies/${sel.value}/select`);
    toast('Switched company');
    refreshSettings();
  };
}

function newCompanyForm() {
  openModal({
    title: 'Add a company',
    body: `
      <p class="bank-help">Each company keeps its own separate books — invoices, expenses, banking, and
        payroll — and all of them feed the household Taxes page.</p>
      <label class="field"><span>Company name</span><input id="nc-name" placeholder="e.g. Eliaspresso LLC"></label>`,
    footer: `<button class="btn btn-primary" id="nc-save">Create company</button>`,
    onOpen(root) {
      $('#nc-save', root).onclick = async () => {
        try {
          const company = await api('POST', '/api/companies', { name: $('#nc-name', root).value });
          await api('POST', `/api/companies/${company.id}/select`);
          closeModal();
          toast(`${company.name} created — you're now working in it`);
          location.hash = '#/dashboard';
          refreshSettings();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ---------- login ----------

function showLogin() {
  const root = $('#login-root');
  if (root.firstChild) return; // already showing
  root.innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="login-form">
        <div class="logo" style="justify-content:center;padding:0 0 6px">
          <span class="logo-mark">Q</span>
          <span class="logo-text" style="color:var(--ink)">QuickBucks</span>
        </div>
        <label class="field"><span>Password</span>
          <input type="password" id="login-pw" autocomplete="current-password" autofocus></label>
        <div class="login-error" id="login-error" hidden></div>
        <button class="btn btn-primary" type="submit" style="width:100%">Log in</button>
      </form>
    </div>`;
  $('#login-form', root).onsubmit = async e => {
    e.preventDefault();
    const errEl = $('#login-error', root);
    errEl.hidden = true;
    try {
      await api('POST', '/api/login', { password: $('#login-pw', root).value });
      root.innerHTML = '';
      refreshSettings();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  };
  $('#login-pw', root).focus();
}

// ----- household taxes (1040 planning) -----

const fmtPct = r => (r * 100).toFixed(0) + '%';

let taxYear = 2026;

async function renderTaxes() {
  const data = await api('GET', `/api/household/tax?year=${taxYear}`);
  const p = data.profile;
  const b = data.baseline;
  const SE = data.scheduleElias;
  const AN = SE.analysis;

  const line = (label, amount, opts = {}) => `
    <tr class="${opts.total ? 'total-row' : ''}">
      <td>${label}${opts.sub ? `<br><span class="muted">${opts.sub}</span>` : ''}</td>
      <td class="num" ${opts.color ? `style="color:${opts.color}"` : ''}>${opts.raw ?? fmtMoney(amount)}</td>
    </tr>`;

  const currentYear = Math.max(...data.supportedYears);
  view.innerHTML = `
    <div class="page-head">
      <h1>Household taxes — ${data.year}</h1>
      <div class="tabs" style="margin-bottom:0">
        ${data.supportedYears.map(y => `<button data-taxyear="${y}" class="${y === data.year ? 'active' : ''}">${y}</button>`).join('')}
      </div>
    </div>
    ${data.year < currentYear ? `<div class="card card-pad mb notice-card">
      <strong>The ${data.year} return is past due.</strong> Use this year's tab to assemble the Schedule C/E
      figures from your books for the catch-up filing — enter that year's W-2s, withholding, and any payments
      already made below. Late-filing and late-payment penalties accrue until filed; your accountant can advise
      on penalty abatement (first-time abatement is often available).</div>` : ''}
    <p class="bank-help"><strong>Planning estimate, not tax advice.</strong> Cash-basis Schedule C profit from every
      company's books feeds a live Form 1040 estimate (SE tax, QBI/§199A with the SSTB phase-out, NIIT, ${data.year} brackets).
      Ordinary income only — no capital-gains rates or AMT. Review with your accountant before relying on it.</p>

    <div class="grid-2 mb">
      <div>
        <div class="card table-wrap mb">
          <div class="card-pad" style="padding-bottom:0"><h2>Businesses (Schedule C, YTD from the books)</h2></div>
          <table>
            <thead><tr><th>Company</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net profit</th><th>SSTB?</th></tr></thead>
            <tbody>
              ${data.companies.map(c => `<tr>
                <td class="strong">${esc(c.name)}<br><span class="muted">W-2 wages paid: ${fmtMoney(c.w2Wages)}</span></td>
                <td class="num">${fmtMoney(c.ytd.income)}</td>
                <td class="num">${fmtMoney(c.ytd.expenses)}</td>
                <td class="num strong">${fmtMoney(c.ytd.netProfit)}</td>
                <td><input type="checkbox" data-sstb="${c.id}" ${c.sstb ? 'checked' : ''} title="Specified service business (law, accounting, consulting…) — affects the QBI deduction"></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="card card-pad">
          <h2>Personal (household)</h2>
          <div class="form-grid">
            <label class="field"><span>Filing status</span>
              <select id="tp-status">
                ${[['married_jointly', 'Married filing jointly'], ['single', 'Single'], ['head_of_household', 'Head of household']]
                  .map(([k, l]) => `<option value="${k}" ${p.filingStatus === k ? 'selected' : ''}>${l}</option>`).join('')}
              </select></label>
            <label class="field"><span>Household W-2 wages (outside these companies)</span><input id="tp-wages" type="number" min="0" step="0.01" value="${p.wages || ''}"></label>
            <label class="field"><span>Federal withholding on those wages</span><input id="tp-wh" type="number" min="0" step="0.01" value="${p.fedWithholding || ''}"></label>
            <label class="field"><span>Other income (interest, dividends…)</span><input id="tp-other" type="number" min="0" step="0.01" value="${p.otherIncome || ''}"></label>
            <label class="field"><span>Above-the-line adjustments (SEP/solo 401k, HSA…)</span><input id="tp-adj" type="number" min="0" step="0.01" value="${p.adjustments || ''}"></label>
            <label class="field"><span>Itemized deductions (0 = standard)</span><input id="tp-item" type="number" min="0" step="0.01" value="${p.itemizedDeductions || ''}"></label>
            <label class="field"><span>Credits (child tax credit…)</span><input id="tp-credits" type="number" min="0" step="0.01" value="${p.credits || ''}"></label>
            <label class="field"><span>1040-ES estimated payments made</span><input id="tp-est" type="number" min="0" step="0.01" value="${p.estimatedPayments || ''}"></label>
            <label class="field"><span>Prior-year (${data.year - 1}) total tax — for the safe harbor</span><input id="tp-prior" type="number" min="0" step="0.01" value="${p.priorYearTax || ''}"></label>
            <div class="full section-divider"><span class="doc-meta-label">New Jersey</span></div>
            <label class="field"><span>NJ tax withheld</span><input id="tp-njwh" type="number" min="0" step="0.01" value="${p.njWithholding || ''}"></label>
            <label class="field"><span>NJ estimated payments</span><input id="tp-njest" type="number" min="0" step="0.01" value="${p.njEstimatedPayments || ''}"></label>
            <label class="field"><span>Prior-year (${data.year - 1}) NJ tax — for the safe harbor</span><input id="tp-njprior" type="number" min="0" step="0.01" value="${p.priorYearNjTax || ''}"></label>
            <label class="field"><span>Dependents (NJ exemptions)</span><input id="tp-njdep" type="number" min="0" step="1" value="${p.njDependents || ''}"></label>
            <label class="field"><span>Property tax paid (principal residence)</span><input id="tp-proptax" type="number" min="0" step="0.01" value="${p.propertyTaxPaid || ''}"></label>
          </div>
          <div style="margin-top:12px"><button class="btn btn-primary" id="tp-save">Save &amp; recalculate</button></div>
        </div>
      </div>

      <div class="card table-wrap">
        <div class="card-pad" style="padding-bottom:0"><h2>Form 1040 estimate</h2></div>
        <table>
          <tbody>
            ${line('Schedule C net profit (all companies)', b.scheduleCTotal)}
            ${b.scheduleELine5 || data.scheduleElias.properties.length ? line('Schedule E rental net (Schedule 1, line 5)', b.scheduleELine5) : ''}
            ${b.wages ? line('W-2 wages', b.wages) : ''}
            ${b.otherIncome ? line('Other income', b.otherIncome) : ''}
            ${line('Total income', b.totalIncome, { total: true })}
            ${line('½ self-employment tax deduction', -b.halfSeDeduction, { raw: '−' + fmtMoney(b.halfSeDeduction) })}
            ${b.adjustments ? line('Other adjustments', -b.adjustments, { raw: '−' + fmtMoney(b.adjustments) }) : ''}
            ${line('Adjusted gross income', b.agi, { total: true })}
            ${line(`${b.deductionType === 'itemized' ? 'Itemized' : 'Standard'} deduction`, -b.deduction, { raw: '−' + fmtMoney(b.deduction) })}
            ${line('QBI deduction (§199A)', -b.qbiDeduction, { raw: '−' + fmtMoney(b.qbiDeduction) })}
            ${line('Taxable income', b.taxableIncome, { total: true })}
            ${line('Income tax', b.incomeTax, { sub: `marginal ${fmtPct(b.marginalRate)}` })}
            ${b.credits ? line('Credits', -b.credits, { raw: '−' + fmtMoney(b.credits) }) : ''}
            ${line('Self-employment tax', b.seTax)}
            ${b.additionalMedicare ? line('Additional Medicare (0.9%)', b.additionalMedicare) : ''}
            ${b.niit ? line('Net investment income tax (3.8%)', b.niit) : ''}
            ${line('Total tax', b.totalTax, { total: true, sub: `effective rate ${b.effectiveRate}%` })}
            ${line('Payments (withholding + estimates)', -b.payments, { raw: '−' + fmtMoney(b.payments) })}
            ${line(b.balanceDue >= 0 ? 'Balance due' : 'Overpaid', Math.abs(b.balanceDue),
              { total: true, color: b.balanceDue > 0 ? 'var(--status-critical)' : 'var(--status-good-text)' })}
          </tbody>
        </table>
        <div class="card-pad" style="padding-top:8px"><h2>NJ-1040 estimate</h2></div>
        <table>
          <tbody>
            ${line('Wages', data.nj.wages)}
            ${line('Net profits from business (floored — NJ has no cross-category netting)', data.nj.businessNet)}
            ${data.nj.rentalNet ? line('Net rents (floored)', data.nj.rentalNet) : ''}
            ${data.nj.otherIncome ? line('Other income', data.nj.otherIncome) : ''}
            ${line('NJ gross income', data.nj.grossIncome, { total: true })}
            ${line('Personal exemptions', -data.nj.exemptions, { raw: '−' + fmtMoney(data.nj.exemptions) })}
            ${data.nj.propertyTaxDeduction ? line('Property tax deduction', -data.nj.propertyTaxDeduction, { raw: '−' + fmtMoney(data.nj.propertyTaxDeduction) }) : ''}
            ${line('NJ taxable income', data.nj.taxableIncome, { total: true })}
            ${data.nj.propertyTaxCredit ? line('Property tax credit', -data.nj.propertyTaxCredit, { raw: '−' + fmtMoney(data.nj.propertyTaxCredit) }) : ''}
            ${line('NJ tax', data.nj.tax, { total: true, sub: `effective rate ${data.nj.effectiveRate}%` })}
            ${line('NJ payments', -data.nj.payments, { raw: '−' + fmtMoney(data.nj.payments) })}
            ${line(data.nj.balanceDue >= 0 ? 'NJ balance due' : 'NJ overpaid', Math.abs(data.nj.balanceDue),
              { total: true, color: data.nj.balanceDue > 0 ? 'var(--status-critical)' : 'var(--status-good-text)' })}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card card-pad mb">
      <h2>Quarterly estimated payments (1040-ES)</h2>
      ${data.esPlan.yearClosed ? `
        <p class="bank-help" style="margin:0">All ${data.year} estimated-payment due dates have passed.
          Estimated total tax <strong>${fmtMoney(b.totalTax)}</strong>, payments recorded
          <strong>${fmtMoney(data.esPlan.paid)}</strong>${b.balanceDue > 0 ? ` — remaining balance
          <strong style="color:var(--status-critical)">${fmtMoney(b.balanceDue)}</strong> is owed with the return (plus interest/penalties)` : ''}.</p>` : `
        <p class="bank-help">Safe harbor: <strong>${fmtMoney(data.esPlan.required)}</strong>
          (${data.esPlan.basis}${data.esPlan.basis.includes('prior') ? ', assumes prior AGI > $150K' : ''}) —
          paid so far ${fmtMoney(data.esPlan.paid)}, remaining <strong>${fmtMoney(data.esPlan.remaining)}</strong>
          split across the due dates left. Enter last year's total tax in the Personal card to use the prior-year harbor.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Quarter</th><th>Due</th><th class="num">Suggested payment</th></tr></thead>
          <tbody>${data.esPlan.quarters.map(q => `<tr ${q.past ? 'style="opacity:.55"' : ''}>
            <td>${q.quarter}</td><td>${fmtDate(q.due)}${q.past ? ' <span class="muted">(passed)</span>' : ''}</td>
            <td class="num">${q.past ? '—' : fmtMoney(q.suggested)}</td></tr>`).join('')}
          </tbody></table></div>`}
      <div class="section-divider" style="margin-top:14px"><span class="doc-meta-label">NJ-1040-ES</span></div>
      ${data.njEsPlan.belowThreshold ? `
        <p class="bank-help" style="margin:0">No NJ estimated payments required — NJ tax after payments stays
          within the $${data.njEsPlan.threshold} threshold.</p>` : data.njEsPlan.yearClosed ? `
        <p class="bank-help" style="margin:0">All ${data.year} NJ due dates have passed. NJ tax
          <strong>${fmtMoney(data.nj.tax)}</strong>, payments <strong>${fmtMoney(data.njEsPlan.paid)}</strong>${data.nj.balanceDue > 0 ? ` —
          <strong style="color:var(--status-critical)">${fmtMoney(data.nj.balanceDue)}</strong> owed with the NJ return` : ''}.</p>` : `
        <p class="bank-help" style="margin:0 0 8px">NJ safe harbor: <strong>${fmtMoney(data.njEsPlan.required)}</strong>
          (${data.njEsPlan.basis}) — paid ${fmtMoney(data.njEsPlan.paid)}, remaining
          <strong>${fmtMoney(data.njEsPlan.remaining)}</strong> split across
          ${data.njEsPlan.quarters.filter(q => !q.past).map(q => `${q.quarter} ${fmtMoney(q.suggested)}`).join(' · ')}.
          Same due dates as the federal calendar; pay at njportal.com or with NJ-1040-ES vouchers.</p>`}
    </div>

    ${AN.sec469 && (AN.sec469.suspendedEnd > 0 || AN.sec469.allowedLoss > 0) ? `<div class="card card-pad mb notice-card">
      <strong>Form 8582:</strong> ${AN.sec469.allowedLoss > 0 ? `rental loss of ${fmtMoney(AN.sec469.allowedLoss)} allowed${AN.sec469.allowance !== null ? ` (special allowance ${fmtMoney(AN.sec469.allowance)})` : ' (real estate professional)'}` : 'no rental loss allowed this year'}${AN.sec469.usedCarryforward > 0 ? `; ${fmtMoney(AN.sec469.usedCarryforward)} of prior suspended losses used` : ''}.
      Suspended carryforward to next year: <strong>${fmtMoney(AN.sec469.suspendedEnd)}</strong>.</div>` : ''}
    ${!AN.sec469 && b.suspendedRentalLoss > 0 ? `<div class="card card-pad mb notice-card">
      Schedule E loss of <strong>${fmtMoney(b.suspendedRentalLoss)}</strong> suspended under §469
      (passive activity rules) — carries forward. Switch to “Form 8582 (computed)” below for the real
      allowance math, or “allow” to model a real-estate-professional year.</div>` : ''}

    <div class="page-head" style="margin-top:6px"><h1 style="font-size:19px">Schedule Elias — tax vs. borrowing power</h1></div>
    <p class="bank-help">The same return drives two numbers: what you owe the IRS and what an underwriter says
      you can borrow. Depreciation is <strong>added back</strong> by agency underwriting, so it's largely
      DTI-neutral — while cash expenses cut both. Qualifying income varies by lender and program; consult a
      mortgage professional.</p>

    <div class="card card-pad mb">
      <div class="se-toolbar">
        <label class="field"><span>Depreciation strategy</span>
          <select id="se-strategy">
            ${[['conservative', 'Conservative (straight-line, no cost-seg)'], ['balanced', 'Balanced (straight-line)'], ['aggressive', 'Aggressive (cost-seg / bonus — enter per property)']]
              .map(([k, l]) => `<option value="${k}" ${SE.settings.depreciationStrategy === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label class="field"><span>§469 rental losses</span>
          <select id="se-469">
            <option value="suspend" ${SE.settings.sec469Handling === 'suspend' ? 'selected' : ''}>Suspend (simple)</option>
            <option value="allow" ${SE.settings.sec469Handling === 'allow' ? 'selected' : ''}>Allow through</option>
            <option value="phase2" ${SE.settings.sec469Handling === 'phase2' ? 'selected' : ''}>Form 8582 (computed)</option>
          </select></label>
        ${SE.settings.sec469Handling === 'phase2' ? `
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="se-activepart" style="width:auto" ${SE.settings.activeParticipation !== false ? 'checked' : ''}>
          <span style="margin:0">Active participation ($25K allowance)</span></label>
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="se-repro" style="width:auto" ${SE.settings.reProfessional ? 'checked' : ''}>
          <span style="margin:0">Real estate professional</span></label>
        <label class="field" style="width:170px"><span>Suspended carryforward ($)</span>
          <input id="se-carryforward" type="number" min="0" step="0.01" value="${SE.settings.suspendedCarryforward || ''}"></label>` : ''}
        <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
          <input type="checkbox" id="se-qbi" style="width:auto" ${SE.settings.qbiSafeHarbor ? 'checked' : ''}>
          <span style="margin:0">Treat rentals as a §199A trade or business (Rev. Proc. 2019-38 safe harbor)</span></label>
        <label class="field" style="width:110px"><span>DTI target %</span>
          <input id="se-dti-target" type="number" min="10" max="80" step="0.5" value="${SE.settings.dtiTargetPct}"></label>
      </div>
    </div>

    <div class="card table-wrap mb">
      <div class="card-pad" style="padding-bottom:0;display:flex;justify-content:space-between;align-items:center">
        <h2>Rental portfolio</h2>
        <button class="btn btn-sm btn-primary" id="se-add-prop">+ Add property</button>
      </div>
      ${SE.properties.length ? `<table>
        <thead><tr><th>Property</th><th class="num">Rent/yr</th><th class="num">Depreciation</th>
          <th class="num">Schedule E net</th><th class="num">Worksheet net/mo</th><th class="num">75% screen/mo</th><th></th></tr></thead>
        <tbody>
          ${AN.portfolio.perProperty.map(pa => `<tr>
            <td class="strong">${esc(pa.nickname)}</td>
            <td class="num">${fmtMoney(SE.properties.find(p => p.id === pa.id).operations.annualGrossRent)}</td>
            <td class="num">${fmtMoney(pa.depreciation)}</td>
            <td class="num">${fmtMoney(pa.scheduleENet)}</td>
            <td class="num ${pa.netRental > 0 ? 'amt-in' : pa.netRental < 0 ? 'strong' : ''}" ${pa.netRental < 0 ? 'style="color:var(--status-critical)"' : ''}>${fmtMoney(pa.netRental)}</td>
            <td class="num muted">${fmtMoney(pa.netRental75)}</td>
            <td class="actions-cell">
              <button class="btn-link" data-sellprop="${pa.id}">Sell vs hold</button>
              <button class="btn-link" data-editprop="${pa.id}">Edit</button>
              <button class="btn-link" data-delprop="${pa.id}" style="color:var(--status-critical)">Delete</button>
            </td>
          </tr>`).join('')}
          <tr class="total-row"><td>Portfolio (${esc(AN.portfolio.strategy)})</td><td></td><td></td>
            <td class="num">${fmtMoney(AN.portfolio.scheduleENetTotal)}</td>
            <td class="num">+${fmtMoney(AN.portfolio.positiveNetRental)} / −${fmtMoney(AN.portfolio.negativeNetRentalLiability)}</td>
            <td class="num muted">${fmtMoney(AN.portfolio.net75Total)}</td><td></td></tr>
        </tbody>
      </table>` : `<div class="empty">No rental properties yet — add one to bring Schedule E into the 1040 and your qualifying income.</div>`}
      ${SE.properties.length ? `<p class="bank-help" style="padding:0 20px 14px;margin:0">Worksheet net/mo is the agency
        (Fannie B3-3.1-08 / Form 1038) figure used for qualifying; the 75% column is a quick-screen estimate.
        Negative worksheet figures count as monthly debt, not reduced income.</p>` : ''}
    </div>

    <div class="grid-2 mb">
      <div class="card table-wrap">
        <div class="card-pad" style="padding-bottom:0"><h2>Qualifying income (lender view)</h2></div>
        <table>
          <tbody>
            <tr><td>W-2 income (monthly)</td>
              <td class="num" style="width:140px"><input id="se-w2" type="number" min="0" step="0.01" value="${SE.borrower.monthlyW2Income || ''}" class="run-input" style="width:110px"></td></tr>
            ${AN.sebByCompany.map(c => `<tr>
              <td>${esc(c.name)} — self-employment (Form 1084 style)
                <br><span class="muted">${c.seb.trend === 'averaged' ? 'two-year average' : c.seb.trend === 'declining' ? `declining ${c.seb.declinePct}% — current year used` : 'current year'}
                · <button class="btn-link" data-sebedit="${c.id}">add-backs</button></span>
                ${c.seb.warnDeclining ? `<br><span style="color:var(--status-critical);font-size:12px">⚠ Lenders scrutinize declining self-employment income; >20% declines may be unusable.</span>` : ''}</td>
              <td class="num">${fmtMoney(Math.max(c.seb.monthlyIncome, 0))}</td></tr>`).join('')}
            <tr><td>Net rental (worksheet method)</td><td class="num">${fmtMoney(AN.portfolio.positiveNetRental)}</td></tr>
            <tr class="total-row"><td>Gross monthly qualifying income</td><td class="num">${fmtMoney(AN.borrowing.income.grossMonthlyQualifying)}</td></tr>
            ${AN.portfolio.negativeNetRentalLiability ? `<tr><td class="muted">Rental shortfalls → debt side</td><td class="num" style="color:var(--status-critical)">${fmtMoney(AN.portfolio.negativeNetRentalLiability)}/mo</td></tr>` : ''}
          </tbody>
        </table>
        <p class="bank-help" style="padding:0 20px 14px;margin:0">SEB pulls from each company's real books; lines QuickBucks
          has no category for (depreciation, home office, mileage) are entered under “add-backs” — never silently zeroed.
          The deducted-meals 50% is subtracted (real cash out).</p>
      </div>

      <div class="card card-pad">
        <h2>Borrowing power</h2>
        <div class="form-grid">
          <label class="field"><span>Other monthly debts</span><input id="se-debts" type="number" min="0" step="0.01" value="${SE.borrower.monthlyNonHousingDebts || ''}"></label>
          <label class="field"><span>Current home PITIA</span><input id="se-pitia" type="number" min="0" step="0.01" value="${SE.borrower.primaryResidencePITIA || ''}"></label>
          <label class="field"><span>Purchase type</span>
            <select id="se-ptype">
              <option value="additional" ${SE.borrower.purchaseType === 'additional' ? 'selected' : ''}>Additional / investment</option>
              <option value="primary_replacement" ${SE.borrower.purchaseType === 'primary_replacement' ? 'selected' : ''}>Replacing primary residence</option>
            </select></label>
          <label class="field" style="display:flex;align-items:end;gap:8px;padding-bottom:8px">
            <input type="checkbox" id="se-countrent" style="width:auto" ${SE.borrower.countProjectedRent ? 'checked' : ''}>
            <span style="margin:0">Count projected rent (75%)</span></label>
          <label class="field"><span>Target price</span><input id="se-price" type="number" min="0" step="1000" value="${SE.borrower.proposedPurchase.targetPrice || ''}"></label>
          <label class="field"><span>Down payment %</span><input id="se-down" type="number" min="0" max="100" step="0.5" value="${SE.borrower.proposedPurchase.downPaymentPct}"></label>
          <label class="field"><span>Rate %</span><input id="se-rate" type="number" min="0" step="0.01" value="${SE.borrower.proposedPurchase.ratePct || ''}"></label>
          <label class="field"><span>Term (months)</span><input id="se-term" type="number" min="12" step="12" value="${SE.borrower.proposedPurchase.termMonths}"></label>
          <label class="field"><span>Monthly taxes</span><input id="se-ptax" type="number" min="0" step="0.01" value="${SE.borrower.proposedPurchase.monthlyTaxes || ''}"></label>
          <label class="field"><span>Monthly insurance + HOA</span><input id="se-pins" type="number" min="0" step="0.01" value="${SE.borrower.proposedPurchase.monthlyInsurance || ''}"></label>
          <label class="field"><span>Projected rent (if investment)</span><input id="se-prent" type="number" min="0" step="0.01" value="${SE.borrower.proposedPurchase.projectedMonthlyRent || ''}"></label>
        </div>
        <div style="margin-top:12px"><button class="btn btn-primary" id="se-save-borrower">Save &amp; recalculate</button></div>
        <div class="dti-row">
          ${AN.borrowing.proposed.backEndDTI !== null ? `
            <div class="dti-gauge"><div class="label">Front-end DTI</div>
              <div class="value dti-${(AN.borrowing.proposed.frontEndBand || '').toLowerCase().replace(' ', '-')}">${AN.borrowing.proposed.frontEndDTI}%</div>
              <div class="muted">${AN.borrowing.proposed.frontEndBand}</div></div>
            <div class="dti-gauge"><div class="label">Back-end DTI</div>
              <div class="value dti-${(AN.borrowing.proposed.backEndBand || '').toLowerCase().replace(' ', '-')}">${AN.borrowing.proposed.backEndDTI}%</div>
              <div class="muted">${AN.borrowing.proposed.backEndBand}</div></div>` : `<div class="muted">Enter qualifying income to see DTI.</div>`}
          <div class="dti-gauge"><div class="label">Max purchase @ ${SE.settings.dtiTargetPct}% DTI</div>
            <div class="value">${fmtMoney(AN.borrowing.maxPurchase.maxPrice)}</div>
            <div class="muted">loan ${fmtMoney(AN.borrowing.maxPurchase.maxLoan)}</div></div>
        </div>
      </div>
    </div>

    <div class="card card-pad">
      <h2>Scenario: what if…</h2>
      <p class="bank-help">Plug in hypothetical changes and compare against today's baseline —
        e.g. “what if ${esc(data.companies[0] ? data.companies[0].name : 'the shop')} buys $20,000 of equipment”
        or “what if I put $15,000 into a solo 401(k)”.</p>
      <div class="form-grid">
        ${data.companies.map(c => `
          <label class="field"><span>${esc(c.name)}: extra income</span><input class="sc-in" data-c="${c.id}" data-k="incomeDelta" type="number" step="0.01" min="0"></label>
          <label class="field"><span>${esc(c.name)}: extra expenses</span><input class="sc-in" data-c="${c.id}" data-k="expenseDelta" type="number" step="0.01" min="0"></label>`).join('')}
        <label class="field"><span>Extra W-2 wages</span><input id="sc-wages" type="number" step="0.01" min="0"></label>
        <label class="field"><span>Extra retirement / adjustments</span><input id="sc-adj" type="number" step="0.01" min="0"></label>
        <label class="field"><span>Extra itemized deductions</span><input id="sc-item" type="number" step="0.01" min="0"></label>
        <label class="field"><span>Depreciation strategy</span>
          <select id="sc-strategy"><option value="">(keep ${esc(SE.settings.depreciationStrategy)})</option>
            ${['conservative', 'balanced', 'aggressive'].map(s => `<option value="${s}">${s}</option>`).join('')}</select></label>
        <label class="field"><span>§469 rental losses</span>
          <select id="sc-469"><option value="">(keep ${esc(SE.settings.sec469Handling)})</option>
            <option value="suspend">suspend</option><option value="allow">allow</option></select></label>
        <div class="field" style="align-self:end"><button class="btn btn-primary" id="sc-run">Run scenario</button></div>
      </div>
      <div id="sc-result"></div>
    </div>`;

  $$('[data-taxyear]').forEach(btn => btn.onclick = () => { location.hash = `#/taxes/${btn.dataset.taxyear}`; });

  const saveProfile = async () => {
    const sstb = {};
    $$('[data-sstb]').forEach(cb => { sstb[cb.dataset.sstb] = cb.checked; });
    await api('PUT', '/api/household/tax-profile', {
      year: taxYear,
      filingStatus: $('#tp-status').value,
      wages: Number($('#tp-wages').value) || 0,
      fedWithholding: Number($('#tp-wh').value) || 0,
      otherIncome: Number($('#tp-other').value) || 0,
      adjustments: Number($('#tp-adj').value) || 0,
      itemizedDeductions: Number($('#tp-item').value) || 0,
      credits: Number($('#tp-credits').value) || 0,
      estimatedPayments: Number($('#tp-est').value) || 0,
      priorYearTax: Number($('#tp-prior').value) || 0,
      njWithholding: Number($('#tp-njwh').value) || 0,
      njEstimatedPayments: Number($('#tp-njest').value) || 0,
      priorYearNjTax: Number($('#tp-njprior').value) || 0,
      njDependents: Number($('#tp-njdep').value) || 0,
      propertyTaxPaid: Number($('#tp-proptax').value) || 0,
      companySstb: sstb
    });
  };
  $('#tp-save').onclick = async () => {
    try { await saveProfile(); toast('Profile saved'); renderTaxes(); }
    catch (e) { toast(e.message, true); }
  };
  $$('[data-sstb]').forEach(cb => cb.onchange = async () => {
    try { await saveProfile(); renderTaxes(); } catch (e) { toast(e.message, true); }
  });

  $('#sc-run').onclick = async () => {
    const companiesAdj = {};
    $$('.sc-in').forEach(inp => {
      const v = Number(inp.value) || 0;
      if (!v) return;
      companiesAdj[inp.dataset.c] = companiesAdj[inp.dataset.c] || {};
      companiesAdj[inp.dataset.c][inp.dataset.k] = v;
    });
    try {
      await saveProfile();   // scenario compares against what's on screen
      const r = await api('POST', '/api/household/scenario', {
        year: taxYear,
        adjustments: {
          companies: companiesAdj,
          wagesDelta: Number($('#sc-wages').value) || 0,
          adjustmentsDelta: Number($('#sc-adj').value) || 0,
          itemizedDelta: Number($('#sc-item').value) || 0,
          depreciationStrategy: $('#sc-strategy').value || undefined,
          sec469Handling: $('#sc-469').value || undefined
        }
      });
      const d = r.delta.totalTax;
      const money = v => fmtMoney(v);
      const rows = [
        ['Taxable income', r.baseline.taxableIncome, r.scenario.taxableIncome, money],
        ['Income tax', r.baseline.incomeTax, r.scenario.incomeTax, money],
        ['SE tax', r.baseline.seTax, r.scenario.seTax, money],
        ['QBI deduction', r.baseline.qbiDeduction, r.scenario.qbiDeduction, money],
        ['NIIT', r.baseline.niit, r.scenario.niit, money],
        ['Total tax', r.baseline.totalTax, r.scenario.totalTax, money],
        ['NJ tax', r.nj.baseline.tax, r.nj.scenario.tax, money],
        ['Balance due', r.baseline.balanceDue, r.scenario.balanceDue, money],
        ['Qualifying income /mo', r.borrowing.baseline.grossMonthlyQualifying, r.borrowing.scenario.grossMonthlyQualifying, money, true],
        ['Back-end DTI', r.borrowing.baseline.backEndDTI, r.borrowing.scenario.backEndDTI, v => v === null ? '—' : v + '%', true],
        ['Max purchase price', r.borrowing.baseline.maxPurchase, r.borrowing.scenario.maxPurchase, money, true]
      ];
      // Insights strip: which lever moved which side.
      const qDelta = r.delta.grossMonthlyQualifying;
      const insights = [];
      if (($('#sc-strategy').value || '') !== '' && Math.abs(d) > 0.004 && Math.abs(qDelta) < 0.005) {
        insights.push(`Depreciation is added back by agency underwriting — this strategy change ${d < 0 ? 'saves' : 'costs'} <strong>${fmtMoney(Math.abs(d))}</strong> in tax with <strong>$0</strong> DTI cost.`);
      }
      if (Object.keys(companiesAdj).length && d < -0.004 && qDelta < -0.005) {
        insights.push(`This expense increase saves <strong>${fmtMoney(-d)}</strong> in tax but cuts qualifying income <strong>${fmtMoney(-qDelta)}/mo</strong> (max purchase ${r.delta.maxPurchase < 0 ? '−' : '+'}${fmtMoney(Math.abs(r.delta.maxPurchase))}).`);
      }
      if (r.scenario.suspendedRentalLoss > 0) {
        insights.push(`Schedule E loss of <strong>${fmtMoney(r.scenario.suspendedRentalLoss)}</strong> suspended under §469 — carries forward.`);
      }
      const combined = d + r.delta.njTax;
      if (Math.abs(r.delta.njTax) > 0.004) {
        insights.push(`Combined federal + NJ: ${combined < 0 ? 'saves' : 'adds'} <strong>${fmtMoney(Math.abs(combined))}</strong> (${fmtMoney(Math.abs(d))} federal, ${fmtMoney(Math.abs(r.delta.njTax))} NJ).`);
      }
      if (!insights.length && Math.abs(d) > 0.004) {
        insights.push(`${d < 0 ? 'Saves' : 'Adds'} <strong>${fmtMoney(Math.abs(d))}</strong> federal tax; qualifying income ${qDelta >= 0 ? '+' : '−'}${fmtMoney(Math.abs(qDelta))}/mo.`);
      }
      $('#sc-result').innerHTML = `
        <div class="table-wrap" style="margin-top:14px">
          <table>
            <thead><tr><th></th><th class="num">Baseline</th><th class="num">Scenario</th><th class="num">Change</th></tr></thead>
            <tbody>
              ${rows.map(([label, base, sc, fmt, isLender]) => {
                const diff = (sc === null || base === null) ? null : Math.round((sc - base) * 100) / 100;
                const good = isLender ? diff > 0.004 : diff < -0.004;
                const bad = isLender ? diff < -0.004 : diff > 0.004;
                return `<tr ${label === 'Total tax' || label === 'Max purchase price' ? 'class="total-row"' : ''}>
                <td>${label}</td><td class="num">${fmt(base)}</td><td class="num">${fmt(sc)}</td>
                <td class="num" style="color:${bad ? 'var(--status-critical)' : good ? 'var(--status-good-text)' : 'inherit'}">
                  ${diff === null ? '—' : (diff >= 0 ? '+' : '−') + fmt(Math.abs(diff)).replace('%', '') + (label === 'Back-end DTI' ? ' pts' : '')}</td>
              </tr>`;
              }).join('')}
            </tbody>
          </table>
          ${insights.map(i => `<p class="bank-help" style="margin-top:10px">💡 ${i}</p>`).join('')}
          <p class="bank-help" style="margin-top:6px">Marginal rate: ${fmtPct(r.baseline.marginalRate)} → ${fmtPct(r.scenario.marginalRate)}.</p>
        </div>`;
    } catch (e) { toast(e.message, true); }
  };

  // ----- Schedule Elias wiring -----

  const saveEliasSettings = async () => {
    const settingsBody = {
      depreciationStrategy: $('#se-strategy').value,
      sec469Handling: $('#se-469').value,
      qbiSafeHarbor: $('#se-qbi').checked,
      dtiTargetPct: Number($('#se-dti-target').value) || 45
    };
    if ($('#se-activepart')) {
      settingsBody.activeParticipation = $('#se-activepart').checked;
      settingsBody.reProfessional = $('#se-repro').checked;
      settingsBody.suspendedCarryforward = Number($('#se-carryforward').value) || 0;
    }
    await api('PUT', '/api/household/schedule-elias', { settings: settingsBody });
  };
  for (const id of ['#se-strategy', '#se-469', '#se-qbi', '#se-dti-target', '#se-activepart', '#se-repro', '#se-carryforward']) {
    const el = $(id);
    if (el) el.onchange = async () => {
      try { await saveEliasSettings(); renderTaxes(); } catch (e) { toast(e.message, true); }
    };
  }

  $('#se-save-borrower').onclick = async () => {
    try {
      await api('PUT', '/api/household/schedule-elias', {
        borrower: {
          monthlyW2Income: Number($('#se-w2').value) || 0,
          monthlyNonHousingDebts: Number($('#se-debts').value) || 0,
          primaryResidencePITIA: Number($('#se-pitia').value) || 0,
          purchaseType: $('#se-ptype').value,
          countProjectedRent: $('#se-countrent').checked,
          proposedPurchase: {
            targetPrice: Number($('#se-price').value) || 0,
            downPaymentPct: Number($('#se-down').value) || 0,
            ratePct: Number($('#se-rate').value) || 0,
            termMonths: Number($('#se-term').value) || 360,
            monthlyTaxes: Number($('#se-ptax').value) || 0,
            monthlyInsurance: Number($('#se-pins').value) || 0,
            projectedMonthlyRent: Number($('#se-prent').value) || 0
          }
        }
      });
      toast('Borrowing inputs saved');
      renderTaxes();
    } catch (e) { toast(e.message, true); }
  };
  $('#se-w2').onchange = $('#se-save-borrower').onclick;

  $('#se-add-prop').onclick = () => propertyForm();
  $$('[data-editprop]').forEach(btn => btn.onclick = () =>
    propertyForm(SE.properties.find(pr => pr.id === btn.dataset.editprop)));
  $$('[data-delprop]').forEach(btn => {
    const pr = SE.properties.find(x => x.id === btn.dataset.delprop);
    btn.onclick = () => confirmDelete(`property "${pr.nickname}"`, () =>
      api('DELETE', `/api/household/properties/${pr.id}`).then(() => { toast('Property removed'); renderTaxes(); }));
  });
  $$('[data-sellprop]').forEach(btn => {
    const pr = SE.properties.find(x => x.id === btn.dataset.sellprop);
    btn.onclick = () => sellPreviewForm(pr);
  });
  $$('[data-sebedit]').forEach(btn => {
    const c = AN.sebByCompany.find(x => x.id === btn.dataset.sebedit);
    btn.onclick = () => sebForm(c, SE.seb[c.id] || {});
  });
}

// Sell-vs-hold recapture preview for one property.
function sellPreviewForm(property) {
  openModal({
    title: `Sell vs hold — ${property.nickname}`,
    body: `
      <div class="form-grid">
        <label class="field"><span>Hypothetical sale price</span>
          <input id="sp-price" type="number" min="0" step="1000" value="${Math.round(property.acquisition.purchasePrice * 1.2) || ''}"></label>
        <label class="field"><span>Selling costs %</span>
          <input id="sp-costs" type="number" min="0" max="20" step="0.5" value="7"></label>
      </div>
      <div id="sp-result" style="margin-top:12px"></div>`,
    footer: `<button class="btn btn-primary" id="sp-run">Preview sale</button>`,
    onOpen(root) {
      $('#sp-run', root).onclick = async () => {
        try {
          const r = await api('POST', `/api/household/properties/${property.id}/sell-preview`, {
            salePrice: Number($('#sp-price', root).value),
            sellingCostsPct: Number($('#sp-costs', root).value)
          });
          const row = (label, v, strong) => `<tr ${strong ? 'class="total-row"' : ''}><td>${label}</td><td class="num">${fmtMoney(v)}</td></tr>`;
          $('#sp-result', root).innerHTML = `
            <div class="table-wrap"><table><tbody>
              ${row('Amount realized (after selling costs)', r.amountRealized)}
              ${row('Adjusted basis (after ' + fmtMoney(r.accumDep) + ' depreciation)', r.adjustedBasis)}
              ${row('Gain on sale', r.gain, true)}
              ${r.gain > 0 ? `
                ${row(`Unrecaptured §1250 (${Math.round(r.unrecapRate * 100)}% on depreciation taken)`, r.unrecapTax)}
                ${row(`Long-term capital gain (${Math.round(r.ltcgRate * 100)}%)`, r.ltcgTax)}
                ${r.niit ? row('NIIT (3.8%)', r.niit) : ''}
                ${r.freedLossBenefit ? row('Freed suspended losses (§469(g) benefit)', -r.freedLossBenefit) : ''}
                ${row('Estimated tax on sale', r.saleTax, true)}` : ''}
              ${row('Net after tax and loan payoff', r.netAfterTax, true)}
            </tbody></table></div>
            <p class="bank-help" style="margin-top:8px">Planning estimate — recapture at min(25%, marginal), LTCG at the
              0/15/20% breakpoints, NIIT on gain over the MAGI threshold, suspended losses released on full disposition.
              Confirm with your accountant before selling.</p>`;
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// Per-company SEB add-backs QuickBucks has no expense category for.
function sebForm(company, current) {
  const f = (id, label, val, hint) => `<label class="field"><span>${label}</span>
    <input id="${id}" type="number" min="0" step="0.01" value="${val || ''}" ${hint ? `title="${hint}"` : ''}></label>`;
  openModal({
    title: `SEB add-backs — ${company.name}`,
    body: `
      <p class="bank-help">Form 1084 lines with no QuickBucks category yet — entered here so they're never
        silently zeroed. Meals are pulled from the books automatically (the non-deducted 50% is subtracted).</p>
      <div class="form-grid">
        ${f('sb-dep', 'Depreciation ($/yr)', current.depreciation)}
        ${f('sb-amort', 'Amortization / casualty loss ($/yr)', current.amortization)}
        ${f('sb-depl', 'Depletion ($/yr)', current.depletion)}
        ${f('sb-home', 'Business use of home ($/yr)', current.businessUseOfHome)}
        ${f('sb-miles', 'Business miles (per year)', current.businessMiles)}
        ${f('sb-nonrec-inc', 'Nonrecurring other income ($/yr)', current.nonrecurringOtherIncome)}
        ${f('sb-nonrec-loss', 'Nonrecurring loss ($/yr)', current.nonrecurringLoss)}
        ${f('sb-prior', 'Prior-year Schedule C net (pre-QuickBucks)', current.priorYearNet)}
      </div>`,
    footer: `<button class="btn btn-primary" id="sb-save">Save</button>`,
    onOpen(root) {
      $('#sb-save', root).onclick = async () => {
        try {
          await api('PUT', '/api/household/schedule-elias', {
            seb: { [company.id]: {
              depreciation: $('#sb-dep', root).value,
              amortization: $('#sb-amort', root).value,
              depletion: $('#sb-depl', root).value,
              businessUseOfHome: $('#sb-home', root).value,
              businessMiles: $('#sb-miles', root).value,
              nonrecurringOtherIncome: $('#sb-nonrec-inc', root).value,
              nonrecurringLoss: $('#sb-nonrec-loss', root).value,
              priorYearNet: $('#sb-prior', root).value
            } }
          });
          closeModal();
          toast('SEB add-backs saved');
          renderTaxes();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

const PROPERTY_EXPENSE_LABELS = {
  advertising: 'Advertising', autoTravel: 'Auto & travel', cleaningMaintenance: 'Cleaning & maintenance',
  commissions: 'Commissions', insurance: 'Insurance', legalProfessional: 'Legal & professional',
  managementFees: 'Management fees', mortgageInterest: 'Mortgage interest', otherInterest: 'Other interest',
  repairs: 'Repairs', supplies: 'Supplies', taxes: 'Property taxes', utilities: 'Utilities', other: 'Other'
};

function propertyForm(prop) {
  const pr = prop || {};
  const acq = pr.acquisition || {};
  const fin = pr.financing || {};
  const ops = pr.operations || {};
  const exp = ops.annualExpenses || {};
  const dep = pr.depreciation || {};
  const strat = dep.annualByStrategy || {};
  openModal({
    title: prop ? `Edit ${pr.nickname}` : 'Add rental property',
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>Nickname</span><input id="pp-nick" value="${esc(pr.nickname || '')}" placeholder="e.g. Maple St duplex"></label>
        <label class="field"><span>Address (optional)</span><input id="pp-addr" value="${esc(pr.address || '')}"></label>
        <label class="field"><span>Months in service this year</span><input id="pp-months" type="number" min="1" max="12" value="${pr.monthsInService || 12}"></label>
        <label class="field"><span>Annual gross rent</span><input id="pp-rent" type="number" min="0" step="0.01" value="${ops.annualGrossRent || ''}"></label>

        <div class="full section-divider"><span class="doc-meta-label">Acquisition (drives depreciation)</span></div>
        <label class="field"><span>Purchase price</span><input id="pp-price" type="number" min="0" step="1000" value="${acq.purchasePrice || ''}"></label>
        <label class="field"><span>Land allocation %</span><input id="pp-land" type="number" min="0" max="90" step="1" value="${acq.landAllocationPct ?? 20}"></label>
        <label class="field"><span>Placed in service (enables real MACRS)</span><input id="pp-placed" type="date" value="${acq.placedInServiceDate || ''}"></label>
        <label class="field"><span>Capital improvements to date</span><input id="pp-improve" type="number" min="0" step="0.01" value="${(acq.improvements || []).reduce((s2, i) => s2 + (Number(i.amount) || 0), 0) || ''}"></label>
        <label class="field"><span>Accumulated depreciation override (mid-life switch)</span><input id="pp-accum" type="number" min="0" step="0.01" value="${(pr.phase2 && pr.phase2.accumulatedDepreciation) || ''}"></label>

        <div class="full section-divider"><span class="doc-meta-label">Cost segregation (used by the Aggressive strategy; 100% bonus applies when placed in service after Jan 19, 2025)</span></div>
        <label class="field"><span>5-year components ($)</span><input id="pp-seg5" type="number" min="0" step="0.01" value="${(pr.phase2 && pr.phase2.costSegComponents && pr.phase2.costSegComponents.five) || ''}"></label>
        <label class="field"><span>7-year components ($)</span><input id="pp-seg7" type="number" min="0" step="0.01" value="${(pr.phase2 && pr.phase2.costSegComponents && pr.phase2.costSegComponents.seven) || ''}"></label>
        <label class="field"><span>15-year components ($)</span><input id="pp-seg15" type="number" min="0" step="0.01" value="${(pr.phase2 && pr.phase2.costSegComponents && pr.phase2.costSegComponents.fifteen) || ''}"></label>

        <div class="full section-divider"><span class="doc-meta-label">Monthly financing (PITIA)</span></div>
        <label class="field"><span>Principal &amp; interest</span><input id="pp-pi" type="number" min="0" step="0.01" value="${fin.monthlyPI || ''}"></label>
        <label class="field"><span>Taxes</span><input id="pp-tax" type="number" min="0" step="0.01" value="${fin.monthlyTaxes || ''}"></label>
        <label class="field"><span>Insurance</span><input id="pp-ins" type="number" min="0" step="0.01" value="${fin.monthlyInsurance || ''}"></label>
        <label class="field"><span>HOA</span><input id="pp-hoa" type="number" min="0" step="0.01" value="${fin.monthlyHOA || ''}"></label>

        <div class="full section-divider"><span class="doc-meta-label">Annual operating expenses (Schedule E lines)</span></div>
        ${Object.entries(PROPERTY_EXPENSE_LABELS).map(([k, label]) =>
          `<label class="field"><span>${label}</span><input class="pp-exp" data-k="${k}" type="number" min="0" step="0.01" value="${exp[k] || ''}"></label>`).join('')}
        <label class="field"><span>One-time / nonrecurring (added back for lending)</span><input id="pp-onetime" type="number" min="0" step="0.01" value="${ops.oneTimeExpenses || ''}"></label>

        <div class="full section-divider"><span class="doc-meta-label">Depreciation</span></div>
        <label class="field full" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="pp-autodep" style="width:auto" ${dep.useComputedDefault !== false ? 'checked' : ''}>
          <span style="margin:0">Compute straight-line default (building basis ÷ 27.5 yrs) for conservative/balanced</span></label>
        <label class="field"><span>Conservative $/yr (straight-line — you can't legally under-depreciate)</span><input id="pp-dep-c" type="number" min="0" step="0.01" value="${strat.conservative || ''}"></label>
        <label class="field"><span>Balanced $/yr</span><input id="pp-dep-b" type="number" min="0" step="0.01" value="${strat.balanced || ''}"></label>
        <label class="field"><span>Aggressive $/yr (models cost-seg / bonus outcome)</span><input id="pp-dep-a" type="number" min="0" step="0.01" value="${strat.aggressive || ''}"></label>
      </div>`,
    footer: `<button class="btn btn-primary" id="pp-save">${prop ? 'Save changes' : 'Add property'}</button>`,
    onOpen(root) {
      $('#pp-save', root).onclick = async () => {
        const expenses = {};
        $$('.pp-exp', root).forEach(i => { expenses[i.dataset.k] = i.value; });
        const body = {
          nickname: $('#pp-nick', root).value,
          address: $('#pp-addr', root).value,
          monthsInService: $('#pp-months', root).value,
          acquisition: {
            purchasePrice: $('#pp-price', root).value,
            landAllocationPct: $('#pp-land', root).value,
            placedInServiceDate: $('#pp-placed', root).value
          },
          capitalImprovements: $('#pp-improve', root).value,
          phase2: {
            accumulatedDepreciation: $('#pp-accum', root).value,
            costSegComponents: {
              five: $('#pp-seg5', root).value,
              seven: $('#pp-seg7', root).value,
              fifteen: $('#pp-seg15', root).value
            }
          },
          financing: {
            monthlyPI: $('#pp-pi', root).value, monthlyTaxes: $('#pp-tax', root).value,
            monthlyInsurance: $('#pp-ins', root).value, monthlyHOA: $('#pp-hoa', root).value
          },
          operations: {
            annualGrossRent: $('#pp-rent', root).value,
            annualExpenses: expenses,
            oneTimeExpenses: $('#pp-onetime', root).value
          },
          depreciation: {
            useComputedDefault: $('#pp-autodep', root).checked,
            annualByStrategy: {
              conservative: $('#pp-dep-c', root).value,
              balanced: $('#pp-dep-b', root).value,
              aggressive: $('#pp-dep-a', root).value
            }
          }
        };
        try {
          if (prop) await api('PUT', `/api/household/properties/${prop.id}`, body);
          else await api('POST', '/api/household/properties', body);
          closeModal();
          toast(prop ? 'Property updated' : 'Property added');
          renderTaxes();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ---------- router ----------

const ROUTES = {
  dashboard: renderDashboard,
  invoices: renderInvoices,
  time: renderTime,
  expenses: renderExpenses,
  banking: renderBanking,
  payroll: renderPayroll,
  customers: renderCustomers,
  taxes: renderTaxes,
  reports: renderReports
};

function router() {
  const hash = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
  const parts = hash.split('/');
  const [route, id] = parts;
  let fn;
  if (route === 'invoices' && id) fn = () => renderInvoiceDetail(id);
  else if (route === 'payroll' && parts[1] === 'runs' && parts[2]) fn = () => renderPayrollRun(parts[2]);
  else if (route === 'payroll' && ['runs', 'employees', 'liabilities', 'filings'].includes(parts[1]) && !parts[2]) fn = () => { payrollTab = parts[1]; return renderPayroll(); };
  else if (route === 'payroll' && parts[1] === 'stubs' && parts[3]) fn = () => renderPayStub(parts[2], parts[3]);
  else if (route === 'taxes' && parts[1] && /^20\d\d$/.test(parts[1])) fn = () => { taxYear = Number(parts[1]); return renderTaxes(); };
  else fn = ROUTES[route] || renderDashboard;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  view.innerHTML = '<div class="empty">Loading…</div>';
  fn().catch(e => {
    view.innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`;
  });
}

window.addEventListener('hashchange', router);

$('#btn-new').onclick = () => {
  const route = location.hash.replace(/^#\//, '') || 'dashboard';
  if (route === 'expenses') api('GET', '/api/categories').then(cats => expenseForm(null, cats));
  else if (route === 'customers') customerForm();
  else if (route === 'time') timeEntryForm();
  else invoiceForm();
};
$('#company-name').onclick = settingsForm;
$('#company-name').title = 'Company settings';
$('#btn-logout').onclick = async () => {
  await api('POST', '/api/logout');
  showLogin();
};

// PWA: installable from the browser menu ("Add to Home Screen"); the
// service worker keeps the shell openable during brief server hiccups.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* http or old browser */ });
}

(async function init() {
  try {
    const status = await api('GET', '/api/auth-status');
    if (status.protected && !status.authenticated) {
      showLogin();
      return;
    }
  } catch { /* fall through to normal load */ }
  refreshSettings();
})();
