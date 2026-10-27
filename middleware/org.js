// ─────────────────────────────────────────────────────────────────────
//  Which college is this request for?
//    1. A signed-in token carries its college (staff and student tokens).
//    2. Otherwise the web address the page was opened on: the website sends
//       `X-Org-Host: <its host>`; else the Origin / Host header is used.
//    3. Unknown address: DEFAULT_ORG_SLUG, else the only college (while there is one), else none.
//  A token for college A used from college B's address is refused.
//  The rest of the request then runs inside that college (services/tenant.js).
//
//  requireModule('training') — 403 when the college has not bought the module.
// ─────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const Organization = require('../models/Organization');
const tenant = require('../services/tenant');

const TTL = 60 * 1000;
let cache = { at: 0, byHost: new Map(), byId: new Map(), bySlug: new Map() };
async function load() {
  if (Date.now() - cache.at < TTL) return cache;
  const orgs = await Organization.find().lean();
  const next = { at: Date.now(), byHost: new Map(), byId: new Map(), bySlug: new Map() };
  for (const o of orgs) {
    next.byId.set(String(o._id), o); next.bySlug.set(o.slug, o);
    for (const h of o.hosts || []) next.byHost.set(h, o);
  }
  cache = next;
  return cache;
}
const forget = () => { cache.at = 0; };

const cleanHost = (h) => String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
function requestHost(req) {
  const given = req.headers['x-org-host'];
  if (given) return cleanHost(given);
  if (req.headers.origin) return cleanHost(req.headers.origin);
  return cleanHost(req.headers['x-forwarded-host'] || req.headers.host);
}
function tokenOrg(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || h.startsWith('Bearer slmcp_')) return undefined;
  try { const d = jwt.verify(h.slice(7), process.env.JWT_SECRET); return d.org === undefined ? undefined : (d.org || null); }
  catch { return undefined; }
}
const platformHosts = () => String(process.env.PLATFORM_HOSTS || '').split(',').map(cleanHost).filter(Boolean);

async function resolveOrg(req, res, next) {
  try {
    const c = await load();
    const host = requestHost(req);
    const byHost = c.byHost.get(host) || null;
    const claim = tokenOrg(req);
    let org = claim ? c.byId.get(String(claim)) || null : null;
    if (claim && !org) return res.status(401).json({ message: 'Please sign in again.' });
    if (org && byHost && String(org._id) !== String(byHost._id))
      return res.status(401).json({ message: 'You are signed in for another college. Please sign in again.' });
    if (!org) org = byHost;
    // unknown address (preview links, the API's own address): DEFAULT_ORG_SLUG, or the only college there is
    if (!org && !platformHosts().includes(host))
      org = (process.env.DEFAULT_ORG_SLUG && c.bySlug.get(process.env.DEFAULT_ORG_SLUG)) || (c.byId.size === 1 ? [...c.byId.values()][0] : null);
    if (org && org.status === 'suspended' && !req.originalUrl.startsWith('/api/platform') && !req.originalUrl.startsWith('/api/org'))
      return res.status(403).json({ message: `${org.name}'s subscription is paused. Contact the platform team.`, suspended: true });
    req.org = org;
    tenant.run(org?._id || null, next);
  } catch (err) { next(err); }
}

// Also: college routes need a college (an unknown address gets a clear 404).
const requireModule = (name) => (req, res, next) => {
  if (!req.org) return res.status(404).json({ message: 'This web address is not linked to a college.', noCollege: true });
  if (req.org.modules?.[name] === false)
    return res.status(403).json({ message: `This college has not switched on "${name}".`, module: name });
  next();
};

// Allowed browser origins: every college's hosts + platform hosts + local / preview addresses.
async function corsOrigin(origin, cb) {
  try {
    if (!origin) return cb(null, true);
    const h = cleanHost(origin);
    const c = await load();
    const fixed = [cleanHost(process.env.FRONTEND_URL || 'http://localhost:5173'), 'localhost', '127.0.0.1', ...platformHosts()];
    cb(null, c.byHost.has(h) || fixed.includes(h) || /\.vercel\.app$/.test(h));
  } catch (err) { cb(err); }
}

module.exports = { resolveOrg, requireModule, corsOrigin, forget, load, cleanHost };
