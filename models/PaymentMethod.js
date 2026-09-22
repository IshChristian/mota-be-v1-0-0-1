const mongoose = require('mongoose');

const paymentMethodSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['momo', 'cash'], required: true },
  label: { type: String, trim: true, maxlength: 80, required: true },
  phone: { type: String, trim: true },
  maskedAccount: { type: String, trim: true },
  providerReference: { type: String, select: false },
  status: { type: String, enum: ['pending', 'verified', 'failed'], default: 'pending' },
  isDefault: { type: Boolean, default: false },
  verificationOtpHash: { type: String, select: false },
  verificationExpiresAt: { type: Date, select: false },
  lastFailure: { message: String, at: Date },
}, { timestamps: true });

paymentMethodSchema.index({ userId: 1, isDefault: 1 });
module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);
