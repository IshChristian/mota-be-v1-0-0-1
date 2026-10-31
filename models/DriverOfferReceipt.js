const mongoose = require("mongoose");

// First time a driver's app opened a ride offer. Basis for acceptance-rate statistics.
const schema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride", required: true },
    receivedAt: { type: Date, default: Date.now },
});
schema.index({ driverId: 1, rideId: 1 }, { unique: true });
schema.index({ driverId: 1, receivedAt: -1 });
schema.index({ receivedAt: 1 }, { expireAfterSeconds: 180 * 86400 });

module.exports = mongoose.model("DriverOfferReceipt", schema);
