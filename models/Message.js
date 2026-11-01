const mongoose = require("mongoose");

// In-ride chat between passenger and assigned driver.
const messageSchema = new mongoose.Schema({
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride", required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, trim: true, required: true, maxlength: 500 },
    readAt: { type: Date },
}, { timestamps: true });

messageSchema.index({ rideId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
