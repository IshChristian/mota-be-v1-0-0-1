const mongoose = require("mongoose");

const uploadSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        url: { type: String, required: true },
        publicId: { type: String, required: true },
        format: { type: String },
        resourceType: { type: String },
        size: { type: Number },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Upload", uploadSchema);
