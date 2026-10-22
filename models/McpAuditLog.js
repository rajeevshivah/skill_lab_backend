const mongoose = require('mongoose');

// One row per tool call an AI app made through /mcp.
// Answers "what did the AI do, as whom, and when?"
// Rows delete themselves after 180 days (TTL index below).
const mcpAuditLogSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token:      { type: mongoose.Schema.Types.ObjectId, ref: 'ApiToken', default: null },
  tokenName:  { type: String, default: '' },
  tool:       { type: String, required: true },
  args:       { type: String, default: '' },     // JSON of the arguments, trimmed
  ok:         { type: Boolean, default: true },
  error:      { type: String, default: '' },
  durationMs: { type: Number, default: 0 },
}, { timestamps: { createdAt: true, updatedAt: false } });

mcpAuditLogSchema.index({ user: 1, createdAt: -1 });
mcpAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('McpAuditLog', mcpAuditLogSchema);
