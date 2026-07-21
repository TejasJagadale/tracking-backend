const bcrypt = require("bcryptjs");
const Admin = require("../../models/Admin");
const { generateToken } = require("../../utils/jwt");

exports.login = async (req, res) => {

    try {

        const { username, password } = req.body;

        const admin = await Admin.findOne({
            username,
        });

        if (!admin)
            return res.status(401).json({
                error: "Invalid username or password",
            });

        const match = await bcrypt.compare(
            password,
            admin.password
        );

        if (!match)
            return res.status(401).json({
                error: "Invalid username or password",
            });

        const token = generateToken(admin);

        res.json({
            token,

            user: {

                id: admin._id,
                username: admin.username,
                name: admin.name,
                role: admin.role,

            },

        });

    } catch (err) {

        res.status(500).json({
            error: err.message,
        });

    }

};