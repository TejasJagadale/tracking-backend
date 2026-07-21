const bcrypt = require("bcryptjs");
const User = require("../../models/User");

/**
 * GET ALL USERS
 */
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find()
      .select("-password")
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * GET USER BY ID
 */
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * CREATE USER
 */
exports.createUser = async (req, res) => {
  try {
    const {
      username,
      fullName,
      email,
      countryCode,
      phone,
      password,
      address,
    } = req.body;

    const usernameExists = await User.findOne({ username });

    if (usernameExists) {
      return res.status(400).json({
        error: "Username already exists",
      });
    }

    const emailExists = await User.findOne({ email });

    if (emailExists) {
      return res.status(400).json({
        error: "Email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      fullName,
      email,
      countryCode,
      phone,
      password: hashedPassword,
      address,
    });

    const response = user.toObject();
    delete response.password;

    res.status(201).json(response);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * UPDATE USER
 */
exports.updateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    const {
      username,
      fullName,
      email,
      countryCode,
      phone,
      password,
      address,
    } = req.body;

    if (username && username !== user.username) {
      const exists = await User.findOne({ username });

      if (exists) {
        return res.status(400).json({
          error: "Username already exists",
        });
      }

      user.username = username;
    }

    if (email && email !== user.email) {
      const exists = await User.findOne({ email });

      if (exists) {
        return res.status(400).json({
          error: "Email already exists",
        });
      }

      user.email = email;
    }

    if (fullName !== undefined)
      user.fullName = fullName;

    if (countryCode !== undefined)
      user.countryCode = countryCode;

    if (phone !== undefined)
      user.phone = phone;

    if (address !== undefined)
      user.address = address;

    if (password) {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();

    const response = user.toObject();
    delete response.password;

    res.json(response);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};

/**
 * DELETE USER
 */
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    await user.deleteOne();

    res.json({
      message: "User deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};