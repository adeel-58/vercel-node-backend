import express from "express";
import pool from "../db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const router = express.Router();

// Middleware to verify JWT
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ success: false, message: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-in-production");
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}

// ✅ 1. GET seller profile
router.get("/profile", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Fetch user info
    const [userRows] = await pool.query(
      "SELECT id, username, email, whatsapp_number FROM User WHERE id = ?",
      [userId]
    );

    if (userRows.length === 0)
      return res.status(404).json({ success: false, message: "User not found" });

    const user = userRows[0];

    // Fetch seller profile
    const [profileRows] = await pool.query(
      "SELECT id, location, credits, total_credits_used, last_credit_update FROM SellerProfile WHERE user_id = ?",
      [userId]
    );

    const profile = profileRows[0] || null;

    res.json({
      success: true,
      user,
      sellerProfile: profile,
    });
  } catch (error) {
    console.error("Get seller profile error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch seller profile",
      error: error.message,
    });
  }
});

// ✅ 2. UPDATE location
router.put("/update-location", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { location } = req.body;

    if (!location) {
      return res.status(400).json({
        success: false,
        message: "Location is required",
      });
    }

    await pool.query(
      "UPDATE SellerProfile SET location = ?, updated_at = NOW() WHERE user_id = ?",
      [location, userId]
    );

    res.json({
      success: true,
      message: "Location updated successfully",
      location,
    });
  } catch (error) {
    console.error("Update location error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update location",
      error: error.message,
    });
  }
});

// ✅ 3. UPDATE WhatsApp number
router.put("/update-whatsapp", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { whatsapp_number } = req.body;

    if (!whatsapp_number) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp number is required",
      });
    }

    // Update WhatsApp number in User table
    await pool.query(
      "UPDATE User SET whatsapp_number = ? WHERE id = ?",
      [whatsapp_number, userId]
    );

    res.json({
      success: true,
      message: "WhatsApp number updated successfully",
      whatsapp_number,
    });
  } catch (error) {
    console.error("Update WhatsApp number error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update WhatsApp number",
      error: error.message,
    });
  }
});

// ✅ 4. CHANGE password
router.put("/change-password", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "All password fields are required",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "New passwords do not match",
      });
    }

    // Verify old password
    const [users] = await pool.query("SELECT password FROM User WHERE id = ?", [userId]);
    if (users.length === 0)
      return res.status(404).json({ success: false, message: "User not found" });

    const isPasswordValid = await bcrypt.compare(oldPassword, users[0].password);
    if (!isPasswordValid)
      return res.status(401).json({ success: false, message: "Old password is incorrect" });

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE User SET password = ? WHERE id = ?", [hashedPassword, userId]);

    res.json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to change password",
      error: error.message,
    });
  }
});

export default router;
