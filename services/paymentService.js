const paypack = require("../config/paypack");
const Transaction = require("../models/Transaction");
const { creditRidePayment } = require("./walletService");

/**
 * Initiate a Paypack cashin (payment request to passenger)
 * @param {string} phone - Passenger phone
 * @param {number} amount - Amount in RWF
 * @param {string} environment - "development" | "production"
 * @returns {Object} Paypack cashin response
 */
const requestCashIn = async (phone, amount, environment = "development") => {
    try {
        const numAmount = Number(amount);
        if (isNaN(numAmount) || numAmount < 100) {
            return { success: false, error: "Amount must be a number greater than or equal to 100 RWF" };
        }
        
        const response = await paypack.cashin({
            number: phone,
            amount: numAmount,
            environment,
        });
        return { success: true, data: response.data };
    } catch (error) {
        console.error("Paypack cashin error:", error?.response?.data || error.message);
        return { success: false, error: error?.response?.data || error.message };
    }
};

/**
 * Initiate a Paypack cashout (withdrawal to driver)
 * @param {string} phone - Driver phone
 * @param {number} amount - Amount in RWF
 * @param {string} environment
 * @returns {Object} Paypack cashout response
 */
const requestCashOut = async (phone, amount, environment = "development") => {
    try {
        const numAmount = Number(amount);
        if (isNaN(numAmount) || numAmount < 100) {
            return { success: false, error: "Amount must be a number greater than or equal to 100 RWF" };
        }

        const response = await paypack.cashout({
            number: phone,
            amount: numAmount,
            environment,
        });
        return { success: true, data: response.data };
    } catch (error) {
        console.error("Paypack cashout error:", error?.response?.data || error.message);
        return { success: false, error: error?.response?.data || error.message };
    }
};

/**
 * Handle incoming Paypack webhook event
 * Completes the transaction and credits driver wallet for completed payments
 * @param {Object} event - Paypack webhook payload
 * @param {string} driverId - Driver to credit (for ride payments)
 * @param {string} rideId - Ride ID (for ride payments)
 */
const handleWebhook = async (event, driverId, rideId) => {
    try {
        const { ref, status, amount, kind } = event;

        // Find the pending transaction by paypackRef
        const tx = await Transaction.findOne({ paypackRef: ref });
        if (tx) {
            tx.status = status === "successful" ? "completed" : "failed";
            await tx.save();
        }

        // If a completed cashin for a ride, credit the driver wallet
        if (kind === "CASHIN" && status === "successful" && driverId && rideId) {
            await creditRidePayment(driverId, rideId, amount);
        }

        return { success: true };
    } catch (error) {
        console.error("Webhook handling error:", error.message);
        return { success: false, error: error.message };
    }
};

const getTransactionStatus = async (ref) => {
    try {
        if (!ref) return { success: false, error: "Transaction ref is required" };
        const response = await paypack.transaction(ref);
        return { success: true, data: response.data };
    } catch (error) {
        console.error("Paypack transaction fetch error:", error?.response?.data || error.message);
        return { success: false, error: error?.response?.data || error.message };
    }
};

const getEvents = async (filters) => {
    try {
        const response = await paypack.events(filters);
        return { success: true, data: response.data };
    } catch (error) {
        console.error("Paypack events fetch error:", error?.response?.data || error.message);
        return { success: false, error: error?.response?.data || error.message };
    }
};

module.exports = {
    requestCashIn,
    requestCashOut,
    handleWebhook,
    getTransactionStatus,
    getEvents,
};
