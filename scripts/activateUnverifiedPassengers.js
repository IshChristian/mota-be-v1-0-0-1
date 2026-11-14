// One-off, run once after deploying "phone proven by payment":
//   node scripts/activateUnverifiedPassengers.js           (dry run: only counts)
//   node scripts/activateUnverifiedPassengers.js --apply   (switches them on)
// Lets in passengers who registered since the SMS outage (2026-03-18) and could never
// enter their phone code. Skips anyone an admin switched off on purpose.
const { activateStuckPassengers } = require("../services/stuckPassengerService");

if (require.main === module) {
    require("dotenv").config();
    const mongoose = require("mongoose");
    const apply = process.argv.includes("--apply");
    require("../config/database")()
        .then(() => activateStuckPassengers({ dryRun: !apply }))
        .then(({ matched, activated }) => console.log(apply ? `matched ${matched}, activated ${activated}` : `matched ${matched} (dry run, nothing changed; add --apply)`))
        .catch((error) => { console.error(error); process.exitCode = 1; })
        .finally(() => mongoose.connection.close());
}
