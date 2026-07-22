// const bcrypt = require("bcryptjs");
// const Admin = require("../../models/Admin");
// const { generateToken } = require("../../utils/jwt");

// exports.login = async (req, res) => {

//     try {

//         const { username, password } = req.body;

//         const admin = await Admin.findOne({
//             username,
//         });

//         if (!admin)
//             return res.status(401).json({
//                 error: "Invalid username or password",
//             });

//         const match = await bcrypt.compare(
//             password,
//             admin.password
//         );

//         if (!match)
//             return res.status(401).json({
//                 error: "Invalid username or password",
//             });

//         const token = generateToken(admin);

//         res.json({
//             token,

//             user: {

//                 id: admin._id,
//                 username: admin.username,
//                 name: admin.name,
//                 role: admin.role,

//             },

//         });

//     } catch (err) {

//         res.status(500).json({
//             error: err.message,
//         });

//     }

// };



const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const User = require("../../models/User");

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required.",
      });
    }

    const user = await User.findOne({ username })
      .populate("dealerId", "businessName dealerCode");

    if (!user) {
      return res.status(401).json({
        error: "Invalid username or password.",
      });
    }

    /**
     * User Status Check
     */
    if (user.status !== "ACTIVE") {
      return res.status(403).json({
        error: "Your account is not active.",
      });
    }

    /**
     * Login Permission Check
     */
    if (!user.canLogin) {
      return res.status(403).json({
        error: "Login is disabled for this account.",
      });
    }

    /**
     * Password Check
     */
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      user.failedLoginAttempts =
        (user.failedLoginAttempts || 0) + 1;

      await user.save();

      return res.status(401).json({
        error: "Invalid username or password.",
      });
    }

    /**
     * Login Success
     */
    user.failedLoginAttempts = 0;
    user.lastLoginAt = new Date();

    await user.save();

    /**
     * JWT Token
     */
    const token = jwt.sign(
      {
        id: user._id,
        username: user.username,
        role: user.role,
        dealerId: user.dealerId?._id || null,
      },
      process.env.JWT_SECRET || "gps_tracking_secret",
      {
        expiresIn: "7d",
      }
    );

    res.json({
      token,

      user: {
        _id: user._id,

        role: user.role,

        dealerId: user.dealerId,

        parentId: user.parentId,

        username: user.username,

        name: user.name,

        email: user.email,

        phoneNumber: user.phoneNumber,

        address: user.address,

        canLogin: user.canLogin,

        status: user.status,

        onboardingType: user.onboardingType,

        occupation: user.occupation,

        designation: user.designation,

        employmentType: user.employmentType,

        profileImage: user.profileImage,

        lastLoginAt: user.lastLoginAt,
      },
    });

  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
};