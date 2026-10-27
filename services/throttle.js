// ─────────────────────────────────────────────────────────────────────
//  Failed-attempt limits for sign-in, student sign-up and similar.
//  Counted twice: per address (req.ip — the real client address, because
//  app.js trusts Render's proxy, so a forged X-Forwarded-For does not help)
//  AND per account (email / roll), so rotating addresses does not help either.
//  In memory: enough for one server; counters reset when it restarts.
// ─────────────────────────────────────────────────────────────────────
function limiter({ windowMs = 15 * 60 * 1000, perIp = 20, perAccount = 8 } = {}) {
  const hits = new Map();   // key -> { n, first }
  const get = (k) => { const r = hits.get(k); if (r && Date.now() - r.first > windowMs) { hits.delete(k); return null; } return r; };
  const keys = (req, account) => [`ip|${req.ip}`, `acct|${String(account || '').trim().toLowerCase()}`];
  setInterval(() => { const c = Date.now() - windowMs; for (const [k, v] of hits) if (v.first < c) hits.delete(k); }, windowMs).unref?.();
  return {
    blocked(req, account) {
      const [ip, acct] = keys(req, account);
      return (get(ip)?.n || 0) >= perIp || (account && (get(acct)?.n || 0) >= perAccount);
    },
    fail(req, account) {
      for (const k of keys(req, account)) { const r = get(k); if (r) r.n++; else hits.set(k, { n: 1, first: Date.now() }); }
    },
    clear(req, account) { hits.delete(keys(req, account)[1]); },
    reset() { hits.clear(); },          // tests
  };
}
module.exports = { limiter };
