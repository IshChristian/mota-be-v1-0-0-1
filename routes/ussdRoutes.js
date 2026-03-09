const express = require("express");
const router = express.Router();
const ussdController = require("../controllers/ussdController");

/**
 * @swagger
 * tags:
 *   name: USSD
 *   description: USSD integration for basic phone interaction
 */

/**
 * @swagger
 * /api/ussd:
 *   post:
 *     summary: Handle incoming USSD requests
 *     tags: [USSD]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: string
 *               serviceCode:
 *                 type: string
 *               phoneNumber:
 *                 type: string
 *               text:
 *                 type: string
 *     responses:
 *       200:
 *         description: USSD response text (CON or END)
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.post("/", ussdController.handleUssd);

module.exports = router;
