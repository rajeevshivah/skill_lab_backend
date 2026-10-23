// Per-request timing, sent back in the standard `Server-Timing` header:
//   Server-Timing: db;dur=412;desc="3 queries", app;dur=530
// Browser dev tools show it under Network → Timing, and it is how slow pages
// were measured on the live site. Needs mongoose.connect(..., { monitorCommands: true }).
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const inflight = new Map();   // driver requestId → { store, t }

function middleware(req, res, next) {
  const store = { t0: process.hrtime.bigint(), db: 0, n: 0 };
  res.setHeader('Timing-Allow-Origin', '*');   // lets the browser show these numbers cross-site
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    try {
      const app = Number(process.hrtime.bigint() - store.t0) / 1e6;
      res.setHeader('Server-Timing', `db;dur=${store.db.toFixed(0)};desc="${store.n} queries", app;dur=${app.toFixed(0)}`);
    } catch { /* headers already sent */ }
    return writeHead.apply(this, args);
  };
  als.run(store, next);
}

function watch(client) {
  client.on('commandStarted', (e) => {
    const store = als.getStore();
    if (store) inflight.set(e.requestId, { store, t: process.hrtime.bigint() });
  });
  const done = (e) => {
    const x = inflight.get(e.requestId);
    if (!x) return;
    inflight.delete(e.requestId);
    x.store.n++;
    x.store.db += Number(process.hrtime.bigint() - x.t) / 1e6;
  };
  client.on('commandSucceeded', done);
  client.on('commandFailed', done);
}

module.exports = { middleware, watch };
