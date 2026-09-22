const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sessionId: { type: String, required: true, unique: true, index: true },
  userAgent: { type: String, maxlength: 500 },
  ipAddress: String,
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('Session', sessionSchema);
