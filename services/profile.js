// ─────────────────────────────────────────────────────────────────────
//  The student's own profile: what they may fill in, the checks, and how
//  complete it is. Same answer for the student app and for staff.
//
//  Built-in: photo, mobile, personal email, GitHub, LinkedIn, portfolio.
//  Plus the college's extra fields that students may fill
//  (ProfileField.editableBy = 'student'); the required ones count towards
//  "complete". Mobile / email stay "not verified" until a one-time code
//  confirms them (not built yet).
// ─────────────────────────────────────────────────────────────────────
const ProfileField = require('../models/ProfileField');
const people = require('./people');

class ProfileError extends Error {}

// 98765 43210 / +91-9876543210 / 09876543210 → 9876543210 (Indian mobile: 10 digits, starts 6–9)
function mobile(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(d)) throw new ProfileError('Give a 10-digit mobile number, like 9876543210.');
  return d;
}
function email(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) || e.length > 120) throw new ProfileError('That email does not look right.');
  return e;
}
const LINKS = {
  github:    [/^https:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/i, 'Give your GitHub profile link, like https://github.com/yourname'],
  linkedin:  [/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s/?#]+\/?$/i, 'Give your LinkedIn profile link, like https://www.linkedin.com/in/yourname'],
  portfolio: [/^https:\/\/[^\s]+\.[^\s]+$/i, 'Your portfolio link must start with https://'],
};
function link(kind, raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (/^http:\/\//i.test(v)) v = 'https://' + v.slice(7);
  if (!/^https:\/\//i.test(v)) v = 'https://' + v;
  const [rx, msg] = LINKS[kind];
  if (!rx.test(v) || v.length > 200) throw new ProfileError(msg);
  return v;
}

const studentFields = () => ProfileField.find({ isActive: true, editableBy: 'student' }).sort('group order label').lean();

// How complete: built-in items + the college's required student fields.
function completion(person, fields, hasPhoto) {
  const items = [
    ['photo', 'Photo', !!hasPhoto],
    ['phone', 'Mobile number', !!person.contact?.phone],
    ['email', 'Personal email', !!person.contact?.email],
    ['github', 'GitHub profile', !!person.links?.github],
    ['linkedin', 'LinkedIn profile', !!person.links?.linkedin],
    ...fields.filter(f => f.required).map(f => [`custom.${f.key}`, f.label, person.custom?.[f.key] !== undefined && person.custom?.[f.key] !== null && person.custom?.[f.key] !== '']),
  ];
  const done = items.filter(i => i[2]).length;
  return { percent: Math.round(100 * done / items.length), done, total: items.length, missing: items.filter(i => !i[2]).map(i => i[1]) };
}

// The student's view of their profile
function view(person, fields, hasPhoto) {
  return {
    name: person.name, roll: person.roll,
    phone: person.contact?.phone || '', phoneVerified: !!person.contact?.phoneVerifiedAt,
    email: person.contact?.email || '', emailVerified: !!person.contact?.emailVerifiedAt,
    github: person.links?.github || '', linkedin: person.links?.linkedin || '', portfolio: person.links?.portfolio || '',
    custom: Object.fromEntries(fields.map(f => [f.key, person.custom?.[f.key] ?? null])),
    verified: Object.fromEntries(fields.filter(f => person.verified?.[f.key]).map(f => [f.key, true])),
    fields: fields.map(f => ({ key: f.key, label: f.label, type: f.type, options: f.options, group: f.group, help: f.help, required: f.required, min: f.min, max: f.max, needsVerification: f.needsVerification })),
    consentGiven: !!person.consents?.profileAt,
    completion: completion(person, fields, hasPhoto),
  };
}

// What the student sends → the $set for their Person. Throws ProfileError.
async function changesFrom(person, body, fields) {
  const set = {};
  if (body.phone !== undefined) set['contact.phone'] = body.phone ? mobile(body.phone) : '';
  if (body.email !== undefined) set['contact.email'] = body.email ? email(body.email) : '';
  // a changed number / email is not verified any more
  if (set['contact.phone'] !== undefined && set['contact.phone'] !== (person.contact?.phone || '')) set['contact.phoneVerifiedAt'] = null;
  if (set['contact.email'] !== undefined && set['contact.email'] !== (person.contact?.email || '')) set['contact.emailVerifiedAt'] = null;
  for (const k of Object.keys(LINKS)) if (body[k] !== undefined) set[`links.${k}`] = link(k, body[k]);
  if (body.custom !== undefined) {
    const { values, errors } = people.checkCustom(fields, body.custom || {}, { asStudent: true });
    if (errors.length) throw new ProfileError(errors.join(' '));
    const fileKeys = Object.keys(values).filter(k => values[k] && fields.find(f => f.key === k)?.type === 'file');
    if (fileKeys.length) {   // a file field must point at the student's own upload
      const Document = require('../models/Document');
      const mine = new Set((await Document.find({ _id: { $in: fileKeys.map(k => values[k]) }, owner: person._id }).select('_id').lean()).map(d => String(d._id)));
      const bad = fileKeys.filter(k => !mine.has(String(values[k])));
      if (bad.length) throw new ProfileError('Upload the file again, please.');
    }
    for (const [k, v] of Object.entries(values)) {
      set[`custom.${k}`] = v;
      // a changed value is not checked by the college any more
      if (JSON.stringify(v) !== JSON.stringify(person.custom?.[k] ?? null) && person.verified?.[k]) set[`verified.${k}`] = null;
    }
  }
  if (!person.consents?.profileAt) {
    if (body.consent !== true) throw new ProfileError('Please tick that you agree your college may use these details for training and placement.');
    set['consents.profileAt'] = new Date();
  }
  return set;
}

module.exports = { ProfileError, mobile, email, link, studentFields, completion, view, changesFrom };
