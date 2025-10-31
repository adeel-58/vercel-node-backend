import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import queryDB from "../db.js"; // ✅ use queryDB instead of pool.query

const router = express.Router();

// ✅ Middleware to verify JWT
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ success: false, message: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key-change-in-production"
    );
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

// ✅ 1. GET seller profile
router.get("/profile", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const userRows = await queryDB(
      "SELECT id, username, email, whatsapp_number FROM User WHERE id = ?",
      [userId]
    );
    if (userRows.length === 0)
      return res.status(404).json({ success: false, message: "User not found" });

    const sellerRows = await queryDB(
      "SELECT id, location, credits, total_credits_used, last_credit_update FROM SellerProfile WHERE user_id = ?",
      [userId]
    );

    res.json({
      success: true,
      user: userRows[0],
      sellerProfile: sellerRows[0] || null,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ success: false, message: "Server error: failed to fetch profile" });
  }
});

// ✅ 2. UPDATE location
router.put("/update-location", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { location } = req.body;

    if (!location)
      return res.status(400).json({ success: false, message: "Location is required" });

    await queryDB(
      "UPDATE SellerProfile SET location = ?, updated_at = NOW() WHERE user_id = ?",
      [location, userId]
    );

    res.json({ success: true, message: "Location updated successfully", location });
  } catch (error) {
    console.error("Update location error:", error);
    res.status(500).json({ success: false, message: "Failed to update location" });
  }
});

// ✅ 3. UPDATE WhatsApp number
router.put("/update-whatsapp", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { whatsapp_number } = req.body;

    if (!whatsapp_number)
      return res.status(400).json({ success: false, message: "WhatsApp number is required" });

    await queryDB("UPDATE User SET whatsapp_number = ? WHERE id = ?", [
      whatsapp_number,
      userId,
    ]);

    res.json({
      success: true,
      message: "WhatsApp number updated successfully",
      whatsapp_number,
    });
  } catch (error) {
    console.error("Update WhatsApp error:", error);
    res.status(500).json({ success: false, message: "Failed to update WhatsApp number" });
  }
});

// ✅ 4. CHANGE password
router.put("/change-password", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword)
      return res.status(400).json({ success: false, message: "All fields are required" });

    if (newPassword !== confirmPassword)
      return res.status(400).json({ success: false, message: "Passwords do not match" });

    const users = await queryDB("SELECT password FROM User WHERE id = ?", [userId]);
    if (users.length === 0)
      return res.status(404).json({ success: false, message: "User not found" });

    const isMatch = await bcrypt.compare(oldPassword, users[0].password);
    if (!isMatch)
      return res.status(401).json({ success: false, message: "Old password is incorrect" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await queryDB("UPDATE User SET password = ? WHERE id = ?", [
      hashedPassword,
      userId,
    ]);

    res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, message: "Failed to change password" });
  }
});

export default router;
