const mongoose = require('mongoose');

const safetyEventSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', index: true },
  type: { type: String, enum: ['sos', 'incident', 'location_share'], required: true },
  category: { type: String, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 4000 },
  location: { latitude: Number, longitude: Number, capturedAt: Date },
  evidence: [{ type: String, trim: true }],
  status: { type: String, enum: ['open', 'acknowledged', 'resolved', 'closed'], default: 'open', index: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolution: { type: String, trim: true, maxlength: 4000 },
}, { timestamps: true });

module.exports = mongoose.model('SafetyEvent', safetyEventSchema);
