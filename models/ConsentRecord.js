const mongoose = require('mongoose');

const consentRecordSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['terms', 'privacy', 'location', 'financial_data', 'marketing'], required: true },
  version: { type: String, required: true, trim: true },
  granted: { type: Boolean, required: true },
  source: { type: String, enum: ['mobile', 'web', 'admin'], required: true },
  ipAddress: String,
  recordedAt: { type: Date, default: Date.now },
}, { timestamps: true });

consentRecordSchema.index({ userId: 1, type: 1, version: 1 }, { unique: true });
module.exports = mongoose.model('ConsentRecord', consentRecordSchema);
