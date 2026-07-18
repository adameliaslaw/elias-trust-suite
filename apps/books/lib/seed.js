// Seeds the first company with realistic demo data on first run (only when
// empty). Delete the data dir and restart to re-seed; QUICKBUCKS_NO_SEED=1
// starts blank. Companies created later always start blank.
const { load, save, companies, uid } = require('./store');
const { loadGlobal, saveGlobal } = require('./global');

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
}

function seedIfEmpty() {
  if (process.env.QUICKBUCKS_NO_SEED) return;
  const list = companies();
  if (list.length > 1) return;
  const db = load(list[0].id);
  if (db.customers.length || db.invoices.length || db.expenses.length) return;

  db.settings.companyName = 'QuickBucks Demo Co.';
  list[0].name = db.settings.companyName;
  saveGlobal();

  const customers = [
    { name: 'Dana Whitfield', company: 'Whitfield Design Studio', email: 'dana@whitfielddesign.com', phone: '555-0141' },
    { name: 'Marcus Chen', company: 'Chen Property Group', email: 'marcus@chenproperty.com', phone: '555-0172' },
    { name: 'Priya Raman', company: 'Raman Consulting LLC', email: 'priya@ramanconsulting.com', phone: '555-0163' },
    { name: 'Tom Alvarez', company: 'Alvarez & Sons Roofing', email: 'tom@alvarezroofing.com', phone: '555-0118' },
    { name: 'Grace Okafor', company: 'Okafor Analytics', email: 'grace@okaforanalytics.com', phone: '555-0195' }
  ].map(c => ({ id: uid(), createdAt: daysAgo(120), notes: '', ...c }));
  db.customers = customers;

  const [dana, marcus, priya, tom, grace] = customers;

  let num = db.settings.nextInvoiceNumber;
  const mkInv = (customer, date, dueDate, items, payments = [], draft = false) => ({
    id: uid(),
    number: db.settings.invoicePrefix + (num++),
    customerId: customer.id,
    date,
    dueDate,
    items,
    payments,
    draft,
    notes: '',
    createdAt: date
  });

  db.invoices = [
    mkInv(dana, daysAgo(95), daysAgo(65),
      [{ description: 'Website redesign — phase 1', qty: 1, rate: 4800 }],
      [{ id: uid(), date: daysAgo(60), amount: 4800, method: 'Bank transfer' }]),
    mkInv(marcus, daysAgo(75), daysAgo(45),
      [{ description: 'Quarterly retainer', qty: 3, rate: 1500 },
       { description: 'On-site consultation', qty: 4, rate: 250 }],
      [{ id: uid(), date: daysAgo(40), amount: 5500, method: 'Check' }]),
    mkInv(priya, daysAgo(50), daysAgo(20),
      [{ description: 'Data pipeline setup', qty: 1, rate: 3200 },
       { description: 'Training workshop', qty: 2, rate: 600 }],
      [{ id: uid(), date: daysAgo(15), amount: 2000, method: 'Credit card' }]),
    mkInv(tom, daysAgo(42), daysAgo(12),
      [{ description: 'Brand identity package', qty: 1, rate: 2750 }]),
    mkInv(grace, daysAgo(18), daysFromNow(12),
      [{ description: 'Monthly analytics report', qty: 1, rate: 950 },
       { description: 'Dashboard maintenance', qty: 5, rate: 120 }]),
    mkInv(dana, daysAgo(6), daysFromNow(24),
      [{ description: 'Website redesign — phase 2', qty: 1, rate: 5200 }]),
    mkInv(marcus, daysAgo(2), daysFromNow(28),
      [{ description: 'Lease review services', qty: 6, rate: 225 }], [], true)
  ];
  db.settings.nextInvoiceNumber = num;

  const mkExp = (date, vendor, category, amount, method, notes = '') =>
    ({ id: uid(), date, vendor, category, amount, paymentMethod: method, notes, createdAt: date });

  db.expenses = [
    mkExp(daysAgo(92), 'WeWork', 'Rent', 850, 'Credit card'),
    mkExp(daysAgo(85), 'Adobe', 'Software & Subscriptions', 59.99, 'Credit card'),
    mkExp(daysAgo(70), 'Staples', 'Office Supplies', 134.5, 'Credit card'),
    mkExp(daysAgo(62), 'WeWork', 'Rent', 850, 'Credit card'),
    mkExp(daysAgo(55), 'Google Ads', 'Advertising', 420, 'Credit card'),
    mkExp(daysAgo(48), 'Delta Airlines', 'Travel', 386.2, 'Credit card'),
    mkExp(daysAgo(41), 'Hilton', 'Travel', 512.75, 'Credit card'),
    mkExp(daysAgo(33), 'WeWork', 'Rent', 850, 'Credit card'),
    mkExp(daysAgo(28), 'State Farm', 'Insurance', 210, 'Bank transfer'),
    mkExp(daysAgo(21), 'Adobe', 'Software & Subscriptions', 59.99, 'Credit card'),
    mkExp(daysAgo(14), 'Chipotle (client lunch)', 'Meals & Entertainment', 64.3, 'Credit card'),
    mkExp(daysAgo(9), 'ConEd', 'Utilities', 142.85, 'Bank transfer'),
    mkExp(daysAgo(3), 'WeWork', 'Rent', 850, 'Credit card'),
    mkExp(daysAgo(1), 'Zoom', 'Software & Subscriptions', 15.99, 'Credit card')
  ];

  save(db);
  console.log('Seeded demo data (customers, invoices, expenses).');
}

module.exports = { seedIfEmpty };
