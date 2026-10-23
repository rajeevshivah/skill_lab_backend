// The Express app (routes + middleware), without connecting or listening.
// server.js starts it; tests/profile.js measures it.
const express   = require('express');
const cors      = require('cors');
const compression = require('compression');
const reqTiming = require('./services/reqTiming');

const app = express();

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'https://skilllab.sheat.ac.in',
    /\.vercel\.app$/
  ],
  credentials: true,
  exposedHeaders: ['Server-Timing'],
}));
app.use(reqTiming.middleware);   // Server-Timing header: database vs app time per request
// gzip every JSON answer (5–10× smaller over the slow India ↔ server link)
// (not /mcp — AI apps there may get streamed answers, which must not be held back)
app.use(compression({ filter: (req, res) => !req.originalUrl.startsWith('/mcp') && compression.filter(req, res) }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Routes ────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/semesters', require('./routes/semesters'));
app.use('/api/batches',   require('./routes/batches'));
app.use('/api/students',  require('./routes/students'));
app.use('/api/plans',     require('./routes/plans'));
app.use('/api/logs',      require('./routes/logs'));
app.use('/api/toppers',   require('./routes/toppers'));
app.use('/api/cycles',    require('./routes/cycles'));
app.use('/api/marks',     require('./routes/cyclemarks'));
app.use('/api/cycleplans', require('./routes/cycleplans'));
app.use('/api/search',    require('./routes/search'));
app.use('/api/performance', require('./routes/performance'));
app.use('/api/tokens',    require('./routes/tokens'));   // MCP tokens for AI apps
app.use('/api/student',   require('./routes/student'));        // students: sign-in, my cycle, submit, pulse, feedback
app.use('/api/student-admin', require('./routes/studentAdmin')); // staff: join codes, resets, submissions, pulse totals
app.use('/api/feedback',  require('./routes/feedback'));       // trainer feedback windows + results
app.use('/api/settings',  require('./routes/settings'));       // admin: batch timetables + holidays
app.use('/api/meeting',   require('./routes/meeting'));        // meeting screens: daily review, cycle review, notes

// ── MCP endpoint (AI apps connect here — see MCP-GUIDE.md) ────────
app.use('/mcp', require('./mcp'));

// GET /api/health          — is the server up (also used by keep-awake pingers)
// GET /api/health?db=1     — plus database round-trip time and the database's region
//                            (Atlas tags), to check the server and database sit close together
app.get('/api/health', async (req, res) => {
  const out = { status: 'ok', time: new Date(), uptimeSec: Math.round(process.uptime()) };
  if (req.query.db) {
    try {
      const mongoose = require('mongoose');
      const db = mongoose.connection.db;
      const pings = [];
      for (let i = 0; i < 3; i++) { const t = Date.now(); await db.admin().command({ ping: 1 }); pings.push(Date.now() - t); }
      const hello = await db.admin().command({ hello: 1 });
      out.db = { pingMs: Math.min(...pings), pings, region: hello.tags?.region || null, provider: hello.tags?.provider || null };
    } catch (e) { out.db = { error: e.message }; }
    out.server = { region: process.env.RENDER_REGION || process.env.REGION || null };
  }
  res.set('Cache-Control', 'no-store').json(out);
});

module.exports = app;
