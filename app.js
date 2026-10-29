// The Express app (routes + middleware), without connecting or listening.
// server.js starts it; tests/profile.js measures it.
const express   = require('express');
const cors      = require('cors');
const compression = require('compression');
const reqTiming = require('./services/reqTiming');
const { resolveOrg, requireModule, corsOrigin } = require('./middleware/org');

const app = express();
// Render puts one proxy in front of the app: trust exactly that hop, so req.ip is
// the real visitor (a forged X-Forwarded-For from the visitor is ignored).
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── Middleware ────────────────────────────────────────────────────
// Browsers may call from any college's own web address (middleware/org.js).
app.use(cors({ origin: corsOrigin, credentials: true, exposedHeaders: ['Server-Timing'] }));
app.use(reqTiming.middleware);   // Server-Timing header: database vs app time per request
// gzip every JSON answer (5–10× smaller over the slow India ↔ server link)
// (not /mcp — AI apps there may get streamed answers, which must not be held back)
app.use(compression({ filter: (req, res) => !req.originalUrl.startsWith('/mcp') && compression.filter(req, res) }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Server errors: the full message goes to the log; in production the user gets a
// plain sentence, never database or code details.
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && process.env.NODE_ENV === 'production') {
      console.error(`[500] ${req.method} ${req.originalUrl}:`, body?.message || body);
      return json({ message: 'Something went wrong on the server. Please try again.' });
    }
    return json(body);
  };
  next();
});
// Every request runs inside one college from here on (services/tenant.js).
app.use(resolveOrg);

// ── Routes ────────────────────────────────────────────────────────
// A module the college has not bought answers 403 (Organization.modules).
const training = requireModule('training'), fame = requireModule('hallOfFame'),
  studentApp = requireModule('studentApp'), ai = requireModule('ai');
const fameOnly = (req, res, next) => /^\/(halloffame|[a-f0-9]{24}\/photo)/.test(req.path) ? fame(req, res, next) : next();

app.use('/api/org',       require('./routes/org'));            // which college this address opens (public)
app.use('/api/platform',  require('./routes/platform'));       // owner console (platform owner only)
app.use('/api/auth',      require('./routes/auth'));
// core — the college's people and academic structure, shared by every module
app.use('/api/people',    require('./routes/people'));
app.use('/api/academics', require('./routes/academics'));
app.use('/api/semesters', training, require('./routes/semesters'));
app.use('/api/batches',   training, require('./routes/batches'));
app.use('/api/students',  training, require('./routes/students'));
app.use('/api/plans',     training, require('./routes/plans'));
app.use('/api/logs',      training, require('./routes/logs'));
app.use('/api/toppers',   fame, require('./routes/toppers'));
app.use('/api/cycles',    fameOnly, training, require('./routes/cycles'));
app.use('/api/marks',     training, require('./routes/cyclemarks'));
app.use('/api/cycleplans', training, require('./routes/cycleplans'));
app.use('/api/search',    training, require('./routes/search'));
app.use('/api/performance', training, require('./routes/performance'));
app.use('/api/tokens',    ai, require('./routes/tokens'));     // MCP tokens for AI apps
app.use('/api/student',   studentApp, require('./routes/student'));        // students: sign-in, my cycle, submit, pulse, feedback
app.use('/api/student-admin', studentApp, require('./routes/studentAdmin')); // staff: join codes, resets, submissions, pulse totals
app.use('/api/feedback',  studentApp, require('./routes/feedback'));       // trainer feedback windows + results
app.use('/api/settings',  training, require('./routes/settings'));       // admin: batch timetables + holidays
app.use('/api/meeting',   training, require('./routes/meeting'));        // meeting screens: daily review, cycle review, notes

// ── MCP endpoint (AI apps connect here — see MCP-GUIDE.md) ────────
app.use('/mcp', require('./mcp'));

// GET /api/health          — is the server up (also used by keep-awake pingers)
// GET /api/health?db=1     — plus the database round-trip time
app.get('/api/health', async (req, res) => {
  const out = { status: 'ok', time: new Date(), uptimeSec: Math.round(process.uptime()) };
  if (req.query.db) {
    try {
      const mongoose = require('mongoose');
      const db = mongoose.connection.db;
      const pings = [];
      for (let i = 0; i < 3; i++) { const t = Date.now(); await db.admin().command({ ping: 1 }); pings.push(Date.now() - t); }
      out.db = { pingMs: Math.min(...pings), pings };
    } catch (e) { out.db = { error: e.message }; }

  }
  res.set('Cache-Control', 'no-store').json(out);
});

// Anything thrown and not answered: a broken request body is the sender's mistake (400);
// everything else is logged and answered with a plain sentence.
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')
    return res.status(err.status || 400).json({ message: err.type === 'entity.too.large' ? 'That upload is too large.' : 'The request could not be read.' });
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ message: 'Something went wrong on the server. Please try again.' });
});

module.exports = app;
