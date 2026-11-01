const mongoose = require('mongoose');
const Ride = require('../models/Ride');
const Receipt = require('../models/DriverOfferReceipt');
const windows = [7, 30, 90];
function parseWindow(value = 30) {
    const days = Number(value);
    if (!windows.includes(days)) { const error = new Error('Choose a 7, 30 or 90 day window.'); error.status = 400; throw error; }
    return days;
}
async function acknowledgeOffer(driverId, rideId) {
    if (!mongoose.isValidObjectId(rideId)) { const error = new Error('Invalid ride ID.'); error.status = 400; throw error; }
    const ride = await Ride.findOne({ _id: rideId, $or: [{ notifiedDrivers: driverId }, { driverId }], rideStatus: { $in: ['searching', 'accepted', 'approaching', 'arrived', 'start_requested', 'in_progress', 'stop_requested', 'awaiting_payment'] } }).select('_id');
    if (!ride) { const error = new Error('This offer is unavailable or was not assigned to you.'); error.status = 404; throw error; }
    await Receipt.init();
    try {
        await Receipt.updateOne({ driverId, rideId }, { $setOnInsert: { receivedAt: new Date() } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; /* Simultaneous duplicate acknowledgment already persisted. */ }
}
function buildPipeline(driverId, from, asOf) {
    const accepted = { $and: [{ $eq: ['$ride.driverId', driverId] }, { $ne: [{ $ifNull: ['$ride.acceptedAt', null] }, null] }] };
    return [
        { $match: { driverId, receivedAt: { $gte: from, $lte: asOf } } },
        { $lookup: { from: Ride.collection.name, localField: 'rideId', foreignField: '_id', as: 'ride' } },
        { $unwind: '$ride' },
        { $set: { accepted } },
        { $group: {
            _id: null, offers: { $sum: 1 }, accepted: { $sum: { $cond: ['$accepted', 1, 0] } },
            driverCancelled: { $sum: { $cond: [{ $and: ['$accepted', { $eq: ['$ride.rideStatus', 'cancelled'] }, { $eq: ['$ride.cancelledBy', driverId] }] }, 1, 0] } },
            passengerCancelled: { $sum: { $cond: [{ $and: ['$accepted', { $eq: ['$ride.rideStatus', 'cancelled'] }, { $ne: [{ $ifNull: ['$ride.cancelledBy', null] }, null] }, { $eq: ['$ride.cancelledBy', '$ride.passengerId'] }] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $and: ['$accepted', { $eq: ['$ride.rideStatus', 'completed'] }] }, 1, 0] } },
        } },
    ];
}
function summarize(raw = {}) {
    const offers = raw.offers || 0, accepted = raw.accepted || 0, driverCancelled = raw.driverCancelled || 0;
    return { offers, accepted, driverCancelled, passengerCancelled: raw.passengerCancelled || 0, completed: raw.completed || 0,
        acceptanceRate: offers ? Math.round(accepted / offers * 1000) / 10 : null,
        cancellationRate: accepted ? Math.round(driverCancelled / accepted * 1000) / 10 : null };
}
async function getPerformance(driverId, window) {
    const days = parseWindow(window), asOf = new Date(), from = new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000);
    const id = new mongoose.Types.ObjectId(driverId);
    const result = await Receipt.aggregate(buildPipeline(id, from, asOf));
    return { ...summarize(result[0]), days, from, asOf, basis: 'app_acknowledged_offer_cohort' };
}
module.exports = { parseWindow, acknowledgeOffer, buildPipeline, summarize, getPerformance };
