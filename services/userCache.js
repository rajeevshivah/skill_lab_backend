// Who-is-signed-in cache for the auth middleware. Without it every request
// spends one database round trip (~200 ms on a far-away database) just to
// look up the user. Entries live 60 s and are dropped the moment the user is
// saved or deleted (hooks in models/User.js), so role changes and
// deactivation still apply at once.
const TTL = 60 * 1000;
const cache = new Map();

module.exports = {
  get(id) {
    const e = cache.get(String(id));
    if (!e) return null;
    if (Date.now() > e.until) { cache.delete(String(id)); return null; }
    return e.user;
  },
  set(id, user) {
    if (cache.size > 500) cache.clear();   // tiny staff list; just a safety cap
    cache.set(String(id), { user, until: Date.now() + TTL });
  },
  forget(id) { if (id == null) cache.clear(); else cache.delete(String(id)); },
};
