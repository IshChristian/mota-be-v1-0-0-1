const mongoose = require('mongoose');

const rideDisputeSchema = new mongoose.Schema({
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, index: true },
  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  category: { type: String, enum: ['conduct', 'fare', 'route', 'vehicle', 'safety', 'cancellation', 'payment', 'other'], required: true },
  description: { type: String, trim: true, minlength: 10, maxlength: 4000, required: true },
  evidence: [{ type: String, trim: true }],
  status: { type: String, enum: ['submitted', 'investigating', 'waiting_customer', 'resolved', 'rejected'], default: 'submitted', index: true },
  refund: {
    requested: { type: Boolean, default: false },
    amount: { type: Number, min: 0 },
    status: { type: String, enum: ['not_requested', 'requested', 'approved', 'rejected', 'processed'], default: 'not_requested' },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  },
  replies: [{ authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, message: { type: String, trim: true, maxlength: 2000 }, createdAt: { type: Date, default: Date.now } }],
  resolution: { type: String, trim: true, maxlength: 4000 },
}, { timestamps: true });

rideDisputeSchema.index({ rideId: 1, openedBy: 1 }, { unique: true });
module.exports = mongoose.model('RideDispute', rideDisputeSchema);
