const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const SavingsAccount = require("../models/SavingsAccount");
const Loan = require("../models/Loan");
const Tier = require("../models/Tier");
const DriverKyc = require("../models/DriverKyc");

const ensureDriver = (req, res) => {
  if (req.user.role !== "driver") {
    res.status(403).json({ message: "Driver finance is only available to authenticated drivers" });
    return false;
  }
  return true;
};

async function summary(req, res) {
  if (!ensureDriver(req, res)) return;
  const driverId = req.user.id;
  const [wallet, savings, activeLoan, tier, kyc, recentTransactions] = await Promise.all([
    Wallet.findOne({ driverId }).lean(),
    SavingsAccount.findOne({ driverId }).lean(),
    Loan.findOne({ driverId, loanStatus: { $in: ["pending", "active"] } }).sort({ createdAt: -1 }).lean(),
    Tier.findOne({ driverId }).lean(),
    DriverKyc.findOne({ userId: driverId }).select("status remarks submittedAt reviewedAt").lean(),
    Transaction.find({ driverId }).sort({ createdAt: -1 }).limit(8).lean(),
  ]);
  res.json({
    data: {
      balances: {
        available: wallet?.balance || 0,
        held: wallet?.heldBalance || 0,
        fuelCredits: wallet?.fuelCredits || 0,
        savings: savings?.balance || 0,
        loanOutstanding: activeLoan?.remainingBalance || 0,
      },
      tier: tier || { tier: "starter", multiplier: 1, totalRides: 0, monthlyRides: 0 },
      kyc: kyc || { status: "not_submitted" },
      activeLoan,
      recentTransactions,
    },
  });
}

async function transactions(req, res) {
  if (!ensureDriver(req, res)) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const filter = { driverId: req.user.id };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.before) filter.createdAt = { $lt: new Date(req.query.before) };
  const data = await Transaction.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ data, nextCursor: data.length === limit ? data[data.length - 1].createdAt : null });
}

module.exports = { summary, transactions };
