const express     = require('express');
const ApiToken    = require('../models/ApiToken');
const McpAuditLog = require('../models/McpAuditLog');
const { protect } = require('../middleware/auth');
const router      = express.Router();

// Every route here uses the normal website login (JWT). A user manages
// only THEIR OWN tokens. Superadmin can additionally see everyone's AI activity.

const MAX_ACTIVE_TOKENS = 5;
const ALLOWED_EXPIRY_DAYS = [30, 90, 365, 0]; // 0 = never expires

// Where AI apps should connect. Set PUBLIC_BASE_URL on Render to be exact,
// e.g. https://skill-lab-backend-t3th.onrender.com — otherwise we derive it.
function mcpUrl(req) {
  const base = (process.env.PUBLIC_BASE_URL ||
    `${(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0]}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/mcp`;
}

const publicShape = (t) => ({
  _id: t._id, name: t.name, prefix: t.prefix,
  createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt,
  expired: !!(t.expiresAt && t.expiresAt.getTime() < Date.now()),
});

// GET /api/tokens — my active tokens + the MCP URL to paste into AI apps
router.get('/', protect, async (req, res) => {
  try {
    const tokens = await ApiToken.find({ user: req.user._id, revokedAt: null }).sort('-createdAt');
    res.json({ tokens: tokens.map(publicShape), mcpUrl: mcpUrl(req) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/tokens  body: { name, expiresInDays }
// Returns the plain token ONCE. It can never be shown again.
router.post('/', protect, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ message: 'Give the token a name, e.g. "Claude on my laptop".' });

    const days = req.body.expiresInDays === undefined ? 90 : Number(req.body.expiresInDays);
    if (!ALLOWED_EXPIRY_DAYS.includes(days))
      return res.status(400).json({ message: 'Expiry must be 30, 90, 365 days or never.' });

    const active = await ApiToken.countDocuments({ user: req.user._id, revokedAt: null });
    if (active >= MAX_ACTIVE_TOKENS)
      return res.status(400).json({ message: `You already have ${MAX_ACTIVE_TOKENS} tokens. Revoke one first.` });

    const { plain, hash, prefix } = ApiToken.generate();
    const record = await ApiToken.create({
      user: req.user._id, name, hash, prefix,
      expiresAt: days ? new Date(Date.now() + days * 86400000) : null,
    });
    res.status(201).json({ token: plain, record: publicShape(record), mcpUrl: mcpUrl(req) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/tokens/:id — revoke one of MY tokens (it stops working immediately)
router.delete('/:id', protect, async (req, res) => {
  try {
    const t = await ApiToken.findOne({ _id: req.params.id, user: req.user._id, revokedAt: null });
    if (!t) return res.status(404).json({ message: 'Token not found' });
    t.revokedAt = new Date();
    await t.save();
    res.json({ message: 'Token revoked' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/tokens/activity — recent AI tool calls.
// Trainers see their own; superadmin sees everyone's.
router.get('/activity', protect, async (req, res) => {
  try {
    const filter = req.user.role === 'superadmin' ? {} : { user: req.user._id };
    const rows = await McpAuditLog.find(filter)
      .populate('user', 'name')
      .sort('-createdAt')
      .limit(Math.min(parseInt(req.query.limit) || 50, 200));
    res.json({
      activity: rows.map(r => ({
        _id: r._id, at: r.createdAt, user: r.user?.name || '—', tokenName: r.tokenName,
        tool: r.tool, args: r.args, ok: r.ok, error: r.error, durationMs: r.durationMs,
      })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
