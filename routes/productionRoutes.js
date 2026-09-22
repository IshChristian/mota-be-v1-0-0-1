const router = require('express').Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/productionController');

router.get('/status', ctrl.platformStatus);
router.use(protect);
router.get('/payment-methods', ctrl.listPaymentMethods);
router.get('/sessions', ctrl.listSessions);
router.delete('/sessions/:sessionId', ctrl.revokeSession);
router.post('/payment-methods', ctrl.createPaymentMethod);
router.post('/payment-methods/:id/verify', ctrl.verifyPaymentMethod);
router.patch('/payment-methods/:id', ctrl.updatePaymentMethod);
router.post('/payment-methods/:id/default', ctrl.defaultPaymentMethod);
router.delete('/payment-methods/:id', ctrl.deletePaymentMethod);
router.get('/safety-events', ctrl.listSafetyEvents);
router.post('/safety-events', ctrl.createSafetyEvent);
router.get('/disputes', ctrl.listDisputes);
router.post('/rides/:rideId/disputes', ctrl.createDispute);
router.post('/disputes/:id/replies', ctrl.replyDispute);
router.get('/notification-preferences', ctrl.getPreferences);
router.put('/notification-preferences', ctrl.updatePreferences);
router.get('/consents', ctrl.listConsents);
router.post('/consents', ctrl.recordConsent);
router.get('/admin/safety-events', authorize('support:view'), ctrl.adminSafetyEvents);
router.patch('/admin/safety-events/:id', authorize('support:update'), ctrl.adminUpdateSafetyEvent);
router.get('/admin/disputes', authorize('ride:dispute'), ctrl.adminDisputes);
router.patch('/admin/disputes/:id', authorize('ride:dispute'), ctrl.adminUpdateDispute);

module.exports = router;
