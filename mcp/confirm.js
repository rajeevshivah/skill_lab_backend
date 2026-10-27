// ─────────────────────────────────────────────────────────────────────
//  Preview → confirm, for every MCP write tool.
//
//  Step 1: the AI calls a write tool WITHOUT confirm. Nothing is saved.
//          We return a preview of the exact changes + a preview_token.
//  Step 2: the AI shows you the preview. Only if you say yes, it calls the
//          same tool again with the SAME arguments + confirm=true + the token.
//
//  The token is a signature over (user, tool, arguments, expiry), made with
//  JWT_SECRET. So it cannot be used for different arguments, another tool,
//  another user, another college, or after 15 minutes — and each token works
//  ONCE (a used token is remembered until it expires).
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const TTL_MS = 15 * 60 * 1000;

// JSON with sorted keys, so {a,b} and {b,a} sign the same.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object')
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function stripControl(args) {
  const { confirm, preview_token, ...rest } = args || {};
  return rest;
}

const used = new Map();   // token -> expiry
setInterval(() => { const now = Date.now(); for (const [t, e] of used) if (e < now) used.delete(t); }, 60 * 1000).unref?.();
const college = () => String(require('../services/tenant').currentOrg() || '');

function sign(userId, tool, args, exp) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', secret)
    .update(`${userId}|${college()}|${tool}|${stable(stripControl(args))}|${exp}`)
    .digest('base64url');
}

exports.makePreviewToken = (userId, tool, args) => {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(String(userId), tool, args, exp)}`;
};

// Returns null if OK, otherwise a human-readable reason.
exports.checkPreviewToken = (userId, tool, args, token) => {
  if (!token) return 'Missing preview_token. Call the tool without confirm first, show the preview to the user, and only then confirm.';
  const [expStr, sig] = String(token).split('.');
  const exp = Number(expStr);
  if (!exp || !sig) return 'Invalid preview_token.';
  if (Date.now() > exp) return 'This preview expired (15 minutes). Make a fresh preview and ask the user again.';
  const expected = sign(String(userId), tool, args, exp);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return 'The arguments changed since the preview. Make a fresh preview with the final values and ask the user again.';
  if (used.has(token)) return 'This preview was already confirmed once. Make a fresh preview to do it again.';
  used.set(token, exp);
  return null;
};

exports.stable = stable;
