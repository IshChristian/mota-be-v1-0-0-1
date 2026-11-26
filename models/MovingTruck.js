const mongoose = require("mongoose");

// MOTA HomeMove truck catalog: the truck sizes customers choose from. Prices are ranges
// because the final price is quoted by the team after checking the job.
const movingTruckSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, trim: true },
        name: { type: String, required: true, trim: true },
        model: { type: String, trim: true, default: "" },
        capacityTonnes: { type: Number, min: 0, required: true },
        fits: { type: String, trim: true, default: "" },
        homeSizes: [{ type: String }],
        priceMin: { type: Number, min: 0, required: true },
        priceMax: { type: Number, min: 0, required: true },
        perKmOutside: { type: Number, min: 0, default: 0 },
        // Empty = the app shows its bundled sample photo for this key.
        imageUrl: { type: String, trim: true, default: "" },
        photoCredit: { type: String, trim: true, default: "" },
        active: { type: Boolean, default: true },
        sort: { type: Number, default: 0 },
    },
    { timestamps: true },
);

module.exports = mongoose.models.MovingTruck || mongoose.model("MovingTruck", movingTruckSchema);
