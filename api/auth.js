import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db.js";

const router = express.Router();

// JWT Secret (should be in .env in production)
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

// ✅ SIGNUP - Register new user
router.post("/signup", async (req, res) => {
  const { username, email, password, role, whatsapp_number } = req.body;

  try {
    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: "Username, email, and password are required" 
      });
    }

    // Check if user already exists
    const [existingUsers] = await pool.query(
      "SELECT id FROM User WHERE email = ? OR username = ?",
      [email, username]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: "User with this email or username already exists" 
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const [userResult] = await pool.query(
      `INSERT INTO User (username, email, password, role, whatsapp_number, date_joined, last_login) 
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [username, email, hashedPassword, role || 'seller', whatsapp_number || null]
    );

    const userId = userResult.insertId;

    // Create profile based on role
    if (role === 'seller' || role === 'both' || !role) {
      await pool.query(
        `INSERT INTO SellerProfile (user_id, whatsapp_number, credits) 
         VALUES (?, ?, 3)`,
        [userId, whatsapp_number || null]
      );
    }

    if (role === 'supplier' || role === 'both') {
      await pool.query(
        `INSERT INTO SupplierProfile (user_id, store_name, whatsapp_number) 
         VALUES (?, ?, ?)`,
        [userId, `${username}'s Store`, whatsapp_number || null]
      );
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId, username, email, role: role || 'seller' },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      token,
      user: {
        id: userId,
        username,
        email,
        role: role || 'seller',
        whatsapp_number
      }
    });

  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Registration failed", 
      error: error.message 
    });
  }
});

// ✅ LOGIN - Authenticate user
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: "Email and password are required" 
      });
    }

    // Find user
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

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        message: "Invalid email or password" 
      });
    }

    // Update last login
    await pool.query(
      "UPDATE User SET last_login = NOW() WHERE id = ?",
      [user.id]
    );

    // Get profile data based on role
    let profileData = {};
    
    if (user.role === 'seller' || user.role === 'both') {
      const [sellerProfile] = await pool.query(
        "SELECT * FROM SellerProfile WHERE user_id = ?",
        [user.id]
      );
      profileData.sellerProfile = sellerProfile[0] || null;
    }

    if (user.role === 'supplier' || user.role === 'both') {
      const [supplierProfile] = await pool.query(
        "SELECT * FROM SupplierProfile WHERE user_id = ?",
        [user.id]
      );
      profileData.supplierProfile = supplierProfile[0] || null;
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        username: user.username, 
        email: user.email, 
        role: user.role 
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

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
        ...profileData
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Login failed", 
      error: error.message 
    });
  }
});

// ✅ VERIFY TOKEN - Check if token is valid
router.get("/verify", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: "No token provided" 
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // Get fresh user data
    const [users] = await pool.query(
      "SELECT id, username, email, role, whatsapp_number FROM User WHERE id = ? AND is_active = TRUE",
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: "User not found" 
      });
    }

    res.json({
      success: true,
      user: users[0]
    });

  } catch (error) {
    res.status(401).json({ 
      success: false, 
      message: "Invalid token", 
      error: error.message 
    });
  }
});

export default router;