// One-off, run once after deploying promo codes:
//   node scripts/migratePromoPermissions.js
// Adds promo:view + promo:manage to the stored superadmin and admin roles, and promo:view
// to financial (only adds; other role edits are kept). New roles get them from the templates.
const Role = require("../models/Role");

async function migrate({ log = console.log } = {}) {
    const managers = await Role.updateMany({ name: { $in: ["superadmin", "admin"] } }, { $addToSet: { permissions: { $each: ["promo:view", "promo:manage"] } } });
    const viewers = await Role.updateMany({ name: "financial" }, { $addToSet: { permissions: "promo:view" } });
    log(`Roles updated: ${managers.modifiedCount + viewers.modifiedCount}`);
    return { updated: managers.modifiedCount + viewers.modifiedCount };
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
