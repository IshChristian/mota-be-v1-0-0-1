const lookupService = require("../services/lookupService");

/**
 * GET /api/lookup/plate/:plateNumber
 * Fetch all data for a user by plate number
 */
const getByPlateNumber = async (req, res) => {
    try {
        const { plateNumber } = req.params;

        if (!plateNumber) {
            return res.status(400).json({ message: "Plate number is required" });
        }

        const data = await lookupService.getFullUserDataByPlateNumber(plateNumber, {
            transactionLimit: parseInt(req.query.transactionLimit) || 50,
            rideLimit: parseInt(req.query.rideLimit) || 50,
        });

        if (!data) {
            return res.status(404).json({
                message: `No driver found with plate number: ${plateNumber}`,
            });
        }

        res.status(200).json({
            message: "User data retrieved successfully",
            data,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * GET /api/lookup/user/:id
 * Fetch all data for a user by ID
 */
const getByUserId = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await lookupService.getFullUserDataById(id, {
            transactionLimit: parseInt(req.query.transactionLimit) || 50,
            rideLimit: parseInt(req.query.rideLimit) || 50,
        });

        if (!data) {
            return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json({
            message: "User data retrieved successfully",
            data,
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getByPlateNumber,
    getByUserId,
};
