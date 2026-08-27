require('dotenv').config();
const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const User      = require('./models/User');

const app = express();

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'https://skilllab.sheat.ac.in',
    /\.vercel\.app$/
  ],
  credentials: true
}));
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

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Connect DB & seed superadmin ──────────────────────────────────
async function start() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');

  const existing = await User.findOne({ role: 'superadmin' });
  if (!existing) {
    await User.create({
      name: 'Super Admin', email: 'admin@sheat.ac.in',
      password: 'sheat@admin2026', role: 'superadmin'
    });
    console.log('Default superadmin created: admin@sheat.ac.in / sheat@admin2026');
    console.log('CHANGE THIS PASSWORD after first login.');
  }

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch(console.error);
