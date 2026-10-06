const router = require("express").Router();
const { rateLimit } = require("express-rate-limit");
const { protectOnboardingStatus } = require("../middleware/authMiddleware");
const controller = require("../controllers/supportController");
router.use(protectOnboardingStatus);
const writes = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many support requests. Please wait and retry." },
});
router.get("/", controller.list);
router.post("/", writes, controller.create);
router.get("/:id", controller.details);
router.post("/:id/messages", writes, controller.reply);
router.post("/:id/reopen", writes, controller.reopen);
module.exports = router;
