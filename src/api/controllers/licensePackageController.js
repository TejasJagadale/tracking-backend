const LicensePackage = require("../../models/LicensePackage");
const Dealer = require("../../models/Dealer");

/**
 * GET ALL PACKAGES
 */
exports.getAllPackages = async (req, res) => {
  try {

    const packages = await LicensePackage.find()
      .populate("dealerId", "businessName username email")
      .sort({ createdAt: -1 });

    const response = packages.map((pkg) => ({
      ...pkg.toObject(),
      dealer: pkg.dealerId,
    }));

    res.json(response);

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }
};

/**
 * GET PACKAGE BY ID
 */
exports.getPackageById = async (req, res) => {
  try {

    const pkg = await LicensePackage.findById(req.params.id)
      .populate("dealerId", "businessName username email");

    if (!pkg) {
      return res.status(404).json({
        error: "License Package not found",
      });
    }

    const response = {
      ...pkg.toObject(),
      dealer: pkg.dealerId,
    };

    res.json(response);

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }
};

/**
 * CREATE PACKAGE
 */
exports.createPackage = async (req, res) => {

  try {

    const {
      dealerId,
      packageName,
      duration,
      licenseCount,
      amount,
      remarks,
    } = req.body;

    const dealer = await Dealer.findById(dealerId);

    if (!dealer) {
      return res.status(400).json({
        error: "Dealer not found",
      });
    }

    const pkg = await LicensePackage.create({

      dealerId,
      packageName,
      duration,
      licenseCount,
      amount,
      remarks,

    });

    await pkg.populate("dealerId", "businessName username email");

    const response = {
      ...pkg.toObject(),
      dealer: pkg.dealerId,
    };

    res.status(201).json(response);

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }

};

/**
 * UPDATE PACKAGE
 */
exports.updatePackage = async (req, res) => {

  try {

    const pkg = await LicensePackage.findById(req.params.id);

    if (!pkg) {
      return res.status(404).json({
        error: "License Package not found",
      });
    }

    const {
      dealerId,
      packageName,
      duration,
      licenseCount,
      amount,
      remarks,
    } = req.body;

    if (dealerId) {

      const dealer = await Dealer.findById(dealerId);

      if (!dealer) {
        return res.status(400).json({
          error: "Dealer not found",
        });
      }

      pkg.dealerId = dealerId;
    }

    if (packageName !== undefined)
      pkg.packageName = packageName;

    if (duration !== undefined)
      pkg.duration = duration;

    if (licenseCount !== undefined)
      pkg.licenseCount = licenseCount;

    if (amount !== undefined)
      pkg.amount = amount;

    if (remarks !== undefined)
      pkg.remarks = remarks;

    await pkg.save();

    await pkg.populate("dealerId", "businessName username email");

    const response = {
      ...pkg.toObject(),
      dealer: pkg.dealerId,
    };

    res.json(response);

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }

};

/**
 * DELETE PACKAGE
 */
exports.deletePackage = async (req, res) => {

  try {

    const pkg = await LicensePackage.findById(req.params.id);

    if (!pkg) {
      return res.status(404).json({
        error: "License Package not found",
      });
    }

    await pkg.deleteOne();

    res.json({
      message: "License Package deleted successfully",
    });

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });

  }

};