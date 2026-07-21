require("dotenv").config();

const bcrypt = require("bcryptjs");

const mongoose = require("mongoose");

const Admin = require("./src/models/Admin");

async function seed() {

    await mongoose.connect("mongodb+srv://tejasjagadale25:VAkZVPbnRFlzjgQs@cluster0.dlnzepm.mongodb.net/gps_tracking");

    const exists = await Admin.findOne({
        username: "admin",
    });

    if (exists) {

        console.log("Admin already exists");
        process.exit();

    }

    const password = await bcrypt.hash("admin123", 10);

    await Admin.create({

        username: "admin",
        password,
        name: "System Administrator",

    });

    console.log("Admin Created");

    process.exit();

}

seed();