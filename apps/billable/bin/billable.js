#!/usr/bin/env node
'use strict';
// Matterproof — an evidence-grade ledger of AI work, kept like a timesheet.

const fs = require('fs');
const store = require('../src/store');
const { buildEntries, filterEntries, totals } = require('../src/entries');
const { textReport, csvReport, htmlInvoice, money } = require('../src/report');
const { ledesExport } = require('../src/ledes');
const { installHooks, eventFromHookPayload, settingsPath } = require('../src/hooks');

const USAGE = `Matterproof — proof of work for every matter

Usage: billable <command> [options]

Commands:
  init [--global]              Install Claude Code hooks (project or user settings)
                               and create the config file
  serve [--port 4321]          Open the review dashboard (local only) with
        [--lan] [--new-token]  entry review, write-offs, payments, exports;
                               --lan serves your network with a token gate
                               (use from your phone), --new-token rotates it
  log                          (used by hooks) read a hook payload from stdin
                               and record it in the ledger
  add --minutes N --desc TEXT  Record a manual entry (e.g. Claude chat / Cowork work)
      [--client C] [--matter M] [--code A111] [--date YYYY-MM-DD]
  import <conversations.json>  Import sittings from a claude.ai data export
      [--client C] [--matter M] [--code A111]
  status                       Today's billable summary
  report [--from D] [--to D] [--client C] [--matter M]
         [--format text|csv|html|ledes] [--out FILE]
  economics [--from D] [--to D]    Per-matter unit economics: actual hours,
                               AI cost, effective rate, flat-fee margin
  fee <client> <matter> <amount>   Record a flat fee for a matter (economics)
  clio connect                 Authorize Clio (needs clioClientId/Secret set)
  clio matters                 List Clio matters and ids
  clio map <client> <matter> <clio-matter-id>   Map a matter to Clio
  clio push [--from D] [--to D] [--dry-run]     Push reviewed entries to Clio
  lawpay link [--from D] [--to D] [--client C] [--matter M]
              [--email E] [--desc TEXT] [--out statement.html]
              [--send] [--dry-run]
                               Generate a pre-filled LawPay payment link from
                               reviewed, unbilled entries; --out writes a
                               statement with a Pay Now button; --send emails
                               the request via SendGrid
  lawpay requests              List payment requests + outstanding balance
  lawpay paid <MP-reference>   Record that a payment request was paid
  config [key value]           Show config, or set a value (rate, aiCostPerHour,
         [--reveal]              timekeeper, firmName, firmId, capturePrompts,
                               incrementHours, minimumHours, idleCapMinutes, ...)
                               Secret values (API keys, tokens) print masked
                               unless --reveal is passed
  matter <dir> <client> <matter>   Bill work done in <dir> to a client/matter

Data lives in ${store.homeDir()} (override with BILLABLE_HOME) and never
leaves this machine. See PRIVACY.md and ETHICS.md.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Keys whose values are credentials. `billable config` masks them so
// screen-shares, recorded demos, and scrollback captures don't leak them;
// --reveal shows the stored values when you actually need them.
const SECRET_KEYS = ['sendgridApiKey', 'clioClientSecret', 'serveToken'];
const MASKED = '(set — hidden; pass --reveal to show)';

function displayConfig(config, reveal) {
  if (reveal) return config;
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_KEYS.includes(k) && v) {
      out[k] = MASKED;
    } else if (k === 'clio' && v && typeof v === 'object') {
      out[k] = { ...v };
      for (const t of ['accessToken', 'refreshToken']) {
        if (out[k][t]) out[k][t] = MASKED;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const config = store.readConfig();

  switch (command) {
    case 'init': {
      const file = settingsPath({ global: !!args.global });
      const added = installHooks(file);
      if (!fs.existsSync(store.configPath())) store.writeConfig(config);
      console.log(
        added.length
          ? `Installed hooks (${added.join(', ')}) in ${file}`
          : `Hooks already installed in ${file}`
      );
      console.log(`Config: ${store.configPath()}`);
      console.log(`Ledger: ${store.ledgerPath()}`);
      console.log('Set your rate with: billable config rate 250');
      return;
    }

    case 'log': {
      const raw = await readStdin();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return; // never break a Claude session over a malformed payload
      }
      const event = eventFromHookPayload(payload);
      if (event) {
        // Privacy mode: keep prompt text out of the ledger entirely.
        if (config.capturePrompts === false && event.type === 'prompt') event.detail = '';
        store.appendEvent(event);
      }
      return;
    }

    case 'serve': {
      const { serve, lanAddresses } = require('../src/server');
      const port = Number(args.port) || 4321;
      const host = args.host || (args.lan ? '0.0.0.0' : '127.0.0.1');
      const lanMode = host !== '127.0.0.1';
      let token;
      if (lanMode) {
        if (args['new-token'] || !config.serveToken) {
          config.serveToken = require('crypto').randomBytes(16).toString('hex');
          store.writeConfig(config);
          if (args['new-token']) console.log('Rotated the access token — old links stop working.');
        }
        token = config.serveToken;
      }
      await serve({ port, host, token });
      if (lanMode) {
        console.log('Matterproof dashboard (LAN mode, token required off this machine):');
        for (const addr of lanAddresses()) {
          console.log(`  http://${addr}:${port}/?token=${token}`);
        }
        console.log(`  http://127.0.0.1:${port}  (this machine, no token needed)`);
        console.log('\nOpen the token link on your phone once — after that a cookie keeps you signed in.');
        console.log('Use only on networks you trust (traffic is plain HTTP on your LAN).');
        console.log('Rotate the token anytime: billable serve --lan --new-token. Ctrl+C to stop.');
      } else {
        console.log(`Matterproof dashboard: http://127.0.0.1:${port}`);
        console.log('Local only — the ledger never leaves this machine. Ctrl+C to stop.');
        console.log('Phone access on your network: billable serve --lan');
      }
      return new Promise(() => {}); // keep the server alive
    }

    case 'import': {
      const [file] = args._;
      if (!file) {
        console.error('Usage: billable import <conversations.json> [--client C] [--matter M] [--code A111]');
        process.exitCode = 1;
        return;
      }
      const { parseClaudeExport, dedupe } = require('../src/importers');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const parsed = parseClaudeExport(
        data,
        { client: args.client, matter: args.matter, code: args.code },
        config
      );
      const fresh = dedupe(parsed, store.readEvents());
      for (const ev of fresh) store.appendEvent(ev);
      const minutes = fresh.reduce((s, e) => s + e.minutes, 0);
      console.log(`Imported ${fresh.length} sittings (${minutes} min) from ${file}` +
        (parsed.length !== fresh.length ? `; skipped ${parsed.length - fresh.length} already imported` : ''));
      console.log('Review the entries before billing: billable serve');
      return;
    }

    case 'add': {
      const minutes = Number(args.minutes);
      const description = args.desc || args.description;
      if (!(minutes > 0) || !description) {
        console.error('Usage: billable add --minutes N --desc "What was done" [--client C] [--matter M]');
        process.exitCode = 1;
        return;
      }
      const date = args.date || today();
      store.appendEvent({
        ts: `${date}T12:00:00.000Z`,
        type: 'manual',
        minutes,
        description,
        client: args.client,
        matter: args.matter,
        code: args.code,
      });
      console.log(`Recorded ${minutes} min: ${description}`);
      return;
    }

    case 'status': {
      const entries = filterEntries(buildEntries(store.readEvents(), config, store.readOverrides()), {
        from: today(),
        to: today(),
      });
      const t = totals(entries);
      console.log(`Today: ${t.count} entries · ${t.steps} steps · ${t.hours.toFixed(1)} hours` +
        ((config.rate || 0) > 0 ? ` · ${money(t.amount, config.currency)}` : '') +
        (t.unreviewed ? ` · ${t.unreviewed} awaiting review (billable serve)` : ''));
      return;
    }

    case 'report': {
      const entries = filterEntries(buildEntries(store.readEvents(), config, store.readOverrides()), {
        from: args.from,
        to: args.to,
        client: args.client,
        matter: args.matter,
      });
      const format = args.format || 'text';
      let output;
      if (format === 'csv') {
        output = csvReport(entries, config);
      } else if (format === 'ledes') {
        output = ledesExport(entries, config, {
          from: args.from,
          to: args.to,
          invoiceNumber: args['invoice-number'],
        });
      } else if (format === 'html') {
        output = htmlInvoice(entries, config, {
          title: args.title,
          from: args.from,
          to: args.to,
        });
      } else {
        const period = args.from || args.to ? ` (${args.from || 'start'} to ${args.to || 'present'})` : '';
        output = textReport(entries, config, `Matterproof Timesheet${period}`);
      }
      if (args.out) {
        fs.writeFileSync(args.out, output);
        console.log(`Wrote ${args.out}`);
      } else {
        console.log(output);
      }
      return;
    }

    case 'economics': {
      const { buildEconomics, economicsReport } = require('../src/economics');
      const entries = filterEntries(buildEntries(store.readEvents(), config, store.readOverrides()), {
        from: args.from,
        to: args.to,
      });
      console.log(economicsReport(buildEconomics(entries, config), config));
      return;
    }

    case 'fee': {
      const [client, matter, amount] = args._;
      if (!client || !matter || !(Number(amount) >= 0)) {
        console.error('Usage: billable fee <client> <matter> <amount>');
        process.exitCode = 1;
        return;
      }
      config.flatFees = config.flatFees || {};
      config.flatFees[`${client}|${matter}`] = Number(amount);
      store.writeConfig(config);
      console.log(`Flat fee for ${client} / ${matter}: ${Number(amount).toFixed(2)}`);
      return;
    }

    case 'clio': {
      const clio = require('../src/clio');
      const [sub, ...subArgs] = args._;
      if (sub === 'connect') {
        await clio.connect(config);
        console.log('Connected to Clio.');
        return;
      }
      if (sub === 'matters') {
        const matters = await clio.listMatters(config);
        for (const m of matters) {
          console.log(`${String(m.id).padEnd(12)} ${m.number || ''}  ${m.client || ''} — ${m.description || ''}`);
        }
        if (!matters.length) console.log('(no open matters found)');
        return;
      }
      if (sub === 'map') {
        const [client, matter, id] = subArgs;
        if (!client || !matter || !id) {
          console.error('Usage: billable clio map <client> <matter> <clio-matter-id>');
          process.exitCode = 1;
          return;
        }
        config.clioMatters = config.clioMatters || {};
        config.clioMatters[`${client}|${matter}`] = Number(id);
        store.writeConfig(config);
        console.log(`${client} / ${matter} -> Clio matter ${id}`);
        return;
      }
      if (sub === 'push') {
        const entries = filterEntries(buildEntries(store.readEvents(), config, store.readOverrides()), {
          from: args.from,
          to: args.to,
        });
        const { results, skipped } = await clio.pushEntries(entries, config, store.readOverrides(), {
          dryRun: !!args['dry-run'],
        });
        const verb = args['dry-run'] ? 'Would push' : 'Pushed';
        console.log(`${verb} ${results.length} entries to Clio.`);
        const reasons = Object.entries(skipped).filter(([, n]) => n > 0);
        if (reasons.length) {
          console.log('Skipped: ' + reasons.map(([k, n]) => `${n} ${k}`).join(', '));
          if (skipped.unreviewed) console.log('  (review entries first: billable serve)');
          if (skipped.unmapped) console.log('  (map matters first: billable clio map ...)');
        }
        return;
      }
      console.error('Usage: billable clio <connect|matters|map|push>');
      process.exitCode = 1;
      return;
    }

    case 'lawpay': {
      const { buildPaymentRequest, markRequested, listRequests, outstanding, markPaid } = require('../src/lawpay');
      const [sub, ...subArgs] = args._;
      const cur = config.currency === 'USD' ? '$' : config.currency + ' ';

      if (sub === 'requests') {
        const requests = listRequests(store.readEvents());
        if (!requests.length) {
          console.log('No payment requests yet. Create one with: billable lawpay link');
          return;
        }
        for (const r of requests) {
          console.log(`${r.date}  ${r.reference}  ${(cur + (r.amountCents / 100).toFixed(2)).padStart(10)}  ` +
            `${r.paid ? `PAID ${r.paidAt}` : 'OUTSTANDING'}  ${r.description}`);
        }
        const due = outstanding(requests);
        console.log(`\nOutstanding: ${cur}${(due / 100).toFixed(2)} across ${requests.filter((r) => !r.paid).length} requests`);
        return;
      }

      if (sub === 'paid') {
        const [reference] = subArgs;
        if (!reference) {
          console.error('Usage: billable lawpay paid <MP-reference>');
          process.exitCode = 1;
          return;
        }
        try {
          const req = markPaid(reference, store.readEvents());
          console.log(`Marked ${reference} paid: ${cur}${(req.amountCents / 100).toFixed(2)} — ${req.description}`);
        } catch (err) {
          console.error(err.message);
          process.exitCode = 1;
        }
        return;
      }

      if (sub !== 'link') {
        console.error('Usage: billable lawpay <link|requests|paid>\n' +
          '  link [--from D] [--to D] [--client C] [--matter M]\n' +
          '       [--email E] [--desc TEXT] [--out statement.html] [--send] [--dry-run]\n' +
          '  requests                 List payment requests and outstanding balance\n' +
          '  paid <MP-reference>      Record that a request was paid');
        process.exitCode = 1;
        return;
      }
      if (args.send && args['dry-run']) {
        console.error('--send and --dry-run cannot be combined: sending IS the request.');
        process.exitCode = 1;
        return;
      }
      if (args.send && !args.email) {
        console.error('--send requires --email <client address>.');
        process.exitCode = 1;
        return;
      }
      const entries = filterEntries(buildEntries(store.readEvents(), config, store.readOverrides()), {
        from: args.from,
        to: args.to,
        client: args.client,
        matter: args.matter,
      });
      let request;
      try {
        request = buildPaymentRequest(entries, config, {
          from: args.from,
          to: args.to,
          email: args.email,
          description: args.desc,
        });
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      console.log(`Payment request ${request.reference}: ${cur}${(request.amountCents / 100).toFixed(2)}` +
        ` for ${request.included.length} entries (${request.totals.hours.toFixed(1)} hrs)`);
      console.log(`Description: ${request.description}`);
      const reasons = Object.entries(request.skipped).filter(([, n]) => n > 0);
      if (reasons.length) console.log('Excluded: ' + reasons.map(([k, n]) => `${n} ${k}`).join(', '));
      console.log('\n' + request.url + '\n');
      if (args.out) {
        const html = '<!doctype html><html><head><meta charset="utf-8">' +
          htmlInvoice(request.included, config, {
            from: args.from,
            to: args.to,
            payUrl: request.url,
          }) + '</html>';
        fs.writeFileSync(args.out, html);
        console.log(`Statement with Pay Now button: ${args.out}`);
      }
      if (args['dry-run']) {
        console.log('(dry run: entries NOT marked as billed; link is usable but unrecorded)');
      } else {
        if (args.send) {
          const { sendPaymentEmail } = require('../src/email');
          try {
            const sent = await sendPaymentEmail(config, {
              to: args.email,
              clientName: args.client || '',
              amountCents: request.amountCents,
              description: request.description,
              payUrl: request.url,
            });
            console.log(`Emailed payment request to ${sent.to} ("${sent.subject}")`);
          } catch (err) {
            console.error(`Email failed: ${err.message}`);
            console.error('The link above is still valid; entries were NOT marked. Fix and retry.');
            process.exitCode = 1;
            return;
          }
        }
        markRequested(request);
        console.log(`Marked ${request.included.length} entries as billed under ${request.reference}.`);
        console.log(`Track it: billable lawpay requests · settle it: billable lawpay paid ${request.reference}`);
      }
      return;
    }

    case 'config': {
      const [key, value] = args._;
      if (!key) {
        console.log(JSON.stringify(displayConfig(config, !!args.reveal), null, 2));
        return;
      }
      if (value === undefined) {
        const shown = displayConfig({ [key]: config[key] }, !!args.reveal)[key];
        console.log(JSON.stringify(shown, null, 2));
        return;
      }
      const numeric = ['rate', 'aiCostPerHour', 'incrementHours', 'minimumHours', 'idleCapMinutes'];
      const boolean = ['capturePrompts'];
      config[key] = numeric.includes(key)
        ? Number(value)
        : boolean.includes(key)
          ? value !== 'false'
          : value;
      store.writeConfig(config);
      console.log(`${key} = ${SECRET_KEYS.includes(key) ? '"********"' : JSON.stringify(config[key])}`);
      return;
    }

    case 'matter': {
      const [dir, client, matter] = args._;
      if (!dir || !client) {
        console.error('Usage: billable matter <dir> <client> [matter]');
        process.exitCode = 1;
        return;
      }
      const resolved = require('path').resolve(dir);
      config.projects = config.projects || {};
      config.projects[resolved] = { client, matter: matter || client };
      store.writeConfig(config);
      console.log(`Work in ${resolved} bills to ${client} / ${matter || client}`);
      return;
    }

    default:
      console.log(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
