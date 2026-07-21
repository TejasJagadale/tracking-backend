const express = require("express");

const router = express.Router();

const dealerController = require("../controllers/dealerController");

const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);

// GET ALL
router.get("/", dealerController.getAllDealers);

// GET BY ID
router.get("/:id", dealerController.getDealerById);

// CREATE
router.post("/", dealerController.createDealer);

// UPDATE
router.put("/:id", dealerController.updateDealer);

// DELETE
router.delete("/:id", dealerController.deleteDealer);

module.exports = router;