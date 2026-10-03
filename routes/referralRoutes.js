const router = require('express').Router();
const { protectOnboardingStatus } = require('../middleware/authMiddleware');
const User = require('../models/User');
const Referral = require('../models/Referral');
const service = require('../services/referralService');
router.get('/me', protectOnboardingStatus, async (req, res) => {
    try {
        const page = Number(req.query.page || 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 10000) return res.status(400).json({ message: 'Invalid page' });
        res.json({ data: await service.getSummary(req.user.id, page) });
    } catch { res.status(500).json({ message: 'Could not load referrals. Please retry.' }); }
});
router.post('/check-rewards', protectOnboardingStatus, require('../middleware/financialWriteGuard'), async (req, res) => {
    try {
        const recent = await User.find({ referredBy: req.user.id }).sort({ createdAt: -1 }).limit(20);
        for (const user of recent) await service.recordReferral(user);
        const pending = await Referral.find({ referrerId: req.user.id, status: 'pending' }).limit(20).select('referredUserId');
        for (const row of pending) await service.settleReferral(row.referredUserId);
        res.json({ data: await service.getSummary(req.user.id), message: 'Eligible rewards checked. Incomplete referrals remain pending.' });
    } catch { res.status(503).json({ message: 'Rewards could not be checked. No duplicate credit will be made; please retry.' }); }
});
module.exports = router;
