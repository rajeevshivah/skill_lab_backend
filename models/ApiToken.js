const mongoose = require('mongoose');
const crypto   = require('crypto');

// A personal access token that lets an AI app (Claude, ChatGPT, Cursor…)
// act AS one Skill Lab user through the /mcp endpoint.
//
// We never store the token itself — only its SHA-256 hash, exactly like a
// password. The plain token is shown to the user once, at creation.
// If it leaks, the user revokes it; their real password stays safe.
const apiTokenSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:       { type: String, required: true, trim: true, maxlength: 60 }, // "My Claude Desktop"
  hash:       { type: String, required: true, unique: true },              // sha256 of the token
  prefix:     { type: String, required: true },                            // first chars, for display only
  expiresAt:  { type: Date, default: null },                               // null = never
  lastUsedAt: { type: Date, default: null },
  revokedAt:  { type: Date, default: null },
}, { timestamps: true });

apiTokenSchema.index({ user: 1, revokedAt: 1 });

const TOKEN_PREFIX = 'slmcp_';

// Make a new random token. Returns the plain value (show once) + its hash.
apiTokenSchema.statics.generate = function () {
  const plain = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { plain, hash: hashToken(plain), prefix: plain.slice(0, 12) };
};

apiTokenSchema.statics.hashToken = hashToken;
apiTokenSchema.statics.TOKEN_PREFIX = TOKEN_PREFIX;

apiTokenSchema.methods.isUsable = function () {
  if (this.revokedAt) return false;
  if (this.expiresAt && this.expiresAt.getTime() < Date.now()) return false;
  return true;
};

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

module.exports = mongoose.model('ApiToken', apiTokenSchema);
