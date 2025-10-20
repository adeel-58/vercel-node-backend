// api/supplier.js
import express from "express";
import pool from "../db.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import FTPClient from "basic-ftp";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASSWORD;
const FTP_PORT = process.env.FTP_PORT || 21;
const FTP_BASE_PATH = process.env.FTP_BASE_PATH || "/uploads/products"; // root folder for product images
const FTP_PUBLIC_URL = process.env.FTP_PUBLIC_URL || "https://storensupply.com/uploads/products";

// ------------------ Multer Setup (temp storage) ------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempPath = "temp_uploads";
    if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
    cb(null, tempPath);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage });

// ------------------ Auth Middleware (for update) ------------------
export const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }
    const token = authHeader.split(" ")[1];
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) return res.status(401).json({ success: false, message: "Invalid or expired token" });
      req.user = decoded;
      next();
    });
  } catch (err) {
    console.error("Token verify error:", err);
    return res.status(500).json({ success: false, message: "Token verification error" });
  }
};

// ------------------ FTP Helpers ------------------
const uploadToFTP = async (localFilePath, remoteFolder) => {
  const client = new FTPClient.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: FTP_PORT,
    });

    // Ensure remote folder exists and change into it
    await client.ensureDir(remoteFolder);
    // uploadFrom(localPath, remoteFilename)
    await client.uploadFrom(localFilePath, path.basename(localFilePath));

    // Return remote path (we store this in DB)
    // remoteFolder might be like "/uploads/products/12"
    return `${remoteFolder}/${path.basename(localFilePath)}`;
  } catch (err) {
    console.error("FTP Upload Error:", err);
    throw new Error("FTP upload failed: " + err.message);
  } finally {
    client.close();
  }
};

const deleteFromFTP = async (remoteFilePath) => {
  const client = new FTPClient.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: FTP_PORT,
    });

    // Try direct remove first
    try {
      await client.remove(remoteFilePath);
      return true;
    } catch (err) {
      // sometimes the FTP root is already public_html; try removing leading /public_html if present
      const alt = remoteFilePath.replace(/^\/?public_html\/?/i, "/");
      await client.remove(alt);
      return true;
    }
  } catch (err) {
    console.error("FTP Delete Error:", err);
    throw new Error("FTP delete failed: " + err.message);
  } finally {
    client.close();
  }
};

// Build public URL from stored remote path
const buildPublicUrl = (remotePath) => {
  if (!remotePath) return null;
  try {
    // remotePath examples:
    // /uploads/products/12/12345.jpg
    // /public_html/uploads/products/12/12345.jpg
    const parts = remotePath.split("/").filter(Boolean); // e.g. ["public_html","uploads","products","12","file.jpg"]
    const uploadsIndex = parts.findIndex((p) => p.toLowerCase() === "uploads");
    if (uploadsIndex >= 0) {
      // parts after "uploads": ["products","12","file.jpg"]
      const afterUploads = parts.slice(uploadsIndex + 1); // ["products","12","file.jpg"]
      // FTP_PUBLIC_URL already points to /uploads/products
      // Remove the first "products" segment to avoid double
      if (afterUploads[0] && afterUploads[0].toLowerCase() === "products") {
        const relative = afterUploads.slice(1).join("/"); // "12/file.jpg"
        return `${FTP_PUBLIC_URL}/${relative}`;
      } else {
        // fallback: join everything
        return `${FTP_PUBLIC_URL}/${afterUploads.join("/")}`;
      }
    }
    // Fallback: return FTP_PUBLIC_URL + filename
    return `${FTP_PUBLIC_URL}/${path.basename(remotePath)}`;
  } catch (err) {
    console.warn("buildPublicUrl failed:", err);
    return `${FTP_PUBLIC_URL}/${path.basename(remotePath)}`;
  }
};

// ------------------ ROUTES ------------------

// POST /supplier/create
// Accepts fields: user_id, store_name, store_description, whatsapp_number, country
// Optional file: logo
router.post("/create", upload.single("logo"), async (req, res) => {
  const { user_id, store_name, store_description, whatsapp_number, country } = req.body;
  const logoFile = req.file; // temp file path available

  if (!user_id || !store_name) {
    // simple validation
    return res.status(400).json({ success: false, message: "user_id and store_name are required" });
  }

  try {
    // 1. Fetch default free plan
    const [planResult] = await pool.query(
      "SELECT * FROM Plan WHERE plan_type = 'free' AND is_active = 1 LIMIT 1"
    );
    if (planResult.length === 0) {
      return res.status(400).json({ success: false, message: "No free plan found" });
    }
    const freePlan = planResult[0];

    // 2. Calculate plan start/end
    const planStart = new Date();
    const planEnd = new Date();
    planEnd.setDate(planEnd.getDate() + (freePlan.duration_days || 30));

    // 3. Insert SupplierProfile with logo NULL for now
    const [insertResult] = await pool.query(
      `INSERT INTO SupplierProfile 
        (user_id, store_name, store_description, whatsapp_number, country, logo, plan_id, plan_start, plan_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        user_id,
        store_name,
        store_description || null,
        whatsapp_number || null,
        country || null,
        null,
        freePlan.id,
        planStart,
        planEnd,
      ]
    );

    const supplierId = insertResult.insertId;

    // 4. If logo was provided, upload it to FTP under FTP_BASE_PATH/{supplierId}
    let finalLogoRemotePath = null;
    if (logoFile) {
      try {
        const remoteFolder = `${FTP_BASE_PATH}/${supplierId}`;
        finalLogoRemotePath = await uploadToFTP(logoFile.path, remoteFolder);
      } catch (uploadErr) {
        console.error("Logo FTP upload failed:", uploadErr);
        // continue — we created the supplier; but inform the client
      } finally {
        // remove temp file
        try { fs.unlinkSync(logoFile.path); } catch (e) {}
      }

      if (finalLogoRemotePath) {
        // Update supplier record with logo remote path
        await pool.query(`UPDATE SupplierProfile SET logo = ? WHERE id = ?`, [finalLogoRemotePath, supplierId]);
      }
    }

    // 5. Update user role to 'both'
    await pool.query(`UPDATE User SET role = 'both' WHERE id = ?`, [user_id]);

    // 6. Fetch and return the created supplier profile (with plan info)
    const [profileRows] = await pool.query(
      `SELECT sp.*, p.name AS plan_name, p.plan_type, p.upload_limit, p.price, p.duration_days
       FROM SupplierProfile sp
       LEFT JOIN Plan p ON sp.plan_id = p.id
       WHERE sp.id = ?`,
      [supplierId]
    );

    const profile = profileRows[0];
    profile.logo = profile.logo ? buildPublicUrl(profile.logo) : null;

    return res.status(201).json({ success: true, message: "Supplier profile created", supplierProfile: profile });
  } catch (err) {
    console.error("Supplier create error:", err);
    return res.status(500).json({ success: false, message: "Failed to create supplier", error: err.message });
  }
});

// PUT /supplier/update
// Auth required. Update any supplier fields; logo optional (if provided, upload, delete old)
router.put("/update", verifyToken, upload.single("logo"), async (req, res) => {
  try {
    const userId = req.user.userId;
    const { store_name, store_description, whatsapp_number, country } = req.body;
    const logoFile = req.file;

    // Find supplier by user_id
    const [supplierRows] = await pool.query(`SELECT * FROM SupplierProfile WHERE user_id = ?`, [userId]);
    if (supplierRows.length === 0) {
      // optionally allow creation if not exist; for now return 404
      return res.status(404).json({ success: false, message: "Supplier profile not found" });
    }

    const supplier = supplierRows[0];
    const supplierId = supplier.id;

    // Build update query for fields
    const updates = [];
    const params = [];

    if (store_name !== undefined) { updates.push("store_name = ?"); params.push(store_name); }
    if (store_description !== undefined) { updates.push("store_description = ?"); params.push(store_description); }
    if (whatsapp_number !== undefined) { updates.push("whatsapp_number = ?"); params.push(whatsapp_number); }
    if (country !== undefined) { updates.push("country = ?"); params.push(country); }

    // Handle logo replacement if provided
    if (logoFile) {
      let newRemotePath = null;
      try {
        const remoteFolder = `${FTP_BASE_PATH}/${supplierId}`;
        newRemotePath = await uploadToFTP(logoFile.path, remoteFolder);
      } catch (uploadErr) {
        console.error("Logo upload failed during update:", uploadErr);
        // cleanup temp file and return error
        try { fs.unlinkSync(logoFile.path); } catch (e) {}
        return res.status(500).json({ success: false, message: "Logo upload failed", error: uploadErr.message });
      } finally {
        try { fs.unlinkSync(logoFile.path); } catch (e) {}
      }

      // Delete old logo from FTP if exists
      if (supplier.logo) {
        try {
          await deleteFromFTP(supplier.logo);
        } catch (delErr) {
          console.warn("Failed to delete old supplier logo from FTP:", delErr.message);
          // do not fail whole operation because deletion is not critical
        }
      }

      updates.push("logo = ?");
      params.push(newRemotePath);
    }

    if (updates.length > 0) {
      params.push(supplierId);
      await pool.query(`UPDATE SupplierProfile SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`, params);
    }

    // Return updated supplier
    const [updatedRows] = await pool.query(`SELECT * FROM SupplierProfile WHERE id = ?`, [supplierId]);
    const updatedSupplier = updatedRows[0];
    updatedSupplier.logo = updatedSupplier.logo ? buildPublicUrl(updatedSupplier.logo) : null;

    return res.json({ success: true, message: "Supplier updated", supplier: updatedSupplier });
  } catch (err) {
    console.error("Supplier update error:", err);
    return res.status(500).json({ success: false, message: "Failed to update supplier", error: err.message });
  }
});

export default router;
