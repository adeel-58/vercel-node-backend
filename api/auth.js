import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";


// ✅ SIGNUP
// ✅ Simplified Signup (Seller only)
router.post("/signup", async (req, res) => {
  const { username, email, password, whatsapp_number, location, country } = req.body;

  try {
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Username, email, and password are required",
      });
    }

    // Check existing user
    const [existingUsers] = await pool.query(
      "SELECT id FROM User WHERE email = ? OR username = ?",
      [email, username]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({
        success: false,
        message: "User with this email or username already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Create User (default role = seller)
    const [userResult] = await pool.query(
      `INSERT INTO User (username, email, password, role, whatsapp_number, date_joined, last_login)
       VALUES (?, ?, ?, 'seller', ?, NOW(), NOW())`,
      [username, email, hashedPassword, whatsapp_number || null]
    );

    const userId = userResult.insertId;

    // ✅ Create Seller Profile
    await pool.query(
      `INSERT INTO SellerProfile 
       (user_id, whatsapp_number, credits, total_credits_used, last_credit_update, location, created_at, updated_at)
       VALUES (?, ?, 3, 0, NOW(), ?, NOW(), NOW())`,
      [userId, whatsapp_number || null, location || null]
    );

    // Generate JWT
    const token = jwt.sign(
      { userId, username, email, role: "seller" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Fetch Seller Profile
    const [[sellerProfile]] = await pool.query(
      `SELECT * FROM SellerProfile WHERE user_id = ?`,
      [userId]
    );

    res.status(201).json({
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
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({
      success: false,
      message: "Registration failed",
      error: error.message,
    });
  }
});




// ✅ VERIFY TOKEN - Check if token is valid and return user + profiles
router.get("/verify", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }

    // Decode token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Fetch basic user info
    const [users] = await pool.query(
      "SELECT id, username, email, role, whatsapp_number FROM User WHERE id = ? AND is_active = TRUE",
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    const user = users[0];

    // Initialize profile containers
    let sellerProfile = null;
    let supplierProfile = null;

    // Fetch seller profile if applicable
    if (user.role === "seller" || user.role === "both") {
      const [sellerProfiles] = await pool.query(
        `SELECT id, user_id, whatsapp_number, credits, total_credits_used, 
                last_credit_update, location, created_at, updated_at
         FROM SellerProfile WHERE user_id = ?`,
        [user.id]
      );
      if (sellerProfiles.length > 0) {
        sellerProfile = sellerProfiles[0];
      }
    }

    // Fetch supplier profile if applicable
    if (user.role === "supplier" || user.role === "both") {
      const [supplierProfiles] = await pool.query(
        `SELECT id, user_id, store_name, store_description, whatsapp_number, logo, 
                plan_id, plan_start, plan_end, is_verified, rating, total_products, 
                country, created_at, updated_at
         FROM SupplierProfile WHERE user_id = ?`,
        [user.id]
      );
      if (supplierProfiles.length > 0) {
        supplierProfile = supplierProfiles[0];
      }
    }

    // ✅ Final Response
    res.json({
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

  } catch (error) {
    console.error("Token verification error:", error);
    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: error.message,
    });
  }
});


// ✅ LOGIN
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    const [users] = await pool.query(
      "SELECT * FROM User WHERE email = ? AND is_active = TRUE",
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const user = users[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    // Update last login
    await pool.query("UPDATE User SET last_login = NOW() WHERE id = ?", [user.id]);

    // Generate token
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

    // ✅ Fetch profiles
    let sellerProfile = null;
    let supplierProfile = null;

    if (user.role === "seller" || user.role === "both") {
      const [seller] = await pool.query(
        `SELECT id, user_id, whatsapp_number, credits, total_credits_used, last_credit_update, location, created_at, updated_at
         FROM SellerProfile WHERE user_id = ?`,
        [user.id]
      );
      sellerProfile = seller[0] || null;
    }

    if (user.role === "supplier" || user.role === "both") {
      const [supplier] = await pool.query(
        `SELECT id, user_id, store_name, store_description, whatsapp_number, logo, plan_id, plan_start, plan_end,
                is_verified, rating, total_products, country, created_at, updated_at
         FROM SupplierProfile WHERE user_id = ?`,
        [user.id]
      );
      supplierProfile = supplier[0] || null;
    }

    res.json({
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
      supplierProfile
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Login failed",
      error: error.message,
    });
  }
});

export default router;



