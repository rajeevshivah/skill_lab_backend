// ─────────────────────────────────────────────────────────────────────
//  The college wall. Every request runs "inside" one college (org); a
//  mongoose plugin adds `org` to every record a college owns and to EVERY
//  query, update, delete, count and aggregate on those models — so a route
//  that forgets to filter can never see or touch another college's data.
//
//  No college context + a query on a college model = an error (never a
//  silent "all colleges"). Platform-wide code (the owner console, the
//  startup migration) opts out explicitly with .setOptions({ allOrgs: true }).
//
//  How the college is found for a request: middleware/org.js
// ─────────────────────────────────────────────────────────────────────
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const als = new AsyncLocalStorage();
const currentOrg = () => als.getStore()?.org || null;
const run = (org, fn) => als.run({ org: org ? new mongoose.Types.ObjectId(String(org)) : null }, fn);
// For scripts and tests: the rest of this async flow runs as `org`.
const enter = (org) => als.enterWith({ org: org ? new mongoose.Types.ObjectId(String(org)) : null });

class NoCollege extends Error {}
const need = (model) => {
  const org = currentOrg();
  if (!org) throw new NoCollege(`No college context for ${model} (a query outside a college request).`);
  return org;
};

const QUERY_OPS = ['find', 'findOne', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'replaceOne'];

function plugin(schema) {
  schema.add({ org: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true } });

  function scope() {
    if (this.getOptions().allOrgs) return;
    const org = need(this.model.modelName);
    this.where({ org });
    // updates never move a record to another college
    const u = this.getUpdate && this.getUpdate();
    if (u && (u.org || u.$set?.org) && String(u.org || u.$set.org) !== String(org)) throw new NoCollege('A record cannot move to another college.');
  }
  for (const op of QUERY_OPS) schema.pre(op, { query: true, document: false }, scope);

  schema.pre('save', function () {
    const org = currentOrg();
    if (!this.org) { this.org = need(this.constructor.modelName); return; }
    if (org && String(this.org) !== String(org)) throw new NoCollege('This record belongs to another college.');
  });
  schema.pre('insertMany', function (next, docs) {
    const org = need(this.modelName);
    for (const d of Array.isArray(docs) ? docs : [docs]) if (!d.org) d.org = org;
    next();
  });
  schema.pre('aggregate', function () {
    if (this.options?.allOrgs) return;
    this.pipeline().unshift({ $match: { org: need(this._model?.modelName || 'aggregate') } });
  });
  // bulkWrite has no query middleware: scope each operation here.
  schema.statics.bulkWrite = function (ops, options = {}) {
    if (options.allOrgs) { const { allOrgs, ...rest } = options; return mongoose.Model.bulkWrite.call(this, ops, rest); }
    const org = need(this.modelName);
    const scoped = ops.map(op => {
      const [kind, body] = Object.entries(op)[0];
      if (kind === 'insertOne') return { insertOne: { document: { ...body.document, org: body.document.org || org } } };
      const b = { ...body, filter: { ...(body.filter || {}), org } };
      if (b.update?.$set?.org && String(b.update.$set.org) !== String(org)) throw new NoCollege('A record cannot move to another college.');
      return { [kind]: b };
    });
    return mongoose.Model.bulkWrite.call(this, scoped, options);
  };
}

module.exports = { als, run, enter, currentOrg, plugin, NoCollege };
