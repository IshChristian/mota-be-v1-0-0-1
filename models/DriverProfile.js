const mongoose = require("mongoose");

const driverProfileSchema = new mongoose.Schema({
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
    },
    plateNumber: { type: String, unique: true, required: true, trim: true },
    cooperativeName: { type: String, trim: true },
    nid: { type: String, required: true, unique: true, trim: true },
    insuranceAttachment: { type: String, required: true },
    permitAttachment: { type: String, required: true },
    permitId: { type: String, required: true, unique: true, trim: true },
    code: { type: String, trim: true },
    wallet: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

driverProfileSchema.pre("save", function () {
    this.updatedAt = Date.now();
});

driverProfileSchema.pre("findOneAndUpdate", function () {
    this.set({ updatedAt: Date.now() });
});

const DriverProfile = mongoose.model("DriverProfile", driverProfileSchema);

module.exports = DriverProfile;
