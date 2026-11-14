const express = require("express");

// Meta's WhatsApp Cloud API webhook (mounted at /api/webhooks/whatsapp).
const whatsappVerify = require("../controllers/whatsappVerifyController");
const router = express.Router();

router.get("/", whatsappVerify.handshake);
router.post("/", whatsappVerify.receive);

module.exports = router;
