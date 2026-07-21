const bcrypt = require("bcryptjs");
const Dealer = require("../../models/Dealer");

/**
 * GET /api/dealers
 */
exports.getAllDealers = async (req, res) => {
  try {
    const dealers = await Dealer.find()
      .select("-password")
      .sort({ createdAt: -1 });

    res.json(dealers);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * GET /api/dealers/:id
 */
exports.getDealerById = async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.params.id).select("-password");

    if (!dealer) {
      return res.status(404).json({
        error: "Dealer not found",
      });
    }

    res.json(dealer);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * POST /api/dealers
 */
exports.createDealer = async (req, res) => {
  try {
    const {
      username,
      password,
      businessName,
      email,
      phone,
      address,
    } = req.body;

    const usernameExists = await Dealer.findOne({ username });

    if (usernameExists) {
      return res.status(400).json({
        error: "Username already exists",
      });
    }

    const emailExists = await Dealer.findOne({ email });

    if (emailExists) {
      return res.status(400).json({
        error: "Email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const dealer = await Dealer.create({
      username,
      password: hashedPassword,
      businessName,
      email,
      phone,
      address,
    });

    const response = dealer.toObject();
    delete response.password;

    res.status(201).json(response);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * PUT /api/dealers/:id
 */
exports.updateDealer = async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.params.id);

    if (!dealer) {
      return res.status(404).json({
        error: "Dealer not found",
      });
    }

    const {
      username,
      password,
      businessName,
      email,
      phone,
      address,
    } = req.body;

    if (username && username !== dealer.username) {
      const exists = await Dealer.findOne({ username });

      if (exists) {
        return res.status(400).json({
          error: "Username already exists",
        });
      }

      dealer.username = username;
    }

    if (email && email !== dealer.email) {
      const exists = await Dealer.findOne({ email });

      if (exists) {
        return res.status(400).json({
          error: "Email already exists",
        });
      }

      dealer.email = email;
    }

    if (businessName !== undefined)
      dealer.businessName = businessName;

    if (phone !== undefined)
      dealer.phone = phone;

    if (address !== undefined)
      dealer.address = address;

    if (password) {
      dealer.password = await bcrypt.hash(password, 10);
    }

    await dealer.save();

    const response = dealer.toObject();
    delete response.password;

    res.json(response);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * DELETE /api/dealers/:id
 */
exports.deleteDealer = async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.params.id);

    if (!dealer) {
      return res.status(404).json({
        error: "Dealer not found",
      });
    }

    await dealer.deleteOne();

    res.json({
      message: "Dealer deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};