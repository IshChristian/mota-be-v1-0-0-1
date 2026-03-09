const Streak = require("../models/Streak");
const Ride = require("../models/Ride");
const { sendSMS } = require("./smsService");
const User = require("../models/User");

const DAILY_TARGET = 20;

/**
 * Check if two dates are on the same day
 */
function isSameDay(date1, date2) {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

/**
 * Check if date1 is exactly one day before date2
 */
function isConsecutiveDay(date1, date2) {
  const d1 = new Date(date1);
  d1.setDate(d1.getDate() + 1);
  return isSameDay(d1, date2);
}

/**
 * Update streak for a driver after a ride
 * @param {string} driverId - Driver's user ID
 */
const updateStreak = async (driverId) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    // Count rides today
    const todayRideCount = await Ride.countDocuments({
      driverId,
      createdAt: { $gte: startOfToday, $lte: endOfToday },
    });

    // Find or create streak record
    let streakRecord = await Streak.findOne({ driverId });

    if (!streakRecord) {
      streakRecord = await Streak.create({
        driverId,
        currentStreak: 0,
        longestStreak: 0,
        lastRideDate: now,
        todayRideCount,
      });
    }

    streakRecord.todayRideCount = todayRideCount;
    streakRecord.lastRideDate = now;

    // Check if daily target is reached
    if (todayRideCount >= DAILY_TARGET) {
      // Only increment streak once per day when target is first reached
      if (todayRideCount === DAILY_TARGET) {
        const lastStreak = streakRecord.lastRideDate;

        if (lastStreak && isConsecutiveDay(lastStreak, now)) {
          streakRecord.currentStreak += 1;
        } else if (!lastStreak || !isSameDay(lastStreak, now)) {
          streakRecord.currentStreak = 1;
        }

        // Update longest streak
        if (streakRecord.currentStreak > streakRecord.longestStreak) {
          streakRecord.longestStreak = streakRecord.currentStreak;
        }

        // Send notification
        const user = await User.findById(driverId);
        if (user) {
          await sendSMS(
            user.phone,
            `Great job ${user.firstName}! You've completed ${DAILY_TARGET} rides today! Current streak: ${streakRecord.currentStreak} days. Keep it up!`,
            "ride_confirmation"
          );
        }
      }
    }

    await streakRecord.save();
    return streakRecord;
  } catch (error) {
    console.error("Error updating streak:", error.message);
    throw error;
  }
};

/**
 * Get streak info for a driver
 * @param {string} driverId - Driver's user ID
 * @returns {Object} Streak information
 */
const getStreakInfo = async (driverId) => {
  let streakRecord = await Streak.findOne({ driverId });

  if (!streakRecord) {
    streakRecord = await Streak.create({
      driverId,
      currentStreak: 0,
      longestStreak: 0,
      todayRideCount: 0,
    });
  }

  // Refresh today ride count
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const todayRideCount = await Ride.countDocuments({
    driverId,
    createdAt: { $gte: startOfToday, $lte: endOfToday },
  });

  streakRecord.todayRideCount = todayRideCount;

  return streakRecord;
};

module.exports = {
  updateStreak,
  getStreakInfo,
  DAILY_TARGET,
};
