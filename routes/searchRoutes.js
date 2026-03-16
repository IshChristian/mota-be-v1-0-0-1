const express = require("express");
const router = express.Router();
const searchController = require("../controllers/searchController");
const { protect, authorize } = require("../middleware/authMiddleware");

router.use(protect);

router.get("/", authorize("search:universal"), searchController.getUniversalSearch);
router.get("/users", authorize("user:view"), searchController.searchUsers);

module.exports = router;
