const User = require("../models/User");
const Ride = require("../models/Ride");
const DriverKyc = require("../models/DriverKyc");
const SupportCase = require("../models/SupportCase");

const activeRideStatuses = ["requested", "searching", "accepted", "approaching", "arrived", "start_requested", "in_progress", "stop_requested", "awaiting_payment"];

const countBy = async (model, match, field) => {
    const rows = await model.aggregate([
        { $match: match },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(({ _id, count }) => [String(_id ?? "unknown"), count]));
};

exports.getOperationsInsights = async (_req, res) => {
    try {
        const [rides, kyc, registrations, cases, casesByRole] = await Promise.all([
            countBy(Ride, { rideStatus: { $in: activeRideStatuses } }, "rideStatus"),
            countBy(DriverKyc, { status: { $in: ["submitted", "correction"] } }, "status"),
            countBy(User, { role: "driver", registrationStatus: "pending" }, "registrationStatus"),
            countBy(SupportCase, { status: { $in: ["open", "in_progress"] } }, "status"),
            SupportCase.aggregate([
                { $match: { status: { $in: ["open", "in_progress"] } } },
                { $lookup: { from: User.collection.name, localField: "createdBy", foreignField: "_id", as: "creator" } },
                { $unwind: { path: "$creator", preserveNullAndEmptyArrays: true } },
                { $group: { _id: { $ifNull: ["$creator.role", "unknown"] }, count: { $sum: 1 } } },
            ]),
        ]);
        res.json({ data: {
            activeRidesByStatus: rides,
            driverKycByStatus: kyc,
            pendingDriverRegistrations: registrations.pending || 0,
            supportCasesByStatus: cases,
            supportCasesBySource: Object.fromEntries(casesByRole.map(({ _id, count }) => [String(_id), count])),
        } });
    } catch (error) {
        res.status(500).json({ message: "Unable to load operations insights" });
    }
};
