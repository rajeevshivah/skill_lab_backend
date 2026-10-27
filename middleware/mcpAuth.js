const ApiToken = require('../models/ApiToken');
const User     = require('../models/User');
const tenant   = require('../services/tenant');
const { roleIn, asRequestUser } = require('./auth');

// Auth for the /mcp endpoint.
//
// The AI app sends:   Authorization: Bearer slmcp_xxxxxxxx
// We hash it, find the matching ApiToken, check it's not revoked/expired,
// and load the user. From then on the AI is treated exactly as that user —
// same role, same batches.
//
// Normal website login JWTs are NOT accepted here on purpose: tokens are
// separate so each AI connection can be revoked on its own.

// Simple in-memory rate limit per token: 120 calls per minute.
const WINDOW_MS = 60 * 1000;
const MAX_CALLS = 120;
const hits = new Map(); // tokenId -> { count, start }

function rateLimited(tokenId) {
  const now = Date.now();
  const rec = hits.get(tokenId);
  if (!rec || now - rec.start > WINDOW_MS) { hits.set(tokenId, { count: 1, start: now }); return false; }
  rec.count += 1;
  return rec.count > MAX_CALLS;
}
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
}, WINDOW_MS).unref?.();

function deny(res, status, message) {
  // JSON-RPC shaped error so MCP clients show a readable message.
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="skilllab-mcp"');
  return res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

exports.mcpAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const plain  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!plain || !plain.startsWith(ApiToken.TOKEN_PREFIX))
      return deny(res, 401, 'Missing Skill Lab MCP token. Generate one under "Connect AI" in the Skill Lab app.');

    // the token decides the college (AI apps call from no college web address)
    const token = await ApiToken.findOne({ hash: ApiToken.hashToken(plain) }).setOptions({ allOrgs: true });
    if (!token || !token.isUsable())
      return deny(res, 401, 'This token is invalid, revoked or expired. Generate a new one under "Connect AI".');

    const user = await User.findById(token.user).select('-password');
    const role = roleIn(user, token.org);
    if (!role)
      return deny(res, 401, 'The account behind this token is inactive.');

    if (rateLimited(token._id.toString()))
      return deny(res, 429, 'Too many requests — slow down (limit 120 per minute).');

    // Record last use at most once a minute (avoids a write on every call).
    if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > 60 * 1000) {
      ApiToken.updateOne({ _id: token._id }, { lastUsedAt: new Date() }).setOptions({ allOrgs: true }).catch(() => {});
    }

    const org = await require('./org').load().then(c => c.byId.get(String(token.org)));
    if (!org) return deny(res, 401, 'This token is not linked to a college.');
    if (org.status === 'suspended') return deny(res, 403, `${org.name}'s subscription is paused.`);
    if (org.modules?.ai === false) return deny(res, 403, `${org.name} has not switched on AI connections.`);
    req.org = org;
    req.user = asRequestUser(user, role, org._id);
    req.apiToken = token;
    tenant.run(org._id, next);
  } catch (err) {
    return deny(res, 500, 'Auth check failed');
  }
};
