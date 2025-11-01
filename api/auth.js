// api/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import queryDB from "../db.js"; // <-- use the stable query helper
import nodemailer from "nodemailer";
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
// ---------------------------
// Email Transporter (Nodemailer)
// ---------------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

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
/**
 * ----------------------------
 * FORGOT PASSWORD
 * ----------------------------
 * Request a password reset link (sent to email)
 */
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required",
    });
  }

  try {
    const users = await queryDB("SELECT id, email, username FROM `User` WHERE email = ?", [email]);
    if (!users || users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No account found with this email",
      });
    }

    const user = users[0];

    // generate a short-lived reset token (15 min expiry)
    const resetToken = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "15m" }
    );

    // construct reset link
    const resetLink = `${process.env.FRONTEND_URL || "https://storensupply.com"}/reset-password?token=${resetToken}`;

    /**
     * 📨 TODO: Send email via Nodemailer or any service
     * For now, we'll return it for testing purposes.
     */
    // ---------------------------
// Send Password Reset Email
// ---------------------------
const mailOptions = {
  from: process.env.EMAIL_FROM,
  to: email,
  subject: "Password Reset Request - Storensupply",
  html: `
    <div style="font-family: Arial, sans-serif; color: #333;">
      <h2>Storensupply Password Reset</h2>
      <p>Hi ${user.username || "there"},</p>
      <p>You requested to reset your password. Please click the link below to set a new password:</p>
      <p><a href="${resetLink}" style="color: #1a73e8;">Reset Password</a></p>
      <p><b>Note:</b> This link will expire in 15 minutes.</p>
      <p>If you didn’t request this, please ignore this email.</p>
      <br/>
      <p>— Storensupply Support</p>
    </div>
  `,
};

try {
  await transporter.sendMail(mailOptions);
  console.log(`✅ Password reset email sent to ${email}`);

  return res.json({
    success: true,
    message: "Password reset email sent successfully",
  });
} catch (emailErr) {
  console.error("❌ Email sending error:", emailErr);
  return res.status(500).json({
    success: false,
    message: "Failed to send password reset email",
    error: emailErr.message,
  });
}

  } catch (err) {
    return handleDBError(res, err);
  }
});

/**
 * ----------------------------
 * RESET PASSWORD
 * ----------------------------
 * Use the reset token to set a new password
 */
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Token and new password are required",
    });
  }

  try {
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtErr) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    // Validate password strength
    const passwordRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*#?&]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters long and include one uppercase letter, one number, and one special character.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user password
    await queryDB("UPDATE `User` SET password = ? WHERE id = ?", [
      hashedPassword,
      decoded.userId,
    ]);

    return res.json({
      success: true,
      message: "Password has been reset successfully",
    });
  } catch (err) {
    return handleDBError(res, err);
  }
});

export default router;
