const mongoose = require("mongoose");

const systemConfigSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, index: true },
        value: { type: mongoose.Schema.Types.Mixed, required: true },
        description: { type: String },
        category: {
            type: String,
            enum: ["financial", "general", "loan", "notification"],
            default: "general",
            index: true,
        },
        dataType: {
            type: String,
            enum: ["number", "string", "boolean", "percentage"],
            default: "string",
        },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    { timestamps: true }
);

module.exports = mongoose.model("SystemConfig", systemConfigSchema);

