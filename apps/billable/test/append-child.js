'use strict';
// Concurrency test helper: append K events to the shared ledger and exit.
// Spawned in parallel by audit.test.js to prove the lockfile prevents forks.
const store = require('../src/store');

const k = Number(process.argv[2]) || 1;
for (let i = 0; i < k; i++) {
  store.appendEvent({
    ts: new Date().toISOString(),
    type: 'tool',
    tool: `child-${process.pid}-${i}`,
    session: `pid-${process.pid}`,
  });
}
