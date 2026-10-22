// ─────────────────────────────────────────────────────────────────────
//  The daily-log rule (applies to class days from RULE_FROM onward).
//
//  A class log is COMPLETE when it says:
//    1. which planned class it was     (planClass — a class number of the cycle plan)
//    2. how it went                    (status: done / partial / not-covered)
//    3. whether students pushed to GitHub (github: all / most / few / none / na)
//    4. what was actually taught       (notes) — required when it was not "done as planned"
//
//  Scoring (services/performance.js): complete on the class day = full credit,
//  complete later = half, saved on the day but incomplete = half, saved later
//  and still incomplete = quarter. A day the admin marks "no class" (holiday,
//  exam, cancelled) is not counted at all.
// ─────────────────────────────────────────────────────────────────────
const RULE_FROM = '2026-10-26';
const GITHUB = ['all', 'most', 'few', 'none', 'na'];

function missingParts(log) {
  const miss = [];
  if (!log) return ['log'];
  if (log.status === 'no-class') return [];
  if (log.planClass == null) miss.push('planned class');
  if (!GITHUB.includes(log.github)) miss.push('GitHub push');
  if (log.status && log.status !== 'done' && !(log.notes || '').trim()) miss.push('what was taught');
  return miss;
}
const isComplete = (log) => missingParts(log).length === 0;

module.exports = { RULE_FROM, GITHUB, missingParts, isComplete };
