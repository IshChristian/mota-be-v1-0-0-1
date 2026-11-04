// One-off, run once after deploying direct cash-outs:
//   node scripts/migrateCashoutAccess.js
// 1. Adds withdrawal:view and withdrawal:manage to the stored admin and
//    financial roles (only adds; other role edits are kept).
// 2. Sends every withdrawal still queued under the old 10,000 RWF batching
//    through the new flow: accepted → provider_pending, refused → manual_required
//    with a staff alert.
const Role = require("../models/Role");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const { dispatchRequest } = require("../services/withdrawalService");

async function migrate({ log = console.log } = {}) {
    const roles = await Role.updateMany(
        { name: { $in: ["admin", "financial"] } },
        { $addToSet: { permissions: { $each: ["withdrawal:view", "withdrawal:manage"] } } },
    );
    log(`Roles updated: ${roles.modifiedCount}`);
    const queued = await WithdrawalRequest.find({ status: "queued" }).sort({ createdAt: 1 }).select("_id").lean();
    const outcomes = {};
    for (const { _id } of queued) {
        const { status } = await dispatchRequest(_id, "auto");
        outcomes[status] = (outcomes[status] || 0) + 1;
    }
    log(`Queued withdrawals dispatched: ${queued.length} ${JSON.stringify(outcomes)}`);
    return { roles: roles.modifiedCount, dispatched: queued.length, outcomes };
}

if (require.main === module) {
    require("dotenv").config();
    const mongoose = require("mongoose");
    require("../config/database")()
        .then(() => migrate())
        .catch((error) => { console.error(error); process.exitCode = 1; })
        .finally(() => mongoose.connection.close());
}

module.exports = { migrate };
