import express from "express";
import pool from "../db.js";
import multer from "multer";
import fs from "fs";
import path from "path";

const router = express.Router();

// ===================================
// 🧩 MULTER SETUP for logo uploads
// ===================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/supplier_logos";
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName =
      "supplier_" + Date.now() + path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

// ===================================
// ✅ Create Supplier Profile
// ===================================
router.post("/create", upload.single("logo"), async (req, res) => {
  const { user_id, store_name, store_description, whatsapp_number, country } = req.body;

  // If image uploaded, save its relative path
  const logo = req.file ? `/uploads/supplier_logos/${req.file.filename}` : null;

  try {
    // 1️⃣ Fetch default free plan
    const [planResult] = await pool.query(
      "SELECT * FROM Plan WHERE plan_type = 'free' AND is_active = 1 LIMIT 1"
    );

    if (planResult.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No free plan found in Plan table",
      });
    }

    const freePlan = planResult[0];

    // 2️⃣ Calculate plan dates
    const planStart = new Date();
    const planEnd = new Date();
    planEnd.setDate(planEnd.getDate() + freePlan.duration_days);

    // 3️⃣ Insert new supplier profile
    const [result] = await pool.query(
      `INSERT INTO SupplierProfile 
        (user_id, store_name, store_description, whatsapp_number, country, logo, plan_id, plan_start, plan_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        user_id,
        store_name,
        store_description,
        whatsapp_number,
        country,
        logo,
        freePlan.id,
        planStart,
        planEnd,
      ]
    );

    const supplierId = result.insertId;

    // 4️⃣ Update user role to "both"
    await pool.query("UPDATE User SET role = 'both' WHERE id = ?", [user_id]);

    // 5️⃣ Return joined supplier + plan info
    const [supplierProfile] = await pool.query(
      `SELECT sp.*, 
              p.name AS plan_name, 
              p.plan_type, 
              p.upload_limit, 
              p.price, 
              p.duration_days 
       FROM SupplierProfile sp 
       LEFT JOIN Plan p ON sp.plan_id = p.id 
       WHERE sp.id = ?`,
      [supplierId]
    );

    res.status(201).json({
      success: true,
      message: "Supplier profile created successfully",
      supplierProfile: supplierProfile[0],
    });
  } catch (err) {
    console.error("Supplier create error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
});

export default router;
