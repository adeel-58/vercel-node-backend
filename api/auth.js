// api/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import queryDB from "../db.js"; // <-- use the stable query helper

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

/**
 * Helper: centralized DB error responder
 */
const handleDBError = (res, err) => {
  console.error("Database error:", err);
  if (err && err.code === "ETIMEDOUT") {
    return res.status(503).json({
      success: false,
      message: "Database timeout. Please try again shortly.",
      error: err.message,
    });
  }
  return res.status(500).json({
    success: false,
    message: "Database error",
    error: err.message || err,
  });
};

/**
 * SIGNUP
 */
router.post("/signup", async (req, res) => {
  const { username, email, password, whatsapp_number, location, country } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Username, email, and password are required",
    });
  }

  try {
    // check existing user
    const existingUsers = await queryDB(
      "SELECT id FROM `User` WHERE email = ? OR username = ?",
      [email, username]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({
        success: false,
        message: "User with this email or username already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // create user
   const userResult = await queryDB(
  `INSERT INTO \`User\` (username, email, password, role, whatsapp_number, date_joined, last_login)
   VALUES (?, ?, ?, 'seller', ?, NOW(), NOW())`,
  [username, email, hashedPassword, whatsapp_number || null]
);


    const userId = userResult.insertId;

    // create seller profile
    await queryDB(
      `INSERT INTO SellerProfile 
       (user_id, whatsapp_number, credits, total_credits_used, last_credit_update, location, created_at, updated_at)
       VALUES (?, ?, 3, 0, NOW(), ?, NOW(), NOW())`,
      [userId, whatsapp_number || null, location || null]
    );

    // generate token
    const token = jwt.sign(
      { userId, username, email, role: "seller" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // fetch seller profile to return
    const sellerProfiles = await queryDB(
      `SELECT * FROM SellerProfile WHERE user_id = ?`,
      [userId]
    );
    const sellerProfile = sellerProfiles[0] || null;

    return res.status(201).json({
      success: true,
      message: "User registered successfully as Seller",
      token,
      user: {
        id: userId,
        username,
        email,
        role: "seller",
        whatsapp_number,
      },
      sellerProfile,
    });
  } catch (err) {
    return handleDBError(res, err);
  }
});

/**
 * VERIFY TOKEN - returns user + profiles
 */
router.get("/verify", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtErr) {
      console.error("JWT verify error:", jwtErr);
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token",
        error: jwtErr.message,
      });
    }

    // fetch user
    const users = await queryDB(
      "SELECT id, username, email, role, whatsapp_number FROM `User` WHERE id = ? AND is_active = TRUE",
      [decoded.userId]
    );

    if (!users || users.length === 0) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    const user = users[0];

    // init profiles
    let sellerProfile = null;
    let supplierProfile = null;

    if (user.role === "seller" || user.role === "both") {
      const sellerProfiles = await queryDB(
        `SELECT id, user_id, whatsapp_number, credits, total_credits_used, 
                last_credit_update, location, created_at, updated_at
         FROM SellerProfile WHERE user_id = ?`,
        [user.id]
      );
      if (sellerProfiles && sellerProfiles.length > 0) sellerProfile = sellerProfiles[0];
    }

    if (user.role === "supplier" || user.role === "both") {
      const supplierProfiles = await queryDB(
        `SELECT id, user_id, store_name, store_description, whatsapp_number, logo, 
                plan_id, plan_start, plan_end, is_verified, rating, total_products, 
                country, created_at, updated_at
         FROM SupplierProfile WHERE user_id = ?`,
        [user.id]
      );
      if (supplierProfiles && supplierProfiles.length > 0) supplierProfile = supplierProfiles[0];
    }

    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        whatsapp_number: user.whatsapp_number,
      },
      sellerProfile,
      supplierProfile,
    });
  } catch (err) {
    return handleDBError(res, err);
  }
});

/**
 * LOGIN
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password are required",
    });
  }

  try {
    const users = await queryDB(
      "SELECT * FROM `User` WHERE email = ? AND is_active = TRUE",
      [email]
    );

    if (!users || users.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = users[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // update last login
    await queryDB("UPDATE `User` SET last_login = NOW() WHERE id = ?", [user.id]);

    // generate token
    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // fetch profiles
    let sellerProfile = null;
    let supplierProfile = null;

    if (user.role === "seller" || user.role === "both") {
      const seller = await queryDB(
        `SELECT id, user_id, whatsapp_number, credits, total_credits_used, last_credit_update, location, created_at, updated_at
         FROM SellerProfile WHERE user_id = ?`,
        [user.id]
      );
      sellerProfile = (seller && seller[0]) || null;
    }

    if (user.role === "supplier" || user.role === "both") {
      const supplier = await queryDB(
        `SELECT id, user_id, store_name, store_description, whatsapp_number, logo, plan_id, plan_start, plan_end,
                is_verified, rating, total_products, country, created_at, updated_at
         FROM SupplierProfile WHERE user_id = ?`,
        [user.id]
      );
      supplierProfile = (supplier && supplier[0]) || null;
    }

    return res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        whatsapp_number: user.whatsapp_number,
        date_joined: user.date_joined,
      },
      sellerProfile,
      supplierProfile,
    });
  } catch (err) {
    return handleDBError(res, err);
  }
});

export default router;
