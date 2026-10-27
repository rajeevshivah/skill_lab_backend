// GET /api/org — which college this web address opens (public: the sign-in page
// shows its name, the menus hide modules it has not bought).
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const o = req.org;
  res.set('Cache-Control', 'no-store');
  if (!o) return res.json({ org: null, platform: 'Pramakra' });
  res.json({
    org: { id: o._id, name: o.name, shortName: o.shortName || o.name, programName: o.programName || 'Skill Lab',
      slug: o.slug, modules: o.modules, status: o.status },
    platform: 'Pramakra',
  });
});

module.exports = router;
