const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
});
schema.index({ driverId: 1, rideId: 1 }, { unique: true });
schema.index({ driverId: 1, receivedAt: -1 });
schema.index({ receivedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
module.exports = mongoose.model('DriverOfferReceipt', schema);
