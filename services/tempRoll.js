// Temporary student IDs (TMP-7K3QF) for students without a roll number yet —
// unique inside the college, easy to read out (no 0/O, 1/I).
const crypto = require('crypto');
const Student = require('../models/Student');

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'TMP-';
const isTemp = (roll) => String(roll || '').toUpperCase().startsWith(PREFIX);

function make() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CHARS[crypto.randomInt(CHARS.length)];
  return PREFIX + s;
}

// n new IDs not used by any student of this college (nor by each other)
async function issue(n = 1) {
  const out = new Set();
  while (out.size < n) {
    const want = Array.from({ length: (n - out.size) * 2 }, make).filter(r => !out.has(r));
    const taken = new Set((await Student.find({ roll: { $in: want } }).select('roll').setOptions({ withDemo: true }).lean()).map(s => s.roll));
    for (const r of want) if (!taken.has(r) && out.size < n) out.add(r);
  }
  return [...out];
}

module.exports = { issue, isTemp, PREFIX };
