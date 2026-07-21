const express = require("express");

const router = express.Router();

const licensePackageController = require("../controllers/licensePackageController");

const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);

// GET ALL
router.get("/", licensePackageController.getAllPackages);

// GET BY ID
router.get("/:id", licensePackageController.getPackageById);

// CREATE
router.post("/", licensePackageController.createPackage);

// UPDATE
router.put("/:id", licensePackageController.updatePackage);

// DELETE
router.delete("/:id", licensePackageController.deletePackage);

module.exports = router;